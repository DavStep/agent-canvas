import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { childEnv } from '../../../electron/paths.ts';
import type { ApprovalAnswer, ChatItem, ChatState, ChatUpdate } from '../../../shared/chat.ts';
import { applyUpdate } from '../chatLog.ts';
import { ClaudeEngine, SIGNED_OUT_BANNER, type ClaudeEngineOptions } from './engine.ts';
import { BUSY_ELSEWHERE, WRITING_ALONGSIDE } from '../../../shared/banners.ts';
import { claudeHistory } from './history.ts';
import { FakeSdk, NEW_SESSION_ID, SESSION_ID as S, usageWith } from './fakeSdk.ts';
import type { Options, SDKMessage } from './sdk.ts';

// The real reader, watched: a read-only chat must not re-read a transcript that did not change.
vi.mock('./history.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('./history.ts')>();
  return { ...real, claudeHistory: vi.fn(real.claudeHistory) };
});

const NOW = 1795000500000;
const HISTORY = path.resolve(import.meta.dirname, '../../../fixtures/claude/history-basic.jsonl');

const homes: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await Promise.all(homes.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

/** A Claude home holding the fixture transcript (and any extra transcripts) under projects/. */
async function claudeHome(extra: Record<string, string> = {}): Promise<string> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ac-claude-'));
  homes.push(home);
  const dir = path.join(home, 'projects', '-work-demo');
  await fs.mkdir(dir, { recursive: true });
  await fs.copyFile(HISTORY, path.join(dir, `${S}.jsonl`));
  for (const [id, text] of Object.entries(extra)) await fs.writeFile(path.join(dir, `${id}.jsonl`), text);
  return home;
}

/** Waits without timers, so tests that fake setTimeout still make progress. */
const tick = () => new Promise((r) => setImmediate(r));

async function setup(opts: {
  agentKey?: ClaudeEngineOptions['agentKey']; idleMs?: number; extra?: Record<string, string>; configure?: (sdk: FakeSdk) => void; elsewhere?: (id: string) => boolean; env?: Record<string, string>;
  foreignFile?: (id: string) => Promise<boolean>; workingElsewhere?: (id: string) => boolean; extras?: (cwd: string) => Partial<Options> | null;
  projectFor?: ClaudeEngineOptions['projectFor'];
} = {}) {
  const sdk = new FakeSdk();
  opts.configure?.(sdk);
  const home = await claudeHome(opts.extra);
  const engine = new ClaudeEngine({
    sdk, agentKey: opts.agentKey, now: () => NOW, claudeHome: home, ...(opts.idleMs ? { idleMs: opts.idleMs } : {}), ...(opts.elsewhere ? { elsewhere: opts.elsewhere } : {}),
    ...(opts.env ? { env: opts.env } : {}), ...(opts.foreignFile ? { foreignFile: opts.foreignFile } : {}),
    ...(opts.workingElsewhere ? { workingElsewhere: opts.workingElsewhere } : {}), ...(opts.extras ? { extras: opts.extras } : {}),
    ...(opts.projectFor ? { projectFor: opts.projectFor } : {}),
  });
  const updates: ChatUpdate[] = [];
  let state: ChatState | null = null;
  const open = async (id = S): Promise<ChatState> => {
    state = await engine.open(id, (u) => {
      updates.push(u);
      if (state) state = applyUpdate(state, u);
    });
    return state;
  };
  const current = (): ChatState => {
    if (!state) throw new Error('chat not open');
    return state;
  };
  const item = <K extends ChatItem['kind']>(kind: K, pred: (i: Extract<ChatItem, { kind: K }>) => boolean = () => true) =>
    current().items.find((i): i is Extract<ChatItem, { kind: K }> => i.kind === kind && pred(i as Extract<ChatItem, { kind: K }>));
  const until = async (cond: () => unknown, what = 'condition'): Promise<void> => {
    for (let n = 0; n < 2000; n++) {
      if (cond()) return;
      await tick();
    }
    throw new Error(`timed out waiting for ${what}`);
  };
  return { sdk, engine, home, updates, open, current, item, until };
}

const BASH_INPUT = { command: 'npm test', description: 'Run the tests' };
const SUGGESTIONS = [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }], behavior: 'allow', destination: 'localSettings' }];

