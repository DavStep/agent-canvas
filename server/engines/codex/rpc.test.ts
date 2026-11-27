import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import readline from 'node:readline';
import { describe, expect, it } from 'vitest';
import { RpcClient, RpcError, RpcTimeoutError } from './rpc.ts';

/** A child process made of two pipes; `sent` collects what the client wrote. */
function pipes() {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough() });
  const sent: any[] = [];
  readline.createInterface({ input: child.stdin }).on('line', (l) => sent.push(JSON.parse(l)));
  const server = (msg: unknown) => child.stdout.write(`${JSON.stringify(msg)}\n`);
  const next = () => new Promise((r) => setImmediate(r));
  return { child, sent, server, next };
}

describe('RpcClient', () => {
  it("a request with no answer within the timeout fails with \"Codex didn't answer\"; others still work, and a late answer is ignored", async () => {
    const { child, server, next } = pipes();
    const health: boolean[] = [];
    const rpc = new RpcClient(child, { timeoutMs: 20 });
    rpc.onHealth((answering) => health.push(answering));
    const hung = rpc.request('thread/read', {});
    const err = await hung.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RpcTimeoutError);
    expect((err as Error).message).toBe("Codex didn't answer");
    expect(health).toEqual([false]);
    server({ id: 1, result: { late: true } }); // ignored
    const ok = rpc.request('model/list', {});
    await next();
    server({ id: 2, result: { data: [] } });
    await expect(ok).resolves.toEqual({ data: [] });
    expect(health).toEqual([false, true]);
    expect(rpc.closed).toBe(false);
  });

  it('a request may opt out of the timeout', async () => {
    const { child, server, next } = pipes();
    const rpc = new RpcClient(child, { timeoutMs: 10 });
    const slow = rpc.request('turn/start', {}, { timeoutMs: null });
    await new Promise((r) => setTimeout(r, 30));
    server({ id: 1, result: { ok: 1 } });
    await next();
    await expect(slow).resolves.toEqual({ ok: 1 });
  });

  it('matches responses to requests by id', async () => {
    const { child, sent, server, next } = pipes();
    const rpc = new RpcClient(child);
    const a = rpc.request('model/list', {});
    const b = rpc.request('account/read', { refreshToken: false });
    await next();
    expect(sent).toEqual([
      { id: 1, method: 'model/list', params: {} },
      { id: 2, method: 'account/read', params: { refreshToken: false } },
    ]);
    expect(sent.every((m) => !('jsonrpc' in m))).toBe(true);
    server({ id: 2, result: { account: null } });
    server({ id: 1, error: { code: -32600, message: 'nope' } });
    await expect(b).resolves.toEqual({ account: null });
    const err = await a.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RpcError);
    expect(err).toMatchObject({ code: -32600, message: 'nope' });
  });

  it('routes server requests to handlers and replies with their result', async () => {
    const { child, sent, server, next } = pipes();
    const rpc = new RpcClient(child);
    const seen: unknown[] = [];
    rpc.onNotification('turn/started', (p) => seen.push(p));
    rpc.onRequest('item/commandExecution/requestApproval', async (p: any) => ({ decision: p.command === 'ls' ? 'accept' : 'decline' }));
    server({ method: 'turn/started', params: { turn: { id: 't' } } });
    server({ id: 0, method: 'item/commandExecution/requestApproval', params: { command: 'ls' } });
    server({ id: 7, method: 'item/tool/call', params: {} });
    await next();
    await next();
    expect(seen).toEqual([{ turn: { id: 't' } }]);
    expect(sent).toContainEqual({ id: 0, result: { decision: 'accept' } });
    expect(sent).toContainEqual({ id: 7, error: { code: -32601, message: 'Agent canvas does not handle item/tool/call' } });
  });

  it('rejects all pending requests when the child exits', async () => {
    const { child } = pipes();
    const rpc = new RpcClient(child);
    let closed = 0;
    rpc.onClose(() => closed++);
    const a = rpc.request('thread/read', {});
    const b = rpc.request('turn/start', {});
    child.emit('exit', 1, null);
    await expect(a).rejects.toThrow('codex app-server exited');
    await expect(b).rejects.toThrow('codex app-server exited');
    await expect(rpc.request('model/list', {})).rejects.toThrow('codex app-server exited');
    expect(rpc.closed).toBe(true);
    expect(closed).toBe(1);
  });

  it('skips a non-JSON line and keeps reading', async () => {
    const { child, server } = pipes();
    const rpc = new RpcClient(child);
    const a = rpc.request('model/list', {});
    child.stdout.write('WARN something on stdout\n');
    server({ id: 1, result: { data: [] } });
    await expect(a).resolves.toEqual({ data: [] });
  });
});
