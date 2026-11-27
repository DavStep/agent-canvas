// The project explorer's view of a zone's folder: one directory listing at a time, and a preview
// of one file. Pure, so the main process (which reads the disk) and the page (which draws it)
// agree on names, kinds and limits.

/** One entry of a listed directory. `ignored`: build output, dependencies or a .gitignore match,
    shown quieter. `outside`: a link that leads out of the project (listed, never opened). */
export interface FileEntry {
  name: string;
  kind: 'dir' | 'file';
  size: number;
  ignored: boolean;
  outside?: boolean;
}
/** `truncated`: the directory held more than MAX_ENTRIES; the first ones (sorted) are listed. */
export interface DirListing { entries: FileEntry[]; truncated: boolean }

export type FilePreview =
  | { kind: 'json' | 'text'; size: number; text: string }
  | { kind: 'image'; size: number; mime: string; dataUrl: string }
  | { kind: 'binary'; size: number }
  | { kind: 'tooLarge'; size: number; limit: number };

/** Most entries one listing returns. */
export const MAX_ENTRIES = 2000;
/** Largest text or JSON file shown. */
export const MAX_TEXT_BYTES = 1_500_000;
/** Largest image shown (it crosses the bridge as a data URL). */
export const MAX_IMAGE_BYTES = 12_000_000;

/** Names never listed: version-control internals and Finder's litter. */
export const HIDDEN_NAMES: ReadonlySet<string> = new Set(['.git', '.hg', '.svn', '.DS_Store']);
/** Folders listed quieter, wherever they sit: dependencies, caches and build output. */
export const NOISE_NAMES: ReadonlySet<string> = new Set([
  'node_modules', 'dist', 'dist-electron', 'build', 'out', 'release', 'coverage', '.next', '.nuxt', '.turbo', '.cache',
  '.parcel-cache', '.vite', '__pycache__', '.venv', 'venv', '.pytest_cache', '.mypy_cache', 'target', '.gradle', 'Pods', 'DerivedData',
]);

const IMAGE_MIME: Readonly<Record<string, string>> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon',
};
const JSON_EXT = new Set(['json', 'jsonc', 'json5', 'webmanifest', 'har', 'geojson']);
/** Files that are text by name, so their bytes need no sniffing. */
const TEXT_EXT = new Set([
  'txt', 'md', 'mdx', 'markdown', 'rst', 'ts', 'tsx', 'cts', 'mts', 'js', 'jsx', 'cjs', 'mjs', 'css', 'scss', 'less', 'html', 'htm', 'xml',
  'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'env', 'sh', 'bash', 'zsh', 'fish', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'kts', 'swift',
  'c', 'h', 'cc', 'cpp', 'hpp', 'm', 'mm', 'cs', 'php', 'lua', 'sql', 'graphql', 'gql', 'proto', 'vue', 'svelte', 'astro', 'csv', 'tsv',
  'log', 'lock', 'gitignore', 'gitattributes', 'editorconfig', 'npmrc', 'nvmrc', 'prettierrc', 'eslintrc', 'babelrc', 'plist', 'gradle',
  'dockerfile', 'makefile', 'tf', 'hcl', 'ex', 'exs', 'erl', 'hs', 'clj', 'dart', 'r', 'jl', 'pl', 'zig', 'nim', 'glsl', 'wgsl',
]);
/** Files that are text by their whole name. */
const TEXT_NAMES = new Set(['dockerfile', 'makefile', 'license', 'licence', 'readme', 'changelog', 'procfile', 'gemfile', 'rakefile', 'brewfile']);

/** The file's extension, lower case, without the dot ('' for none; a dotfile's name is its extension). */
export function extOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
}

