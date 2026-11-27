import { describe, expect, it } from 'vitest';
import { admitAttachments, admitImages, afterSend, canSend, composerKey, MAX_IMAGE_BYTES } from './Composer.tsx';

const key = (k: string, patch: { shiftKey?: boolean; isComposing?: boolean; keyCode?: number } = {}) =>
  composerKey({ key: k, shiftKey: false, isComposing: false, keyCode: 0, ...patch });

describe('composerKey', () => {
  it('sends on Enter', () => {
    expect(key('Enter')).toBe('send');
  });

  it('breaks the line on Shift+Enter', () => {
    expect(key('Enter', { shiftKey: true })).toBe('newline');
  });

  it('does nothing on Enter while an input method is composing', () => {
    expect(key('Enter', { isComposing: true })).toBe('none');
    // Safari-style: composition reported only through keyCode 229.
    expect(key('Enter', { keyCode: 229 })).toBe('none');
  });

  it('leaves other keys to the field', () => {
    expect(key('a')).toBe('none');
    expect(key('Escape')).toBe('none');
  });
});

describe('canSend', () => {
  const image = { mime: 'image/png', dataUrl: 'data:image/png;base64,AA==' };

  it('refuses empty or blank text with no images', () => {
    expect(canSend('', [], null)).toBe(false);
    expect(canSend('  \n ', [], null)).toBe(false);
  });

  it('sends text, images, or both', () => {
    expect(canSend('hi', [], null)).toBe(true);
    expect(canSend('', [image], null)).toBe(true);
    expect(canSend('hi', [image], null)).toBe(true);
  });

  it('sends files alone', () => {
    expect(canSend('', [], null, [{ name: 'a.pdf', path: '/a.pdf' }])).toBe(true);
    expect(canSend('', [], 'Read-only', [{ name: 'a.pdf', path: '/a.pdf' }])).toBe(false);
  });

  it('refuses while sending is blocked (read-only, provider banner)', () => {
    expect(canSend('hi', [], 'Open in another app — read-only here')).toBe(false);
  });
});

describe('admitImages', () => {
  const file = (type: string, size = 1000) => ({ type, size, name: `f.${type.split('/')[1]}` });

  it('takes PNG, JPEG, GIF and WebP', () => {
    const r = admitImages(0, [file('image/png'), file('image/jpeg'), file('image/gif'), file('image/webp')]);
    expect(r.accepted).toEqual([0, 1, 2, 3]);
    expect(r.errors).toEqual([]);
  });

  it('refuses other types and files over 5 MB, saying why', () => {
    const r = admitImages(0, [file('image/svg+xml'), file('image/png', MAX_IMAGE_BYTES + 1), file('image/png', MAX_IMAGE_BYTES)]);
    expect(r.accepted).toEqual([2]);
    expect(r.errors).toHaveLength(2);
  });

  it('keeps at most six images in all', () => {
    const r = admitImages(4, [file('image/png'), file('image/png'), file('image/png')]);
    expect(r.accepted).toEqual([0, 1]);
    expect(r.errors).toEqual(['At most 6 images per message']);
  });
});

describe('afterSend', () => {
  const a = { mime: 'image/png', dataUrl: 'data:image/png;base64,AA==' };
  const b = { mime: 'image/png', dataUrl: 'data:image/png;base64,BB==' };

  it('clears the field only when it still holds what was sent', () => {
    expect(afterSend({ text: 'hi', images: [a] }, { text: 'hi', images: [a] })).toEqual({ text: '', images: [] });
    // Typed (or an image added) while the send was under way: kept.
    expect(afterSend({ text: 'hi and more', images: [a, b] }, { text: 'hi', images: [a] })).toEqual({ text: 'hi and more', images: [b] });
  });
});


describe('admitAttachments', () => {
  const offer = (name: string, type: string, path = `/Users/me/${name}`, size = 1000) => ({ name, type, path, size });
  const none = { images: 0, files: 0 };

  it('takes supported images as images and any other file with a path as a file', () => {
    const r = admitAttachments(none, [offer('shot.png', 'image/png'), offer('report.pdf', 'application/pdf'), offer('notes', '')]);
    expect(r).toEqual({ images: [0], files: [1, 2], errors: [] });
  });

  it('attaches by path the images it cannot send as images (too big, or another type)', () => {
    const r = admitAttachments(none, [offer('big.png', 'image/png', '/big.png', MAX_IMAGE_BYTES + 1), offer('logo.svg', 'image/svg+xml')]);
    expect(r).toEqual({ images: [], files: [0, 1], errors: [] });
  });

  it('keeps a pasted screenshot (no path) as an image, and refuses other pathless files', () => {
    const r = admitAttachments(none, [offer('image.png', 'image/png', ''), offer('clip.pdf', 'application/pdf', '')]);
    expect(r.images).toEqual([0]);
    expect(r.files).toEqual([]);
    expect(r.errors).toEqual(["clip.pdf: can't attach this"]);
  });

  it('keeps at most 20 files in all', () => {
    const r = admitAttachments({ images: 0, files: 19 }, [offer('a.txt', 'text/plain'), offer('b.txt', 'text/plain')]);
    expect(r.files).toEqual([0]);
    expect(r.errors).toEqual(['At most 20 files per message']);
  });
});
