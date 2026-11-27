// A preview kept on the board, folded to one row in its zone: its title opens it there, × takes
// it off the board. It arrives and leaves as a card does (motion.css).
import { useClosing } from '../useClosing.ts';

export function BoardPreviewRow({ title, onOpen, onRemove }: { title: string; onOpen(): void; onRemove(): void }) {
  const { closing, close } = useClosing(onRemove);
  return (
    <div className={`board-preview-row${closing ? ' is-closing' : ''}`}>
      <button type="button" title={title} aria-label={`Open preview for ${title}`} onClick={onOpen}>
        <span aria-hidden="true">▣</span> {title}
      </button>
      <button type="button" aria-label={`Remove preview for ${title} from board`} onClick={close}>×</button>
    </div>
  );
}
