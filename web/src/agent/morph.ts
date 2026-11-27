// The canvas agent's orb becoming its panel, and the panel becoming the orb again. One layer over
// the page carries it (a shared element, FLIP: both ends are measured once, then only the layer
// moves): a surface that starts as the round button and ends as the panel, flying a short bowed
// path while it grows and squares off, and on it the orb, which ends as the mark beside the
// panel's title. The frames are plain numbers (tested); `fly` plays them. See docs/motion.md.

export interface Box { x: number; y: number; width: number; height: number }
export type FlightDir = 'open' | 'close';

/** How long each way takes. Out is shorter, as every exit is. */
export const FLIGHT_MS: Record<FlightDir, number> = { open: 480, close: 420 };
/** Keyframes per flight: about one a frame, so the path and the shape are exact, not eased between two ends. */
const SAMPLES = 28;
/** How far the path bows off the straight line, as a share of its length. */
const BOW = 0.16;
/** Closing, the surface barely shrinks at first (the power its time is raised to), while the
    panel's content fades on it; then it gathers quickly. */
const HOLD = 2.2;
/** After landing as the panel the orb stays this long, over the real mark fading in beneath it. */
const ORB_HOLD_MS = 240;

export interface FlightPlan {
  /** The round button on the canvas. */
  orb: Box;
  /** How large the orb is drawn on it. */
  glyph: number;
  /** The panel where it stands when open. */
  panel: Box;
  /** The orb drawn beside the panel's title, or null when the panel shows none. */
  mark: Box | null;
  /** The panel's corner radius. */
  radius: number;
}

export interface FlightFrame {
  /** 0 to 1 through the flight. */
  offset: number;
  /** The surface, and its corner radius. */
  box: Box;
  radius: number;
  /** The orb on it: its centre, its size (1 as on the button) and how solid it is. */
  orb: { x: number; y: number; scale: number; opacity: number };
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
/** Between two sizes by ratio, so a thing forty pixels wide and one four hundred wide both seem to grow evenly. */
const grown = (a: number, b: number, t: number): number => a * Math.pow(b / a, t);
const clamp01 = (t: number): number => Math.max(0, Math.min(1, t));
const smooth = (t: number): number => t * t * (3 - 2 * t);
const outCubic = (t: number): number => 1 - Math.pow(1 - t, 3);
const inOutCubic = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
/** Past its mark by a twentieth, then back: the landing's overshoot. */
const outBack = (t: number): number => 1 + 2.2 * Math.pow(t - 1, 3) + 1.2 * Math.pow(t - 1, 2);

const centre = (b: Box): { x: number; y: number } => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });

/** The path's control point: the middle of the straight line, pushed off it to the upper side. */
function bow(from: { x: number; y: number }, to: { x: number; y: number }): { x: number; y: number } {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const side = dx >= 0 ? 1 : -1;
  return { x: (from.x + to.x) / 2 + side * dy * BOW, y: (from.y + to.y) / 2 - side * dx * BOW };
}

/**
 * The layer at one moment. `travel` is how far along the path from the button (0) to the panel
 * (1); `grow` how far the surface is from the button's size to the panel's. Below 0 it is smaller
 * than the button: the squeeze of landing.
 */
export function frameAt(plan: FlightPlan, travel: number, grow: number, offset = 0): FlightFrame {
  const a = centre(plan.orb);
  const b = centre(plan.panel);
  const c = bow(a, b);
  const t = clamp01(travel);
  const cx = (1 - t) * (1 - t) * a.x + 2 * (1 - t) * t * c.x + t * t * b.x;
  const cy = (1 - t) * (1 - t) * a.y + 2 * (1 - t) * t * c.y + t * t * b.y;
  const g = Math.min(1, grow);
  const width = grown(plan.orb.width, plan.panel.width, g);
  const height = grown(plan.orb.height, plan.panel.height, g);
  const box = { x: cx - width / 2, y: cy - height / 2, width, height };
  const round = Math.min(width, height) / 2;
  const squared = Math.pow(clamp01(g), 0.7);
  const radius = Math.min(round, lerp(round, plan.radius, squared));
  // The orb rides the surface from its middle to where the mark is drawn on the panel.
  const ride = smooth(clamp01(g));
  const squeeze = g < 0 ? width / plan.orb.width : 1;
  const mark = plan.mark;
  const orb = mark === null
    ? { x: cx, y: cy, scale: lerp(1, 0.6, ride) * squeeze, opacity: 1 - smooth(clamp01(g * 2.5)) }
    : {
        x: box.x + lerp(width / 2, mark.x + mark.width / 2 - plan.panel.x, ride),
        y: box.y + lerp(height / 2, mark.y + mark.height / 2 - plan.panel.y, ride),
        scale: lerp(1, mark.width / plan.glyph, ride) * squeeze,
        opacity: 1,
      };
  return { offset, box, radius, orb };
}

/**
 * Every frame of one flight. Opening, the orb leaves quickly and is nearly there before it grows
 * much, then blooms into the panel and settles. Closing, the panel gathers into the orb first,
 * which glides home and lands a little small before it springs to size.
 */
