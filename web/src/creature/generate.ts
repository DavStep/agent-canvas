// Creatures: one small dot-matrix character per session. The provider picks the character, so a
// glance tells Claude Code from Codex: Claude Code sessions are Clawd, a terracotta block on four
// legs; Codex chats are Dot, a blue cloud whose face is a terminal prompt, `>_`, as in the Codex
// logo. The session id picks a topper, so sessions sharing a zone still look apart, and the state
// picks the pose. Creature.tsx turns cells into square dots.
import type { SessionState, SessionView } from '../../../shared/types.ts';

/** The built-in characters; an ACP session borrows one by its icon (see creatureProvider). */
export type Provider = Exclude<SessionView['provider'], 'acp'>;
export type PortraitKind = Provider | 'orchestrator';

/** The character a session shows: its provider's, or for an ACP session the one its icon names
 *  (the generic icon borrows Claude's, tinted: `variant: 'agent'`). */
export function creatureOf(s: Pick<SessionView, 'provider' | 'acp'>): { provider: Provider; variant?: 'agent' } {
  if (s.provider !== 'acp') return { provider: s.provider };
  const icon = s.acp?.icon ?? 'agent';
  return icon === 'agent' ? { provider: 'claude', variant: 'agent' } : { provider: icon };
}
export interface CreatureSpec { topper: number }
export type CreatureState = SessionState | 'done';

/** What a dot is drawn in. Creature.tsx maps each ink to a class; the CSS maps classes to tokens. */
export type Ink =
  | 'body' | 'light' | 'shade' | 'eye' | 'white' | 'metal' | 'prompt' // the creature
  | 'sign' | 'post' | 'cursor' | 'z' | 'check';                 // state marks
/** figure bobs while working, feet stay planted, marks sit beside the head. */
export type Part = 'figure' | 'feet' | 'mark';
export interface Dot { x: number; y: number; ink: Ink; part: Part }
export interface Sprite { cols: number; rows: number; dots: Dot[] }

type Grid = readonly string[];
type Cell = { x: number; y: number; ink: Ink };

const cell = (x: number, y: number, ink: Ink): Cell => ({ x, y, ink });
const range = (from: number, to: number): number[] => Array.from({ length: to - from + 1 }, (_, i) => from + i);

interface Figure {
  /** x body, h highlight, s feet. */
  art: Grid;
  /** Top row of the head and its middle column (the left one of the middle pair). */
  top: number;
  mid: number;
  /** Row of the arm that holds the sign. */
  hand: number;
  /** The face, awake or asleep. */
  face(awake: boolean): Cell[];
}

// ---------- Clawd: Claude Code ----------
// A wide block with tall slit eyes, stub arms on both sides and four legs, as in the Claude Code
// banner. Awake, the slits are open; asleep they close to short lines.
const CLAWD: Figure = {
  art: [
    '..........',
    '..........',
    '..........',
    '.hhxxxxxx.',
    '.hxxxxxxx.',
    'xxxxxxxxxx',
    '.xxxxxxxx.',
    '.xxxxxxxx.',
    '.s.s..s.s.',
    '.s.s..s.s.',
  ],
  top: 3, mid: 4, hand: 5,
  face: (awake) => awake
    ? [cell(2, 4, 'eye'), cell(2, 5, 'eye'), cell(7, 4, 'eye'), cell(7, 5, 'eye')]
    : [cell(2, 5, 'eye'), cell(3, 5, 'eye'), cell(6, 5, 'eye'), cell(7, 5, 'eye')],
};

const CLAWD_MINI: Figure = {
  art: [
    '.......',
    '.......',
    '.hxxxx.',
    '.xxxxx.',
    'xxxxxxx',
    '.xxxxx.',
    '.s.s.s.',
  ],
  top: 2, mid: 3, hand: 4,
  face: (awake) => awake
    ? [cell(2, 3, 'eye'), cell(4, 3, 'eye')]
    : [cell(1, 3, 'eye'), cell(2, 3, 'eye'), cell(4, 3, 'eye'), cell(5, 3, 'eye')],
};

