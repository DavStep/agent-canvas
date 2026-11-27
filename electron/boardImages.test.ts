import { mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BoardItem, ImageItem } from '../shared/boardItems.ts';
import { createBoardImages, filePatches, nameFromUrl, picturesOf, sniffImage, watchBoardFiles, type BoardImagesOptions } from './boardImages.ts';

// 1×1 transparent PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]);

let dir: string;
let items: BoardItem[];
let fetched: { url: string; init: RequestInit }[];
let respond: (url: string) => Response;
const encoded: string[] = [];

const image = (patch: Partial<ImageItem>): ImageItem => ({
  id: 'item:aaaaaa', kind: 'image', place: { zone: null, x: 0, y: 0 }, width: 320, height: 240,
  src: { kind: 'copy', file: '0123456789abcdef0123456789abcdef.png' }, name: 'shot.png', ...patch,
});

const store = (patch: Partial<BoardImagesOptions> = {}) => createBoardImages({
  dir,
  items: () => items,
  fetch: async (url, init) => { fetched.push({ url, init }); return respond(url); },
  // A file:// response, as net.fetch gives one.
  fetchFile: async (url) => new Response(await readFile(fileURLToPath(url))),
  image: {
    encode: (file, max, format, onlyIfLarger) => {
      encoded.push(`${path.basename(file)} ${max} ${format} ${onlyIfLarger}`);
      return onlyIfLarger ? null : Buffer.from(`resized ${format}`);
    },
  },
  ...patch,
});

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'canvas-board-images-'));
  items = [];
  fetched = [];
  encoded.length = 0;
  respond = () => new Response(PNG, { headers: { 'content-type': 'image/png' } });
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('sniffing', () => {
  it('knows an image by its first bytes, never by its name', () => {
    expect(sniffImage(PNG)).toEqual({ ext: 'png', mime: 'image/png' });
    expect(sniffImage(JPEG)).toEqual({ ext: 'jpg', mime: 'image/jpeg' });
    expect(sniffImage(Buffer.from('GIF89a....'))).toEqual({ ext: 'gif', mime: 'image/gif' });
    expect(sniffImage(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toEqual({ ext: 'webp', mime: 'image/webp' });
    expect(sniffImage(Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"></svg>'))?.ext).toBe('svg');
    expect(sniffImage(Buffer.from('<html><body>not an image</body></html>'))).toBeNull();
    expect(sniffImage(Buffer.from('#!/bin/sh\nrm -rf /'))).toBeNull();
  });

  it('names a fetched image by its address', () => {
    expect(nameFromUrl(new URL('https://example.com/a/Hero%20Shot.png?x=1'), 'png')).toBe('Hero Shot.png');
    expect(nameFromUrl(new URL('https://example.com/render?id=4'), 'jpg')).toBe('render.jpg');
    expect(nameFromUrl(new URL('https://example.com/'), 'webp')).toBe('image.webp');
  });
});

describe('copies in the data folder', () => {
  it('keeps dropped bytes under a random name with the type the bytes are, and refuses what is no image', async () => {
    const b = store();
    const a = await b.importBytes('../../evil.png', PNG);
    expect(a.file).toMatch(/^[a-f0-9]{32}\.png$/);
    expect(a.name).toBe('....evil.png');
    expect(await readFile(path.join(dir, a.file))).toEqual(PNG);
    const j = await b.importBytes('photo.png', JPEG);
    expect(j.file.endsWith('.jpg')).toBe(true);
    await expect(b.importBytes('x.png', Buffer.from('hello'))).rejects.toThrow('isn’t an image');
    await expect(b.importBytes('x.png', new Uint8Array())).rejects.toThrow('empty');
    await expect(b.importBytes('x.png', 'not bytes')).rejects.toThrow(TypeError);
    expect((await readdir(dir)).sort()).toEqual([a.file, j.file].sort());
  });

  it('fetches a dropped web address once, follows no redirect and sends no credentials', async () => {
    const b = store();
    const got = await b.importUrl('https://images.example.com/cat.png');
    expect(fetched).toHaveLength(1);
    expect(fetched[0]!.url).toBe('https://images.example.com/cat.png');
    expect(fetched[0]!.init).toMatchObject({ redirect: 'error', credentials: 'omit' });
    expect(got.name).toBe('cat.png');
    expect(await readFile(path.join(dir, got.file))).toEqual(PNG);

    await expect(b.importUrl('file:///etc/passwd')).rejects.toThrow('Only web images');
    await expect(b.importUrl('https://me:secret@example.com/a.png')).rejects.toThrow('password');
    respond = () => new Response('<html>', { headers: { 'content-type': 'image/png' } });
    await expect(b.importUrl('https://example.com/fake.png')).rejects.toThrow('not an image');
    respond = () => new Response(null, { status: 404 });
    await expect(b.importUrl('https://example.com/gone.png')).rejects.toThrow('404');
    respond = () => { throw new TypeError('redirect'); };
    await expect(b.importUrl('https://example.com/moved.png')).rejects.toThrow('could not be fetched');
    respond = () => new Response(PNG, { headers: { 'content-length': String(100_000_000) } });
    await expect(b.importUrl('https://example.com/huge.png')).rejects.toThrow('too large');
  });
});

describe('serving', () => {
  it('serves an item on the board only, as an image, and a thumbnail when one is asked for and made', async () => {
    const b = store();
    const { file } = await b.importBytes('a.png', PNG);
    items = [image({ src: { kind: 'copy', file } })];
    const ok = await b.serve(new Request('canvas-media://board/item%3Aaaaaaa?v=0&size=full'));
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toBe('image/png');
    expect(ok.headers.get('x-content-type-options')).toBe('nosniff');
    expect(Buffer.from(await ok.arrayBuffer())).toEqual(PNG);
    // The small test picture needs no thumbnail: the file itself is served.
    const thumb = await b.serve(new Request('canvas-media://board/item%3Aaaaaaa?v=0&size=thumb'));
    expect(thumb.status).toBe(200);
    expect(encoded).toEqual([`${file} 1024 png true`]);
    expect((await b.serve(new Request('canvas-media://board/item%3Aother?size=full'))).status).toBe(404);
    expect((await b.serve(new Request('canvas-media://board/item%3Aaaaaaa', { method: 'POST', body: 'x' }))).status).toBe(404);
  });

  it('a file by path is read where it is, and a missing one is a 404', async () => {
    const file = path.join(dir, 'shots', 'hero.png');
    await writeFile(path.join(dir, 'hero.png'), PNG);
    items = [image({ src: { kind: 'path', path: '/demo/project/hero.png' } })];
    const b = store({ onDisk: (p) => p.replace('/demo/project', dir) });
    expect((await b.serve(new Request('canvas-media://board/item%3Aaaaaaa?v=5&size=full'))).headers.get('cache-control')).toContain('immutable');
    items = [image({ src: { kind: 'path', path: file } })];
    expect((await b.serve(new Request('canvas-media://board/item%3Aaaaaaa?size=full'))).status).toBe(404);
  });

  it('gives a chat the image as it is when a chat takes it, resized as JPEG when not', async () => {
    const b = store();
    const { file } = await b.importBytes('a.png', PNG);
    items = [image({ src: { kind: 'copy', file } })];
    expect(await b.chatImage('item:aaaaaa')).toEqual({ name: 'shot.png', mime: 'image/png', data: new Uint8Array(PNG) });
    await writeFile(path.join(dir, 'pic.bmp'), Buffer.from('BM'.padEnd(64, '\0')));
    items = [image({ name: 'pic.bmp', src: { kind: 'path', path: path.join(dir, 'pic.bmp') } })];
    expect(await b.chatImage('item:aaaaaa')).toMatchObject({ name: 'pic.jpg', mime: 'image/jpeg' });
    await expect(b.chatImage('item:nothere')).rejects.toThrow('no longer on the board');
  });
});

describe('sweeping', () => {
  it('removes copies no item names once they are an hour old, and keeps the rest', async () => {
    const b = store();
    const kept = await b.importBytes('a.png', PNG);
    const fresh = await b.importBytes('b.png', PNG);
    const old = await b.importBytes('c.png', PNG);
    const inNote = await b.importBytes('d.png', PNG);
    const hourAgo = (Date.now() - 2 * 3600_000) / 1000;
    for (const f of [kept, old, inNote]) await utimes(path.join(dir, f.file), hourAgo, hourAgo);
    await writeFile(path.join(dir, 'layout.json'), '{}');
    items = [image({ src: { kind: 'copy', file: kept.file } }),
      { id: 'item:note01', kind: 'note', images: [{ src: { kind: 'copy', file: inNote.file } }] } as unknown as BoardItem];
    await b.sweep();
    expect((await readdir(dir)).sort()).toEqual([kept.file, fresh.file, inNote.file, 'layout.json'].sort());
    await expect(stat(path.join(dir, old.file))).rejects.toThrow();
  });

  it('finds every picture an item draws', () => {
    expect(picturesOf(image({}))).toEqual([{ kind: 'copy', file: '0123456789abcdef0123456789abcdef.png' }]);
    expect(picturesOf({ kind: 'note', images: [{ src: { kind: 'path', path: '/a.png' } }, { src: 'bad' }] } as unknown as BoardItem)).toEqual([{ kind: 'path', path: '/a.png' }]);
  });
});

describe('files shown by path', () => {
  it('brings each item showing a file up to date: a new version, gone, back', () => {
    const list = [image({ id: 'item:a00000', src: { kind: 'path', path: '/p/x.png' }, version: 1 }), image({ id: 'item:b00000' })];
    expect(filePatches(list, '/p/x.png', 1)).toEqual([]);
    expect(filePatches(list, '/p/x.png', 2)).toEqual([{ id: 'item:a00000', patch: { version: 2 } }]);
    expect(filePatches(list, '/p/x.png', null)).toEqual([{ id: 'item:a00000', patch: { missing: true } }]);
    const gone = [image({ id: 'item:a00000', src: { kind: 'path', path: '/p/x.png' }, version: 1, missing: true })];
    expect(filePatches(gone, '/p/x.png', null)).toEqual([]);
    expect(filePatches(gone, '/p/x.png', 1)).toEqual([{ id: 'item:a00000', patch: { missing: false } }]);
  });

  it('watches exactly the files the board shows, and looks at each when it starts watching it', async () => {
    const watching = new Map<string, (m: number) => void>();
    const edits: [string, object][] = [];
    let list: BoardItem[] = [image({ id: 'item:a00000', src: { kind: 'path', path: '/p/x.png' } })];
    const w = watchBoardFiles({
      items: () => list,
      edit: (id, patch) => edits.push([id, patch]),
      watch: (file, cb) => watching.set(file, cb),
      unwatch: (file) => watching.delete(file),
      stat: async () => 42,
    });
    w.sync();
    expect([...watching.keys()]).toEqual(['/p/x.png']);
    await new Promise((r) => setTimeout(r, 0));
    expect(edits).toEqual([['item:a00000', { version: 42 }]]);
    watching.get('/p/x.png')!(0);
    expect(edits.at(-1)).toEqual(['item:a00000', { missing: true }]);
    list = [];
    w.sync();
    expect(watching.size).toBe(0);
  });
});
