import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { splitFiles } from '../../shared/attachments.ts';
import { AttachmentStore, MAX_ATTACHMENT_BYTES, MAX_INLINE_IMAGE_BYTES, orchestratorMessage, workerMessage } from './taskAttachments.ts';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

function setup() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-attach-'));
  const file = (name: string, data: Buffer | string) => { const p = path.join(tmp, name); fs.writeFileSync(p, data); return p; };
  return { tmp, file, store: new AttachmentStore(path.join(tmp, 'data', 'attachments')) };
}

describe('AttachmentStore', () => {
  it('copies files into one new folder per hand-off, telling images by their bytes', async () => {
    const { file, store } = setup();
    const text = file('a.txt', 'x');
    const kept = await store.keep([file('1.png', PNG), file('fake.png', 'not an image'), text, text]);
    expect(kept.map(k => [k.name, k.mime])).toEqual([['1.png', 'image/png'], ['fake.png', null], ['a.txt', null]]);
    expect(new Set(kept.map(k => path.dirname(k.path))).size).toBe(1);
    expect(path.dirname(path.dirname(kept[0]!.path))).toBe(store.root);
  });

  it('names same-named files apart and keeps a copy already in the store as it is', async () => {
    const { tmp, file, store } = setup();
    fs.mkdirSync(path.join(tmp, 'other'));
    const kept = await store.keep([file('1.png', PNG), file('other/1.png', PNG)]);
    expect(kept.map(k => k.name)).toEqual(['1.png', '1-2.png']);
    expect(await store.keep([kept[0]!.path])).toEqual([kept[0]]);
    expect(fs.readdirSync(store.root)).toHaveLength(1);
  });

  it('refuses too many, too big, unreadable and non-file paths, copying nothing', async () => {
    const { tmp, file, store } = setup();
    const many = Array.from({ length: 21 }, (_, i) => file(`${i}.txt`, 'x'));
    await expect(store.keep(many)).rejects.toThrow('At most 20 attachments');
    const big = file('big.bin', '');
    fs.truncateSync(big, MAX_ATTACHMENT_BYTES + 1);
    await expect(store.keep([big])).rejects.toThrow(/is 50\.0 MB; an attachment can be at most 50\.0 MB/);
    const locked = file('locked.txt', 'x');
    fs.chmodSync(locked, 0o000);
    if (process.getuid?.() !== 0) await expect(store.keep([locked])).rejects.toThrow('cannot be read');
    await expect(store.keep([tmp])).rejects.toThrow('is a folder');
    await expect(store.keep([file('ok.txt', 'x'), '/no/such/file'])).rejects.toThrow('does not exist');
    expect(fs.existsSync(store.root)).toBe(false);
  });

  it('sends an image over the inline limit as a file', async () => {
    const { file, store } = setup();
    const p = file('huge.png', PNG);
    fs.truncateSync(p, MAX_INLINE_IMAGE_BYTES + 1);
    expect((await store.keep([p]))[0]!.mime).toBeNull();
  });

  it('writes pasted images out as files', async () => {
    const { store } = setup();
    const [kept] = await store.keepImages([{ mime: 'image/png', dataUrl: `data:image/png;base64,${PNG.toString('base64')}` }]);
    expect(kept).toMatchObject({ name: 'image-1.png', mime: 'image/png' });
    expect(fs.readFileSync(kept!.path)).toEqual(PNG);
  });
});

describe('messages', () => {
  it('a worker gets images as images and files as its provider shows them', async () => {
    const { file, store } = setup();
    const files = await store.keep([file('shot.png', PNG), file('spec.md', '# Spec')]);
    const claude = await workerMessage('claude', 'Do it', files);
    expect(claude.images).toEqual([{ mime: 'image/png', dataUrl: `data:image/png;base64,${PNG.toString('base64')}` }]);
    expect(splitFiles(claude.text)).toEqual({ text: 'Do it', files: [{ name: 'spec.md', path: files[1]!.path }] });
    expect(splitFiles((await workerMessage('codex', 'Do it', files)).text).files).toEqual([{ name: 'spec.md', path: files[1]!.path }]);
    expect((await workerMessage('acp', 'Do it', files)).text).toBe(`@"${files[1]!.path}"\n\nDo it`);
    expect(await workerMessage('claude', 'Plain', [])).toEqual({ text: 'Plain', images: [] });
  });

  it('the orchestrator sees the images and gets every kept path to hand on', async () => {
    const { file, store } = setup();
    const files = await store.keep([file('shot.png', PNG), file('spec.md', '# Spec')]);
    const m = await orchestratorMessage('Fix it', files);
    expect(m.images).toHaveLength(1);
    expect(m.text).toContain(`- ${files[0]!.path} (image)\n- ${files[1]!.path}`);
    expect(m.text).toMatch(/attachments` of create_chat or continue_chat/);
  });
});