// ---------- Dot: Codex ----------
// A lumpy cloud with a terminal prompt for a face: a chevron and an underscore, `>_`. Asleep, the
// chevron folds flat to a dash, `-_`.
const DOT: Figure = {
  art: [
    '..........',
    '..........',
    '...hhx.x..',
    '.xhxxxxxx.',
    'xxxxxxxxxx',
    'xxxxxxxxxx',
    'xxxxxxxxxx',
    'xxxxxxxxxx',
    '.xxxxxxxxx',
    '..xxx.xxx.',
  ],
  top: 2, mid: 4, hand: 6,
  face: (awake) => [
    ...(awake
      ? [cell(2, 4, 'prompt'), cell(3, 5, 'prompt'), cell(2, 6, 'prompt')]
      : [cell(2, 5, 'prompt'), cell(3, 5, 'prompt')]),
    ...range(5, 7).map((x) => cell(x, 6, 'prompt')),
  ],
};

const DOT_MINI: Figure = {
  art: [
    '.......',
    '..hx.x.',
    '.xxxxxx',
    'xxxxxxx',
    'xxxxxxx',
    'xxxxxxx',
    '.xx.xx.',
  ],
  top: 1, mid: 3, hand: 3,
  face: (awake) => [
    ...(awake
      ? [cell(1, 3, 'prompt'), cell(2, 4, 'prompt'), cell(1, 5, 'prompt')]
      : [cell(1, 4, 'prompt'), cell(2, 4, 'prompt')]),
    cell(3, 5, 'prompt'), cell(4, 5, 'prompt'),
  ],
};

const FIGURES: Record<Provider, { big: Figure; mini: Figure }> = {
  claude: { big: CLAWD, mini: CLAWD_MINI },
  codex: { big: DOT, mini: DOT_MINI },
};

// ---------- Toppers ----------
// Drawn above the head on the 40 and 72 px drawings only. `top` is the head's top row and `mid`
// the left of its two middle columns, so every topper is centred on both characters.
type Topper = (top: number, mid: number) => Cell[];

const TOPPERS: readonly Topper[] = [
  // Bare: the character as it is.
  () => [],
  // Antennae: two stalks leaning out, a bulb on each.
  (top, mid) => [
    cell(mid - 1, top - 1, 'light'), cell(mid + 2, top - 1, 'light'),
    cell(mid - 2, top - 2, 'white'), cell(mid + 3, top - 2, 'white'),
  ],
  // Sprout: a stem and two leaves.
  (top, mid) => [cell(mid + 1, top - 1, 'light'), cell(mid, top - 2, 'light'), cell(mid + 2, top - 2, 'light')],
  // Cap: a dome, the peak out to the left.
  (top, mid) => [
    ...range(mid - 1, mid + 2).map((x) => cell(x, top - 1, 'white')),
    cell(mid - 3, top, 'white'), cell(mid - 2, top, 'white'),
  ],
  // Crown: three points on a band.
  (top, mid) => [
    ...range(mid - 1, mid + 2).map((x) => cell(x, top - 1, 'white')),
    cell(mid - 1, top - 2, 'white'), cell(mid + 2, top - 2, 'white'),
  ],
  // Halo: floating a row above the head.
  (top, mid) => range(mid - 1, mid + 2).map((x) => cell(x, top - 2, 'white')),
  // Top hat: a brim on the head and a short crown with a band.
  (top, mid) => [
    ...range(mid - 2, mid + 3).map((x) => cell(x, top, 'white')),
    ...range(mid - 1, mid + 2).map((x) => cell(x, top - 1, 'metal')),
    ...range(mid - 1, mid + 2).map((x) => cell(x, top - 2, 'white')),
  ],
  // Beanie: a band on the head and a pompom.
  (top, mid) => [
    ...range(mid - 2, mid + 3).map((x) => cell(x, top - 1, 'white')),
    cell(mid, top - 2, 'light'), cell(mid + 1, top - 2, 'light'),
  ],
];

export const TOPPER_COUNT = TOPPERS.length;

/** FNV-1a, 32 bit. */
function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/** A pure function of the id, so a session keeps its creature across restarts. */
export function creatureFor(sessionId: string): CreatureSpec {
  const h = fnv1a(sessionId);
  return { topper: h % TOPPER_COUNT };
}

