// What a message carries besides its words: images (sent as images, shown as small thumbnails
// with a viewer that opens any one large) and other files (sent by path, the way the Codex and
// Claude apps attach them, shown as name chips). Added by paste, drop or the attach button.
// Shared by the chat composer, the New session dialog and the thread.
import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react';
import { MAX_FILES, type FileRef } from '../../../shared/attachments.ts';
import type { ImageRef } from '../../../shared/chat.ts';
import { pathForFile } from '../bridge.ts';

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGES = 6;
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

/** Which of the offered files may join the `current` images, and why the others may not. */
export function admitImages(current: number, files: { type: string; size: number; name: string }[]): { accepted: number[]; errors: string[] } {
  const accepted: number[] = [];
  const errors = new Set<string>();
  files.forEach((f, i) => {
    if (!IMAGE_TYPES.includes(f.type)) errors.add(`${f.name}: only PNG, JPEG, GIF or WebP images`);
    else if (f.size > MAX_IMAGE_BYTES) errors.add(`${f.name}: larger than 5 MB`);
    else if (current + accepted.length >= MAX_IMAGES) errors.add(`At most ${MAX_IMAGES} images per message`);
    else accepted.push(i);
  });
  return { accepted, errors: [...errors] };
}

/** Which offered files go as images, which by path, and why any are refused. An image is sent as
    one while it can be (type, size, count); past that, or of another type, a file with a path on
    disk goes by path. A file with no path (a pasted screenshot) can only be an image. */
export function admitAttachments(
  current: { images: number; files: number },
  offered: { type: string; size: number; name: string; path: string }[],
): { images: number[]; files: number[]; errors: string[] } {
  const images: number[] = [];
  const files: number[] = [];
  const errors = new Set<string>();
  offered.forEach((f, i) => {
    const asImage = admitImages(current.images + images.length, [f]);
    if (asImage.accepted.length > 0) images.push(i);
    else if (f.path === '') {
      for (const e of IMAGE_TYPES.includes(f.type) ? asImage.errors : [`${f.name}: can't attach this`]) errors.add(e);
    } else if (current.files + files.length >= MAX_FILES) errors.add(`At most ${MAX_FILES} files per message`);
    else files.push(i);
  });
  return { images, files, errors: [...errors] };
}

const readDataUrl = (file: File): Promise<string> => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result));
  reader.onerror = () => reject(reader.error ?? new Error('Could not read the image'));
  reader.readAsDataURL(file);
});

/** Only data: image URLs are ever drawn (the page's CSP allows no other images). */
const safeSrc = (img: ImageRef): string | undefined => (/^(?:data:image\/|https:\/\/|canvas-media:\/\/(?:item|board|note)\/)/i.test(img.dataUrl) ? img.dataUrl : undefined);

const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

