// Zone folder for a working directory, and the one-line activity shown on a card.
import type { NeedKind } from '../shared/types.ts';
import type { RawSession } from './adapter/sessionFiles.ts';
import type { TranscriptTail } from './adapter/transcript.ts';

const MAX_LINE = 80;
const WORKTREES = '/.claude/worktrees/';
const SCRATCH = '/scratch-workspaces/';

/** waitingFor values the app writes; anything else is shown to the user as written. */
const KNOWN_WAITING = new Set(['permission prompt', 'sandbox request', 'worker request', 'input needed']);
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

const lastSegment = (p: string): string => p.split('/').filter((s) => s !== '').at(-1) ?? '';

export function folderOf(cwd: string): string {
  const wt = cwd.indexOf(WORKTREES);
  if (wt !== -1) return lastSegment(cwd.slice(0, wt));
  if (cwd.includes(SCRATCH)) return '';
  return lastSegment(cwd);
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);
/**
 * One line of at most 80 characters. A longer line is cut before the word that does not fit and
 * ends in "…"; a word too long to fit on a line by itself is cut hard instead of being dropped.
 */
function oneLine(text: string): string {
  const s = text.replace(/\s+/g, ' ').trim();
  if (s.length <= MAX_LINE) return s;
  const room = MAX_LINE - 1; // the ellipsis takes the last character
  if (s[room] === ' ') return `${s.slice(0, room).trimEnd()}…`;
  const start = s.lastIndexOf(' ', room) + 1;
  const next = s.indexOf(' ', room);
  const wordLength = (next === -1 ? s.length : next) - start;
  const cut = wordLength > room ? s.slice(0, room) : s.slice(0, start).trimEnd();
  return `${cut === '' ? s.slice(0, room) : cut}…`;
}

function firstQuestion(input: Record<string, unknown>): string | null {
  const qs = input.questions;
  if (!Array.isArray(qs) || typeof qs[0] !== 'object' || qs[0] === null) return null;
  return str((qs[0] as Record<string, unknown>).question);
}

function busyLine(tail: TranscriptTail | null): string {
  const tool = tail?.pendingTool;
  if (tool) {
    const input = tool.input;
    const file = str(input.file_path) ?? str(input.notebook_path);
    if (EDIT_TOOLS.has(tool.name)) return file ? `Editing ${lastSegment(file)}` : `Using ${tool.name}`;
    switch (tool.name) {
      case 'Read': return file ? `Reading ${lastSegment(file)}` : 'Using Read';
      case 'Bash': {
        const command = str(input.command);
        return str(input.description) ?? (command ? `Running: ${command}` : 'Using Bash');
      }
      case 'Grep': case 'Glob': return 'Searching the code';
      case 'WebSearch': case 'WebFetch': return 'Searching the web';
      case 'Agent': case 'Task': {
        const description = str(input.description);
        return description ? `Delegating: ${description}` : `Using ${tool.name}`;
      }
      default: return `Using ${tool.name}`;
    }
  }
  if (tail?.lastBlock === 'thinking') return 'Thinking';
  if (tail?.lastBlock === 'text') return 'Writing a reply';
  return 'Working';
}

function line(raw: RawSession, tail: TranscriptTail | null, need: NeedKind | null): string | null {
  const tool = tail?.pendingTool ?? null;
  if (need === 'permission') {
    const command = tool?.name === 'Bash' ? str(tool.input.command) : null;
    if (command) return `Wants to run: ${command}`;
    if (tool) return `Wants to use ${tool.name}`;
    return 'Wants permission';
  }
  if (need === 'question') {
    const q = tool ? firstQuestion(tool.input) : null;
    if (q) return q;
    const w = str(raw.waitingFor);
    return w && !KNOWN_WAITING.has(w) ? w : 'Has a question';
  }
  if (need === 'terminal') return 'Waiting on a prompt in its terminal';
  if (need === 'reply') {
    const first = (tail?.lastAnswer ?? '').split('\n').find((l) => l.trim() !== '');
    return first ?? 'Finished';
  }
  if (raw.status === 'shell') return 'A shell is still running';
  if (raw.status === 'busy') return busyLine(tail);
  return null;
}

export function describeActivity(raw: RawSession, tail: TranscriptTail | null, need: NeedKind | null): string | null {
  const text = line(raw, tail, need);
  return text === null ? null : oneLine(text);
}
