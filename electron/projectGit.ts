import { execFile } from 'node:child_process';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { conflicted, fullyStaged, staged, type GitAction, type GitFile, type GitStatus } from '../shared/projectGit.ts';
import { projectRoot, type ProjectFilesOptions } from './files.ts';

const exec = promisify(execFile);
async function git(cwd: string, args: string[], expectedExit = 0, paths?: string[]) {
  try {
    const pending = exec('/usr/bin/git', ['--literal-pathspecs', ...args], {
      cwd, timeout: args.includes('push') ? 120_000 : 30_000, maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true' },
    });
    if (paths) {
      const input = pending.child.stdin!;
      // Git may exit before reading stdin (for example, when the index is locked).
      input.on('error', () => {});
      input.end(paths.join('\0') + '\0');
    }
    return (await pending).stdout;
  } catch (err) {
    const e = err as Error & { code?: number | string; stderr?: string; stdout?: string };
    if (expectedExit !== 0 && e.code === expectedExit) return e.stdout ?? '';
    if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw new Error('This Git output is too large to display.');
    const message = e.stderr?.trim() || e.stdout?.trim();
    throw new Error(message?.replace(/(https?:\/\/)[^/\s]+@/g, '$1').slice(0, 3000) || 'Git could not finish the operation.');
  }
}

async function status(cwd: string): Promise<GitStatus> {
  const prefix = (await git(cwd, ['rev-parse', '--show-prefix'])).replace(/\n$/, '');
  const raw = await git(cwd, ['--no-optional-locks', 'status', '--porcelain=v2', '--branch', '--no-renames', '-z', '-uall']);
  let head = '', branch: string | null = null, conflicts = false, stagedOutside = false;
  const files: GitFile[] = [];
  for (const line of raw.split('\0')) {
    if (line.startsWith('# branch.oid ')) head = line.slice(13);
    if (line.startsWith('# branch.head ')) branch = line.slice(14);
    // Porcelain v2 has six metadata fields after XY for ordinary paths and eight for conflicts.
    const match = /^(?:1 (..) (?:[^ ]+ ){6}|u (..) (?:[^ ]+ ){8}|\? )([\s\S]+)$/.exec(line);
    if (!match) continue;
    const xy = (match[1] ?? match[2] ?? '??').replaceAll('.', ' ');
    const file = { path: match[3]!, index: xy[0]!, worktree: xy[1]! };
    if (conflicted(file)) conflicts = true;
    if (file.path.startsWith(prefix)) files.push({ ...file, path: file.path.slice(prefix.length) });
    else if (staged(file)) stagedOutside = true;
  }
  if (branch === '(detached)') branch = null;
  let pushTo: GitStatus['pushTo'] = null;
  let ahead: number | null = null;
  if (branch) {
    const ref = 'refs/heads/' + branch;
    const info = await git(cwd, ['for-each-ref', '--format=%(refname)%00%(upstream:remotename)%00%(upstream:remoteref)', ref]);
    const upstream = info.trimEnd().split('\n').map(line => line.split('\0')).find(parts => parts[0] === ref);
    if (upstream?.[1] && upstream[2]?.startsWith('refs/heads/')) {
      pushTo = { remote: upstream[1], branch: upstream[2].slice(11) };
    } else {
      const remotes = (await git(cwd, ['remote'])).trim().split('\n').filter(Boolean);
      const remote = remotes.includes('origin') ? 'origin' : remotes.length === 1 ? remotes[0] : null;
      if (remote) pushTo = { remote, branch };
    }
    // Commits the push would send, judged by the last fetched copy of the destination. Unknown
    // when that copy is missing (a branch the remote has never had): the whole branch goes.
    const tracking = pushTo && `refs/remotes/${pushTo.remote}/${pushTo.branch}`;
    if (tracking && head !== '(initial)' && (await git(cwd, ['for-each-ref', '--format=%(refname)', tracking])).trim() === tracking) {
      ahead = Number((await git(cwd, ['rev-list', '--count', tracking + '..' + ref])).trim());
    }
  }
  const index = await git(cwd, ['diff', '--cached', '--raw', '--no-abbrev', '--no-renames', '-z']);
  return { branch, head, files, conflicts, stagedOutside, pushTo, ahead, indexVersion: createHash('sha256').update(index).digest('hex') };
}