/** The images and files being attached to a message, and the handlers that add them. */
export function useAttachments(disabled: boolean) {
  const [images, setImages] = useState<ImageRef[]>([]);
  const [files, setFiles] = useState<FileRef[]>([]);
  const [error, setError] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);

  const addFiles = async (offered: File[]) => {
    const withPaths = offered.map((f) => ({ type: f.type, size: f.size, name: f.name, path: pathForFile(f) }));
    const admitted = admitAttachments({ images: images.length, files: files.length }, withPaths);
    setError(admitted.errors.length > 0 ? admitted.errors.join(' · ') : null);
    const byPath = admitted.files.map((i) => ({ name: baseName(withPaths[i]!.path) || offered[i]!.name, path: withPaths[i]!.path }));
    // The same file twice is attached once.
    setFiles((now) => [...now, ...byPath.filter((f) => !now.some((n) => n.path === f.path))].slice(0, MAX_FILES));
    try {
      const added = await Promise.all(admitted.images.map(async (i) => ({ mime: offered[i]!.type, dataUrl: await readDataUrl(offered[i]!) })));
      setImages((now) => [...now, ...added].slice(0, MAX_IMAGES));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  /** A pasted file is attached; pasted text goes into the field as usual. */
  const onPaste = (e: ClipboardEvent<HTMLElement>) => {
    const pasted = [...e.clipboardData.files];
    if (pasted.length === 0 || disabled) return;
    e.preventDefault();
    void addFiles(pasted);
  };

  const onDragOver = (e: DragEvent<HTMLElement>) => { e.preventDefault(); };
  const onDrop = (e: DragEvent<HTMLElement>) => {
    e.preventDefault();
    if (!disabled) void addFiles([...e.dataTransfer.files]);
  };

  const remove = (index: number) => setImages((now) => now.filter((_, j) => j !== index));
  const removeFile = (index: number) => setFiles((now) => now.filter((_, j) => j !== index));

  const pickerInput = (
    <input ref={picker} type="file" multiple hidden
      onChange={(e) => { void addFiles([...(e.target.files ?? [])]); e.target.value = ''; }} />
  );

  return {
    images, setImages, files, setFiles, error, setError, onPaste, onDragOver, onDrop, remove, removeFile, pickerInput,
    pick: () => picker.current?.click(),
    full: files.length >= MAX_FILES,
  };
}

export function AttachButton({ onClick, disabled }: { onClick(): void; disabled: boolean }) {
  return (
    <button type="button" className="icon-btn" aria-label="Attach files" title="Attach files (or paste, or drop)" disabled={disabled} onClick={onClick}>
      <svg className="i" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M13 7.5 8.2 12.3a3 3 0 0 1-4.3-4.2l5-5a2 2 0 0 1 2.9 2.8L6.9 10.8a1 1 0 0 1-1.4-1.4L10 4.9" />
      </svg>
    </button>
  );
}

function FileIcon() {
  return (
    <svg className="i" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4 1.5h5L12.5 5v9.5h-8.5z" /><path d="M9 1.5V5h3.5" />
    </svg>
  );
}

/** Files attached by path, as name chips (the full path on hover). With `onRemove`, each has a
    remove button; with `onOpen`, pressing a chip shows the file in Finder. */
export function FileStrip({ files, label, onRemove, onOpen, className = 'cp-files' }: {
  files: FileRef[]; label: string; onRemove?(index: number): void; onOpen?(file: FileRef): void; className?: string;
}) {
  if (files.length === 0) return null;
  return (
    <ul className={className} aria-label={label}>
      {files.map((f, i) => (
        <li key={f.path} className="file-chip" title={f.path}>
          {onOpen
            ? <button type="button" className="file-open" aria-label={`Show ${f.name} in Finder`} onClick={() => onOpen(f)}><FileIcon /><span>{f.name}</span></button>
            : <span className="file-open"><FileIcon /><span>{f.name}</span></span>}
          {onRemove && (
            <button type="button" className="file-remove" aria-label={`Remove ${f.name}`} onClick={() => onRemove(i)}>
              <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true"><path d="M1.5 1.5l5 5M6.5 1.5l-5 5" /></svg>
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

/** Small square thumbnails; a press opens one large. With `onRemove`, each has a remove button. */
export function ImageStrip({ images, label, onRemove, className = 'cp-images' }: {
  images: ImageRef[]; label: string; onRemove?(index: number): void; className?: string;
}) {
  const [open, setOpen] = useState<number | null>(null);
  if (images.length === 0) return null;
  return (
    <>
      <ul className={className} aria-label={label}>
        {images.map((img, i) => (
          <li key={i}>
            <button type="button" className="img-thumb" aria-label={`View image ${i + 1}`} onClick={() => setOpen(i)}>
              <img referrerPolicy="no-referrer" src={safeSrc(img)} alt="" />
            </button>
            {onRemove && (
              <button type="button" className="img-remove" aria-label={`Remove image ${i + 1}`} onClick={() => onRemove(i)}>
                <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true"><path d="M1.5 1.5l5 5M6.5 1.5l-5 5" /></svg>
              </button>
            )}
          </li>
        ))}
      </ul>
      {open !== null && open < images.length && (
        <ImageViewer images={images} index={open} onIndex={setOpen} onClose={() => setOpen(null)} />
      )}
    </>
  );
}

/** One image at a time, as large as the window allows. Esc, the close button or a press outside
    the image closes it; the arrow keys step through several. A modal <dialog>, so it sits above
    the New session dialog too, and keeps focus while open. */
export function ImageViewer({ images, index, onIndex, onClose }: {
  images: ImageRef[]; index: number; onIndex(i: number): void; onClose(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef<Element | null>(null);
  useEffect(() => {
    opener.current = document.activeElement;
    const el = dialog.current;
    if (el && !el.open) el.showModal();
    return () => { if (opener.current instanceof HTMLElement) opener.current.focus(); };
  }, []);
  const many = images.length > 1;
  const step = (by: number) => onIndex((index + by + images.length) % images.length);

  // Handled here, before the canvas's own keys: Esc must close only the viewer, not the chat or
  // the dialog beneath it.
  const onKeyDown = (e: KeyboardEvent<HTMLDialogElement>) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); }
    else if (many && e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); step(1); }
    else if (many && e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); step(-1); }
  };

  return (
    <dialog
      ref={dialog}
      className="img-viewer"
      aria-label={many ? `Image ${index + 1} of ${images.length}` : 'Image'}
      onKeyDown={onKeyDown}
      onCancel={(e) => { e.preventDefault(); e.stopPropagation(); onClose(); }}
      onClick={(e) => { e.stopPropagation(); if (e.target === e.currentTarget || (e.target as Element).classList.contains('img-stage')) onClose(); }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="img-stage">
        <img referrerPolicy="no-referrer" src={safeSrc(images[index]!)} alt={`Image ${index + 1}`} />
      </div>
      <div className="img-bar">
        {many && <button type="button" className="img-nav" aria-label="Previous image" onClick={() => step(-1)}>
          <svg className="i" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3.5 5.5 8l4.5 4.5" /></svg>
        </button>}
        {many && <span className="img-count">{index + 1} / {images.length}</span>}
        {many && <button type="button" className="img-nav" aria-label="Next image" onClick={() => step(1)}>
          <svg className="i" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5" /></svg>
        </button>}
        <button type="button" className="img-nav img-close" aria-label="Close image" autoFocus onClick={onClose}>
          <svg className="i" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
        </button>
      </div>
    </dialog>
  );
}