export function flightFrames(dir: FlightDir, plan: FlightPlan, samples = SAMPLES): FlightFrame[] {
  const frames: FlightFrame[] = [];
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    frames.push(dir === 'open'
      ? frameAt(plan, outCubic(t), inOutCubic(Math.pow(t, 0.9)), t)
      : frameAt(plan, 1 - inOutCubic(t), 1 - outBack(Math.pow(t, HOLD)), t));
  }
  return frames;
}

const n = (v: number): string => String(Math.round(v * 1000) / 1000);
const px = (v: number): string => `${Math.round(v * 100) / 100}px`;

/** The surface's keyframes. It is laid out once at the panel's size and only transformed; its
    corners and border are divided by the scale so they stay round and a pixel wide on screen. */
export function shapeKeyframes(frames: FlightFrame[], panel: Box): Keyframe[] {
  return frames.map((f) => {
    const sx = f.box.width / panel.width;
    const sy = f.box.height / panel.height;
    return {
      offset: f.offset,
      transform: `translate(${px(f.box.x)}, ${px(f.box.y)}) scale(${n(sx)}, ${n(sy)})`,
      borderRadius: `${px(f.radius / sx)} / ${px(f.radius / sy)}`,
      borderWidth: `${px(1 / sy)} ${px(1 / sx)}`,
    };
  });
}

/** The orb's keyframes: an element the button orb's size, moved by its centre. */
export function orbKeyframes(frames: FlightFrame[], size: number): Keyframe[] {
  return frames.map((f) => ({
    offset: f.offset,
    transform: `translate(${px(f.orb.x - size / 2)}, ${px(f.orb.y - size / 2)}) scale(${n(f.orb.scale)})`,
    opacity: n(f.orb.opacity),
  }));
}

/** A surface's two colours. */
export interface Surface { background: string; border: string }

export interface FlightOptions {
  dir: FlightDir;
  plan: FlightPlan;
  /** The button's orb, copied onto the layer. */
  glyph: HTMLElement;
  button: Surface;
  panel: Surface;
  /** The layer has arrived, as the panel (`open`) or as the button (`close`): show the real one now. */
  onLand(dir: FlightDir): void;
}

export interface Flight {
  /** Where it is heading now. */
  readonly dir: FlightDir;
  /** Turns round where it is and flies back the way it came. */
  reverse(): void;
  /** Takes the layer away at once, without landing. */
  cancel(): void;
}

const LAYER = 'agent-flight';

/** Plays one flight on a layer of its own. There is only ever one layer: a new flight clears the last. */
export function fly(o: FlightOptions): Flight | null {
  if (typeof document === 'undefined' || typeof Element.prototype.animate !== 'function') return null;
  for (const old of document.querySelectorAll(`.${LAYER}`)) old.remove();
  const { plan } = o;
  const layer = document.createElement('div');
  layer.className = LAYER;
  layer.setAttribute('aria-hidden', 'true');
  const shape = document.createElement('div');
  shape.className = `${LAYER}-shape`;
  shape.style.width = px(plan.panel.width);
  shape.style.height = px(plan.panel.height);
  const orb = o.glyph.cloneNode(true) as HTMLElement;
  orb.classList.add(`${LAYER}-orb`);
  layer.append(shape, orb);
  document.body.append(layer);

  const frames = flightFrames(o.dir, plan);
  const shapeFrames = shapeKeyframes(frames, plan.panel);
  const [from, to] = o.dir === 'open' ? [o.button, o.panel] : [o.panel, o.button];
  Object.assign(shapeFrames[0]!, { backgroundColor: from.background, borderColor: from.border });
  Object.assign(shapeFrames.at(-1)!, { backgroundColor: to.background, borderColor: to.border });
  const duration = FLIGHT_MS[o.dir];
  const timing: KeyframeAnimationOptions = { duration, easing: 'linear', fill: 'both' };
  const anims = [shape.animate(shapeFrames, timing), orb.animate(orbKeyframes(frames, plan.glyph), timing)];

  let dir = o.dir;
  let over = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const land = () => {
    if (over) return;
    over = true;
    clearTimeout(timer);
    o.onLand(dir);
    // As the panel, the orb waits on the mark until the panel's own has faded in under it.
    if (dir === 'open' && plan.mark !== null) {
      shape.remove();
      setTimeout(() => layer.remove(), ORB_HOLD_MS);
    } else {
      layer.remove();
    }
  };
  // Frames stop in a window out of view; the timer lands the layer regardless.
  const arm = (ms: number) => { clearTimeout(timer); timer = setTimeout(land, ms + 160); };
  anims[0]!.onfinish = land;
  arm(duration);
  return {
    get dir() { return dir; },
    reverse() {
      if (over) return;
      dir = dir === 'open' ? 'close' : 'open';
      for (const a of anims) a.reverse();
      const at = Number(anims[0]!.currentTime ?? 0);
      arm(dir === o.dir ? duration - at : at);
    },
    cancel() {
      if (over) return;
      over = true;
      clearTimeout(timer);
      layer.remove();
    },
  };
}
