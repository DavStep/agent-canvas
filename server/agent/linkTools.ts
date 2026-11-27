// The canvas agent's tools for links between sessions ("B runs after A", shared/runs.ts): make a
// session wait for others with a prompt queued, take a link away, cap how many run at once in a
// project, and what canvas_overview and read_session say about waits. tools.ts adds them to
// CANVAS_TOOLS and calls queueTask for start_task's `after`. Only types come from tools.ts, so
// importing this file never runs tools.ts first.
import { z } from 'zod';
import { folderOf } from '../activity.ts';
import { isPlanId, MAX_AFTER, MAX_RUNNING_LIMIT, runOfPlan, type RunMode, type RunTarget } from '../../shared/runs.ts';
import type { Snapshot } from '../../shared/types.ts';
import { RunError } from '../runs/store.ts';
import type { CanvasApi, CanvasTool, define as Define, ToolResult } from './tools.ts';

const ok = (text: string): ToolResult => ({ text, isError: false });
const fail = (text: string): ToolResult => ({ text, isError: true });
const NO_QUEUE = 'Links between sessions are not available here.';

const short = (text: string, max = 200): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** A card's name for a sentence. */
function nameIn(snap: Snapshot, id: string): string {
  if (isPlanId(id)) {
    const run = snap.runs?.find((r) => r.id === runOfPlan(id));
    const title = run?.target.kind === 'new' ? run.target.title : null;
    return title ? `"${title}" (planned)` : 'a planned session';
  }
  const s = snap.sessions.find((x) => x.id === id);
  return s?.name.trim() ? `"${s.name.trim()}"` : id;
}

/** Every id must be a session on the canvas, or a planned session still to start. */
export function checkUpstreams(snap: Snapshot, ids: readonly string[]): string | null {
  for (const id of ids) {
    if (isPlanId(id)) {
      if (!snap.runs?.some((r) => r.id === runOfPlan(id) && r.status !== 'started')) return `No planned session is ${id}. canvas_overview lists the queue.`;
      continue;
    }
    if (!snap.sessions.some((s) => s.id === id)) return `No session has the id ${id}. canvas_overview lists the sessions.`;
  }
  return null;
}

export const afterArg = (what: string) => z.array(z.string()).max(MAX_AFTER).optional()
  .describe(`Session ids (from canvas_overview) that must finish their turns before ${what} starts. The app starts it by itself when they have; leave out to start now`);
export const afterModeArg = z.enum(['all', 'any']).optional().describe("'all' (default): wait for every one of them; 'any': start when the first finishes");
export const handOffArg = z.boolean().optional().describe("Append each finished session's last answer to the prompt (\"Upstream result from …\")");

/** start_task with `after`: the task goes to the orchestrator once those sessions finish. */
export function queueTask(api: CanvasApi, task: {
  cwd: string; provider: string | null; model: string | null; effort?: string; mode: string | null; prompt: string;
  attachments: { path: string; name: string; mime: string | null }[]; after: string[]; afterMode?: RunMode; handOff?: boolean;
}): ToolResult {
  if (!api.runs) return fail(NO_QUEUE);
  const snap = api.snapshot();
  const bad = checkUpstreams(snap, task.after);
  if (bad) return fail(bad);
  const target: RunTarget = { kind: 'handoff', cwd: task.cwd, provider: task.provider, model: task.model, ...(task.effort !== undefined ? { effort: task.effort } : {}), mode: task.mode };
  try {
    const run = api.runs.queue({ target, after: task.after, mode: task.afterMode, prompt: task.prompt, handOff: task.handOff, attachments: task.attachments, by: 'agent' });
    const names = task.after.map((id) => nameIn(snap, id));
    return ok(`Queued the task for ${task.cwd} as run ${run.id}: it goes to the project orchestrator by itself once ${names.join(task.afterMode === 'any' ? ' or ' : ' and ')} ${task.after.length === 1 ? 'finishes' : task.afterMode === 'any' ? 'finishes' : 'have finished'}. A line on the canvas shows the wait; canvas_overview lists the queue.`);
  } catch (err) {
    return fail(err instanceof RunError ? err.message : `The task was not queued: ${(err as Error).message}`);
  }
}

