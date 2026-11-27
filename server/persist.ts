// Atomic JSON files in the data folder, their validators, and a debounced, one-at-a-time saver.
import fs from 'node:fs/promises';
import path from 'node:path';
import { isZoneColor, isZoneIcon } from '../shared/zoneAppearance.ts';
import type { Layout, ZoneLayout } from '../shared/types.ts';

/** `dismissedInterruptions`: session id → the latest interruption the owner aborted (epoch ms). */
export interface ReplyState { version: 1; pendingReply: Record<string, number>; dismissedInterruptions?: Record<string, number> }

const log = (message: string): void => { process.stderr.write(`agent-canvas: ${message}\n`); };

/**
 * Reads and validates a JSON file. Returns `fallback` when the file is missing, unparsable or
 * invalid; in the last two cases the file is first moved aside to `<file>.bad-<epoch>`.
 */
export async function loadJson<T>(file: string, fallback: T, isValid: (v: unknown) => v is T): Promise<T> {
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log(`cannot read ${file}: ${(err as Error).message}`);
    return fallback;
  }
  let value: unknown;
  let problem: string | null = null;
  try {
    value = JSON.parse(text);
    if (!isValid(value)) problem = 'unexpected shape';
  } catch (err) {
    problem = (err as Error).message;
  }
  if (problem === null) return value as T;
  const bad = `${file}.bad-${Date.now()}`;
  try {
    await fs.rename(file, bad);
    log(`${file} is damaged (${problem}); moved it to ${bad} and started fresh`);
  } catch (err) {
    log(`${file} is damaged (${problem}) and could not be moved aside: ${(err as Error).message}`);
  }
  return fallback;
}

/** Writes `<file>.tmp-<pid>` then renames it over `file`, so readers see the old or the new file, never half of one. */
export async function saveJsonAtomic(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    await fs.writeFile(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    await fs.chmod(tmp, 0o600); // a leftover tmp file keeps its old mode through writeFile
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isCoord = (v: unknown): boolean => v === null || (typeof v === 'number' && Number.isFinite(v));

function isZone(v: unknown): v is ZoneLayout {
  return isRecord(v)
    && typeof v.id === 'string'
    && typeof v.name === 'string'
    && (v.kind === 'folder' || v.kind === 'custom')
    && (v.folder === null || typeof v.folder === 'string')
    && isCoord(v.x) && isCoord(v.y)
    && (v.color === undefined || isZoneColor(v.color))
    && (v.icon === undefined || isZoneIcon(v.icon))
    && Number.isInteger(v.hueIndex) && (v.hueIndex as number) >= 0 && (v.hueIndex as number) <= 6
    && (v.hiddenAt === undefined || (typeof v.hiddenAt === 'number' && Number.isFinite(v.hiddenAt)))
    // Layouts saved before folder zones had a path carry none.
    && (v.path === undefined || typeof v.path === 'string');
}

export function isLayout(v: unknown): v is Layout {
  return isRecord(v)
    && v.version === 1
    && Array.isArray(v.zones) && v.zones.every(isZone)
    && isRecord(v.assignments) && Object.values(v.assignments).every((z) => typeof z === 'string')
    // Board items are checked one by one when loaded (withCleanItems): a bad one never costs the layout.
    && (v.items === undefined || Array.isArray(v.items))
    // Card slots likewise (withCleanSlots): a damaged zone's slots are dropped, never the layout.
    && (v.slots === undefined || isRecord(v.slots));
}

export function isReplyState(v: unknown): v is ReplyState {
  return isRecord(v)
    && v.version === 1
    && isRecord(v.pendingReply)
    && Object.values(v.pendingReply).every((t) => typeof t === 'number' && Number.isFinite(t))
    && (v.dismissedInterruptions === undefined || (isRecord(v.dismissedInterruptions)
      && Object.values(v.dismissedInterruptions).every((t) => typeof t === 'number' && Number.isFinite(t))));
}

export interface DebouncedSave {
  /** Asks for a save `ms` after the last request. */
  schedule(): void;
  /** Starts a pending save now and resolves when every started save has finished. */
  flush(): Promise<void>;
}

/** Debounces `run`; runs never overlap, and a failed run is logged without stopping later ones. */
export function createDebouncedSave(run: () => Promise<void>, ms: number): DebouncedSave {
  let timer: NodeJS.Timeout | null = null;
  let chain: Promise<void> = Promise.resolve();
  const begin = (): void => {
    timer = null;
    chain = chain.then(run).catch((err: unknown) => log(`save failed: ${(err as Error).message}`));
  };
  return {
    schedule() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(begin, ms);
    },
    flush() {
      if (timer) {
        clearTimeout(timer);
        begin();
      }
      return chain;
    },
  };
}
