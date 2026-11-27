import { describe, expect, it } from 'vitest';
import type { NoteImage } from '../../shared/boardNotes.ts';
import type { Layout, Snapshot } from '../../shared/types.ts';
import { applyLayoutOp } from '../layoutOps.ts';
import { CANVAS_TOOLS, type CanvasApi } from './tools.ts';
import { agentNotePlace } from './noteTools.ts';

const NOW = 1_800_000_000_000;

function fakeApi(opts: { layout?: Layout; noPictures?: boolean } = {}) {
  let layout: Layout = opts.layout ?? { version: 1, zones: [{ id: 'z1', name: 'Launch', kind: 'custom', folder: null, x: 400, y: 300, hueIndex: 0 }], assignments: {} };
  const imported: string[] = [];
  let n = 0;
  const api: CanvasApi = {
    snapshot: () => ({ generatedAt: NOW, demo: false, sessions: [], layout, banners: { claude: null, codex: null } } as Snapshot),
    applyLayout: (op) => { layout = applyLayoutOp(layout, op); },
    startSession: async () => 'x',
    keepAttachments: async () => [],
    findFolders: async () => [],
    folderKind: async () => 'missing',
    openSession: () => {},
    now: () => NOW,
    ...(opts.noPictures ? {} : {
      notes: {
        importFile: async (file: string): Promise<NoteImage> => {
          if (file.endsWith('.txt')) throw new Error(`${file} is not an image file a note can show.`);
          imported.push(file);
          return { id: `ni:${String(++n).padStart(8, '0')}`, src: { kind: 'copy', file: '0123456789abcdef0123456789abcdef.png' }, name: file.slice(file.lastIndexOf('/') + 1) };
        },
      },
    }),
  };
  return { api, imported, layout: () => layout };
}

const run = (api: CanvasApi, name: string, args: Record<string, unknown>) => {
  const tool = CANVAS_TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`no tool ${name}`);
  return tool.handler(api, args);
};

describe('the note tools', () => {
  it('create_note writes a free note above the zones, with pictures copied in', async () => {
    const { api, imported, layout } = fakeApi();
    const res = await run(api, 'create_note', { text: '# Ideas\n- [ ] one', images: ['/tmp/a.png'] });
    expect(res.isError).toBe(false);
    const note = layout().notes![0]!;
    expect(res.text).toContain(note.id);
    expect(note).toMatchObject({ text: '# Ideas\n- [ ] one', editedAt: NOW, place: { zone: null } });
    expect(note.place.zone === null && note.place.y < 300).toBe(true);
    expect(note.images?.map((i) => i.name)).toEqual(['a.png']);
    expect(imported).toEqual(['/tmp/a.png']);
  });

  it('create_note puts a note into a zone, and refuses a zone or picture it cannot use', async () => {
    const { api, layout } = fakeApi();
    expect((await run(api, 'create_note', { text: 'x', zoneId: 'z1', color: 2 })).isError).toBe(false);
    expect(layout().notes![0]).toMatchObject({ place: { zone: 'z1', col: 0 }, hueIndex: 2 });
    expect((await run(api, 'create_note', { text: 'x', zoneId: 'nope' })).text).toMatch(/No zone/);
    expect((await run(api, 'create_note', { text: 'x', images: ['rel.png'] })).text).toMatch(/not an absolute path/);
    expect((await run(api, 'create_note', { text: 'x', images: ['/tmp/a.txt'] })).text).toMatch(/not an image/);
    expect(layout().notes).toHaveLength(1);
    const bare = fakeApi({ noPictures: true });
    expect((await run(bare.api, 'create_note', { text: 'x', images: ['/tmp/a.png'] })).isError).toBe(true);
  });

  it('update_note changes text and colour, and adds and removes pictures by name', async () => {
    const { api, layout } = fakeApi();
    await run(api, 'create_note', { text: 'old', images: ['/tmp/a.png', '/tmp/b.png'] });
    const id = layout().notes![0]!.id;
    const res = await run(api, 'update_note', { id, title: 'New title', text: 'new', color: 4, addImages: ['/tmp/c.png'], removeImages: ['a.png'] });
    expect(res.isError).toBe(false);
    expect(layout().notes![0]).toMatchObject({ title: 'New title', text: 'new', hueIndex: 4 });
    expect(layout().notes![0]!.images?.map((i) => i.name)).toEqual(['b.png', 'c.png']);
    expect((await run(api, 'update_note', { id, removeImages: ['zzz.png'] })).text).toMatch(/no picture named zzz.png/);
    expect((await run(api, 'update_note', { id })).text).toMatch(/Nothing to change/);
    expect((await run(api, 'update_note', { id: 'note:ffffffffffffffff', text: 'x' })).text).toMatch(/No note/);
  });

  it('list_notes reads them all or one; delete_note takes one off', async () => {
    const { api, layout } = fakeApi();
    expect((await run(api, 'list_notes', {})).text).toMatch(/no notes/);
    await run(api, 'create_note', { title: 'Shopping', text: 'Buy milk' });
    const id = layout().notes![0]!.id;
    const list = JSON.parse((await run(api, 'list_notes', {})).text) as { id: string; text: string }[];
    expect(list).toEqual([expect.objectContaining({ id, title: 'Shopping', text: 'Buy milk' })]);
    expect((await run(api, 'list_notes', { id: 'note:ffffffffffffffff' })).isError).toBe(true);
    const overview = JSON.parse((await run(api, 'canvas_overview', {})).text) as { notes?: { title: string }[] };
    expect(overview.notes).toEqual([expect.objectContaining({ id, title: 'Shopping' })]);
    expect((await run(api, 'delete_note', { id })).text).toMatch(/Deleted the note "Shopping"/);
    expect(layout().notes).toEqual([]);
  });

  it('free notes step along so none hides another', () => {
    const layout: Layout = { version: 1, zones: [], assignments: {} };
    const a = agentNotePlace(layout, null);
    const b = agentNotePlace({ ...layout, notes: [{ id: 'note:aaaaaaaa', place: a, width: 248, height: 152, title: '', text: '', hueIndex: 6 }] }, null);
    expect(b).not.toEqual(a);
  });
});
