// The chats the page has open: one engine `open` per chat id however many listeners attach,
// closed on the last closeChat. Chats are named by card id here (Codex: `codex:<thread id>`);
// the engine knows each by its own id.
import type { ChatState, ChatUpdate } from '../shared/chat.ts';
import { applyUpdate } from '../server/engines/chatLog.ts';
import type { ChatEngine } from '../server/engines/engine.ts';

export interface ChatRoute { engine: ChatEngine; engineId: string }

export interface ChatHubOptions {
  /** The engine behind a card, and the id that engine knows the session by. */
  route(cardId: string): ChatRoute;
  /** Sends one update to the page. */
  push(cardId: string, u: ChatUpdate): void;
  /** A title for a chat whose engine gives none: the card's name. */
  title?(cardId: string): string;
}

interface OpenChat {
  route: ChatRoute;
  refs: number;
  ready: Promise<void>;
  /** The hub's copy, kept current from the updates; null until the engine has opened it. */
  state: ChatState | null;
}

export class ChatHub {
  private readonly chats = new Map<string, OpenChat>();

  constructor(private readonly opts: ChatHubOptions) {}

  async open(cardId: string): Promise<ChatState> {
    const known = this.chats.get(cardId);
    if (known) {
      known.refs++;
      await known.ready;
      return known.state!;
    }
    const route = this.opts.route(cardId);
    const chat: OpenChat = { route, refs: 1, ready: Promise.resolve(), state: null };
    this.chats.set(cardId, chat);
    chat.ready = route.engine.open(route.engineId, (u) => this.forward(cardId, chat, u)).then((state) => {
      chat.state = this.asCard(cardId, state);
    });
    try {
      await chat.ready;
    } catch (err) {
      if (this.chats.get(cardId) === chat) this.chats.delete(cardId);
      throw err;
    }
    if (chat.refs === 0) this.release(cardId, chat); // closed while it opened
    return chat.state!;
  }

  close(cardId: string): void {
    const chat = this.chats.get(cardId);
    if (!chat || chat.refs === 0) return;
    chat.refs--;
    if (chat.refs === 0 && chat.state !== null) this.release(cardId, chat);
  }

  /** The page went away (reload, crash): every chat it had open is closed. */
  closeAll(): void {
    for (const [cardId, chat] of [...this.chats]) {
      chat.refs = 0;
      if (chat.state !== null) this.release(cardId, chat);
    }
  }

  /** The engine for a card: the open chat's, else as routed now. */
  route(cardId: string): ChatRoute {
    return this.chats.get(cardId)?.route ?? this.opts.route(cardId);
  }

  /** The current state of an open chat, or null. */
  state(cardId: string): ChatState | null {
    return this.chats.get(cardId)?.state ?? null;
  }

  private release(cardId: string, chat: OpenChat): void {
    if (this.chats.get(cardId) !== chat) return;
    this.chats.delete(cardId);
    chat.route.engine.close(chat.route.engineId);
  }

  private forward(cardId: string, chat: OpenChat, u: ChatUpdate): void {
    if (this.chats.get(cardId) !== chat) return;
    const update: ChatUpdate = u.op === 'reset' ? { op: 'reset', state: this.asCard(cardId, u.state) } : u;
    if (chat.state !== null) chat.state = applyUpdate(chat.state, update);
    this.opts.push(cardId, update);
  }

  /** The page knows chats by card id, and an untitled one by its card's name. */
  private asCard(cardId: string, state: ChatState): ChatState {
    return { ...state, sessionId: cardId, title: state.title || this.opts.title?.(cardId) || '' };
  }
}
