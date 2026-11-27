// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { OpenThread } from '../../../shared/threads.ts';
import { dropAt, dropLabel, projectLabel, readDragged, spokenAgo, threadMessage } from './threads.ts';

const MIN = 60_000;
const thread: OpenThread = {
  id: 'b8fd#abc',
  title: 'Tile Merger events',
  summary: 'Four event ideas: Tile Rush, Gem Hunt, Stack Race and Swap Duel.\nStack Race first.',
  question: 'Gate events by location or by Stone, and start with bots or real players?',
  sessionId: 'b8fd',
  sessionName: 'Canvas agent',
  provider: 'claude',
  cwd: '/Users/owner/.agent-canvas/agent',
  folder: 'agent',
  askedAt: 0,
  foundAt: 1,
  excerpt: 'My pick is Stack Race.\n\nShould events be gated by location or by Coins?',
  state: 'open',
};

function board(): HTMLElement {
  document.body.innerHTML = `
    <div class="canvas-area">
      <main class="workspace">
        <section class="zone" data-zone-id="z1"><div class="card" data-card-id="c1"><span id="in-card">x</span></div><p id="in-zone">y</p>
          <article class="thread-note"><p id="in-note">t</p></article></section>
        <p id="on-canvas">z</p>
      </main>
      <div class="composer"><textarea id="field"></textarea></div>
      <p id="elsewhere">e</p>
    </div>`;
  return document.body;
}
const at = (id: string) => dropAt(document.getElementById(id));

describe('dropAt', () => {
  it('reads the composer, a card, a zone and the empty canvas, most specific first', () => {
    board();
    expect(at('field')?.drop).toEqual({ kind: 'composer' });
    expect(at('in-card')?.drop).toEqual({ kind: 'card', id: 'c1' });
    expect(at('in-zone')?.drop).toEqual({ kind: 'zone', id: 'z1' });
    expect(at('on-canvas')?.drop).toEqual({ kind: 'canvas' });
  });
  it('rings the whole target', () => {
    board();
    expect(at('in-card')?.target.getAttribute('data-card-id')).toBe('c1');
    expect(at('field')?.target.className).toBe('composer');
  });
  it('is no target on a thread note, even inside a zone, or outside the canvas and chat', () => {
    board();
    expect(at('in-note')).toBeNull();
    expect(at('elsewhere')).toBeNull();
    expect(dropAt(null)).toBeNull();
  });
  it('says what each drop does', () => {
    expect(dropLabel({ kind: 'composer' })).toBe('Add to this message');
    expect(dropLabel({ kind: 'zone', id: 'z' })).toBe('Start a session here');
    expect(dropLabel(null)).toBe('Drop on a chat, a card or a zone');
  });
});

describe('threadMessage', () => {
  it('carries the summary, the open question, the source and the passage', () => {
    const text = threadMessage(thread, 26 * 60 * MIN);
    expect(text).toContain('**Tile Merger events**');
    expect(text).toContain('Stack Race first.');
    expect(text).toContain('**Still open:** Gate events by location or by Stone');
    expect(text).toContain('This came from “Canvas agent” about 26 hours ago, working in /Users/owner/.agent-canvas/agent.');
    expect(text).toContain('> Should events be gated by location or by Coins?');
  });
  it('says how long ago in words', () => {
    expect(spokenAgo(0, 1 * MIN)).toBe('1 minute');
    expect(spokenAgo(0, 40 * MIN)).toBe('40 minutes');
    expect(spokenAgo(0, 3 * 60 * MIN)).toBe('3 hours');
    expect(spokenAgo(0, 3 * 24 * 60 * MIN)).toBe('3 days');
  });
});

describe('helpers', () => {
  it('names the project by its folder', () => {
    expect(projectLabel(thread)).toBe('agent');
    expect(projectLabel({ ...thread, folder: '', cwd: '/Users/owner/shop' })).toBe('shop');
    expect(projectLabel({ ...thread, folder: '', cwd: '' })).toBe('No folder');
  });
  it('reads back only a ticket it knows', () => {
    expect(readDragged(JSON.stringify({ id: thread.id }), [thread])).toBe(thread);
    expect(readDragged(JSON.stringify({ id: 'other' }), [thread])).toBeNull();
    expect(readDragged('not json', [thread])).toBeNull();
  });
});
