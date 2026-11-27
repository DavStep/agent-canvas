import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { TOPPER_COUNT, creatureFor, spriteFor, type CreatureSpec, type CreatureState, type Provider, type Sprite } from './generate.ts';

const STATES: CreatureState[] = ['working', 'needs_you', 'idle', 'unknown', 'done'];
const PROVIDERS: Provider[] = ['claude', 'codex'];

function* every() {
  for (const provider of PROVIDERS)
    for (let topper = 0; topper < TOPPER_COUNT; topper++)
      for (const state of STATES)
        for (const mini of [false, true]) yield { spec: { topper } as CreatureSpec, provider, state, mini };
}

const inks = (s: Sprite) => new Set(s.dots.map((d) => d.ink));
const draw = (s: Sprite) => JSON.stringify(s.dots);

describe('creatureFor', () => {
  it('has at least 8 toppers', () => {
    expect(TOPPER_COUNT).toBeGreaterThanOrEqual(8);
  });

  it('gives one id the same creature every time', () => {
    const id = '0f6c2a8e-5d41-4b7e-9c3a-1e2f3a4b5c6d';
    expect(creatureFor(id)).toEqual(creatureFor(id));
    expect(creatureFor('a')).not.toEqual(creatureFor('b'));
  });

  it('reaches every topper over 200 random ids', () => {
    const specs = Array.from({ length: 200 }, () => creatureFor(randomUUID()));
    expect(new Set(specs.map((s) => s.topper)).size).toBe(TOPPER_COUNT);
  });
});

describe('spriteFor', () => {
  it('keeps every dot inside the grid, one dot per cell', () => {
    for (const { spec, provider, state, mini } of every()) {
      const sprite = spriteFor(spec, provider, state, mini);
      const seen = new Set<string>();
      for (const d of sprite.dots) {
        const where = `${provider} ${JSON.stringify(spec)} ${state} ${mini} ${d.x},${d.y}`;
        expect(d.x, where).toBeGreaterThanOrEqual(0);
        expect(d.x, where).toBeLessThan(sprite.cols);
        expect(d.y, where).toBeGreaterThanOrEqual(0);
        expect(d.y, where).toBeLessThan(sprite.rows);
        expect(seen.has(`${d.x},${d.y}`), where).toBe(false);
        seen.add(`${d.x},${d.y}`);
      }
    }
  });

  it('tells the providers apart in every pose and size: Clawd stands on legs, Dot wears a prompt', () => {
    for (const { spec, provider, state, mini } of every()) {
      const sprite = spriteFor(spec, provider, state, mini);
      const legs = sprite.dots.some((d) => d.part === 'feet');
      expect(legs).toBe(provider === 'claude');
      expect(inks(sprite).has('prompt')).toBe(provider === 'codex');
    }
  });

  it('gives Dot a `>_` face that folds to `-_` asleep', () => {
    for (const mini of [false, true]) {
      const face = (state: CreatureState) => spriteFor({ topper: 0 }, 'codex', state, mini).dots.filter((d) => d.ink === 'prompt');
      const rows = (state: CreatureState) => new Set(face(state).map((d) => d.y)).size;
      expect(rows('working')).toBe(3); // the chevron spans three rows, its foot shared with the underscore
      expect(rows('idle')).toBe(2);
    }
  });

  it('closes the eyes when idle or unknown and opens them otherwise', () => {
    for (const { spec, provider, state, mini } of every()) {
      const eyes = (s: CreatureState) => draw({ ...spriteFor(spec, provider, s, mini), dots: spriteFor(spec, provider, s, mini).dots.filter((d) => d.ink === 'eye' || d.ink === 'prompt') });
      const asleep = state === 'idle' || state === 'unknown';
      if (asleep) expect(eyes(state)).toBe(eyes('idle'));
      else expect(eyes(state)).not.toBe(eyes('idle'));
    }
  });

  it('marks each state its own way, with at most one mark', () => {
    for (const provider of PROVIDERS) {
      for (const mini of [false, true]) {
        const has = (state: CreatureState) => inks(spriteFor({ topper: 0 }, provider, state, mini));
        expect(has('working').has('cursor')).toBe(true);
        expect(has('needs_you').has('sign')).toBe(true);
        expect(has('idle').has('z')).toBe(true);
        expect(has('unknown').has('z')).toBe(false);
        expect(has('done').has('check')).toBe(true);
        for (const state of STATES) {
          expect(['cursor', 'sign', 'z', 'check'].filter((ink) => has(state).has(ink as never)).length).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it('holds the sign with an arm that reaches the post', () => {
    for (const provider of PROVIDERS) {
      for (const mini of [false, true]) {
        const dots = spriteFor({ topper: 0 }, provider, 'needs_you', mini).dots;
        const post = dots.filter((d) => d.ink === 'post');
        const lowest = post.reduce((a, b) => (b.y > a.y ? b : a));
        expect(dots.some((d) => d.ink === 'body' && d.x === lowest.x && d.y === lowest.y + 1)).toBe(true);
      }
    }
  });

  it('gives every topper its own look at 40 px and none at 20 px', () => {
    for (const provider of PROVIDERS) {
      const looks = new Set<string>();
      for (let topper = 0; topper < TOPPER_COUNT; topper++) {
        looks.add(draw(spriteFor({ topper }, provider, 'working', false)));
        expect(draw(spriteFor({ topper }, provider, 'working', true)))
          .toBe(draw(spriteFor({ topper: 0 }, provider, 'working', true)));
      }
      expect(looks.size).toBe(TOPPER_COUNT);
    }
  });

  it('draws every topper whole on both characters, never cut off at the top', () => {
    // The first row of each head, as drawn in generate.ts.
    const head: Record<Provider, number> = { claude: 3, codex: 2 };
    const above = (provider: Provider, topper: number) =>
      spriteFor({ topper }, provider, 'working', false).dots.filter((d) => d.y < head[provider]).length;
    for (let topper = 0; topper < TOPPER_COUNT; topper++) {
      expect(above('codex', topper), `topper ${topper}`).toBe(above('claude', topper));
    }
    expect(above('claude', 0)).toBe(0);
  });
});
