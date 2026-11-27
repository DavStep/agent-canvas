import { describe, expect, it } from 'vitest';
import { clampMenu } from './ZoneMenu.tsx';
import { removeNote } from './Zone.tsx';
import type { ZoneLayout } from '../../../shared/types.ts';

describe('clampMenu', () => {
  it('opens at the pointer when there is room', () => {
    expect(clampMenu(100, 200, 264, 120, 1440, 900)).toEqual({ x: 100, y: 200 });
  });
  it('stays inside the window near the right and bottom edges', () => {
    expect(clampMenu(1400, 880, 264, 120, 1440, 900)).toEqual({ x: 1440 - 264 - 8, y: 900 - 120 - 8 });
  });
  it('stays inside the window near the top-left', () => {
    expect(clampMenu(-20, 2, 264, 120, 1440, 900)).toEqual({ x: 8, y: 8 });
  });
});

describe('removeNote', () => {
  const zone = (kind: ZoneLayout['kind']) => ({ id: 'z', name: 'Work', kind, hueIndex: 0 }) as ZoneLayout;
  it('says a custom zone is deleted and its cards go home', () => {
    expect(removeNote(zone('custom'), 'the Zones menu')).toBe('Delete “Work”? Its cards go back to their folder zones.');
  });
  it('says where a removed folder zone comes back from', () => {
    expect(removeNote(zone('folder'), 'the Zones menu')).toContain('or from the Zones menu.');
  });
});
