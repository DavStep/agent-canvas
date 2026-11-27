import { describe, expect, it } from 'vitest';
import { EXPLORER_TYPE, explorerImageDrag, fileFromDataUrl, imageInHtml, incomingFrom, mayBringImage, urisIn } from './imports.ts';
import { newFrame, resized } from './useBoardItems.tsx';

/** Enough of a DataTransfer for these: its data by type, its files and items. */
function transfer(data: Record<string, string>, files: File[] = []): DataTransfer {
  return {
    types: [...Object.keys(data), ...(files.length > 0 ? ['Files'] : [])],
    getData: (t: string) => data[t] ?? '',
    files,
    items: files.map((f) => ({ kind: 'file', type: f.type })),
  } as unknown as DataTransfer;
}
const PNG_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

describe('what a drop brings', () => {
  it('a project explorer row: its file by path', () => {
    const dt = transfer({ [EXPLORER_TYPE]: JSON.stringify({ path: '/Users/me/app/logo.png', name: 'logo.png' }), 'text/plain': '/Users/me/app/logo.png' });
    expect(mayBringImage(dt)).toBe(true);
    expect(incomingFrom(dt)).toEqual([{ kind: 'path', path: '/Users/me/app/logo.png', name: 'logo.png' }]);
    expect(incomingFrom(transfer({ [EXPLORER_TYPE]: JSON.stringify({ path: '/Users/me/app/notes.md' }) }))).toEqual([]);
  });

  it('image files from Finder or another app, never other files', () => {
    const png = new File([new Uint8Array([1])], 'a.png', { type: 'image/png' });
    const noType = new File([new Uint8Array([1])], 'b.webp', { type: '' });
    const pdf = new File([new Uint8Array([1])], 'c.pdf', { type: 'application/pdf' });
    const out = incomingFrom(transfer({}, [png, noType, pdf]));
    expect(out.map((i) => i.kind === 'file' && i.file.name)).toEqual(['a.png', 'b.webp']);
    expect(mayBringImage(transfer({}, [pdf]))).toBe(false);
  });

  it('an image dragged out of a web page: its address, from the HTML or the address list', () => {
    expect(incomingFrom(transfer({ 'text/html': '<a href="/x"><img alt="" src="https://cdn.example.com/a.jpg?w=1&amp;h=2"></a>', 'text/uri-list': 'https://example.com/page' })))
      .toEqual([{ kind: 'url', url: 'https://cdn.example.com/a.jpg?w=1&h=2' }]);
    expect(incomingFrom(transfer({ 'text/uri-list': '# comment\nhttps://example.com/b.png\n' }))).toEqual([{ kind: 'url', url: 'https://example.com/b.png' }]);
    const data = incomingFrom(transfer({ 'text/html': `<img src="${PNG_URL}">` }));
    expect(data[0]!.kind === 'file' && data[0]!.file.type).toBe('image/png');
    expect(incomingFrom(transfer({ 'text/uri-list': 'javascript:alert(1)' }))).toEqual([]);
    expect(incomingFrom(transfer({ 'text/plain': 'hello' }))).toEqual([]);
  });

  it('reads the pieces', () => {
    expect(imageInHtml("<img class=x src='/rel.png'>")).toBe('/rel.png');
    expect(imageInHtml('<p>no image</p>')).toBeNull();
    expect(urisIn('a\r\n#b\n\n c ')).toEqual(['a', 'c']);
    expect(fileFromDataUrl('data:text/html;base64,PGI+')).toBeNull();
    expect(fileFromDataUrl(PNG_URL, 'Pasted')?.name).toBe('Pasted.png');
  });
});

describe('the explorer as a drag source', () => {
  it('only an image file row drags, carrying its absolute path', () => {
    expect(explorerImageDrag({ name: 'src', kind: 'dir' }, '/p/src')).toEqual({});
    expect(explorerImageDrag({ name: 'a.ts', kind: 'file' }, '/p/a.ts')).toEqual({});
    expect(explorerImageDrag({ name: 'x.png', kind: 'file', outside: true }, '/p/x.png')).toEqual({});
    const props = explorerImageDrag({ name: 'Logo.PNG', kind: 'file' }, '/p/Logo.PNG');
    expect(props.draggable).toBe(true);
    const set: Record<string, string> = {};
    const dt = { setData: (t: string, v: string) => { set[t] = v; }, effectAllowed: '' } as unknown as DataTransfer;
    props.onDragStart!({ dataTransfer: dt });
    expect(JSON.parse(set[EXPLORER_TYPE]!)).toEqual({ path: '/p/Logo.PNG', name: 'Logo.PNG' });
    expect(set['text/plain']).toBe('/p/Logo.PNG');
  });
});

describe('frames', () => {
  it('a new image is a card column wide in a zone and wider free, never wider than the picture', () => {
    expect(newFrame({ width: 1600, height: 800 }, true)).toEqual({ width: 232, height: 116 });
    expect(newFrame({ width: 1600, height: 800 }, false)).toEqual({ width: 320, height: 160 });
    expect(newFrame({ width: 120, height: 60 }, false)).toEqual({ width: 120, height: 60 });
    expect(newFrame(undefined, false)).toEqual({ width: 320, height: 240 });
  });

  it('a corner drag keeps the shape, unless free (Shift)', () => {
    expect(resized({ width: 200, height: 100 }, 2, 100, 0, false)).toEqual({ width: 300, height: 150 });
    expect(resized({ width: 200, height: 100 }, 2, 100, -20, true)).toEqual({ width: 300, height: 80 });
    expect(resized({ width: 200, height: 100 }, 2, -500, 0, false)).toEqual({ width: 48, height: 48 });
  });
});
