// What arrives on the board by drag and drop or paste, read from a DataTransfer: a file row from
// the project explorer (kept by its path), image files from Finder or another app, and images
// dragged out of a web page (a data: address, or an http(s) one main fetches once).
import { extForMime, imageMimeOf } from '../../../shared/boardItems.ts';

/** The drag type the project explorer's image rows carry: `{ path, name }` as JSON. */
export const EXPLORER_TYPE = 'application/x-agent-canvas-file';

export type Incoming =
  | { kind: 'path'; path: string; name: string }
  | { kind: 'file'; file: File }
  | { kind: 'url'; url: string };

const isImageFile = (f: { type: string; name: string }): boolean => f.type.startsWith('image/') ? extForMime(f.type) !== null : imageMimeOf(f.name) !== null;

/** Whether a drag may bring an image, judged during the drag (only the types and kinds can be read then). */
export function mayBringImage(dt: DataTransfer | null): boolean {
  if (!dt) return false;
  const types = [...dt.types];
  if (types.includes(EXPLORER_TYPE)) return true;
  if (types.includes('Files')) {
    // An item's type is readable during the drag; an empty one (some apps) may still be an image.
    const files = [...dt.items].filter((i) => i.kind === 'file');
    return files.length === 0 || files.some((i) => i.type === '' || i.type.startsWith('image/'));
  }
  return types.includes('text/uri-list') || types.includes('text/html');
}

/** The address of the first image in a piece of dragged HTML (a browser drags an <img> as such). */
export function imageInHtml(html: string): string | null {
  const m = /<img\b[^>]*?\ssrc\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i.exec(html);
  const src = m?.[1] ?? m?.[2] ?? m?.[3];
  return src ? src.replace(/&amp;/g, '&') : null;
}

/** The addresses in a text/uri-list (comments and blank lines skipped). */
export const urisIn = (list: string): string[] =>
  list.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('#'));

/** A data: image address as a file, or null when it is not one the board draws. */
export function fileFromDataUrl(url: string, name = 'Dropped image'): File | null {
  const m = /^data:(image\/[\w+.-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(url);
  const ext = m ? extForMime(m[1]!) : null;
  if (!m || !ext) return null;
  try {
    const bin = atob(m[2]!.replace(/\s+/g, ''));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new File([bytes], `${name}.${ext}`, { type: m[1]! });
  } catch {
    return null;
  }
}

const webUrl = (u: string): boolean => /^https?:\/\//i.test(u);

/** Everything a drop or a paste brings that can become a board image, in order. */
export function incomingFrom(dt: DataTransfer): Incoming[] {
  const explorer = dt.getData(EXPLORER_TYPE);
  if (explorer) {
    try {
      const v = JSON.parse(explorer) as { path?: unknown; name?: unknown };
      if (typeof v.path === 'string' && imageMimeOf(v.path)) {
        return [{ kind: 'path', path: v.path, name: typeof v.name === 'string' ? v.name : v.path.slice(v.path.lastIndexOf('/') + 1) }];
      }
    } catch { /* not ours after all */ }
    return [];
  }
  const files = [...dt.files].filter(isImageFile);
  if (files.length > 0) return files.map((file) => ({ kind: 'file', file }));
  // An image dragged out of a web page: its address, from the HTML it was in or the address list.
  const fromHtml = imageInHtml(dt.getData('text/html'));
  const candidates = [...(fromHtml ? [fromHtml] : []), ...urisIn(dt.getData('text/uri-list'))];
  for (const url of candidates) {
    if (url.startsWith('data:')) {
      const file = fileFromDataUrl(url);
      if (file) return [{ kind: 'file', file }];
    } else if (webUrl(url)) {
      return [{ kind: 'url', url }];
    }
  }
  return [];
}

/** An image file's own size in pixels, read by drawing it once (null when it cannot be drawn). */
export function naturalSize(blob: Blob): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    const done = (v: { width: number; height: number } | null) => { URL.revokeObjectURL(url); resolve(v); };
    img.onload = () => done(img.naturalWidth > 0 && img.naturalHeight > 0 ? { width: img.naturalWidth, height: img.naturalHeight } : null);
    img.onerror = () => done(null);
    img.src = url;
  });
}

/** What makes a project explorer row draggable onto the board: image files only, never a folder
    or a link that leads outside the project. */
export function explorerImageDrag(entry: { name: string; kind: 'dir' | 'file'; outside?: boolean }, path: string): { draggable?: true; onDragStart?(e: DragEvent | { dataTransfer: DataTransfer | null }): void } {
  if (entry.kind !== 'file' || entry.outside || imageMimeOf(entry.name) === null) return {};
  return {
    draggable: true,
    onDragStart: (e) => {
      const dt = e.dataTransfer;
      if (!dt) return;
      dt.setData(EXPLORER_TYPE, JSON.stringify({ path, name: entry.name }));
      dt.setData('text/plain', path);
      dt.effectAllowed = 'copy';
    },
  };
}
