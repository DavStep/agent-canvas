import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readSubagents } from './subagents.ts';

const ALPHA = path.resolve(import.meta.dirname, '../../fixtures/projects/-work-alpha');
const SID = 'aaaaaaaa-0000-4000-8000-000000000001';
const T0 = 1_790_000_000_000;

/** Copies the fixture project folder and sets every file's mtime to T0. */
async function copy(): Promise<{ transcript: string; subDir: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ac-sub-'));
  await fs.cp(ALPHA, dir, { recursive: true });
  const subDir = path.join(dir, SID, 'subagents');
  for (const f of await fs.readdir(subDir)) await touch(path.join(subDir, f), T0);
  return { transcript: path.join(dir, `${SID}.jsonl`), subDir };
}

const touch = (file: string, ms: number) => fs.utimes(file, ms / 1000, ms / 1000);

describe('readSubagents', () => {
  it('maps meta files to views: finished is done, otherwise working', async () => {
    const { transcript } = await copy();
    const views = await readSubagents(transcript, SID, T0);
    expect(views).toHaveLength(2);
    expect(views).toContainEqual({ id: 'a0000000000000001', type: 'Explore', description: 'Find invented parser files', state: 'done' });
    expect(views).toContainEqual({ id: 'a0000000000000002', type: 'general-purpose', description: 'Write invented tests', state: 'working' });
  });

  it('drops agents whose meta and jsonl are both older than since', async () => {
    const { transcript } = await copy();
    expect(await readSubagents(transcript, SID, T0 + 1000)).toEqual([]);
  });

  it('keeps an agent whose jsonl alone was modified at or after since', async () => {
    const { transcript, subDir } = await copy();
    await touch(path.join(subDir, 'agent-a0000000000000002.jsonl'), T0 + 5000);
    const views = await readSubagents(transcript, SID, T0 + 5000);
    expect(views.map((v) => v.id)).toEqual(['a0000000000000002']);
  });

  it('returns at most 6, newest first', async () => {
    const { transcript, subDir } = await copy();
    for (let i = 0; i < 8; i++) {
      const meta = path.join(subDir, `agent-b${i}.meta.json`);
      await fs.writeFile(meta, JSON.stringify({ agentType: 'Explore', description: `Invented ${i}` }));
      await touch(meta, T0 + 10_000 + i * 1000);
    }
    const views = await readSubagents(transcript, SID, T0);
    expect(views.map((v) => v.id)).toEqual(['b7', 'b6', 'b5', 'b4', 'b3', 'b2']);
  });

  it('skips a meta file that fails to parse', async () => {
    const { transcript, subDir } = await copy();
    await fs.writeFile(path.join(subDir, 'agent-torn.meta.json'), '{"agentType":"Ex');
    const views = await readSubagents(transcript, SID, T0);
    expect(views.map((v) => v.id).sort()).toEqual(['a0000000000000001', 'a0000000000000002']);
  });

  it('returns nothing when the session has no subagents folder', async () => {
    const { transcript } = await copy();
    expect(await readSubagents(transcript, 'no-such-session', 0)).toEqual([]);
  });
});