// ---------- Layout and state marks ----------
// 40 and 72 px: the figure takes columns 0-9 and the state mark sits in columns 10-12, beside
// the head. 20 px: figure in 0-6, mark in 8-10.
const BIG = { cols: 13, rows: 10 } as const;
const MINI = { cols: 11, rows: 7 } as const;

const ARTS: Record<string, Ink> = { x: 'body', h: 'light', s: 'shade' };

function parse(art: Grid): Cell[] {
  const cells: Cell[] = [];
  art.forEach((line, y) => [...line].forEach((ch, x) => {
    const ink = ARTS[ch];
    if (ink) cells.push(cell(x, y, ink));
  }));
  return cells;
}

const Z_TALL: Grid = ['zzz', '..z', '.z.', 'zzz'];
const Z_SMALL: Grid = ['zzz', '.z.', 'zzz'];
const CHECK: Grid = ['..k', 'k.k', '.k.'];

function stamp(grid: Grid, x0: number, y0: number, ink: Ink): Cell[] {
  const cells: Cell[] = [];
  grid.forEach((line, y) => [...line].forEach((ch, x) => { if (ch !== '.') cells.push(cell(x0 + x, y0 + y, ink)); }));
  return cells;
}

/** The state mark beside the head, plus the arm that holds the sign. */
function mark(state: CreatureState, mini: boolean, handRow: number, handFrom: number): { mark: Cell[]; arm: Cell[] } {
  const g = mini
    ? { cursorX: 8, cursorRows: [3, 4, 5], signX: 8, postX: 9, z: Z_SMALL }
    : { cursorX: 11, cursorRows: [6, 7, 8], signX: 10, postX: 11, z: Z_TALL };
  switch (state) {
    case 'working':
      return { mark: g.cursorRows.map((y) => cell(g.cursorX, y, 'cursor')), arm: [] };
    case 'needs_you': {
      const sign = [0, 1].flatMap((y) => range(g.signX, g.signX + 2).map((x) => cell(x, y, 'sign')));
      const post = range(2, handRow - 1).map((y) => cell(g.postX, y, 'post'));
      const arm = range(handFrom, g.postX).map((x) => cell(x, handRow, 'body'));
      return { mark: [...sign, ...post], arm };
    }
    case 'idle':
      return { mark: stamp(g.z, g.signX, 0, 'z'), arm: [] };
    case 'done':
      return { mark: stamp(CHECK, g.signX, 0, 'check'), arm: [] };
    case 'unknown':
      return { mark: [], arm: [] };
  }
}

/** Every dot of one creature in one state. mini is the 20 px drawing, which wears no topper. */
export function spriteFor(spec: CreatureSpec, provider: Provider, state: CreatureState, mini: boolean): Sprite {
  const figure = FIGURES[provider][mini ? 'mini' : 'big'];
  const grid = mini ? MINI : BIG;
  const awake = state !== 'idle' && state !== 'unknown';

  const handCells = [...figure.art[figure.hand] ?? ''].flatMap((ch, x) => (ch === '.' ? [] : [x]));
  const { mark: marks, arm } = mark(state, mini, figure.hand, Math.max(...handCells) + 1);
  const topper = mini ? [] : TOPPERS[spec.topper % TOPPER_COUNT]!(figure.top, figure.mid);

  // Later layers win where they overlap: body, topper, face, arm, mark.
  const cells = new Map<string, Dot>();
  const put = (cs: Cell[], part: (c: Cell) => Part) => {
    for (const c of cs) {
      if (c.x < 0 || c.x >= grid.cols || c.y < 0 || c.y >= grid.rows) continue;
      cells.set(`${c.x},${c.y}`, { ...c, part: part(c) });
    }
  };
  put(parse(figure.art), (c) => (c.ink === 'shade' ? 'feet' : 'figure'));
  put(topper, () => 'figure');
  put(figure.face(awake), () => 'figure');
  put(arm, () => 'figure');
  put(marks, () => 'mark');

  const dots = [...cells.values()].sort((a, b) => a.y - b.y || a.x - b.x);
  return { cols: grid.cols, rows: grid.rows, dots };
}