/** How a file is shown, judged by name: 'unknown' means its bytes decide (text, or binary). */
export function previewKindOf(name: string): { kind: 'json' | 'text' | 'unknown' } | { kind: 'image'; mime: string } {
  const ext = extOf(name);
  const mime = IMAGE_MIME[ext];
  if (mime) return { kind: 'image', mime };
  if (JSON_EXT.has(ext)) return { kind: 'json' };
  if (TEXT_EXT.has(ext) || TEXT_NAMES.has(name.toLowerCase())) return { kind: 'text' };
  return { kind: 'unknown' };
}

/** Bytes that read as text: no NUL in the sample, and few control characters. */
export function looksLikeText(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 8192);
  let odd = 0;
  for (let i = 0; i < n; i++) {
    const b = bytes[i]!;
    if (b === 0) return false;
    if (b < 7 || (b > 13 && b < 32 && b !== 27)) odd++;
  }
  return n === 0 || odd / n < 0.05;
}

/** A relative path from the project's root: '' is the root, steps joined by '/'. Throws on an
    absolute path, a '.' or '..' step, an empty step or a NUL. */
export function relativeSteps(rel: string): string[] {
  if (typeof rel !== 'string' || rel.length > 4096 || rel.includes('\0') || rel.includes('\\')) throw new TypeError('not a project path');
  if (rel === '') return [];
  if (rel.startsWith('/')) throw new TypeError('a project path is relative to its folder');
  const steps = rel.split('/');
  if (steps.some((s) => s === '' || s === '.' || s === '..')) throw new TypeError('a project path has no empty, . or .. step');
  return steps;
}

/** The folder a session's zone stands for, as the page's zoneFolder reads it: its working
    directory, or the repository a worktree was made from. */
export function rootOfCwd(cwd: string): string {
  const wt = cwd.indexOf('/.claude/worktrees/');
  return wt === -1 ? cwd : cwd.slice(0, wt);
}

/** "12 KB", "1.4 MB": a size for a person. */
export function formatSize(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = bytes / 1000;
  let u = 0;
  while (v >= 1000 && u < units.length - 1) { v /= 1000; u++; }
  return `${v < 10 ? v.toFixed(1).replace(/\.0$/, '') : Math.round(v)} ${units[u]}`;
}

// ---------- .gitignore (the root's, the common subset) ----------

export interface IgnoreRule { re: RegExp; negate: boolean; dirOnly: boolean }

const globToRe = (glob: string): string => {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // "**/" matches any number of folders; a trailing "**" anything below.
        if (glob[i + 2] === '/') { out += '(?:.*/)?'; i += 2; } else { out += '.*'; i += 1; }
      } else out += '[^/]*';
    } else if (c === '?') out += '[^/]';
    else if (c === '[') {
      const end = glob.indexOf(']', i + 1);
      if (end === -1) { out += '\\['; continue; }
      out += `[${glob.slice(i + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\')}]`;
      i = end;
    } else out += c.replace(/[.+^${}()|\\]/g, '\\$&');
  }
  return out;
};

/** The rules of one .gitignore: blank lines and comments skipped; a pattern with no slash but a
    trailing one matches the name at any depth, any other is anchored to the root. */
export function parseGitignore(text: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.replace(/(?<!\\)\s+$/, '');
    if (line === '' || line.startsWith('#')) continue;
    const negate = line.startsWith('!');
    if (negate) line = line.slice(1);
    if (line.startsWith('\\')) line = line.slice(1);
    const dirOnly = line.endsWith('/');
    if (dirOnly) line = line.slice(0, -1);
    if (line === '') continue;
    const anchored = line.includes('/');
    if (line.startsWith('/')) line = line.slice(1);
    const body = globToRe(line);
    rules.push({ re: new RegExp(anchored ? `^${body}$` : `(?:^|/)${body}$`), negate, dirOnly });
  }
  return rules;
}

/** Whether a path (relative to the root) is ignored: the last matching rule wins. */
export function isIgnored(rules: readonly IgnoreRule[], rel: string, dir: boolean): boolean {
  let ignored = false;
  for (const r of rules) {
    if (r.dirOnly && !dir) continue;
    if (r.re.test(rel)) ignored = !r.negate;
  }
  return ignored;
}
