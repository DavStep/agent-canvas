export const noteAppearances = {
  canvas: 'Canvas',
  paper: 'Paper',
  holographic: 'Holographic',
} as const;
export type NoteAppearance = keyof typeof noteAppearances;

const KEY = 'agent-canvas.note-appearance';

export function readNoteAppearance(): NoteAppearance {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === 'paper' || saved === 'holographic') return saved;
  } catch { /* Storage can be unavailable. */ }
  return 'canvas';
}

export function saveNoteAppearance(value: NoteAppearance): void {
  try { localStorage.setItem(KEY, value); } catch { /* The choice still applies to this window. */ }
}
