import type { NeedKind } from '../../../shared/types.ts';

// Small outline glyphs share the stroke and 16 px grid of the canvas controls.
const icons = {
  approval: 'M8 1.5 13.5 4v4c0 3-2.6 5.2-5.5 6.5C5.1 13.2 2.5 11 2.5 8V4Zm-2.5 6.3L7.3 10l3.4-4',
  question: 'M2 2.5h12v9H7l-4 3v-3H2zM6.5 5.7c.4-1.8 3.6-1.6 3.2.3-.2.9-1.7 1-1.7 2M8 9.6h.01',
  reply: 'm6.5 3.5-4 4 4 4M3 7.5h6c2.5 0 4.5 1.5 4.5 4.5',
  done: 'M14 8a6 6 0 1 1-12 0 6 6 0 0 1 12 0ZM5.2 8.2 7.2 10.2 10.8 6',
  history: 'M2 2.5V6h3.5M2.2 6A6 6 0 1 1 2.5 11M8 4.5V8l2.4 1.5',
  clock: 'M14 8a6 6 0 1 1-12 0 6 6 0 0 1 12 0ZM8 4.5V8l2.5 1.5',
  branch: 'M4 5v6m0-3c5 0 7-1 7-3M5.5 3.5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0Zm7 0a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0Zm-7 9a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0Z',
  model: 'M8 1.5 14 5v6l-6 3.5L2 11V5ZM2 5l6 3.5L14 5M8 8.5v6',
  command: 'M2 2.5h12v11H2zM4.5 6 7 8l-2.5 2M8.5 10h3',
  edit: 'm3 10 7.8-7.8 3 3L6 13l-4 1Zm6.4-6.4 3 3',
  search: 'M10.5 6.5a4 4 0 1 1-8 0 4 4 0 0 1 8 0Zm-1 3 4.5 4.5',
  read: 'M3 1.5h6l4 4v9H3zM9 1.5v4h4M5.5 8.5h5m-5 3H9',
  message: 'M2 2.5h12v9H7l-4 3v-3H2zM5 6h6M5 8.5h4',
  tool: 'm2 8 3 0 2-5 2 10 2-5h3',
  alert: 'M14 8a6 6 0 1 1-12 0 6 6 0 0 1 12 0ZM8 4.8v3.7M8 11h.01',
} as const;

export function CardIcon({ name }: { name: keyof typeof icons }) {
  return <svg className="card-icon" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d={icons[name]} /></svg>;
}

export const requestIcons = { permission: 'approval', question: 'question', reply: 'done', terminal: 'command', interrupted: 'alert' } as const satisfies Record<NeedKind, keyof typeof icons>;
