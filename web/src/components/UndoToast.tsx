// A short-lived note at the foot of the canvas for a change that can still be taken back.
export interface UndoToastProps {
  message: string;
  onUndo(): void;
  onDismiss(): void;
}

export function UndoToast({ message, onUndo, onDismiss }: UndoToastProps) {
  return (
    <div className="undo-toast" role="status">
      <span>{message}</span>
      <button className="menu-btn" type="button" onClick={onUndo} aria-keyshortcuts="Meta+Z" title="Undo (⌘Z)">
        Undo<kbd>⌘Z</kbd>
      </button>
      <button className="undo-close" type="button" onClick={onDismiss} aria-label="Dismiss">
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 3l6 6M9 3l-6 6" /></svg>
      </button>
    </div>
  );
}
