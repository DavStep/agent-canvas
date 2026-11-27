import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findProgram } from './which.ts';

let dir: string;
beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'acp-which-')));
  await fs.mkdir(path.join(dir, 'bin'));
  await fs.writeFile(path.join(dir, 'bin', 'agent'), '#!/bin/sh\n', { mode: 0o755 });
  await fs.writeFile(path.join(dir, 'bin', 'plain'), 'not runnable', { mode: 0o644 });
});
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

describe('findProgram', () => {
  it('finds a bare name on PATH, takes an absolute or ~/ path as written, and says null otherwise', async () => {
    const bin = path.join(dir, 'bin');
    expect(await findProgram('agent', `/nope:relative:${bin}`)).toBe(path.join(bin, 'agent'));
    expect(await findProgram('plain', bin)).toBeNull();
    expect(await findProgram('missing', bin)).toBeNull();
    expect(await findProgram(path.join(bin, 'agent'), '')).toBe(path.join(bin, 'agent'));
    expect(await findProgram('~/bin/agent', '', dir)).toBe(path.join(bin, 'agent'));
    expect(await findProgram('bin/agent', bin)).toBeNull();
    expect(await findProgram(bin, '')).toBeNull();
  });
});