export function createProjectGit(options: ProjectFilesOptions) {
  const busy = new Set<string>();
  return {
    async status(root: unknown) {
      const cwd = await projectRoot(root, options);
      const snapshot = await status(cwd);
      const files = new Map(snapshot.files.map(f => [f.path, f]));
      // Check added lines against Git's own whitespace and conflict-marker rules.
      // Run only when displaying the list, once per comparison across the folder.
      const check = async (cached: boolean) => {
        const args = ['-c', 'core.quotePath=false', 'diff', '--relative', '--no-color', '--no-ext-diff', '--check'];
        if (cached) args.push('--cached');
        const result = await git(cwd, [...args, '--', '.'], 2);
        for (const line of result.split('\n')) {
          const match = /^(.*):(\d+): (.+)$/.exec(line);
          if (!match) continue;
          const file = files.get(match[1]!);
          if (file) (file.issues ??= []).push({ line: Number(match[2]), message: match[3]!, staged: cached });
        }
      };
      const checks = [];
      if (snapshot.files.some(staged)) checks.push(check(true));
      if (snapshot.files.some(f => f.worktree !== ' ' && f.index !== '?')) checks.push(check(false));
      if ((await Promise.allSettled(checks)).some(r => r.status === 'rejected')) snapshot.checksUnavailable = true;
      return snapshot;
    },
    async diff(root: unknown, filename: unknown) {
      const cwd = await projectRoot(root, options);
      const current = await status(cwd);
      const file = current.files.find(f => f.path === filename);
      if (!file) throw new Error('This file has changed. Refresh the Git tab.');
      const args = ['diff', '--relative', '--no-ext-diff', '--no-textconv', '--no-color'];
      const paths = ['--', file.path];
      if (file.path.endsWith('/')) return 'Embedded repository';
      const patches: string[] = [];
      if (staged(file)) patches.push('Staged\n' + await git(cwd, [...args, '--cached', ...paths]));
      if (current.files.some(f => f.path === filename && f.index === '?')) {
        patches.push('Untracked\n' + await git(cwd, [...args, '--no-index', '--', '/dev/null', file.path], 1));
      } else if (file.worktree !== ' ' || conflicted(file)) {
        patches.push('Working tree\n' + await git(cwd, [...args, ...paths]));
      }
      return patches.join('\n');
    },
    async act(root: unknown, input: unknown) {
      const cwd = await projectRoot(root, options);
      if (busy.has(cwd)) throw new Error('Another Git operation is running.');
      busy.add(cwd);
      try {
        const current = await status(cwd);
        const action = input as GitAction;
        // A push sends the branch as it is now, so a commit made since the tab last read it (often by
        // an agent on the canvas) does not stand in the way. Everything else acts on what was shown.
        if (!action || action.branch !== current.branch || (action.type !== 'push' && action.head !== current.head)) throw new Error('The branch changed. Refresh the Git tab.');
        if (action.type === 'stage' || action.type === 'unstage') {
          const batch = !('file' in action);
          if (batch && action.indexVersion !== current.indexVersion) throw new Error('The staged changes changed. Review the selection again.');
          const requested = batch ? action.files : [action.file];
          if (!Array.isArray(requested) || !requested.length) throw new Error('Choose files to update.');
          const eligible = current.files.filter(f => !conflicted(f) && (action.type === 'stage' ? !fullyStaged(f) : staged(f)));
          const matches = new Set(eligible.map(f => f.index + f.worktree + f.path));
          const paths = new Set<string>();
          for (const file of requested) {
            if (!file || typeof file.path !== 'string' || file.index?.length !== 1 || file.worktree?.length !== 1 ||
                !matches.has(file.index + file.worktree + file.path)) throw new Error('This change is out of date. Refresh the Git tab.');
            paths.add(file.path);
          }
          const args = action.type === 'stage' ? ['add'] : current.head === '(initial)' ? ['rm', '--cached', '-f'] : ['restore', '--staged'];
          // One index transaction, even for thousands of names. Pathspecs are literal and NUL-delimited.
          const top = (await git(cwd, ['rev-parse', '--show-toplevel'])).replace(/\n$/, '');
          const prefix = path.relative(top, cwd);
          await git(top, [...args, '--pathspec-from-file=-', '--pathspec-file-nul'], 0, [...paths].map(name => path.join(prefix, name)));
          return;
        }
        if (current.conflicts) throw new Error('Resolve the conflicts before continuing.');
        if (action.type === 'commit') {
          if (current.stagedOutside) throw new Error('Files outside this folder are staged. Commit from the repository root.');
          if (current.indexVersion !== action.indexVersion) throw new Error('The staged changes have changed. Review them again.');
          if (!current.files.some(staged)) throw new Error('Select files to commit.');
          if (typeof action.message !== 'string' || !action.message.trim() || action.message.length > 16000) throw new Error('Enter a commit message of up to 16,000 characters.');
          await git(cwd, ['commit', '-m', action.message.trim()]);
        } else if (action.type === 'push') {
          const target = current.pushTo;
          if (!target || !current.branch || target.remote !== action.remote || target.branch !== action.destination) throw new Error('The push destination changed. Refresh the Git tab.');
          if (current.ahead === 0) throw new Error(`Nothing to push: ${target.remote}/${target.branch} already has every commit. Commit your changes first.`);
          await git(cwd, ['-c', 'remote.' + target.remote + '.mirror=false', 'push', '--no-follow-tags', '--set-upstream', '--', target.remote,
            'refs/heads/' + current.branch + ':refs/heads/' + target.branch]);
        } else throw new Error('Unknown Git action.');
      } finally { busy.delete(cwd); }
    },
  };
}
