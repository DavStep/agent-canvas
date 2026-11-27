// Images and files handed on with a task. The canvas agent's start_task and the orchestrator's
// create_chat and continue_chat take absolute paths: a screenshot the owner pasted (Claude Code
// keeps it under /private/tmp/claude-…/images/N.png), or any file. A temp folder can vanish, so
// each hand-off copies its files into the app's data folder (<dataHome>/attachments/<task>/) and
// refers to the copies from then on; a path already there is used as it is.
// The receiving chat gets the images as images, as a paste in the composer sends them, and the
// other files as its provider's own file mentions (shared/attachments.ts), so its first message
// shows both. ACP has no mention of its own: it gets Claude's `@"<path>"` form, which the ACP
// engine turns into resource_link blocks (engines/acp/prompt.ts).
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { MAX_FILES, withFiles } from '../../shared/attachments.ts';
import type { ImageRef, SessionProvider } from '../../shared/chat.ts';

/** A kept file: its copy's path, and its type when it goes to the chat as an image. */
export interface Attachment { name: string; path: string; mime: string | null }

export const MAX_ATTACHMENTS = MAX_FILES;
/** Larger images (and other image types) go as files: the providers take images up to 5 MB. */
export const MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 200 * 1024 * 1024;

/** The tools' `attachments` argument. */
export const attachmentsArg = (what: string) => z.array(z.string()).max(MAX_ATTACHMENTS).optional().describe(
  `Absolute paths of images and files to hand on with ${what}: the screenshots the owner pasted (their local path, such as /private/tmp/claude-…/images/1.png) and any file the work needs. At most ${MAX_ATTACHMENTS}, each at most 50 MB. Images arrive as images; other files as attached files.`);

const mb = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** The image type the providers take, by the file's first bytes (an extension can lie). */
function imageType(head: Buffer): string | null {
  if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (head.subarray(0, 6).toString('latin1') === 'GIF87a' || head.subarray(0, 6).toString('latin1') === 'GIF89a') return 'image/gif';
  if (head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

async function sniff(file: string, size: number): Promise<string | null> {
  if (size > MAX_INLINE_IMAGE_BYTES) return null;
  const handle = await fs.open(file, 'r');
  try {
    const head = Buffer.alloc(12);
    await handle.read(head, 0, 12, 0);
    return imageType(head);
  } finally { await handle.close(); }
}

const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

/** The app's attachments folder: one folder per hand-off. */
export class AttachmentStore {
  constructor(readonly root: string) {}

  private kept(p: string): boolean { return p.startsWith(path.resolve(this.root) + path.sep); }

  private async folder(): Promise<string> {
    const dir = path.join(this.root, `${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  private static async copy(dir: string, src: string, name: string, taken: Set<string>): Promise<string> {
    const ext = path.extname(name);
    const stem = name.slice(0, name.length - ext.length) || 'file';
    let n = 1;
    let candidate = name;
    while (taken.has(candidate)) candidate = `${stem}-${++n}${ext}`;
    taken.add(candidate);
    const dest = path.join(dir, candidate);
    await fs.copyFile(src, dest, constants.COPYFILE_EXCL);
    return dest;
  }

  /** Checks every path first (absolute, a readable file, within the limits), then copies them
      into a new folder. Throws a one-line reason, copying nothing, when one fails. */
  async keep(paths: readonly string[]): Promise<Attachment[]> {
    const unique = [...new Set(paths)];
    if (unique.length === 0) return [];
    if (unique.length > MAX_ATTACHMENTS) throw new Error(`At most ${MAX_ATTACHMENTS} attachments can go with one message; ${unique.length} were given.`);
    const checked: { src: string; size: number; mime: string | null }[] = [];
    let total = 0;
    for (const given of unique) {
      if (!path.isAbsolute(given)) throw new Error(`The attachment ${given} is not an absolute path.`);
      const src = path.resolve(given);
      let stat;
      try { stat = await fs.stat(src); } catch {
        throw new Error(`The attachment ${src} does not exist. A pasted image's temporary file may be gone: ask the owner to paste it again.`);
      }
      if (stat.isDirectory()) throw new Error(`The attachment ${src} is a folder; attach files only.`);
      if (!stat.isFile()) throw new Error(`The attachment ${src} is not a regular file.`);
      if (stat.size > MAX_ATTACHMENT_BYTES) throw new Error(`The attachment ${src} is ${mb(stat.size)}; an attachment can be at most ${mb(MAX_ATTACHMENT_BYTES)}.`);
      try { await fs.access(src, constants.R_OK); } catch { throw new Error(`The attachment ${src} cannot be read.`); }
      total += stat.size;
      checked.push({ src, size: stat.size, mime: await sniff(src, stat.size).catch(() => null) });
    }
    if (total > MAX_TOTAL_BYTES) throw new Error(`The attachments come to ${mb(total)}; together they can be at most ${mb(MAX_TOTAL_BYTES)}.`);
    if (checked.every((c) => this.kept(c.src))) return checked.map((c) => ({ name: path.basename(c.src), path: c.src, mime: c.mime }));
    const dir = await this.folder();
    const taken = new Set<string>();
    const out: Attachment[] = [];
    for (const c of checked) {
      const kept = this.kept(c.src) ? c.src : await AttachmentStore.copy(dir, c.src, path.basename(c.src), taken);
      out.push({ name: path.basename(kept), path: kept, mime: c.mime });
    }
    return out;
  }

  /** Images the page sent as data (a paste in the composer), written as files to hand on. */
  async keepImages(images: readonly ImageRef[]): Promise<Attachment[]> {
    if (images.length === 0) return [];
    const dir = await this.folder();
    const out: Attachment[] = [];
    for (const [i, img] of images.entries()) {
      const data = /^data:[^;,]+;base64,(.*)$/s.exec(img.dataUrl)?.[1];
      if (data === undefined) continue;
      const name = `image-${i + 1}.${EXT[img.mime] ?? 'png'}`;
      const file = path.join(dir, name);
      await fs.writeFile(file, Buffer.from(data, 'base64'), { flag: 'wx', mode: 0o600 });
      out.push({ name, path: file, mime: img.mime });
    }
    return out;
  }
}

async function imagesOf(files: readonly Attachment[]): Promise<ImageRef[]> {
  return Promise.all(files.filter((f) => f.mime !== null).map(async (f) =>
    ({ mime: f.mime!, dataUrl: `data:${f.mime};base64,${(await fs.readFile(f.path)).toString('base64')}` })));
}

/** A worker's message: the images as images, the other files as the provider's file mentions. */
export async function workerMessage(provider: SessionProvider, text: string, files: readonly Attachment[]): Promise<{ text: string; images: ImageRef[] }> {
  const others = files.filter((f) => f.mime === null).map(({ name, path: p }) => ({ name, path: p }));
  const images = await imagesOf(files);
  if (others.length === 0) return { text, images };
  return { text: withFiles(provider === 'acp' ? 'claude' : provider, text, others), images };
}

/** The orchestrator's brief: it sees the images, and is given every kept path to hand on. */
export async function orchestratorMessage(text: string, files: readonly Attachment[]): Promise<{ text: string; images: ImageRef[] }> {
  if (files.length === 0) return { text, images: [] };
  const list = files.map((f) => `- ${f.path}${f.mime ? ' (image)' : ''}`).join('\n');
  return {
    text: `${text}\n\nAttachments from the owner (kept copies). Pass the ones each worker needs, or all of them if unsure, in the \`attachments\` of create_chat or continue_chat:\n${list}`,
    images: await imagesOf(files),
  };
}