describe('ClaudeEngine', () => {
  it('open() of a session not running here → history, owner nobody, turn idle', async () => {
    const { engine, open } = await setup();
    const state = await open();
    expect(state).toMatchObject({ sessionId: S, provider: 'claude', owner: 'nobody', turn: 'idle', cwd: '/work/demo', mode: 'auto', hasOlder: false, banner: null });
    expect(state.modes.map((m) => m.id)).toEqual(['auto', 'default', 'acceptEdits', 'plan', 'bypassPermissions']);
    expect(state.items.map((i) => i.id)).toEqual(expect.arrayContaining(['msg_demo01', 'toolu_demo01', 'msg_demo05']));
    expect(engine.owned().size).toBe(0);
  });

  it("the environment main built (the login shell's PATH and the allowlist) is what Claude Code gets", async () => {
    const env = { PATH: '/opt/homebrew/bin:/h/.nvm/bin:/usr/bin', HOME: '/h', SSH_AUTH_SOCK: '/tmp/agent.sock' };
    const { sdk, engine, open } = await setup({ env });
    await open();
    await engine.send(S, 'hi', []);
    expect(sdk.last.options.env).toEqual(env);
  });

  it('a resumed session (Continue on an interrupted one) keeps the exact model it ran on, unless one is picked here', async () => {
    const { sdk, engine, open } = await setup();
    await open();
    await engine.send(S, 'Your previous turn was interrupted (a usage limit). Continue where you left off.', []);
    expect(sdk.last.options.model).toBe('claude-demo-1');
  });

  it('query options: includePartialMessages, claude_code preset, resume=sessionId, env allowlisted (no CLAUDE_CODE_*, no ANTHROPIC_*)', async () => {
    vi.stubEnv('CLAUDE_CODE_ENTRYPOINT', 'claude-desktop');
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'host-token');
    vi.stubEnv('ANTHROPIC_BASE_URL', 'http://127.0.0.1:1/proxy');
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-host');
    const { sdk, engine, open, current, item } = await setup();
    await open();
    await engine.send(S, 'hi', []);
    const { options } = sdk.last;
    expect(options).toMatchObject({
      includePartialMessages: true, systemPrompt: { type: 'preset', preset: 'claude_code' }, resume: S, cwd: '/work/demo',
    });
    // No mode picked and none in the transcript: Auto, never none (Claude Code's own default asks).
    expect(options.permissionMode).toBe('auto');
    expect(options.allowDangerouslySkipPermissions).toBeUndefined();
    expect(options.settingSources).toBeUndefined();
    expect(options.canUseTool).toEqual(expect.any(Function));
    expect(options.env).toEqual(childEnv(process.env));
    expect(Object.keys(options.env ?? {}).filter((k) => k.startsWith('CLAUDE_CODE_') || k.startsWith('ANTHROPIC_'))).toEqual([]);

    const user = item('user', (u) => u.text === 'hi');
    expect(user).toBeTruthy();
    await new Promise((r) => setImmediate(r));
    expect(sdk.last.prompts).toEqual([{ type: 'user', message: { role: 'user', content: 'hi' }, parent_tool_use_id: null, uuid: user!.id, session_id: S }]);
    expect(current()).toMatchObject({ owner: 'here', turn: 'running' });
    expect(engine.owned()).toEqual(new Set([S]));
    expect(engine.busy()).toEqual([{ sessionId: S, reason: 'turn' }]);
  });

  it('streams a turn, then goes idle', async () => {
    const { sdk, engine, open, current, item, until, updates } = await setup();
    await open();
    await engine.send(S, 'Say hello', []);
    await sdk.last.replay('stream-text.json');
    await until(() => current().turn === 'idle', 'turn idle');
    expect(updates).toContainEqual({ op: 'append', id: 'msg_live01', field: 'text', chunk: 'Hel' });
    expect(item('assistant', (a) => a.id === 'msg_live01')).toMatchObject({ text: 'Hello', streaming: false });
    expect(current().model).toBe('claude-demo-large');
    expect(current().models).toEqual([
      { id: 'default', label: 'Default (recommended)', isDefault: true, efforts: [] },
      { id: 'opus', label: 'Opus', isDefault: false, efforts: ['low', 'high', 'max'] },
    ]);
    expect(engine.busy()).toEqual([]);
  });

  it('images go as base64 image blocks before the text', async () => {
    const { sdk, engine, open } = await setup();
    await open();
    await engine.send(S, 'Like this', [{ mime: 'image/png', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' }]);
    await new Promise((r) => setImmediate(r));
    expect(sdk.last.prompts[0]?.message.content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } },
      { type: 'text', text: 'Like this' },
    ]);
  });

  it('a message sent mid-turn is queued on the same query and shown at once', async () => {
    const { sdk, engine, open, item } = await setup();
    await open();
    await engine.send(S, 'first', []);
    await engine.send(S, 'second', []);
    expect(item('user', (u) => u.text === 'second')).toBeTruthy();
    await new Promise((r) => setImmediate(r));
    expect(sdk.queries).toHaveLength(1);
    expect(sdk.last.prompts.map((p) => p.message.content)).toEqual(['first', 'second']);
  });

  it('ExitPlanMode asks with the whole plan; after approval the mode picker follows Claude Code out of plan mode', async () => {
    const plan = `# Plan\n\n${'A long step of the plan. '.repeat(40)}\n\n- the last step`;
    const { sdk, engine, open, current, item, until } = await setup();
    await open();
    await engine.setMode(S, 'plan');
    await engine.send(S, 'Plan it', []);
    const asked = sdk.last.ask('ExitPlanMode', { plan }, { toolUseID: 'toolu_plan', suggestions: [] });
    await until(() => item('approval'), 'approval');
    expect(item('approval')).toMatchObject({ title: 'Approve this plan?', detail: plan, status: 'pending' });
    await engine.answerApproval(S, item('approval')!.id, 'allow');
    await asked;
    sdk.last.emit({ type: 'system', subtype: 'status', status: null, permissionMode: 'default', uuid: 'st-1', session_id: S } as unknown as SDKMessage);
    await until(() => current().mode === 'default', 'mode follows');
  });

  describe('canUseTool for Bash → approval item pending and tool waiting', () => {
    it.each<[ApprovalAnswer, unknown, string, string]>([
      ['allow', { behavior: 'allow', updatedInput: BASH_INPUT }, 'allowed', 'running'],
      ['allowAlways', { behavior: 'allow', updatedInput: BASH_INPUT, updatedPermissions: SUGGESTIONS }, 'allowedAlways', 'running'],
      ['deny', { behavior: 'deny', message: 'Denied in Agent canvas' }, 'denied', 'denied'],
    ])('answering %s resolves %j', async (answer, result, status, toolStatus) => {
      const { sdk, engine, open, current, item, until } = await setup();
      await open();
      await engine.send(S, 'Run the tests', []);
      const played = sdk.last.replay('stream-tool.json', (e) => (answer === 'deny' && !('fake' in e) && e.type === 'user'
        ? { ...e, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_live01', content: "The user doesn't want to proceed with this tool use.", is_error: true }] } } as SDKMessage
        : e));
      await until(() => item('approval'), 'approval');
      expect(item('approval')).toMatchObject({
        status: 'pending', toolItemId: 'toolu_live01', title: 'Claude wants to run npm test', detail: 'npm test\n\nRun the tests',
        alwaysLabel: "this project's local settings",
      });
      expect(item('tool', (t) => t.id === 'toolu_live01')?.status).toBe('waiting');
      expect(engine.busy()).toEqual([{ sessionId: S, reason: 'approval' }]);

      await engine.answerApproval(S, item('approval')!.id, answer);
      expect(item('approval')?.status).toBe(status);
      expect(item('tool', (t) => t.id === 'toolu_live01')?.status).toBe(toolStatus);
      await played;
      expect(sdk.last.permissions.map((p) => p.result)).toEqual([result]);
      await until(() => current().turn === 'idle', 'turn idle');
      expect(item('tool', (t) => t.id === 'toolu_live01')?.status).toBe(answer === 'deny' ? 'denied' : 'done');
      expect(engine.busy()).toEqual([]);
      await expect(engine.answerApproval(S, item('approval')!.id, 'allow')).rejects.toThrow();
    });

    it.each([
      ['projectSettings', "this project's shared settings"],
      ['userSettings', 'your user settings'],
      ['session', 'this session'],
    ])('alwaysLabel names the destination (%s → %s)', async (destination, label) => {
      const { sdk, engine, open, item, until } = await setup();
      await open();
      await engine.send(S, 'Run', []);
      void sdk.last.ask('Bash', BASH_INPUT, { toolUseID: 'toolu_x', suggestions: [{ ...SUGGESTIONS[0], destination }] });
      await until(() => item('approval'), 'approval');
      expect(item('approval')?.alwaysLabel).toBe(label);
    });

    it('no suggestions → no "Always allow"; allowAlways is refused', async () => {
      const { sdk, engine, open, item, until } = await setup();
      await open();
      await engine.send(S, 'Run', []);
      void sdk.last.ask('Bash', BASH_INPUT, { toolUseID: 'toolu_x' });
      await until(() => item('approval'), 'approval');
      expect(item('approval')).toMatchObject({ alwaysLabel: null, title: 'Allow this command?' });
      await expect(engine.answerApproval(S, item('approval')!.id, 'allowAlways')).rejects.toThrow(/Always allow/);
      expect(item('approval')?.status).toBe('pending');
    });
  });

  it('AskUserQuestion → question item; answer resolves updatedInput {questions, answers}', async () => {
    const { sdk, engine, open, current, item, until } = await setup();
    await open();
    await engine.send(S, 'Pick a colour', []);
    const played = sdk.last.replay('stream-question.json');
    await until(() => item('question'), 'question');
    expect(engine.busy()).toEqual([{ sessionId: S, reason: 'question' }]);
    expect(item('question')).toMatchObject({
      status: 'pending', answers: null,
      questions: [{
        id: 'Which colour?', header: 'Colour', text: 'Which colour?', multiSelect: false, allowOther: true,
        options: [{ label: 'Blue', description: 'Calm' }, { label: 'Red', description: 'Loud' }],
      }],
    });
    expect(current().items.some((i) => i.kind === 'approval')).toBe(false);
    // Its call waits on the owner while the question is open, and settles once answered.
    expect(item('tool', (t) => t.id === 'toolu_live02')).toMatchObject({ name: 'AskUserQuestion', status: 'waiting' });
    await engine.answerQuestion(S, item('question')!.id, { 'Which colour?': 'Blue' });
    expect(item('tool', (t) => t.id === 'toolu_live02')).toMatchObject({ status: 'running' });
    await played;
    expect(item('tool', (t) => t.id === 'toolu_live02')).toMatchObject({ status: 'done' });
    const questions = (sdk.last.permissions[0]?.result as { updatedInput?: { questions?: unknown } }).updatedInput?.questions;
    expect(sdk.last.permissions.map((p) => p.result)).toEqual([
      { behavior: 'allow', updatedInput: { questions, answers: { 'Which colour?': 'Blue' } } },
    ]);
    expect(questions).toEqual([expect.objectContaining({ question: 'Which colour?' })]);
    expect(item('question')).toMatchObject({ status: 'answered', answers: { 'Which colour?': 'Blue' } });
  });

  it('interrupt calls query.interrupt()', async () => {
    const { sdk, engine, open } = await setup();
    await open();
    await engine.send(S, 'Long job', []);
    await engine.interrupt(S);
    expect(sdk.last.calls).toContainEqual(['interrupt']);
  });

  it('setModel / setMode call query.setModel / setPermissionMode', async () => {
    const { sdk, engine, open, current } = await setup();
    await open();
    await engine.send(S, 'hi', []);
    await engine.setModel(S, 'opus');
    await engine.setMode(S, 'plan');
    expect(sdk.last.calls).toEqual(expect.arrayContaining([['setModel', 'opus'], ['setPermissionMode', 'plan']]));
    expect(current()).toMatchObject({ model: 'opus', mode: 'plan' });
    await expect(engine.setMode(S, 'dontAsk')).rejects.toThrow(/Unknown Claude permission mode/);
  });

  it('setModel / setMode with no query running → the next query starts with them', async () => {
    const { sdk, engine, open } = await setup();
    await open();
    await engine.setModel(S, 'opus');
    await engine.setMode(S, 'bypassPermissions');
    expect(sdk.queries).toHaveLength(0);
    await engine.send(S, 'go', []);
    expect(sdk.last.options).toMatchObject({ model: 'opus', permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true });
  });

  it('resumes the same chat with an exact profile that overrides retained subagent aliases', async () => {
    const { sdk, engine, open } = await setup();
    await open();
    await engine.setModelProfile(S, 'claude-opus-5-5', 'high');
    await engine.send(S, 'Continue', []);
    expect(sdk.last.options).toMatchObject({
      resume: S,
      model: 'claude-opus-5-5',
      effort: 'high',
      env: {
        CLAUDE_CODE_SUBAGENT_MODEL: 'claude-opus-5-5',
        CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1',
        CLAUDE_CODE_EFFORT_LEVEL: 'high',
      },
    });
  });

  it('idle 10 min with no turn and no chat use → query closed; next send resumes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { sdk, engine, open, current, until } = await setup();
    await open();
    await engine.send(S, 'Say hello', []);
    await sdk.last.replay('stream-text.json');
    await until(() => current().turn === 'idle', 'turn idle');
    vi.advanceTimersByTime(9 * 60_000);
    await engine.setMode(S, 'acceptEdits'); // chat use: the 10 minutes start again
    vi.advanceTimersByTime(9 * 60_000);
    await tick();
    expect(sdk.last.closed).toBe(false);
    vi.advanceTimersByTime(60_000 + 1);
    await until(() => current().owner === 'nobody', 'owner nobody');
    expect(sdk.last.closed).toBe(true);
    expect(engine.owned().size).toBe(0);
    expect(current().items.some((i) => i.kind === 'notice')).toBe(false);

    await engine.send(S, 'Again', []);
    expect(sdk.queries).toHaveLength(2);
    expect(sdk.last.options).toMatchObject({ resume: S, permissionMode: 'acceptEdits' });
    expect(current()).toMatchObject({ owner: 'here', turn: 'running' });
  });

  it('a message sent while an idle close is under way starts a new process and is not lost', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { sdk, engine, open, current, until } = await setup({ configure: (s) => { s.slowClose = true; } });
    await open();
    await engine.send(S, 'Say hello', []);
    const first = sdk.last;
    await first.replay('stream-text.json');
    await until(() => current().turn === 'idle', 'turn idle');
    vi.advanceTimersByTime(600_000 + 1);
    expect(first.closed).toBe(true); // closing: its messages have not ended yet

    await engine.send(S, 'Still there?', []);
    expect(sdk.queries).toHaveLength(2);
    expect(sdk.last.options.resume).toBe(S);
    for (let n = 0; n < 10; n++) await tick();
    expect(sdk.last.prompts.map((p) => p.message.content)).toEqual(['Still there?']);
    expect(first.prompts.map((p) => p.message.content)).toEqual(['Say hello']);
    // The old process ending later changes nothing for the new one.
    expect(current()).toMatchObject({ owner: 'here', turn: 'running' });
    expect(engine.owned()).toEqual(new Set([S]));
  });

  it('a turn that starts after a result with nothing queued runs again: Stop works and no idle close', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { sdk, engine, open, current, item, until } = await setup();
    await open();
    await engine.send(S, 'Say hello', []);
    await sdk.last.replay('stream-text.json');
    await until(() => current().turn === 'idle', 'turn idle');
    // A background task finishing starts a turn the result did not count as queued.
    const ev = (event: object, n: number) => ({ type: 'stream_event', parent_tool_use_id: null, uuid: `bg-${n}`, session_id: S, event }) as SDKMessage;
    sdk.last.emit(ev({ type: 'message_start', message: { id: 'msg_bg', content: [] } }, 1));
    sdk.last.emit(ev({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, 2));
    sdk.last.emit(ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Background done' } }, 3));
    await until(() => current().turn === 'running', 'turn running again');
    expect(item('assistant', (a) => a.id === 'msg_bg')).toMatchObject({ text: 'Background done', streaming: true });
    expect(engine.busy()).toEqual([{ sessionId: S, reason: 'turn' }]);
    vi.advanceTimersByTime(60 * 60_000);
    await tick();
    expect(sdk.last.closed).toBe(false);
    await engine.interrupt(S);
    expect(sdk.last.calls).toContainEqual(['interrupt']);
  });

  it('no idle close while a turn runs', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { sdk, engine, open } = await setup();
    await open();
    await engine.send(S, 'Long job', []);
    vi.advanceTimersByTime(60 * 60_000);
    await tick();
    expect(sdk.last.closed).toBe(false);
  });

  it('SDK child crash → error notice, approvals expired, next send starts a new query', async () => {
    const { sdk, engine, open, current, item, until } = await setup();
    await open();
    await engine.send(S, 'Run the tests', []);
    const first = sdk.last;
    void first.replay('stream-tool.json');
    await until(() => item('approval'), 'approval');
    first.crash();
    await until(() => current().turn === 'idle', 'turn idle');
    expect(item('approval')?.status).toBe('expired');
    expect(item('tool', (t) => t.id === 'toolu_live01')?.status).toBe('failed');
    expect(item('notice', (n) => n.level === 'error')?.text).toMatch(/Claude Code stopped unexpectedly \(Claude Code process exited with code 1\)/);
    expect(current().owner).toBe('nobody');
    expect(engine.owned().size).toBe(0);
    expect(engine.busy()).toEqual([]);
    await until(() => first.permissions.length === 1, 'canUseTool settled');
    expect(first.permissions[0]?.result).toMatchObject({ behavior: 'deny' });
    await expect(engine.answerApproval(S, item('approval')!.id, 'allow')).rejects.toThrow();

    await engine.send(S, 'Try again', []);
    expect(sdk.queries).toHaveLength(2);
    expect(sdk.last.options.resume).toBe(S);
    expect(current()).toMatchObject({ owner: 'here', turn: 'running' });
  });

  it('signed out (result api_error "Failed to authenticate") → banner "Claude Code is signed out on this Mac. Run claude, then /login."', async () => {
    const { sdk, engine, open, current, item, until } = await setup();
    await open();
    await engine.send(S, 'hi', []);
    await sdk.last.replay('stream-signed-out.json');
    await until(() => current().turn === 'idle', 'turn idle');
    expect(SIGNED_OUT_BANNER).toBe('Claude Code is signed out on this Mac. Run claude, then /login.');
    expect(current().banner).toBe(SIGNED_OUT_BANNER);
    expect(engine.banner).toBe(SIGNED_OUT_BANNER);
    expect(item('notice', (n) => n.level === 'error')?.text).toMatch(/^Failed to authenticate/);
    expect(current().items.some((i) => i.kind === 'assistant' && i.text.startsWith('Failed'))).toBe(false);
  });

  it('start() runs a query with cwd and returns the new session id from the init message', async () => {
    const { sdk, engine, open } = await setup();
    const id = await engine.start({ provider: 'claude', cwd: '/work/new', model: null, effort: null, mode: 'plan', text: 'Hello', images: [] });
    expect(id).toBe(NEW_SESSION_ID);
    expect(sdk.last.options).toMatchObject({ cwd: '/work/new', permissionMode: 'plan' });
    expect(sdk.last.options.resume).toBeUndefined();
    expect(sdk.last.prompts.map((p) => p.message.content)).toEqual(['Hello']);
    const state = await open(id);
    expect(state).toMatchObject({ sessionId: NEW_SESSION_ID, owner: 'here', turn: 'running', cwd: '/work/new', mode: 'plan', hasOlder: false });
    expect(state.items).toEqual([expect.objectContaining({ kind: 'user', text: 'Hello' })]);
    expect(engine.owned()).toEqual(new Set([NEW_SESSION_ID]));
  });

  it('start() passes the thinking level picked, and none for Auto; an unknown level is refused', async () => {
    const { sdk, engine } = await setup();
    await engine.start({ provider: 'claude', cwd: '/work/new', model: 'opus', effort: 'high', mode: 'plan', text: 'Hello', images: [] });
    expect(sdk.last.options).toMatchObject({ model: 'opus', effort: 'high' });
    await engine.start({ provider: 'claude', cwd: '/work/new', model: null, effort: null, mode: 'plan', text: 'Hello', images: [] });
    expect(sdk.last.options.effort).toBeUndefined();
    await expect(engine.start({ provider: 'claude', cwd: '/work/new', model: null, effort: 'ludicrous', mode: 'plan', text: 'Hi', images: [] }))
      .rejects.toThrow('Unknown Claude thinking level');
  });

  describe("extras: more query options by the session's folder (the canvas agent)", () => {
    const AGENT = '/data/agent';
    const append = { type: 'preset' as const, preset: 'claude_code' as const, append: 'You are the canvas agent.' };
    const asked: string[] = [];
    let built = 0;
    const extras = (cwd: string): Partial<Options> | null => {
      asked.push(cwd);
      if (cwd !== AGENT) return null;
      return {
        mcpServers: { canvas: { type: 'http', url: `http://127.0.0.1/${++built}` } }, allowedTools: ['mcp__canvas__create_zone'], systemPrompt: append,
        permissionMode: 'default',
        // What the engine sets itself is never replaced.
        cwd: '/somewhere/else', canUseTool: async () => ({ behavior: 'allow' }), env: { LEAK: '1' },
      };
    };
    const record = (id: string, cwd: string) => `${JSON.stringify({ type: 'user', uuid: `u-${id}`, sessionId: id, cwd, timestamp: '2026-11-20T10:00:00.000Z', message: { role: 'user', content: 'What is going on?' } })}\n`;

    it('uses the API key for a keyed agent on start and resume, and keeps it out of other sessions', async () => {
      const cwd = AGENT + '/claude-api';
      const read = vi.fn().mockResolvedValue('test-key');
      const A = 'bbbbbbbb-0000-4000-8000-0000000000a9';
      const { sdk, engine, open } = await setup({ agentKey: { cwd, read }, extra: { [A]: record(A, cwd) } });
      const req = { provider: 'claude' as const, cwd, model: null, effort: null, mode: 'default', text: 'Hello', images: [] };
      try {
        await engine.start(req);
        expect(sdk.last.options.env?.ANTHROPIC_API_KEY).toBe('test-key');
        const state = await open(A);
        expect(state.apiKeyAuth).toBe(true);
        await engine.send(A, 'Again', []);
        expect(sdk.last.options).toMatchObject({ resume: A, env: { ANTHROPIC_API_KEY: 'test-key' } });
        await engine.start({ ...req, cwd: AGENT });
        expect(sdk.last.options.env).not.toHaveProperty('ANTHROPIC_API_KEY');
        expect(read).toHaveBeenCalledTimes(2);
        read.mockResolvedValue('');
        await expect(engine.start(req)).rejects.toThrow('API key');
      } finally { await engine.stop(); }
    });

    it('a new session in the agent folder starts with them; one anywhere else does not', async () => {
      asked.length = 0;
      const { sdk, engine } = await setup({ extras });
      await engine.start({ provider: 'claude', cwd: AGENT, model: null, effort: null, mode: 'default', text: 'What is going on?', images: [] });
      const o = sdk.last.options;
      expect(o).toMatchObject({ cwd: AGENT, permissionMode: 'default', allowedTools: ['mcp__canvas__create_zone'], systemPrompt: append, includePartialMessages: true });
      expect(o.mcpServers).toEqual({ canvas: { type: 'http', url: 'http://127.0.0.1/1' } });
      expect(o.env).not.toHaveProperty('LEAK');
      // Approvals still come to the engine: its own canUseTool, not the one the extras named.
      void sdk.last.ask('mcp__canvas__start_task', { folder: '/work/alpha', prompt: 'Go' });
      await tick();
      expect(engine.busy()).toEqual([{ sessionId: NEW_SESSION_ID, reason: 'approval' }]);

      await engine.start({ provider: 'claude', cwd: '/work/new', model: null, effort: null, mode: 'plan', text: 'Hello', images: [] });
      expect(sdk.last.options.mcpServers).toBeUndefined();
      expect(sdk.last.options.allowedTools).toBeUndefined();
      expect(sdk.last.options.systemPrompt).toEqual({ type: 'preset', preset: 'claude_code' });
      expect(sdk.last.options.permissionMode).toBe('plan');
      expect(asked).toEqual([AGENT, '/work/new']);
    });

    it('a resume of an agent session gets them again, built anew; a resume elsewhere does not', async () => {
      asked.length = 0;
      const A = 'bbbbbbbb-0000-4000-8000-0000000000a9';
      const { sdk, engine, open } = await setup({ extras, extra: { [A]: record(A, AGENT) } });
      const before = built;
      await engine.open(A, () => {});
      await engine.send(A, 'And now?', []);
      expect(sdk.last.options).toMatchObject({ cwd: AGENT, resume: A, allowedTools: ['mcp__canvas__create_zone'], systemPrompt: append });
      expect(sdk.last.options.mcpServers).toEqual({ canvas: { type: 'http', url: `http://127.0.0.1/${before + 1}` } });
      // No mode is recorded in that transcript: Auto is passed, and wins over the extras' own.
      expect(sdk.last.options.permissionMode).toBe('auto');

      await open();
      await engine.send(S, 'hi', []);
      expect(sdk.last.options).toMatchObject({ cwd: '/work/demo', resume: S });
      expect(sdk.last.options.mcpServers).toBeUndefined();
      expect(sdk.last.options.allowedTools).toBeUndefined();
      expect(sdk.last.options.permissionMode).toBe('auto');
      expect(asked).toEqual([AGENT, '/work/demo']);
    });

    it('a mode picked for the agent chat wins over the extras', async () => {
      const A = 'bbbbbbbb-0000-4000-8000-0000000000a9';
      const { sdk, engine } = await setup({ extras, extra: { [A]: record(A, AGENT) } });
      await engine.open(A, () => {});
      await engine.setMode(A, 'plan');
      await engine.send(A, 'Plan it', []);
      expect(sdk.last.options.permissionMode).toBe('plan');
    });

    it("an MCP tool's approval card reads in words and shows every argument", async () => {
      const { sdk, engine, open, item, until } = await setup({ extras });
      const id = await engine.start({ provider: 'claude', cwd: AGENT, model: null, effort: null, mode: 'default', text: 'Start it', images: [] });
      await open(id);
      void sdk.last.ask('mcp__canvas__start_task', { folder: '/work/alpha', prompt: 'Add a healthcheck', provider: 'codex' });
      await until(() => item('approval'), 'approval');
      expect(item('approval')).toMatchObject({ title: 'Start this task?', detail: 'folder: /work/alpha\n\nprompt: Add a healthcheck\n\nprovider: codex', status: 'pending' });
      await engine.answerApproval(id, item('approval')!.id, 'deny');
      void sdk.last.ask('mcp__tickets__create_ticket', { title: 'Login fails', labels: ['bug'] });
      await until(() => item('approval', (a) => a.status === 'pending'), 'second approval');
      expect(item('approval', (a) => a.status === 'pending')).toMatchObject({ title: 'Allow tickets: create ticket?', detail: 'title: Login fails\n\nlabels: ["bug"]' });
    });
  });

  it("start(): a process that never sends init is closed after 30 s and the start rejects \"Claude didn't start\"", async () => {
    const { sdk, engine } = await setup({ configure: (s) => { s.sendsInit = false; } });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const start = engine.start({ provider: 'claude', cwd: '/work/new', model: null, effort: null, mode: null, text: 'Hello', images: [] });
    let outcome: string | null = null;
    start.then(() => { outcome = 'started'; }, (e: Error) => { outcome = e.message; });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(outcome).toBeNull();
    expect(sdk.last.closed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome).toBe("Claude didn't start");
    expect(sdk.queries).toHaveLength(1);
    expect(sdk.last.closed).toBe(true);
    expect(engine.owned()).toEqual(new Set());
    expect(engine.busy()).toEqual([]);
  });

  it('start(): an init in time clears the timer, and the session keeps running past 30 s', async () => {
    const { sdk, engine } = await setup();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const id = await engine.start({ provider: 'claude', cwd: '/work/new', model: null, effort: null, mode: null, text: 'Hello', images: [] });
    await vi.advanceTimersByTimeAsync(31_000);
    expect(sdk.last.closed).toBe(false);
    expect(engine.owned()).toEqual(new Set([id]));
  });

  it('options() before any process: the built-in models and the five modes with Auto chosen, and no SDK process is started', async () => {
    const { sdk, engine } = await setup();
    const options = await engine.options();
    expect(sdk.queries).toHaveLength(0);
    expect(options.models[0]).toEqual({ id: 'default', label: 'Default (recommended)', isDefault: true, efforts: ['low', 'medium', 'high', 'xhigh', 'max'] });
    expect(options.effort).toBeNull();
    expect(options.models.map((m) => m.id)).toEqual(['default', 'opus', 'sonnet', 'haiku']);
    expect(options.model).toBe('default');
    expect(options.modes).toEqual([
      { id: 'auto', label: 'Auto' }, { id: 'default', label: 'Ask' }, { id: 'acceptEdits', label: 'Accept edits' },
      { id: 'plan', label: 'Plan' }, { id: 'bypassPermissions', label: 'Bypass' },
    ]);
    expect(options.mode).toBe('auto');
  });

  it("options() after a process started: the models Claude Code listed at its last init", async () => {
    const { sdk, engine, open, current, until } = await setup({ configure: (s) => {
      s.models = [{ value: 'default', displayName: 'Default', description: '' }, { value: 'claude-next', displayName: 'Claude Next', description: '' }];
    } });
    await open();
    await engine.send(S, 'hi', []);
    await sdk.last.replay('stream-text.json');
    await until(() => current().models.length === 2, 'models listed');
    const queries = sdk.queries.length;
    expect(await engine.options()).toMatchObject({
      models: [{ id: 'default', label: 'Default', isDefault: true }, { id: 'claude-next', label: 'Claude Next', isDefault: false }],
      model: 'default', mode: 'auto',
    });
    expect(sdk.queries).toHaveLength(queries);
  });

  describe('permission mode of a chat opened here', () => {
    const M = 'cccccccc-0000-4000-8000-00000000000m';
    const transcript = (mode: string) => [
      { type: 'user', uuid: 'u1', cwd: '/work/demo', sessionId: M, timestamp: '2026-11-01T09:00:00.000Z', permissionMode: 'default', message: { role: 'user', content: 'first' } },
      { type: 'user', uuid: 'u2', cwd: '/work/demo', sessionId: M, timestamp: '2026-11-01T09:01:00.000Z', permissionMode: mode, message: { role: 'user', content: 'second' } },
    ].map((r) => JSON.stringify(r)).join('\n') + '\n';

    it('resumes in the mode the transcript last recorded', async () => {
      const { sdk, engine, open } = await setup({ extra: { [M]: transcript('acceptEdits') } });
      expect((await open(M)).mode).toBe('acceptEdits');
      await engine.send(M, 'go on', []);
      expect(sdk.last.options).toMatchObject({ resume: M, permissionMode: 'acceptEdits' });
    });

    it('carries Auto over from the transcript', async () => {
      const { sdk, engine, open } = await setup({ extra: { [M]: transcript('auto') } });
      expect((await open(M)).mode).toBe('auto');
      await engine.send(M, 'go on', []);
      expect(sdk.last.options.permissionMode).toBe('auto');
    });

    it('never carries Bypass over by itself: the process starts in Auto (main restores a saved Bypass)', async () => {
      const { sdk, engine, open } = await setup({ extra: { [M]: transcript('bypassPermissions') } });
      expect((await open(M)).mode).toBe('auto');
      await engine.send(M, 'go on', []);
      expect(sdk.last.options.permissionMode).toBe('auto');
      expect(sdk.last.options.allowDangerouslySkipPermissions).toBeUndefined();
    });

    it('when Claude Code starts in another mode than asked, the picker shows the real one and the chat says so', async () => {
      const { engine, open, current, until } = await setup({ configure: (s) => { s.startsIn = 'default'; } });
      expect((await open()).mode).toBe('auto');
      await engine.send(S, 'hi', []);
      await until(() => current().mode === 'default', 'picker follows init');
      expect(current().items.some((i) => i.kind === 'notice' && i.text === 'Claude Code started in Ask, not Auto.')).toBe(true);
    });

    // A long last turn (big tool output) pushed the newest stamped prompt out of the 64 KB tail, so
    // the resume passed no mode and every Continue ran in Ask (2026-11-27).
    const longTurn = (mode: string) => [
      { type: 'user', uuid: 'u1', cwd: '/work/demo', sessionId: M, timestamp: '2026-11-01T09:00:00.000Z', permissionMode: mode, message: { role: 'user', content: 'do the work' } },
      ...Array.from({ length: 40 }, (_, n) => ({
        type: 'user', uuid: `r${n}`, cwd: '/work/demo', sessionId: M, timestamp: '2026-11-01T09:01:00.000Z',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${n}`, content: 'x'.repeat(20_000) }] },
      })),
    ].map((r) => JSON.stringify(r)).join('\n') + '\n';

    it('the Continue button on an interrupted session resumes in its mode even when its last prompt is far back', async () => {
      for (const mode of ['auto', 'acceptEdits']) {
        const { sdk, engine, open } = await setup({ extra: { [M]: longTurn(mode) } });
        expect((await open(M)).mode).toBe(mode);
        await engine.send(M, 'Your previous turn was interrupted (its process ended mid-turn). Continue where you left off.', []);
        expect(sdk.last.options).toMatchObject({ resume: M, permissionMode: mode });
      }
    });

    it('a stricter mode the transcript names is kept on resume, not raised to Auto', async () => {
      const { sdk, engine, open } = await setup({ extra: { [M]: longTurn('default') } });
      expect((await open(M)).mode).toBe('default');
      await engine.send(M, 'go on', []);
      expect(sdk.last.options.permissionMode).toBe('default');
    });

    it('a process started again after its idle close keeps the mode, also one picked here', async () => {
      const { sdk, engine, open, until, current } = await setup({ idleMs: 5, extra: { [M]: transcript('auto') } });
      await open(M);
      await engine.setMode(M, 'acceptEdits');
      await engine.send(M, 'one', []);
      await sdk.last.replay('stream-text.json');
      await until(() => current().turn === 'idle' && sdk.last.closed, 'idle close');
      await engine.send(M, 'two', []);
      expect(sdk.queries.at(-1)!.options.permissionMode).toBe('acceptEdits');
      expect(sdk.queries.length).toBeGreaterThan(1);
    });

    it("the orchestrator's chat, sent to by continue_chat or a queued prompt, never resumes without a mode", async () => {
      const O = 'dddddddd-0000-4000-8000-00000000000o';
      const project = { folder: '/work/demo', connection: 'claude-login' } as unknown as NonNullable<ReturnType<NonNullable<ClaudeEngineOptions['projectFor']>>>;
      const extras = (): Partial<Options> => ({ permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true });
      const make = () => setup({ extras, projectFor: (id) => id === O ? project : undefined, extra: { [O]: longTurn('auto').replaceAll(M, O) } });
      const plain = await make();
      await plain.engine.open(O, () => {});
      await plain.engine.send(O, 'Install the app once the others finish', []);
      // Its last mode (Auto), not the extras' Bypass: no turn silently runs in Bypass.
      expect(plain.sdk.last.options.permissionMode).toBe('auto');
      // A saved Bypass (an orchestrator starts in it) comes back through main's restore, a setMode
      // before the send, and the process is started for it.
      const saved = await make();
      await saved.engine.open(O, () => {});
      await saved.engine.setMode(O, 'bypassPermissions');
      await saved.engine.send(O, 'Install the app once the others finish', []);
      expect(saved.sdk.last.options).toMatchObject({ permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true });
    });

    it('a mode picked here is passed on the next start, even with none in the transcript', async () => {
      const { sdk, engine, open } = await setup();
      await open();
      await engine.setMode(S, 'plan');
      await engine.send(S, 'hi', []);
      expect(sdk.last.options.permissionMode).toBe('plan');
    });

    it('a new chat starts in Auto unless another mode is chosen', async () => {
      const { sdk, engine } = await setup();
      await engine.start({ provider: 'claude', cwd: '/work/new', model: null, effort: null, mode: null, text: 'Hello', images: [] });
      expect(sdk.last.options.permissionMode).toBe('auto');
    });
  });

  it('a tool call with no result opens as failed when the session is not running here', async () => {
    const lines = [
      { type: 'user', uuid: 'u1', cwd: '/work/demo', timestamp: '2026-11-01T09:00:00.000Z', message: { role: 'user', content: 'go' } },
      { type: 'assistant', uuid: 'a1', cwd: '/work/demo', timestamp: '2026-11-01T09:00:01.000Z', message: { id: 'msg_x', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_lost', name: 'Bash', input: { command: 'sleep 100' } }] } },
    ].map((l) => JSON.stringify(l)).join('\n');
    const id = 'bbbbbbbb-0000-4000-8000-0000000000d4';
    const { open } = await setup({ extra: { [id]: lines } });
    const state = await open(id);
    expect(state.items.find((i) => i.id === 'toolu_lost')).toMatchObject({ kind: 'tool', status: 'failed', output: null });
  });

  it("a resume re-reads the session files first: another program's file seen since the last poll means writing alongside it, never mid-turn", async () => {
    let busy = true;
    const looked: string[] = [];
    const { sdk, engine, open, current, item } = await setup({
      foreignFile: async (id) => { looked.push(id); return true; }, workingElsewhere: () => busy,
    });
    await open();
    expect(current().owner).toBe('nobody');
    // The other program is mid-turn: the message waits, and nothing is shown or started.
    await expect(engine.send(S, 'hi', [])).rejects.toThrow(BUSY_ELSEWHERE);
    expect(looked).toEqual([S]);
    expect(sdk.queries).toHaveLength(0);
    expect(item('user', (u) => u.text === 'hi')).toBeUndefined();
    // Between its turns: resumed here, said once, and not looked at again while it runs.
    busy = false;
    await engine.send(S, 'now', []);
    expect(sdk.queries).toHaveLength(1);
    expect(sdk.last.options.resume).toBe(S);
    expect(current().owner).toBe('here');
    expect(item('notice', (n) => n.text === WRITING_ALONGSIDE)?.level).toBe('info');
    expect(engine.shared().has(S)).toBe(true);
    await engine.send(S, 'again', []);
    expect(looked).toEqual([S, S]);
    expect(current().items.filter((i) => i.kind === 'notice' && i.text === WRITING_ALONGSIDE)).toHaveLength(1);
  });

  it('a tool call with no result stays running when another app has the session open: it may still be running there', async () => {
    const lines = [
      { type: 'user', uuid: 'u1', cwd: '/work/demo', timestamp: '2026-11-01T09:00:00.000Z', message: { role: 'user', content: 'go' } },
      { type: 'assistant', uuid: 'a1', cwd: '/work/demo', timestamp: '2026-11-01T09:00:01.000Z', message: { id: 'msg_x', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_live', name: 'Bash', input: { command: 'sleep 100' } }] } },
    ].map((l) => JSON.stringify(l)).join('\n');
    const id = 'bbbbbbbb-0000-4000-8000-0000000000d5';
    let elsewhere = true;
    const { sdk, engine, open, current } = await setup({
      extra: { [id]: lines }, elsewhere: (s) => s === id && elsewhere, workingElsewhere: (s) => s === id && elsewhere,
    });
    const state = await open(id);
    expect(state).toMatchObject({ owner: 'elsewhere', banner: 'Open in another app — read-only here' });
    expect(state.items.find((i) => i.id === 'toolu_live')).toMatchObject({ kind: 'tool', status: 'running' });
    await expect(engine.send(id, 'hi', [])).rejects.toThrow(BUSY_ELSEWHERE);
    expect(sdk.queries).toHaveLength(0);

    // Closed there: Move here reads it afresh, and now the call is lost.
    elsewhere = false;
    await expect(engine.moveHere(id)).resolves.toBe(true);
    expect(current()).toMatchObject({ owner: 'nobody', banner: null });
    expect(current().items.find((i) => i.id === 'toolu_live')).toMatchObject({ kind: 'tool', status: 'failed' });
  });

  describe('a chat open in another app follows the transcript live', () => {
    const ID = 'bbbbbbbb-0000-4000-8000-0000000000e6';
    const rec = (r: Record<string, unknown>) => JSON.stringify({ cwd: '/work/demo', timestamp: '2026-11-01T09:00:00.000Z', ...r });
    const LINES = [
      rec({ type: 'user', uuid: 'u1', message: { role: 'user', content: 'go' } }),
      rec({ type: 'assistant', uuid: 'a1', message: { id: 'msg_1', role: 'assistant', content: [{ type: 'text', text: 'Working on it' }] } }),
    ].join('\n') + '\n';
    const later = rec({ type: 'assistant', uuid: 'a2', message: { id: 'msg_2', role: 'assistant', content: [{ type: 'text', text: 'Written in the Claude app' }] } }) + '\n';
    const reader = vi.mocked(claudeHistory);

    async function following() {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      const t = await setup({ extra: { [ID]: LINES }, elsewhere: (id) => id === ID });
      const file = path.join(t.home, 'projects', '-work-demo', `${ID}.jsonl`);
      const state = await t.open(ID);
      expect(state.owner).toBe('elsewhere');
      reader.mockClear();
      /** One poll, and the reads it starts. */
      const poll = async () => {
        vi.advanceTimersByTime(2000);
        for (let n = 0; n < 50; n++) await tick();
      };
      return { ...t, file, poll };
    }

    it('an appended assistant record appears within one poll', async () => {
      const { file, poll, item, updates } = await following();
      await fs.appendFile(file, later);
      await poll();
      expect(item('assistant', (a) => a.id === 'msg_2')).toMatchObject({ text: 'Written in the Claude app' });
      expect(reader).toHaveBeenCalledTimes(1);
      expect(reader.mock.calls[0]![1]).toMatchObject({ before: null });
      // Only what changed is sent; what was shown already is not sent again.
      expect(updates.filter((u) => u.op === 'upsert').map((u) => u.op === 'upsert' && u.item.id)).toEqual(['msg_2']);
    });

    it('no re-read when size and mtime are unchanged', async () => {
      const { poll } = await following();
      await poll();
      await poll();
      await poll();
      expect(reader).not.toHaveBeenCalled();
    });

    it('polling stops after close', async () => {
      const { engine, file, poll } = await following();
      engine.close(ID);
      await fs.appendFile(file, later);
      await poll();
      await poll();
      expect(reader).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    });

    it('polling stops once Move here succeeds', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      let elsewhere = true;
      const { engine, home, open } = await setup({ extra: { [ID]: LINES }, elsewhere: (id) => id === ID && elsewhere });
      await open(ID);
      expect(vi.getTimerCount()).toBe(1);
      elsewhere = false;
      await expect(engine.moveHere(ID)).resolves.toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      void home;
    });

    it('polling stops once the store no longer reports the session elsewhere; the chat stays read-only until Move here', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      let elsewhere = true;
      const { engine, open, current } = await setup({ extra: { [ID]: LINES }, elsewhere: (id) => id === ID && elsewhere });
      await open(ID);
      expect(vi.getTimerCount()).toBe(1);
      elsewhere = false;
      vi.advanceTimersByTime(2000);
      expect(vi.getTimerCount()).toBe(0);
      expect(current().owner).toBe('elsewhere');
      // Opened there again: the store's transition re-arms it.
      elsewhere = true;
      engine.lost(ID);
      expect(vi.getTimerCount()).toBe(1);
    });

    it('when the other app lets go, its last writes are read: a call it finished settles, one it never answered fails', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      let elsewhere = true;
      const t = await setup({ extra: { [ID]: LINES }, elsewhere: (id) => id === ID && elsewhere });
      const file = path.join(t.home, 'projects', '-work-demo', `${ID}.jsonl`);
      await t.open(ID);
      const poll = async () => {
        vi.advanceTimersByTime(2000);
        for (let n = 0; n < 50; n++) await tick();
      };
      const call = (id: string, uuid: string) => rec({ type: 'assistant', uuid, message: { id: `msg_${id}`, role: 'assistant',
        content: [{ type: 'tool_use', id, name: 'mcp__canvas__start_task', input: { cwd: '/work/demo', text: 'Ship it' } }] } }) + '\n';
      await fs.appendFile(file, call('toolu_task', 'a3') + call('toolu_lost', 'a4'));
      await poll();
      expect(t.item('tool', (i) => i.id === 'toolu_task')).toMatchObject({ status: 'running' });
      // Within one poll: the result and the reply are written, and the other app exits.
      await fs.appendFile(file, rec({ type: 'user', uuid: 'u3', message: { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'toolu_task', content: [{ type: 'text', text: 'Handed the task to the project orchestrator.' }] },
      ] } }) + '\n');
      elsewhere = false;
      await poll();
      expect(vi.getTimerCount()).toBe(0);
      expect(t.item('tool', (i) => i.id === 'toolu_task')).toMatchObject({ status: 'done', output: 'Handed the task to the project orchestrator.' });
      expect(t.item('tool', (i) => i.id === 'toolu_lost')).toMatchObject({ status: 'failed' });
      expect(t.current().owner).toBe('elsewhere');
    });

    it('a transcript that shrank or was replaced resets the chat from a fresh newest page', async () => {
      const { file, poll, current, updates } = await following();
      const replaced = `${file}.new`;
      await fs.writeFile(replaced, rec({ type: 'user', uuid: 'u9', message: { role: 'user', content: 'a new start' } }) + '\n');
      await fs.rename(replaced, file);
      await poll();
      expect(updates.at(-1)).toMatchObject({ op: 'reset' });
      expect(current()).toMatchObject({ owner: 'elsewhere', banner: 'Open in another app — read-only here' });
      expect(current().items.map((i) => i.kind === 'user' && i.text)).toEqual(['a new start']);
    });
  });

  it('lost() while running here: the process is closed and the chat follows the other app; a later message writes alongside it', async () => {
    const { sdk, engine, open, current, item, until } = await setup();
    await open();
    await engine.send(S, 'hi', []);
    const askDone = sdk.last.ask('Bash', BASH_INPUT, { suggestions: SUGGESTIONS });
    await until(() => item('approval'), 'approval');
    expect(item('approval')?.status).toBe('pending');
    engine.lost(S);
    expect(sdk.last.closed).toBe(true);
    expect(engine.owned().has(S)).toBe(false);
    expect(current()).toMatchObject({ owner: 'elsewhere', turn: 'idle', banner: 'Open in another app — read-only here' });
    expect(item('approval')?.status).toBe('expired');
    expect(item('notice', (n) => n.level === 'warn')?.text).toBe('Opened in another app — read-only here');
    await expect(askDone).resolves.toMatchObject({ behavior: 'deny' });
    await engine.send(S, 'more', []);
    expect(sdk.queries).toHaveLength(2);
    expect(current()).toMatchObject({ owner: 'here', turn: 'running' });
    // Written alongside: polls that still see the other app no longer stop it.
    engine.lost(S);
    expect(sdk.last.closed).toBe(false);
    // A chat nobody has open: nothing to tell.
    expect(() => engine.lost('not-open')).not.toThrow();
  });

  describe('account()', () => {
    it("maps accountInfo() + usage windows ('5 h', 'Weekly', 'Weekly Opus' when present)", async () => {
      const { sdk, engine } = await setup();
      const account = await engine.account();
      expect(account).toEqual({
        provider: 'claude', signedIn: true, email: 'owner@example.com', plan: 'max', note: null,
        windows: [
          { label: '5 h', usedPercent: 12, resetsAt: Date.parse('2026-11-23T18:00:00.000Z') },
          { label: 'Weekly', usedPercent: 40, resetsAt: Date.parse('2026-11-27T09:00:00.000Z') },
          { label: 'Weekly Opus', usedPercent: 55, resetsAt: Date.parse('2026-11-27T09:00:00.000Z') },
        ],
      });
      // No session was running: a short query answered, without a transcript, and was closed.
      expect(sdk.queries).toHaveLength(1);
      expect(sdk.last.options).toMatchObject({ persistSession: false, env: childEnv(process.env) });
      expect(sdk.last.prompts).toEqual([]);
      expect(sdk.last.closed).toBe(true);
    });

    it('without Opus usage there is no Weekly Opus window', async () => {
      const { engine } = await setup({ configure: (sdk) => {
        sdk.usage = usageWith({ five_hour: { utilization: 1, resets_at: null }, seven_day: null });
      } });
      expect((await engine.account()).windows).toEqual([{ label: '5 h', usedPercent: 1, resetsAt: null }]);
    });

    it('a running session answers it', async () => {
      const { sdk, engine, open } = await setup();
      await open();
      await engine.send(S, 'hi', []);
      await engine.account();
      expect(sdk.queries).toHaveLength(1);
      expect(sdk.last.calls).toContainEqual(['accountInfo']);
      expect(sdk.last.closed).toBe(false);
    });

    it('usage call failing → windows from last rate_limit_event', async () => {
      const hints: number[] = [];
      const sdk = new FakeSdk();
      sdk.usage = new Error('usage is not available');
      const engine = new ClaudeEngine({ sdk, now: () => NOW, claudeHome: await claudeHome(), onAccountChanged: () => hints.push(1) });
      await engine.open(S, () => {});
      await engine.send(S, 'hi', []);
      const rate = (rateLimitType: string, utilization: number, resetsAt: number): SDKMessage =>
        ({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', rateLimitType, utilization, resetsAt }, uuid: `rl-${rateLimitType}`, session_id: S }) as SDKMessage;
      sdk.last.emit(rate('five_hour', 0.3, 1795010000));
      sdk.last.emit(rate('seven_day', 0.5, 1795400000));
      sdk.last.emit(rate('five_hour', 0.35, 1795010000));
      for (let n = 0; n < 20; n++) await tick();
      expect(hints.length).toBe(3);
      const account = await engine.account();
      expect(account.windows).toEqual([
        { label: '5 h', usedPercent: 35, resetsAt: 1795010000 * 1000 },
        { label: 'Weekly', usedPercent: 50, resetsAt: 1795400000 * 1000 },
      ]);
      expect(account.signedIn).toBe(true);
    });

    it('signed out → signedIn false with the login note', async () => {
      const { engine } = await setup({ configure: (sdk) => {
        sdk.accountInfo = { tokenSource: 'none', apiProvider: 'firstParty' };
        sdk.usage = usageWith(null, null);
      } });
      expect(await engine.account()).toEqual({
        provider: 'claude', signedIn: false, email: null, plan: null, windows: [], note: SIGNED_OUT_BANNER,
      });
      expect(engine.banner).toBe(SIGNED_OUT_BANNER);
    });
  });

  it('stop() closes running queries and denies what waits', async () => {
    const { sdk, engine, open, item, until } = await setup();
    await open();
    await engine.send(S, 'Run', []);
    void sdk.last.ask('Bash', BASH_INPUT, { toolUseID: 'toolu_x' });
    await until(() => item('approval'), 'approval');
    await engine.stop();
    expect(sdk.last.closed).toBe(true);
    await until(() => sdk.last.permissions.length === 1, 'denied');
    expect(sdk.last.permissions[0]?.result.behavior).toBe('deny');
    expect(engine.owned().size).toBe(0);
    expect(engine.busy()).toEqual([]);
  });

  describe('stopping (quit)', () => {
    it('after stop(), send, start and moveHere reject with "Agent canvas is quitting" and start no process', async () => {
      const { sdk, engine, open } = await setup();
      await open();
      await engine.stop();
      await expect(engine.send(S, 'hi', [])).rejects.toThrow('Agent canvas is quitting');
      await expect(engine.start({ provider: 'claude', cwd: '/work/new', model: null, effort: null, mode: null, text: 'Hello', images: [] })).rejects.toThrow('Agent canvas is quitting');
      await expect(engine.moveHere(S)).rejects.toThrow('Agent canvas is quitting');
      expect(sdk.queries).toHaveLength(0);
    });

    it('a send that arrives while stop() runs is refused and launches nothing', async () => {
      const { sdk, engine, open } = await setup({ configure: (s) => { s.holdClose = true; } });
      await open();
      await engine.send(S, 'Run', []);
      const first = sdk.last;
      const stopped = engine.stop();
      await expect(engine.send(S, 'One more', [])).rejects.toThrow('Agent canvas is quitting');
      expect(sdk.queries).toHaveLength(1);
      first.finishClose();
      await stopped;
      expect(engine.busy()).toEqual([]);
      expect(engine.owned().size).toBe(0);
    });

    it('stop() waits for a start still in flight (no init yet): its process is closed and the start rejects', async () => {
      const { sdk, engine } = await setup({ configure: (s) => { s.sendsInit = false; s.holdClose = true; } });
      const start = engine.start({ provider: 'claude', cwd: '/work/new', model: null, effort: null, mode: null, text: 'Hello', images: [] });
      start.catch(() => {});
      await tick();
      let stopDone = false;
      const stopped = engine.stop().then(() => { stopDone = true; });
      for (let n = 0; n < 5; n++) await tick();
      expect(sdk.last.closed).toBe(true);
      expect(stopDone).toBe(false); // the process has not exited yet
      sdk.last.finishClose();
      await stopped;
      await expect(start).rejects.toThrow();
      expect(engine.busy()).toEqual([]);
    });

    it('stop() waits for a process replaced by a Bypass restart', async () => {
      const { sdk, engine, open, current, until } = await setup({ configure: (s) => { s.refuseBypass = true; s.holdClose = true; } });
      await open();
      await engine.send(S, 'Say hello', []);
      const first = sdk.last;
      await first.replay('stream-text.json');
      await until(() => current().turn === 'idle', 'turn idle');
      await engine.setMode(S, 'bypassPermissions'); // the running process cannot switch: restart on the next send
      await engine.send(S, 'Now with bypass', []);
      expect(sdk.queries).toHaveLength(2);
      expect(first.closed).toBe(true); // replaced, still exiting
      const second = sdk.last;

      let stopDone = false;
      const stopped = engine.stop().then(() => { stopDone = true; });
      for (let n = 0; n < 5; n++) await tick();
      expect(second.closed).toBe(true);
      second.finishClose();
      for (let n = 0; n < 5; n++) await tick();
      expect(stopDone).toBe(false); // the replaced process is still exiting
      first.finishClose();
      await stopped;
      expect(engine.busy()).toEqual([]);
      expect(engine.owned().size).toBe(0);
    });
  });
});
