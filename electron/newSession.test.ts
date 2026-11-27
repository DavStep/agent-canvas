import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SIGNED_OUT_BANNER } from '../server/engines/claude/engine.ts';
import { MISSING_BANNER, NOT_STARTED_BANNER } from '../server/engines/codex/engine.ts';
import { checkStart, folderKind } from './newSession.ts';

let dir: string;
let file: string;
beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ac-newsession-'));
  file = path.join(dir, 'notes.txt');
  await fs.writeFile(file, 'x');
});
afterAll(async () => { await fs.rm(dir, { recursive: true, force: true }); });

describe('checkStart: what main checks before an engine starts a session', () => {
  it('an existing folder and no banner: the start goes ahead', async () => {
    await expect(checkStart(dir, { banner: null })).resolves.toBeUndefined();
  });

  it('a folder that is gone, or a file, is refused with the folder named', async () => {
    const gone = path.join(dir, 'gone');
    await expect(checkStart(gone, { banner: null })).rejects.toThrow(`The folder ${gone} no longer exists`);
    await expect(checkStart(file, { banner: null })).rejects.toThrow(`The folder ${file} no longer exists`);
  });

  it("a provider that cannot start sessions (signed out, Codex missing or not started) is refused with its banner", async () => {
    for (const banner of [SIGNED_OUT_BANNER, MISSING_BANNER, NOT_STARTED_BANNER]) {
      await expect(checkStart(dir, { banner })).rejects.toThrow(banner);
    }
  });

  it("a warning banner does not stop a start", async () => {
    await expect(checkStart(dir, { banner: "Codex didn't answer" }))
      .resolves.toBeUndefined();
  });

  it('the folder is checked first, then the provider', async () => {
    await expect(checkStart(path.join(dir, 'gone'), { banner: SIGNED_OUT_BANNER })).rejects.toThrow(/no longer exists/);
  });

  it('folderKind tells a folder, a file and nothing apart', async () => {
    expect(await folderKind(dir)).toBe('dir');
    expect(await folderKind(file)).toBe('file');
    expect(await folderKind(path.join(dir, 'gone'))).toBe('missing');
  });
});
