// Applies one ChatUpdate to a ChatState. Pure and import-free so the page uses the same code
// as the main process: both sides then agree on what a chat holds.
import type { ChatItem, ChatState, ChatUpdate } from '../../shared/chat.ts';

/** A tool's output keeps its last 256 KB: a dev server or a test run can print for hours, and
    the output is held in main, in the page and shown twice. */
export const MAX_OUTPUT = 256 * 1024;
export const TRIMMED = '… earlier output trimmed\n';
/** How far into the kept part a cut may move to start at a whole line. */
const LINE_SLACK = 4096;

type Tool = Extract<ChatItem, { kind: 'tool' }>;

/** The tool with `output` as its output, kept to its last MAX_OUTPUT characters behind one
    marker, and `outputDropped` counting every character the cap has dropped from it so far. */
function capTool(item: Tool, output: string): Tool {
  if (output.length <= MAX_OUTPUT) return { ...item, output };
  const body = output.startsWith(TRIMMED) ? output.slice(TRIMMED.length) : output;
  if (body.length <= MAX_OUTPUT) return { ...item, output: TRIMMED + body };
  let kept = body.slice(-MAX_OUTPUT);
  const nl = kept.indexOf('\n');
  if (nl !== -1 && nl < LINE_SLACK && nl < kept.length - 1) kept = kept.slice(nl + 1);
  return { ...item, output: TRIMMED + kept, outputDropped: (item.outputDropped ?? 0) + body.length - kept.length };
}

function appended(item: ChatItem, field: 'text' | 'output', chunk: string): ChatItem | null {
  if (field === 'text' && (item.kind === 'assistant' || item.kind === 'reasoning')) return { ...item, text: item.text + chunk };
  if (field === 'output' && item.kind === 'tool') return capTool(item, (item.output ?? '') + chunk);
  return null;
}

/** An upserted tool whose output is not the one this side holds (a final output, or a tool
    rebuilt around a new result) drops the count it may carry over by spreading: that counted
    the drops of the output it replaced. The same output (a status change) keeps it. */
function ownCount(before: ChatItem | undefined, item: ChatItem): ChatItem {
  if (item.kind !== 'tool' || item.outputDropped === undefined || before?.kind !== 'tool' || before.output === item.output) return item;
  const { outputDropped: _replaced, ...rest } = item;
  return rest;
}

const capped = (item: ChatItem): ChatItem =>
  item.kind === 'tool' && item.output !== null && item.output.length > MAX_OUTPUT ? capTool(item, item.output) : item;

export function applyUpdate(state: ChatState, u: ChatUpdate): ChatState {
  switch (u.op) {
    case 'reset':
      return u.state.items.some((i) => capped(i) !== i) ? { ...u.state, items: u.state.items.map(capped) } : u.state;
    case 'upsert': {
      const at = state.items.findIndex((i) => i.id === u.item.id);
      const item = capped(ownCount(state.items[at], u.item));
      const items = at === -1 ? [...state.items, item] : state.items.with(at, item);
      return { ...state, items };
    }
    case 'append': {
      // A chunk for an item this side never saw (dropped, or before a reset) is ignored.
      const at = state.items.findIndex((i) => i.id === u.id);
      const current = state.items[at];
      const next = current ? appended(current, u.field, u.chunk) : null;
      return next ? { ...state, items: state.items.with(at, next) } : state;
    }
    case 'older':
      return { ...state, items: [...u.items.map(capped), ...state.items], hasOlder: u.hasOlder };
    case 'meta':
      // The patch's type has no items, but it crosses IPC: never let one through.
      return { ...state, ...u.patch, items: state.items };
  }
}
