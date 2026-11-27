import { describe, expect, it } from 'vitest';
import { DEFAULT_SLOT_SETTINGS, parseSlotSettings } from './slotSettings.ts';
import { stripOrder } from '../components/Briefing.tsx';
import { session } from '../testSession.ts';

describe('card order settings', () => {
  it('default to no auto-tidy and folding after a day; damaged text reads as the default', () => {
    expect(DEFAULT_SLOT_SETTINGS).toEqual({ autoTidy: false, foldAfterHours: 24 });
    expect(parseSlotSettings(null)).toEqual(DEFAULT_SLOT_SETTINGS);
    expect(parseSlotSettings('{nope')).toEqual(DEFAULT_SLOT_SETTINGS);
    expect(parseSlotSettings('{"autoTidy":true,"foldAfterHours":null}')).toEqual({ autoTidy: true, foldAfterHours: null });
    expect(parseSlotSettings('{"autoTidy":"yes","foldAfterHours":-3}')).toEqual(DEFAULT_SLOT_SETTINGS);
  });
});

describe('the Needs you strip', () => {
  it('lists requests (interrupted ones too) before finished work, each the longest waiting first, so a new one joins at the end', () => {
    const list = [
      session({ id: 'idle', state: 'idle' }),
      session({ id: 'done-old', state: 'needs_you', need: 'reply', stateSince: 1 }),
      session({ id: 'ask-new', state: 'needs_you', need: 'permission', stateSince: 30 }),
      session({ id: 'cut', state: 'needs_you', need: 'interrupted', stateSince: 20 }),
      session({ id: 'ask-old', state: 'needs_you', need: 'question', stateSince: 10 }),
    ];
    expect(stripOrder(list).map((s) => s.id)).toEqual(['ask-old', 'cut', 'ask-new', 'done-old']);
    const more = [...list, session({ id: 'ask-newest', state: 'needs_you', need: 'permission', stateSince: 40 })];
    expect(stripOrder(more).map((s) => s.id)).toEqual(['ask-old', 'cut', 'ask-new', 'ask-newest', 'done-old']);
  });
});
