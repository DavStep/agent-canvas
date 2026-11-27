import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { session } from '../../web/src/testSession.ts';
import { projectProfile, ProjectHandoffs } from './project.ts';
import { AttachmentStore } from './taskAttachments.ts';
import type { CanvasApi } from './tools.ts';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-project-'));
const store = new AttachmentStore(path.join(tmp, 'attachments'));

function setup() {
  const roots = ['/work/a', '/linked/a'];
  const actions = {
    folders: async () => roots,
    sessions: () => [
      session({ id: 'manual', cwd: roots[1]!, lastPrompt: 'Update the parser' }),
      session({ id: 'other', cwd: '/different/a' }),
      session({ id: 'self', cwd: roots[0]! }),
      session({ id: 'busy', state: 'working' }),
      session({ id: 'blocked', state: 'needs_you', need: 'permission' }),
      session({ id: 'foreign', owner: 'elsewhere' }),
    ],
    isOrchestrator: (id: string) => id === 'self',
    options: vi.fn(), create: vi.fn().mockResolvedValue('new'), send: vi.fn(), rename: vi.fn(),
    attachments: (paths: string[]) => store.keep(paths),
  };
  const profile = projectProfile({ connection: 'claude-api', folder: roots[0]! }, actions);
  const call = (name: string, args = {}) => profile.tools.find(t => t.name === name)!.handler({} as CanvasApi, args);
  return { actions, call };
}

describe('project orchestration', () => {
  it('includes manual chats in linked checkouts and excludes other projects and orchestrators', async () => {
    const { call } = setup();
    const list = JSON.parse((await call('project_chats')).text);
    expect(list.map((s: { id: string }) => s.id)).toEqual(['manual', 'busy', 'blocked', 'foreign']);
    expect(list[0]).toMatchObject({ lastPrompt: 'Update the parser', cwd: '/linked/a' });
  });

  it('reuses and names available chats and refuses busy, foreign and out-of-project targets', async () => {
    const { call, actions } = setup();
    for (const id of ['busy', 'blocked', 'foreign', 'other', 'self']) {
      expect((await call('continue_chat', { id, prompt: 'Review parser coverage' })).isError).toBe(true);
    }
    expect(actions.send).not.toHaveBeenCalled();
    await call('continue_chat', { id: 'manual', prompt: 'Review parser coverage' });
    expect(actions.send).toHaveBeenCalledWith('manual', 'Review parser coverage', []);
    await call('name_chat', { id: 'manual', title: 'Parser review' });
    expect((await call('name_chat', { id: 'other', title: 'Wrong project' })).isError).toBe(true);
    expect(actions.rename.mock.calls).toEqual([['manual', 'Parser review']]);
  });

  it('passes a chosen model and effort to a named worker in the requested checkout', async () => {
    const { call, actions } = setup();
    const args = { provider: 'codex', title: 'Parser review', prompt: 'Review the parser', model: 'example', effort: 'high' };
    expect((await call('create_chat', { ...args, folder: '/different/a' })).isError).toBe(true);
    await call('create_chat', { ...args, folder: '/linked/a' });
    expect(actions.create.mock.calls).toEqual([[{ cwd: '/linked/a', provider: 'codex', text: args.prompt,
      model: 'example', effort: 'high', mode: null, images: [] }, args.title]]);
  });

  it('forwards attachments to the worker it creates: images as images, files as file mentions', async () => {
    const { call, actions } = setup();
    const [shot, notes] = await store.keep([path.join(tmp, 'shot.png'), path.join(tmp, 'notes.md')].map((p, i) => {
      fs.writeFileSync(p, i === 0 ? PNG : '# Notes');
      return p;
    }));
    const image = { mime: 'image/png', dataUrl: `data:image/png;base64,${PNG.toString('base64')}` };
    const args = { title: 'Header fix', prompt: 'Fix the header', attachments: [shot!.path, notes!.path] };
    await call('create_chat', { ...args, provider: 'claude' });
    expect(actions.create.mock.calls[0]![0]).toMatchObject({ provider: 'claude', text: `@"${notes!.path}"\n\nFix the header`, images: [image] });
    await call('create_chat', { ...args, provider: 'codex' });
    expect(actions.create.mock.calls[1]![0].text).toContain(`## notes.md: ${notes!.path}`);
    expect(actions.create.mock.calls[1]![0].images).toEqual([image]);
    // Kept copies are used as they are, not copied again.
    expect(fs.readdirSync(store.root)).toHaveLength(1);
  });

  it('forwards attachments when it continues a worker, and refuses a missing one before sending', async () => {
    const { call, actions } = setup();
    const [shot] = await store.keep([path.join(tmp, 'again.png')].map(p => { fs.writeFileSync(p, PNG); return p; }));
    await call('continue_chat', { id: 'manual', prompt: 'And the footer', attachments: [shot!.path] });
    expect(actions.send).toHaveBeenCalledWith('manual', 'And the footer', [{ mime: 'image/png', dataUrl: `data:image/png;base64,${PNG.toString('base64')}` }]);
    const r = await call('continue_chat', { id: 'manual', prompt: 'More', attachments: ['/gone/1.png'] });
    expect(r).toMatchObject({ isError: true, text: expect.stringContaining('The attachment /gone/1.png does not exist') });
    expect(actions.send).toHaveBeenCalledTimes(1);
  });

  it('tells the orchestrator to hand attachments on', () => {
    const { prompt } = projectProfile({ connection: 'claude-api', folder: '/work/a' }, {} as never);
    expect(prompt).toMatch(/attachments.*create_chat or continue_chat/);
  });

  it('serializes same-project handoffs and recovers from a failure while other projects proceed', async () => {
    const handoffs = new ProjectHandoffs();
    const events: string[] = [];
    let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    const first = handoffs.dispatch('a', async () => { events.push('first'); await wait; throw new Error('failed'); });
    const next = handoffs.dispatch('a', async () => { events.push('second'); return 'a'; });
    await handoffs.dispatch('b', async () => { events.push('independent'); return 'b'; });
    expect(events).toEqual(['first', 'independent']);
    release();
    await expect(first).rejects.toThrow('failed');
    await expect(next).resolves.toBe('a');
    expect(events.at(-1)).toBe('second');
  });
});
