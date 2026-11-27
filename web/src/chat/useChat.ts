// One open chat: its state kept current from the main process's updates, and its calls.
import { useCallback, useMemo, useSyncExternalStore } from 'react';
import type { ApprovalAnswer, ChatState, ChatUpdate, ImageRef, Owner, Provider, SessionProvider } from '../../../shared/chat.ts';
import { applyUpdate } from '../../../server/engines/chatLog.ts';
import { chatBridge } from '../bridge.ts';
import { isBlockingBanner, READ_ONLY_BANNER, type ProviderBanner } from '../../../shared/banners.ts';

/** The engines' read-only banner; it may be joined to a provider reason with " · ". */
export const READ_ONLY = READ_ONLY_BANNER;

export interface ChatBlocks {
  /** Another program has the session. A Claude chat can still be written to alongside it; a
      Codex one accepts queued messages. */
  readOnly: boolean;
  /** Why the provider cannot work now (not found, signed out), or null. */
  provider: string | null;
  /** A provider warning that still allows sending, or null. */
  warning: string | null;
  /** Why sending is off, or null when it is on. */
  blocked: string | null;
}

/** What stands between the owner and sending: the read-only owner and the provider's blocking
    banner (from the snapshot, else the chat banner's parts that are not the read-only notice).
    A warning banner is shown but blocks nothing. */
export function chatBlocks(state: { owner: Owner; banner: string | null; provider?: SessionProvider }, providerBanner: ProviderBanner | null, busyThere = false): ChatBlocks {
  const readOnly = state.owner === 'elsewhere';
  // A Claude session another app has open takes messages here too, between that app's turns.
  const writable = state.provider === 'codex' || state.provider === 'acp' || (state.provider === 'claude' && !busyThere);
  const parts = (state.banner ?? '').split(' · ').map((s) => s.trim()).filter((s) => s !== '' && s !== READ_ONLY);
  const join = (xs: string[]) => (xs.length === 0 ? null : xs.join(' · '));
  const provider = providerBanner ? (providerBanner.blocking ? providerBanner.text : null) : join(parts.filter(isBlockingBanner));
  const warning = providerBanner ? (providerBanner.blocking ? null : providerBanner.text) : join(parts.filter((p) => !isBlockingBanner(p)));
  return { readOnly, provider, warning, blocked: readOnly && !writable ? READ_ONLY : provider };
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export interface UseChat {
  state: ChatState | null;
  /** Opening failed (say, the engine could not start). */
  error: string | null;
  send(text: string, images: ImageRef[]): Promise<void>;
  interrupt(): Promise<void>;
  answerApproval(approvalId: string, answer: ApprovalAnswer): Promise<void>;
  answerQuestion(questionId: string, answers: Record<string, string>): Promise<void>;
  setModel(model: string): Promise<void>;
  setMode(mode: string): Promise<void>;
  loadOlder(): Promise<void>;
  moveHere(): Promise<boolean>;
}

// A detached preview and its conversation can watch the same session. Both consume the same
// snapshot, including updates received while open() was in flight.
type ChatSnapshot = Pick<UseChat, 'state' | 'error'>;
const OPENING: ChatSnapshot = { state: null, error: null };
interface Subscription {
  snapshot: ChatSnapshot;
  listeners: Set<() => void>;
  off(): void;
}
const subscriptions = new Map<string, Subscription>();

function subscribeChat(id: string, listener: () => void): () => void {
  let sub = subscriptions.get(id);
  if (!sub) {
    const entry: Subscription = { snapshot: OPENING, listeners: new Set(), off: () => {} };
    subscriptions.set(id, entry);
    const early: ChatUpdate[] = [];
    const publish = (snapshot: ChatSnapshot) => {
      entry.snapshot = snapshot;
      entry.listeners.forEach(notify => notify());
    };
    entry.off = chatBridge.onChat(id, update => {
      if (entry.snapshot.state) publish({ state: applyUpdate(entry.snapshot.state, update), error: null });
      else early.push(update);
    });
    chatBridge.open(id).then(
      state => publish({ state: early.reduce(applyUpdate, state), error: null }),
      err => publish({ state: null, error: message(err) }),
    ).finally(() => { early.length = 0; });
    sub = entry;
  }
  sub.listeners.add(listener);
  return () => {
    sub.listeners.delete(listener);
    if (!sub.listeners.size) {
      subscriptions.delete(id);
      sub.off();
      chatBridge.close(id);
    }
  };
}

export function useChat(sessionId: string): UseChat {
  const subscribe = useCallback((listener: () => void) => subscribeChat(sessionId, listener), [sessionId]);
  const read = useCallback(() => subscriptions.get(sessionId)?.snapshot ?? OPENING, [sessionId]);
  const { state, error } = useSyncExternalStore(subscribe, read);

  const send = useCallback((text: string, images: ImageRef[]) => chatBridge.send(sessionId, text, images), [sessionId]);
  const interrupt = useCallback(() => chatBridge.interrupt(sessionId), [sessionId]);
  const answerApproval = useCallback((id: string, a: ApprovalAnswer) => chatBridge.answerApproval(sessionId, id, a), [sessionId]);
  const answerQuestion = useCallback((id: string, a: Record<string, string>) => chatBridge.answerQuestion(sessionId, id, a), [sessionId]);
  const setModel = useCallback((model: string) => chatBridge.setModel(sessionId, model), [sessionId]);
  const setMode = useCallback((mode: string) => chatBridge.setMode(sessionId, mode), [sessionId]);
  const loadOlder = useCallback(() => chatBridge.loadOlder(sessionId), [sessionId]);
  const moveHere = useCallback(() => chatBridge.moveHere(sessionId), [sessionId]);

  // A state from the previous chat never shows under the new one's id.
  const shown = state?.sessionId === sessionId ? state : null;
  return useMemo(() => ({ state: shown, error, send, interrupt, answerApproval, answerQuestion, setModel, setMode, loadOlder, moveHere }),
    [shown, error, send, interrupt, answerApproval, answerQuestion, setModel, setMode, loadOlder, moveHere]);
}
