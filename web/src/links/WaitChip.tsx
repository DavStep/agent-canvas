// A waiting card's state: "Waiting for Fix login" with a queue glyph, its queued prompt on hover.
import { QueueIcon } from './CardMenu.tsx';
import type { CardWait } from './links.ts';

const short = (text: string, max = 600): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export function WaitChip({ wait }: { wait: CardWait }) {
  return (
    <span className={`chip link-wait is-${wait.status}`} title={`${wait.reason}\n\nQueued prompt:\n${short(wait.prompt)}`}>
      <QueueIcon /><span>{wait.reason}</span>
    </span>
  );
}
