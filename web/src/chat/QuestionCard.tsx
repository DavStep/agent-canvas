// A question from the session (Claude's AskUserQuestion, Codex's requestUserInput). A secret
// question is typed into a masked field that React never holds: its value is read once on
// sending, then cleared, and the thread shows "Hidden" in its place.
import { memo, useRef, useState } from 'react';
import type { ChatItem, Question } from '../../../shared/chat.ts';

export type QuestionItem = Extract<ChatItem, { kind: 'question' }>;

const RECOMMENDED = /\s*[([]\s*recommended\s*[)\]]/i;

/** An option's label as shown, and whether the session marked it "(Recommended)" (both Claude
    and Codex mark their pick that way, in the label). The answer sent back keeps the full label. */
export function optionLabel(label: string): { name: string; recommended: boolean } {
  const recommended = RECOMMENDED.test(label);
  return { name: recommended ? label.replace(RECOMMENDED, '').trim() || label : label, recommended };
}

/** The option a question recommends, when it marks one. */
export function recommendedOf(q: Question): string | null {
  return q.isSecret ? null : q.options.find((o) => optionLabel(o.label).recommended)?.label ?? null;
}

/** What a skipped question answers with (the Claude app's wording), so the session knows it was
    passed over rather than left blank. */
export const SKIPPED = '[No preference]';

/** How an answer appears in the thread: a secret one never does. */
export function shownAnswer(q: Question, answer: string | undefined): string {
  if (q.isSecret) return 'Hidden';
  if (answer === SKIPPED) return 'Skipped';
  return answer === undefined || answer === '' ? 'No answer' : answer.replace(new RegExp(RECOMMENDED, 'gi'), '');
}

const wasAnswered = (answer: string | undefined): boolean => answer !== undefined && answer !== '' && answer !== SKIPPED;

/** `otherOn`: the "Other" row is chosen and its field shown. `skipped`: passed over with Skip. */
interface Draft { picked: string[]; other: string; otherOn: boolean; skipped: boolean }
const EMPTY: Draft = { picked: [], other: '', otherOn: false, skipped: false };

function answerOf(d: Draft | undefined): string {
  if (!d) return '';
  const other = d.otherOn ? d.other.trim() : '';
  return [...d.picked, ...(other ? [other] : [])].join(', ');
}

export interface QuestionCardProps {
  item: QuestionItem;
  onAnswer(answers: Record<string, string>): Promise<void>;
}

/** Drawn again only when its props change: unchanged items keep their identity (applyUpdate),
    so a streaming chat redraws only the item that grows. */
