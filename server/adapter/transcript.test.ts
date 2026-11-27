import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findTranscript, readTail } from './transcript.ts';

const PROJECTS = path.resolve(import.meta.dirname, '../../fixtures/projects');
const sid = (n: number) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;
const fixture = (folder: string, n: number) => path.join(PROJECTS, folder, `${sid(n)}.jsonl`);

const tempDirs: string[] = [];

/** A fresh temp folder, removed after the test whether it passes or fails. */
async function tempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function tempFile(lines: unknown[]): Promise<string> {
  const dir = await tempDir('ac-tail-');
  const file = path.join(dir, 't.jsonl');
  await fs.writeFile(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

describe('findTranscript', () => {
  it('finds <projectsDir>/*/<sessionId>.jsonl', async () => {
    expect(await findTranscript(PROJECTS, sid(1))).toBe(fixture('-work-alpha', 1));
    expect(await findTranscript(PROJECTS, sid(3))).toBe(fixture('-work-beta', 3));
  });

  it('returns null when no folder holds it', async () => {
    expect(await findTranscript(PROJECTS, sid(99))).toBeNull();
  });

  it('caches the match per sessionId', async () => {
    const dir = await tempDir('ac-projects-');
    await fs.mkdir(path.join(dir, 'b'));
    await fs.writeFile(path.join(dir, 'b', 'cached.jsonl'), '');
    const first = await findTranscript(dir, 'cached');
    expect(first).toBe(path.join(dir, 'b', 'cached.jsonl'));
    await fs.mkdir(path.join(dir, 'a'));
    await fs.writeFile(path.join(dir, 'a', 'cached.jsonl'), '');
    expect(await findTranscript(dir, 'cached')).toBe(first);
  });

  it('finds a transcript that appears after a miss', async () => {
    const dir = await tempDir('ac-projects-');
    expect(await findTranscript(dir, 'later')).toBeNull();
    await fs.mkdir(path.join(dir, 'x'));
    await fs.writeFile(path.join(dir, 'x', 'later.jsonl'), '');
    expect(await findTranscript(dir, 'later')).toBe(path.join(dir, 'x', 'later.jsonl'));
  });

  it('looks again when the cached file no longer exists', async () => {
    const dir = await tempDir('ac-projects-');
    await fs.mkdir(path.join(dir, 'a'));
    await fs.mkdir(path.join(dir, 'b'));
    await fs.writeFile(path.join(dir, 'a', 'moved.jsonl'), '');
    expect(await findTranscript(dir, 'moved')).toBe(path.join(dir, 'a', 'moved.jsonl'));
    await fs.rename(path.join(dir, 'a', 'moved.jsonl'), path.join(dir, 'b', 'moved.jsonl'));
    expect(await findTranscript(dir, 'moved')).toBe(path.join(dir, 'b', 'moved.jsonl'));
    await fs.rm(path.join(dir, 'b', 'moved.jsonl'));
    expect(await findTranscript(dir, 'moved')).toBeNull();
  });
});

describe('readTail', () => {
  it("reads the title: the owner's over the app's, and keeps it once the records scroll out of the window", async () => {
    const file = await tempFile([{ type: 'ai-title', aiTitle: 'First' }, { type: 'ai-title', aiTitle: 'Chat titles' }]);
    expect((await readTail(file)).title).toBe('Chat titles');
    await fs.appendFile(file, JSON.stringify({ type: 'custom-title', customTitle: 'Mine' }) + '\n' + JSON.stringify({ type: 'ai-title', aiTitle: 'Later' }) + '\n');
    expect((await readTail(file)).title).toBe('Mine');
    await fs.appendFile(file, JSON.stringify({ type: 'last-prompt', lastPrompt: 'x'.repeat(300) }) + '\n');
    expect((await readTail(file, 200)).title).toBe('Mine');
  });

  it('reads every field from a full tail, skipping a line that fails to parse', async () => {
    expect(await readTail(fixture('-work-alpha', 1))).toEqual({
      title: 'Invented title',
      lastPrompt: 'Please tidy the invented parser module.',
      lastAnswer: 'First invented paragraph.\n\nSecond invented paragraph.',
      recentSteps: [{ kind: 'read', label: 'Read parser.ts', status: 'done' }],
      branch: 'feature/tidy',
      model: 'claude-invented-2',
      pendingTool: null,
      lastBlock: 'thinking',
    });
  });

  it('pairs results by call id and keeps only completed steps from this turn', async () => {
    const call = (id: string) => ({ type: 'assistant', timestamp: '2026-01-01T00:00:00Z',
      message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command: id } }] } });
    const result = (id: string, failed = false) => ({ type: 'user', timestamp: '2026-01-01T00:00:02Z',
      message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: failed }] } });
    const file = await tempFile([call('old'), result('old'), { type: 'user', message: { content: 'next' } },
      call('pending'), call('test'), result('test', true)]);
    expect((await readTail(file)).recentSteps).toEqual([{ kind: 'command', label: 'Bash test', status: 'failed', durationMs: 2000 }]);
  });

  it('reports a pending Bash call with its command', async () => {
    const tail = await readTail(fixture('-work-alpha', 2));
    expect(tail.pendingTool?.name).toBe('Bash');
    expect(tail.pendingTool?.input.command).toBe('npm test');
    expect(tail.lastBlock).toBe('tool_use');
    expect(tail.lastAnswer).toBe('Running the tests now.');
  });

  it('reports no pending tool once a later user record carries its tool_result', async () => {
    const tail = await readTail(fixture('-work-beta', 3));
    expect(tail.pendingTool).toBeNull();
    expect(tail.lastAnswer).toBeNull();
  });

  it('reports the earlier parallel call when only the later one has a result', async () => {
    const tail = await readTail(fixture('-work-beta', 6));
    expect(tail.pendingTool).toEqual({ name: 'Bash', input: { command: 'sleep 60' } });
    expect(tail.lastBlock).toBe('tool_use');
  });

  it('reports no pending tool when every parallel call has a result', async () => {
    expect((await readTail(fixture('-work-beta', 7))).pendingTool).toBeNull();
  });

  it('joins an answer split over records that share one message.id, in order', async () => {
    const tail = await readTail(fixture('-work-beta', 8));
    expect(tail.lastAnswer).toBe('Invented part one.\n\nInvented part two.');
  });

  it('uses only the last text record when it has no message.id', async () => {
    const file = await tempFile([
      { type: 'assistant', message: { content: [{ type: 'text', text: 'one' }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'two' }] } },
    ]);
    expect((await readTail(file)).lastAnswer).toBe('two');
  });

  it('does not count a tool_result that comes before its tool_use', async () => {
    const file = await tempFile([
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'same' }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'same', name: 'Bash', input: {} }] } },
    ]);
    expect((await readTail(file)).pendingTool?.name).toBe('Bash');
  });

  it('never reports an unanswered call from before the last real prompt as pending', async () => {
    const file = await tempFile([
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'old', name: 'Bash', input: { command: 'sleep 9' } }] } },
      { type: 'user', message: { content: 'A new prompt, typed as a string.' } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'On it.' }] } },
    ]);
    expect((await readTail(file)).pendingTool).toBeNull();
    const blocks = await tempFile([
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'old', name: 'Bash', input: {} }] } },
      { type: 'user', message: { content: [{ type: 'text', text: 'A new prompt, as blocks.' }] } },
    ]);
    expect((await readTail(blocks)).pendingTool).toBeNull();
  });

  it('still reports a call made after the last prompt, and does not count tool results or sidechain prompts as prompts', async () => {
    const file = await tempFile([
      { type: 'user', message: { content: 'Run the tests.' } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'a', name: 'Read', input: {} }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a' }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'b', name: 'Bash', input: { command: 'npm test' } }] } },
      { type: 'user', isSidechain: true, message: { content: 'A subagent prompt.' } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'unrelated' }] } },
    ]);
    expect((await readTail(file)).pendingTool).toEqual({ name: 'Bash', input: { command: 'npm test' } });
  });

  it('ignores sidechain records', async () => {
    expect(await readTail(fixture('-work-beta', 4))).toEqual({
      lastPrompt: null,
      lastAnswer: 'Main invented answer.',
      branch: 'main',
      model: 'claude-invented-main',
      pendingTool: null,
      lastBlock: 'text',
    });
  });

  it('returns all null when a single 500,000-byte line exceeds the window', async () => {
    const file = fixture('-work-beta', 5);
    expect((await fs.stat(file)).size).toBe(500_000);
    expect(await readTail(file)).toEqual({
      lastPrompt: null, lastAnswer: null, branch: null, model: null, pendingTool: null, lastBlock: null,
    });
  });

  it('reads the same line whole when the window covers byte 0', async () => {
    const tail = await readTail(fixture('-work-beta', 5), 600_000);
    expect(tail.model).toBe('claude-invented-huge');
  });

  it('drops the first partial line when the read starts past byte 0', async () => {
    // Leading spaces make the cut-off remainder of the first line still valid JSON,
    // so only the drop rule keeps it out.
    const first = '   ' + JSON.stringify({ type: 'last-prompt', lastPrompt: 'first' });
    const second = JSON.stringify({ type: 'assistant', message: { model: 'm', content: [] } });
    const dir = await tempDir('ac-tail-');
    const file = path.join(dir, 't.jsonl');
    await fs.writeFile(file, `${first}\n${second}\n`);
    const tail = await readTail(file, first.length - 1 + 1 + second.length + 1);
    expect(tail.lastPrompt).toBeNull();
    expect(tail.model).toBe('m');
  });

  it('shows a prompt without its attached files block', async () => {
    const file = await tempFile([{ type: 'last-prompt', lastPrompt: '@"/Users/me/report.pdf"\n\nSummarise it' }]);
    expect((await readTail(file)).lastPrompt).toBe('Summarise it');
    const only = await tempFile([{ type: 'last-prompt', lastPrompt: '@"/Users/me/report.pdf"' }]);
    expect((await readTail(only)).lastPrompt).toBe('report.pdf');
  });

  it('cuts strings to 2000 chars', async () => {
    const long = 'y'.repeat(5000);
    const file = await tempFile([
      { type: 'last-prompt', lastPrompt: long },
      { type: 'assistant', gitBranch: long, message: { model: long, content: [
        { type: 'text', text: long },
        { type: 'tool_use', id: 't', name: 'Bash', input: { command: long } },
      ] } },
    ]);
    const tail = await readTail(file);
    expect(tail.lastPrompt).toHaveLength(2000);
    expect(tail.lastAnswer).toHaveLength(2000);
    expect(tail.branch).toHaveLength(2000);
    expect(tail.model).toHaveLength(2000);
    expect(tail.pendingTool?.input.command).toHaveLength(2000);
  });

  it('returns all null for a missing file', async () => {
    const tail = await readTail(path.join(PROJECTS, 'missing.jsonl'));
    expect(tail.lastPrompt).toBeNull();
    expect(tail.lastBlock).toBeNull();
  });
});
