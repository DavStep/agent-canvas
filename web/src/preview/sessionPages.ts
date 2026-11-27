// One preview view serves every chat, so each session's page is remembered here (in memory only,
// never on disk) and put back when the chat moves to that session; a session with none gets an
// empty view. A page from one session never shows under another's chat.
import type { PreviewCommand } from '../../../shared/bridge.ts';

export interface SessionPage {
  /** The page last open in the Browser tab for this session. */
  url: string | null;
  /** The owner typed an address in this session: pages then open as typed, and printed local
      addresses no longer open by themselves. */
  typed: boolean;
  /** The printed local address already opened by itself, so it opens once. */
  autoLoaded: string | null;
  /** The tab the owner last picked in this session's preview, so hiding and showing it again
      (the chat header's toggle) comes back to the same view. */
  tab?: 'live' | 'browser' | 'capture';
}

/** Keyed by SessionView id, for the life of the page. */
export const sessionPages = new Map<string, SessionPage>();

/** The session whose page the view holds now (null: none yet in this page's life). */
let viewHolds: string | null = null;
export const holder = {
  get: (): string | null => viewHolds,
  set: (id: string | null): void => { viewHolds = id; },
};

export function pageOf(pages: Map<string, SessionPage>, id: string): SessionPage {
  let page = pages.get(id);
  if (!page) {
    page = { url: null, typed: false, autoLoaded: null };
    pages.set(id, page);
  }
  return page;
}

/** What to send when the view should show `next`'s page; null when it already does. */
export function switchCommand(pages: ReadonlyMap<string, SessionPage>, current: string | null, next: string): PreviewCommand | null {
  if (current === next) return null;
  const page = pages.get(next);
  // Fresh: nothing of the last session's page (its drawing, its history) carries over.
  if (page?.url) return { kind: 'navigate', url: page.url, typed: page.typed, fresh: true };
  return { kind: 'clear' };
}

/** Records the page now open for a session, and whether the owner typed it. */
export function remember(pages: Map<string, SessionPage>, id: string, change: { url: string | null; typed?: boolean }): void {
  const page = pageOf(pages, id);
  page.url = change.url;
  if (change.typed !== undefined) page.typed = change.typed;
}