export const QuestionCard = memo(function QuestionCard({ item, onAnswer }: QuestionCardProps) {
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  // Whether each secret field has something in it; never the text itself.
  const [filled, setFilled] = useState<Record<string, boolean>>({});
  const secrets = useRef(new Map<string, HTMLInputElement>());
  // Several questions are asked one at a time; `page` is the one shown.
  const [page, setPage] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const count = item.questions.length;

  if (item.status !== 'pending') {
    const answered = item.questions.filter((q) => wasAnswered(item.answers?.[q.id])).length;
    return (
      <div className={`t-question is-${item.status}`} role="group" aria-label="Question">
        {count > 1 && item.status === 'answered' && <div className="t-q-tally">{answered}/{count} answered</div>}
        {item.questions.map((q) => (
          <div key={q.id} className="t-q-done">
            <span className="t-q-head">{q.header || q.text}</span>
            <span className={`t-q-answer${item.status === 'answered' && !q.isSecret && !wasAnswered(item.answers?.[q.id]) ? ' is-none' : ''}`}>
              {item.status === 'expired' ? 'Expired' : shownAnswer(q, item.answers?.[q.id])}
            </span>
          </div>
        ))}
      </div>
    );
  }

  const draft = (id: string): Draft => drafts[id] ?? EMPTY;
  const set = (id: string, d: Draft) => setDrafts((all) => ({ ...all, [id]: d }));
  const pick = (q: Question, label: string) => {
    const d = draft(q.id);
    if (q.multiSelect) set(q.id, { ...d, skipped: false, picked: d.picked.includes(label) ? d.picked.filter((l) => l !== label) : [...d.picked, label] });
    else set(q.id, { ...EMPTY, other: d.other, picked: [label] });
  };
  const pickOther = (q: Question) => {
    const d = draft(q.id);
    if (q.multiSelect) set(q.id, { ...d, skipped: false, otherOn: !d.otherOn });
    else set(q.id, { ...EMPTY, other: d.other, otherOn: true });
  };
  const has = (q: Question): boolean => (q.isSecret ? filled[q.id] === true : answerOf(drafts[q.id]) !== '');
  const settled = (q: Question, skips: ReadonlySet<string>): boolean => has(q) || skips.has(q.id) || draft(q.id).skipped;

  const at = Math.min(page, count - 1);
  const current = item.questions[at];
  const last = at === count - 1;
  const none = new Set<string>();
  const ready = item.questions.every((q) => settled(q, none));
  const untouched = item.questions.every((q) => !settled(q, none));

  // One press answers the whole card with the session's own picks, when every question has one.
  const picks = item.questions.map(recommendedOf);
  const canRecommend = count > 0 && picks.every((p) => p !== null);

  const send = (answers: Record<string, string>) => {
    // The secret leaves the page in this one call; the fields are emptied at once.
    for (const input of secrets.current.values()) input.value = '';
    setFilled({});
    setBusy(true);
    setError(null);
    onAnswer(answers).catch((err: unknown) => setError(err instanceof Error ? err.message : String(err))).finally(() => setBusy(false));
  };
  const submit = (skips: ReadonlySet<string> = none) => {
    if (busy || !item.questions.every((q) => settled(q, skips))) return;
    const answers: Record<string, string> = {};
    for (const q of item.questions) {
      const skipped = skips.has(q.id) || (draft(q.id).skipped && !has(q));
      answers[q.id] = skipped ? SKIPPED : q.isSecret ? secrets.current.get(q.id)?.value ?? '' : answerOf(drafts[q.id]);
    }
    send(answers);
  };
  const useRecommended = () => {
    if (busy || !canRecommend) return;
    send(Object.fromEntries(item.questions.map((q, i) => [q.id, picks[i]!])));
  };
  /** Next on every page but the last, where it answers. */
  const advance = () => {
    if (!current || !settled(current, none)) return;
    if (last) submit(); else setPage(at + 1);
  };
  const skip = () => {
    if (!current || busy) return;
    const input = secrets.current.get(current.id);
    if (input) { input.value = ''; setFilled((f) => ({ ...f, [current.id]: false })); }
    set(current.id, { ...EMPTY, skipped: true });
    // The last page answers at once; the skip just made is not in `drafts` yet, so it is passed along.
    if (last) submit(new Set([current.id])); else setPage(at + 1);
  };

  return (
    <form className={`t-question is-pending${count > 1 ? ' has-pager' : ''}`} aria-label="Question" onSubmit={(e) => { e.preventDefault(); advance(); }}>
      {count > 1 && (
        <div className="t-q-pager">
          <span>{at + 1} of {count}</span>
          <button type="button" aria-label="Previous question" disabled={at === 0} onClick={() => setPage(at - 1)}>
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M7.5 2.5 4 6l3.5 3.5" /></svg>
          </button>
          <button type="button" aria-label="Next question" disabled={last} onClick={() => setPage(at + 1)}>
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M4.5 2.5 8 6 4.5 9.5" /></svg>
          </button>
        </div>
      )}
      {item.questions.map((q, i) => {
        const d = draft(q.id);
        const mark = q.multiSelect ? 'mark box' : 'mark';
        const role = q.multiSelect ? 'checkbox' : 'radio';
        return (
          // Every question stays mounted (a secret field holds its own text); only the page shown is visible.
          <fieldset key={q.id} className="t-q" hidden={i !== at}>
            {q.header !== '' && <legend className="t-q-head">{q.header}</legend>}
            <p className="t-q-text">{q.text}</p>
            {q.isSecret ? (
              <input
                className="t-q-input"
                type="password"
                autoComplete="off"
                spellCheck={false}
                aria-label={q.header || q.text}
                ref={(el) => { if (el) secrets.current.set(q.id, el); else secrets.current.delete(q.id); }}
                onInput={(e) => { const full = e.currentTarget.value !== ''; setFilled((f) => (f[q.id] === full ? f : { ...f, [q.id]: full })); }}
              />
            ) : q.options.length === 0 ? (
              <input
                className="t-q-input"
                type="text"
                placeholder="Your answer"
                aria-label={q.header || q.text}
                value={d.other}
                onChange={(e) => set(q.id, { ...EMPTY, otherOn: true, other: e.target.value })}
              />
            ) : (
              <div className="t-q-options" role={q.multiSelect ? 'group' : 'radiogroup'}>
                {q.options.map((o) => {
                  const on = d.picked.includes(o.label);
                  const { name, recommended } = optionLabel(o.label);
                  return (
                    <button key={o.label} type="button" className={`t-q-option${on ? ' is-on' : ''}`}
                      role={role} aria-checked={on} onClick={() => pick(q, o.label)}>
                      <i className={mark} aria-hidden="true" />
                      <span className="b">
                        <span className="l">{name}{recommended && <em className="t-q-rec">Recommended</em>}</span>
                        {o.description !== '' && <span className="d">{o.description}</span>}
                      </span>
                    </button>
                  );
                })}
                {q.allowOther && (
                  <>
                    <button type="button" className={`t-q-option${d.otherOn ? ' is-on' : ''}`} role={role} aria-checked={d.otherOn} onClick={() => pickOther(q)}>
                      <i className={mark} aria-hidden="true" />
                      <span className="b"><span className="l">Other</span></span>
                    </button>
                    {d.otherOn && (
                      <input
                        className="t-q-input"
                        type="text"
                        autoFocus
                        placeholder="Type your own answer"
                        aria-label={`${q.header || q.text}: other`}
                        value={d.other}
                        onChange={(e) => set(q.id, { ...d, skipped: false, other: e.target.value })}
                      />
                    )}
                  </>
                )}
              </div>
            )}
          </fieldset>
        );
      })}
      <div className="t-ask-actions">
        {canRecommend && untouched && (
          <button type="button" className="t-btn t-q-primary" disabled={busy} onClick={useRecommended}>
            <span>{count === 1 ? `Use ${optionLabel(picks[0]!).name}` : count === 2 ? 'Use both recommendations' : `Use all ${count} recommendations`}</span>
            <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true"><path d="m3 8 3.2 3.2L13 4.5" /></svg>
          </button>
        )}
        <button type="submit" className={`t-btn ${canRecommend && untouched ? 'outline' : 't-q-primary'}`} disabled={busy || !current || !settled(current, none) || (last && !ready)}>
          {last ? 'Answer' : 'Next'}
          {!last && <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8h10M8.5 3.5 13 8l-4.5 4.5" /></svg>}
        </button>
        <button type="button" className="t-btn ghost" disabled={busy} onClick={skip}>Skip</button>
        {error !== null && <span className="t-ask-error" role="alert">{error}</span>}
      </div>
    </form>
  );
});