/** The queue as canvas_overview lists it; nothing when it is empty. */
export function runsOverview(snap: Snapshot): { queue?: object[]; maxRunning?: Record<string, number> } {
  const runs = snap.runs ?? [];
  const limits = snap.maxRunning ?? {};
  return {
    ...(runs.length > 0 ? {
      queue: runs.map((r) => ({
        run: r.id,
        waits: r.target.kind === 'session' ? { session: r.target.id, name: nameIn(snap, r.target.id) }
          : r.target.kind === 'new' ? { planned: `plan:${r.id}`, folder: r.target.cwd, provider: r.target.provider, ...(r.target.title ? { title: r.target.title } : {}) }
            : { orchestrator: r.target.cwd },
        for: r.edges.map((e) => ({ id: e.from, state: e.state })),
        ...(r.mode === 'any' ? { mode: 'any' } : {}),
        status: r.status, reason: r.reason, prompt: short(r.prompt),
        ...(r.startedId ? { startedSession: r.startedId } : {}),
      })),
    } : {}),
    ...(Object.keys(limits).length > 0 ? { maxRunning: limits } : {}),
  };
}

/** What read_session adds about one session's waits: the run it waits in, and the runs waiting on it. */
export function runFacts(snap: Snapshot, id: string): { waitsFor?: object; unblocks?: object[] } {
  const runs = (snap.runs ?? []).filter((r) => r.status !== 'started');
  const mine = runs.find((r) => r.node === id);
  const after = runs.filter((r) => r.edges.some((e) => e.from === id));
  return {
    ...(mine ? { waitsFor: { run: mine.id, for: mine.edges.map((e) => ({ id: e.from, name: nameIn(snap, e.from), state: e.state })), status: mine.status, reason: mine.reason, queuedPrompt: mine.prompt } } : {}),
    ...(after.length > 0 ? { unblocks: after.map((r) => ({ run: r.id, session: r.node, status: r.status })) } : {}),
  };
}

