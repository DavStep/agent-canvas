import { describe, expect, it, vi } from 'vitest';
import type { ChatState, ChatUpdate } from '../shared/chat.ts';
import type { Engine } from '../server/engines/engine.ts';
import { ChatHub } from './chats.ts';

const base = (sessionId: string): ChatState => ({
  sessionId, provider: 'codex', owner: 'here', title: '', cwd: '/work/a', items: [], hasOlder: false, turn: 'idle',
  model: null, models: [], mode: 'auto', modes: [], banner: null,
});

function fakeEngine() {
  let emit: ((u: ChatUpdate) => void) | null = null;
  let release: (() => void) | null = null;
  let fail: Error | null = null;
  let hold = false;
  const engine = {
    provider: 'codex',
    open: vi.fn(async (id: string, e: (u: ChatUpdate) => void) => {
      if (hold) await new Promise<void>((r) => (release = r));
      if (fail) throw fail;
      emit = e;
      return base(id);
    }),
    close: vi.fn(),
  } as unknown as Engine & { open: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };
  return {
    engine,
    emit: (u: ChatUpdate) => emit!(u),
    hold: () => { hold = true; },
    release: () => { hold = false; release?.(); },
    fail: (e: Error | null) => { fail = e; },
  };
}

function setup() {
  const fake = fakeEngine();
  const pushed: [string, ChatUpdate][] = [];
  const hub = new ChatHub({
    route: (id) => ({ engine: fake.engine, engineId: id.replace(/^codex:/, '') }),
    push: (id, u) => pushed.push([id, u]),
    title: (id) => (id === 'codex:t1' ? 'Card name' : ''),
  });
  return { hub, pushed, ...fake };
}

describe('ChatHub', () => {
  it('one engine open per chat id, however many listeners attach; the card id and name are what the page sees', async () => {
    const { hub, engine } = setup();
    const [a, b] = await Promise.all([hub.open('codex:t1'), hub.open('codex:t1')]);
    expect(engine.open).toHaveBeenCalledTimes(1);
    expect(engine.open.mock.calls[0]![0]).toBe('t1');
    expect(a).toMatchObject({ sessionId: 'codex:t1', title: 'Card name' });
    expect(b).toEqual(a);
  });

  it('forwards each update once under the card id, and keeps its own copy current', async () => {
    const { hub, pushed, emit } = setup();
    await hub.open('codex:t1');
    await hub.open('codex:t1');
    const item = { kind: 'notice', id: 'n1', at: 1, level: 'info', text: 'hello' } as const;
    emit({ op: 'upsert', item });
    emit({ op: 'reset', state: { ...base('t1'), title: 'Renamed' } });
    expect(pushed).toEqual([
      ['codex:t1', { op: 'upsert', item }],
      ['codex:t1', { op: 'reset', state: expect.objectContaining({ sessionId: 'codex:t1', title: 'Renamed' }) }],
    ]);
    expect(hub.state('codex:t1')).toMatchObject({ sessionId: 'codex:t1', title: 'Renamed' });
    // A later listener opens onto the current state.
    expect(await hub.open('codex:t1')).toMatchObject({ title: 'Renamed' });
  });

  it('closes the engine chat on the last closeChat only', async () => {
    const { hub, engine } = setup();
    await hub.open('codex:t1');
    await hub.open('codex:t1');
    hub.close('codex:t1');
    expect(engine.close).not.toHaveBeenCalled();
    hub.close('codex:t1');
    expect(engine.close.mock.calls).toEqual([['t1']]);
    hub.close('codex:t1');
    expect(engine.close).toHaveBeenCalledTimes(1);
    expect(hub.state('codex:t1')).toBeNull();
  });

  it('a close that arrives while the open is under way closes once it has opened', async () => {
    const { hub, engine, hold, release } = setup();
    hold();
    const opening = hub.open('codex:t1');
    hub.close('codex:t1');
    release();
    await opening;
    await new Promise((r) => setImmediate(r));
    expect(engine.close.mock.calls).toEqual([['t1']]);
  });

  it('a failed open leaves nothing behind, so the next open tries again', async () => {
    const { hub, engine, fail } = setup();
    fail(new Error('Codex not found'));
    await expect(hub.open('codex:t1')).rejects.toThrow('Codex not found');
    fail(null);
    await expect(hub.open('codex:t1')).resolves.toMatchObject({ sessionId: 'codex:t1' });
    expect(engine.open).toHaveBeenCalledTimes(2);
  });

  it('closeAll (the page reloaded) closes every open chat', async () => {
    const { hub, engine } = setup();
    await hub.open('codex:t1');
    await hub.open('codex:t1');
    await hub.open('codex:t2');
    hub.closeAll();
    expect(engine.close.mock.calls.sort()).toEqual([['t1'], ['t2']]);
  });
});