export function linkTools(define: typeof Define): CanvasTool[] {
  return [
    define({
      name: 'link_sessions',
      description: "Makes a session wait for others with a prompt queued: once every session in `after` has finished its turn normally, the app sends `prompt` to session `to` by itself, with its own model and permission mode, even across an app relaunch. A line on the canvas shows each link; if one of them is interrupted (a limit, an error, cut off), `to` stays waiting and shows blocked. With `after` empty the prompt only queues behind the project's max running (set_max_running): the way to run \"these sessions, at most N at once\". A session has one queued prompt: linking it again adds to what it waits for (and replaces the prompt when one is given). A loop is refused. The owner may be asked first.",
      shape: {
        to: z.string().describe('The session that waits (an id from canvas_overview)'),
        after: z.array(z.string()).max(MAX_AFTER).describe('The sessions it waits for; may be empty (see the description)'),
        prompt: z.string().optional().describe('What to send it when it starts: complete instructions. Needed unless it already has a queued prompt'),
        mode: afterModeArg,
        handOff: handOffArg,
      },
      safe: false,
      handler: async (api, args) => {
        if (!api.runs) return fail(NO_QUEUE);
        const snap = api.snapshot();
        const bad = checkUpstreams(snap, [args.to, ...args.after]);
        if (bad) return fail(bad);
        try {
          const run = api.runs.apply({ type: 'link', from: args.after, to: args.to, ...(args.prompt !== undefined ? { prompt: args.prompt } : {}),
            ...(args.mode ? { mode: args.mode } : {}), ...(args.handOff !== undefined ? { handOff: args.handOff } : {}) }, 'agent');
          if (!run) return fail('Nothing was linked.');
          const names = run.after.map((id) => nameIn(snap, id));
          return ok(names.length === 0
            ? `Queued the prompt for ${nameIn(snap, args.to)} (run ${run.id}): it is sent as soon as the project has a free slot.`
            : `${nameIn(snap, args.to)} now waits for ${names.join(run.mode === 'any' ? ' or ' : ' and ')} (run ${run.id}); its queued prompt is sent by itself when ${run.mode === 'any' ? 'the first' : names.length === 1 ? 'that one' : 'they all'} finish${run.mode === 'any' || names.length === 1 ? 'es' : ''}.`);
        } catch (err) {
          return fail(err instanceof RunError ? err.message : `Not linked: ${(err as Error).message}`);
        }
      },
    }),
    define({
      name: 'unlink_sessions',
      description: 'Takes a link away: with `from`, only the line from that session to `to`; without, the whole queued prompt of `to` (a session id, or a planned session as plan:<run id> from canvas_overview). A queued prompt left waiting for nothing is removed with it.',
      shape: {
        to: z.string().describe('The waiting session, or plan:<run id>'),
        from: z.string().optional().describe('One session it waits for; leave out to remove its queued prompt entirely'),
      },
      safe: true,
      handler: async (api, { to, from }) => {
        if (!api.runs) return fail(NO_QUEUE);
        const snap = api.snapshot();
        try {
          if (from !== undefined) {
            api.runs.apply({ type: 'unlink', from, to }, 'agent');
            return ok(`${nameIn(snap, to)} no longer waits for ${nameIn(snap, from)}.`);
          }
          const run = snap.runs?.find((r) => r.status !== 'started' && r.node === to) ?? (isPlanId(to) ? snap.runs?.find((r) => r.id === runOfPlan(to)) : undefined);
          if (!run) return fail(`${nameIn(snap, to)} has no queued prompt. canvas_overview lists the queue.`);
          api.runs.apply({ type: 'cancelRun', id: run.id }, 'agent');
          return ok(`Removed the queued prompt of ${nameIn(snap, to)} (run ${run.id}).`);
        } catch (err) {
          return fail(err instanceof RunError ? err.message : `Not unlinked: ${(err as Error).message}`);
        }
      },
    }),
    define({
      name: 'set_max_running',
      description: "Caps how many sessions work at once in a project (a folder zone): queued prompts and planned sessions there wait for a free slot, oldest first. Give `folder` (an absolute path) or `zoneId`; `max` null takes the cap away.",
      shape: {
        folder: z.string().optional().describe('The absolute path of the project folder'),
        zoneId: z.string().optional().describe('Instead of folder: the id of a folder zone'),
        max: z.number().int().min(1).max(MAX_RUNNING_LIMIT).nullable().describe('At most this many at once, or null for no cap'),
      },
      safe: true,
      handler: async (api, args) => {
        if (!api.runs) return fail(NO_QUEUE);
        if ((args.folder === undefined) === (args.zoneId === undefined)) return fail('Give either folder or zoneId, not both and not neither.');
        let key: string;
        if (args.zoneId !== undefined) {
          const zone = api.snapshot().layout.zones.find((z) => z.id === args.zoneId);
          if (!zone) return fail(`No zone has the id ${args.zoneId}. canvas_overview lists the zones.`);
          if (zone.kind !== 'folder' || zone.folder === null) return fail(`${zone.name} is a custom zone; a cap belongs to a project's folder zone.`);
          key = zone.folder;
        } else {
          if (!args.folder!.startsWith('/')) return fail(`${args.folder} is not an absolute path.`);
          key = folderOf(args.folder!);
        }
        api.runs.apply({ type: 'setMaxRunning', folder: key, max: args.max }, 'agent');
        return ok(args.max === null ? `No cap on sessions running at once in ${key || 'No folder'} any more.` : `At most ${args.max} session${args.max === 1 ? '' : 's'} run at once in ${key || 'No folder'}; queued work there waits for a free slot.`);
      },
    }),
  ];
}
