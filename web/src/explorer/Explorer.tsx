// The project explorer: a zone's folder as a tree, docked left of the canvas (the chat panel
// keeps the right). Folders list one level at a time as they are opened; a file opens in its own
// panel docked beside the tree (JSON as a foldable outline, images with their size, other text as
// it is), so the tree keeps its full height.
// Everything is read through the main process, which keeps it read-only and inside the folder.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type RefObject } from 'react';
import { formatSize, previewKindOf, type FilePreview } from '../../../shared/files.ts';
import type { GitStatus } from '../../../shared/projectGit.ts';
import type { ZoneLayout } from '../../../shared/types.ts';
import { filesBridge, openExternal, previewBridge, revealFile } from '../bridge.ts';
import { ZoneMark, zoneHue } from '../components/ZoneMark.tsx';
import { errorText } from '../preview/BrowserTab.tsx';
import { editorUrl } from '../preview/LiveWork.tsx';
import { arrive } from './cascade.ts';
import { GitPanel } from './GitPanel.tsx';
import { JsonView } from './JsonView.tsx';
import { explorerImageDrag } from '../board/imports.ts';
import { parseJson } from './json.ts';
import { PANEL_EXIT_MS, useLingering } from '../useLingering.ts';
import { homeOf, join, parentOf, shortPath, stepFocus, visibleRows, type Dirs, type Row } from './tree.ts';

export interface ExplorerProps {
  zone: ZoneLayout;
  /** The zone's folder: the tree's root. */
  root: string;
  onOpenChat(id: string): void;
  onClose(): void;
  /** Closed already and only playing its exit (useLingering). */
  closing?: boolean;
}

const WIDTH_KEY = 'agent-canvas:explorer-width';
export const EXPLORER_MIN = 240;
const EXPLORER_DEFAULT = 320;
const EXPLORER_MAX = 720;
const VIEWER_KEY = 'agent-canvas:file-viewer-width';
export const VIEWER_MIN = 280;
const VIEWER_DEFAULT = 520;
const VIEWER_MAX = 1200;
/** The canvas keeps at least this much beside the explorer (and the file open beside it). */
const CANVAS_MIN = 320;
/** The gap between docked panels (.canvas-area). */
const GAP = 8;

/** The width kept between the minimum and what leaves the canvas room, in a window `page` wide. */
export function clampExplorerWidth(w: number, page: number): number {
  return Math.round(Math.max(EXPLORER_MIN, Math.min(w, EXPLORER_MAX, page - CANVAS_MIN)));
}
/** The file panel's width, leaving the canvas room beside it and an explorer `explorer` wide. */
export function clampViewerWidth(w: number, page: number, explorer: number): number {
  return Math.round(Math.max(VIEWER_MIN, Math.min(w, VIEWER_MAX, page - explorer - GAP - CANVAS_MIN)));
}
function loadWidth(key: string, min: number, fallback: number): number {
  try {
    const n = Number(window.localStorage.getItem(key));
    return Number.isFinite(n) && n >= min ? n : fallback;
  } catch {
    return fallback;
  }
}
function saveWidth(key: string, w: number) {
  try { window.localStorage.setItem(key, String(w)); } catch { /* not remembered */ }
}

/** A docked panel's right edge: drag, arrow keys, double-click to reset, as the chat panel's left edge. */
function ResizeEdge({ panel, width, min, fallback, label, resize }: {
  panel: RefObject<HTMLElement | null>; width: number; min: number; fallback: number; label: string;
  resize(w: number, done: boolean): void;
}) {
  const drag = useRef<{ id: number; x: number; w: number } | null>(null);
  const down = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    drag.current = { id: e.pointerId, x: e.clientX, w: panel.current?.getBoundingClientRect().width ?? width };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* gone */ }
  };
  const move = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (d && d.id === e.pointerId) resize(d.w + e.clientX - d.x, false);
  };
  const up = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    resize(d.w + e.clientX - d.x, true);
  };
  return <div className="ex-edge" role="separator" aria-orientation="vertical" aria-label={label} tabIndex={0}
    aria-valuenow={width} aria-valuemin={min} title="Drag to resize · double-click for the default width"
    onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
    onDoubleClick={() => resize(fallback, true)}
    onKeyDown={(e) => {
      const step = e.key === 'ArrowRight' ? 16 : e.key === 'ArrowLeft' ? -16 : 0;
      if (step !== 0) { e.preventDefault(); resize(width + step, true); }
    }} />;
}

type PreviewState = { status: 'loading' } | { status: 'ok'; preview: FilePreview } | { status: 'error'; message: string };

const Chevron = () => <svg className="i ex-chev" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="m3.5 2 3 3-3 3" /></svg>;
const FolderIcon = () => <svg className="i" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M2 4.5a1 1 0 0 1 1-1h3l1.5 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1Z" /></svg>;
const FileIcon = ({ name }: { name: string }) => {
  const k = previewKindOf(name).kind;
  return <svg className={`i ex-file is-${k}`} width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
    {k === 'image'
      ? <><rect x="2.5" y="3" width="11" height="10" rx="1.5" /><path d="m3 11.5 3.5-3.5 2.5 2.5 1.5-1.5 2.5 2.5" /><circle cx="10.5" cy="6" r="1" /></>
      : k === 'json'
        ? <path d="M6 2.5c-1.5 0-2 .6-2 2v1.6c0 .9-.4 1.4-1.3 1.9.9.5 1.3 1 1.3 1.9v1.6c0 1.4.5 2 2 2m4-11c1.5 0 2 .6 2 2v1.6c0 .9.4 1.4 1.3 1.9-.9.5-1.3 1-1.3 1.9v1.6c0 1.4-.5 2-2 2" />
        : <><path d="M4 2.5h5l3 3v8H4z" /><path d="M9 2.5v3h3" /></>}
  </svg>;
};

function ImagePreview({ preview, name }: { preview: Extract<FilePreview, { kind: 'image' }>; name: string }) {
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const [broken, setBroken] = useState(false);
  return <div className="ex-image">
    <div className="ex-image-stage">
      {broken
        ? <p className="ex-note">This image can’t be drawn.</p>
        : <img src={preview.dataUrl} alt={name} draggable={false}
            onLoad={(e) => setDims({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
            onError={() => setBroken(true)} />}
    </div>
    <p className="ex-image-facts">
      {dims && dims.w > 0 ? <span>{dims.w} × {dims.h} px</span> : null}
      <span>{formatSize(preview.size)}</span>
      <span>{preview.mime.replace('image/', '').replace('+xml', '').toUpperCase()}</span>
    </p>
  </div>;
}

function JsonPreview({ text }: { text: string }) {
  const parsed = useMemo(() => parseJson(text), [text]);
  const [raw, setRaw] = useState(false);
  if (!parsed.ok) {
    return <div className="ex-json">
      <p className="ex-parse-error" role="status">
        <strong>Not valid JSON</strong> {parsed.error}{parsed.line !== null ? ` (line ${parsed.line}, column ${parsed.column})` : ''}
      </p>
      <pre className="ex-text">{text}</pre>
    </div>;
  }
  return <div className="ex-json">
    <div className="ex-json-bar">
      <div className="ex-seg" role="group" aria-label="JSON view">
        <button type="button" className={raw ? '' : 'is-on'} aria-pressed={!raw} onClick={() => setRaw(false)}>Outline</button>
        <button type="button" className={raw ? 'is-on' : ''} aria-pressed={raw} onClick={() => setRaw(true)}>Text</button>
      </div>
      {parsed.loose && <span className="ex-json-note">With comments</span>}
    </div>
    {raw ? <pre className="ex-text">{text}</pre> : <JsonView value={parsed.value} />}
  </div>;
}

function PreviewBody({ state, name }: { state: PreviewState; name: string }) {
  if (state.status === 'loading') return <p className="ex-note is-loading">Loading…</p>;
  if (state.status === 'error') return <p className="ex-note is-error" role="alert">{state.message}</p>;
  const p = state.preview;
  switch (p.kind) {
    case 'image': return <ImagePreview preview={p} name={name} />;
    case 'json': return <JsonPreview text={p.text} />;
    case 'text': return p.text === '' ? <p className="ex-note">Empty file</p> : <pre className="ex-text">{p.text}</pre>;
    case 'binary': return <p className="ex-note"><strong>No preview</strong>This is a binary file ({formatSize(p.size)}). Open it in another app to see it.</p>;
    case 'tooLarge': return <p className="ex-note"><strong>Too large to preview</strong>{formatSize(p.size)}; previews stop at {formatSize(p.limit)}.</p>;
  }
}

interface FileViewerProps {
  root: string;
  /** The open file, relative to the root. */
  file: string;
  preview: PreviewState;
  canEdit: boolean;
  width: number;
  explorerWidth: number;
  resize(w: number, done: boolean): void;
  /** No room to dock beside the tree and keep the canvas: it floats over the canvas instead. */
  floating: boolean;
  onClose(): void;
  /** Closed already and only playing its exit (useLingering). */
  closing?: boolean;
}

/** The open file, in its own panel docked right of the tree: its name, where it is, and the file itself. */
function FileViewer({ root, file, preview, canEdit, width, explorerWidth, resize, floating, onClose, closing }: FileViewerProps) {
  const shell = useRef<HTMLElement>(null);
  const fileName = file.split('/').at(-1) ?? '';
  const editLink = editorUrl(file, root);
  return (
    <section ref={shell} className={`ex-viewer${floating ? ' is-floating' : ''}${closing ? ' is-closing' : ''}`} aria-label={`Preview of ${fileName}`}
      inert={closing} aria-hidden={closing || undefined}
      style={{ '--fv-w': `${width}px`, '--ex-w': `${explorerWidth}px` } as CSSProperties}
      onKeyDown={(e) => {
        if (e.key !== 'Escape' || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
        e.preventDefault();
        onClose();
      }}>
      <header className="ex-pv-head">
        <div className="ex-pv-title">
          <strong title={file}>{fileName}</strong>
          <span className="ex-pv-path" title={file}>{[parentOf(file), preview.status === 'ok' ? formatSize(preview.preview.size) : ''].filter(Boolean).join(' · ') || '\u00a0'}</span>
        </div>
        <button type="button" className="ex-icon" aria-label="Show in Finder" title="Show in Finder"
          onClick={() => { revealFile(join(root, file)).catch(() => {}); }}>
          <svg className="i" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M2 4.5a1 1 0 0 1 1-1h3l1.5 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1Z" /><path d="M6.5 9.5h3m-1.5-1.5 1.5 1.5L8 11" /></svg>
        </button>
        {canEdit && editLink && (
          <button type="button" className="ex-icon" aria-label="Open in editor" title="Open in editor"
            onClick={() => { openExternal(editLink).catch(() => {}); }}>
            <svg className="i" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="m5.5 5-3 3 3 3m5-6 3 3-3 3" /></svg>
          </button>
        )}
        <button type="button" className="ex-icon" aria-label="Close preview" title="Close preview · Esc" onClick={onClose}>
          <svg className="i" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8m0-8-8 8" /></svg>
        </button>
      </header>
      <div className="ex-pv-body" key={file}><PreviewBody state={preview} name={fileName} /></div>
      <ResizeEdge panel={shell} width={width} min={VIEWER_MIN} fallback={VIEWER_DEFAULT} label="Resize file preview" resize={resize} />
    </section>
  );
}

export function Explorer({ zone, root, onClose, onOpenChat, closing }: ExplorerProps) {
  const [tab, setTab] = useState<'Files' | 'Git'>('Files');
  const [revision, setRevision] = useState(0);
  const [message, setMessage] = useState('');
  const [dirs, setDirs] = useState<Dirs>({});
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const [file, setFile] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewState>({ status: 'loading' });
  const [focus, setFocus] = useState<string | null>(null);
  const [width, setWidth] = useState(() => loadWidth(WIDTH_KEY, EXPLORER_MIN, EXPLORER_DEFAULT));
  const [viewerWidth, setViewerWidth] = useState(() => loadWidth(VIEWER_KEY, VIEWER_MIN, VIEWER_DEFAULT));
  const [canEdit, setCanEdit] = useState(false);
  const shell = useRef<HTMLElement>(null);
  const rowEls = useRef(new Map<string, HTMLElement>());
  /** What the Git tab last showed, kept here because the tab is drawn afresh each time it is entered. */
  const gitSeen = useRef<GitStatus | null>(null);
  /** How many times Reload was pressed: its arrow turns once for each (motion.css). */
  const [turns, setTurns] = useState(0);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);

  const load = useCallback((dir: string) => {
    setDirs((d) => ({ ...d, [dir]: { status: 'loading' } }));
    filesBridge.list(root, dir).then(
      (listing) => { if (live.current) setDirs((d) => ({ ...d, [dir]: { status: 'ok', listing } })); },
      (err: unknown) => { if (live.current) setDirs((d) => ({ ...d, [dir]: { status: 'error', message: errorText(err) } })); },
    );
  }, [root]);
  useEffect(() => { load(''); }, [load]);
  useEffect(() => {
    let on = true;
    previewBridge.canOpenInEditor().then((ok) => { if (on) setCanEdit(ok); }, () => {});
    return () => { on = false; };
  }, []);

  const rows = useMemo(() => visibleRows(dirs, open), [dirs, open]);
  const entryRows = rows.filter((r): r is Extract<Row, { kind: 'entry' }> => r.kind === 'entry');
  const tabStop = entryRows.some((r) => r.path === focus) ? focus : entryRows[0]?.path ?? null;
  // Rows that arrive together follow one another (cascade.ts): the whole tree from its top when it
  // is first drawn or the tab comes back to it, a folder's own rows from that folder when it opens.
  const drawn = useRef(false);
  useLayoutEffect(() => { drawn.current = tab === 'Files' && rows.length > 0; });
  const under: number[] = [];
  const place = rows.map((row, i) => {
    under[row.depth] = i;
    return drawn.current && row.depth > 0 ? i - under[row.depth - 1]! - 1 : i;
  });

  const toggle = (path: string) => {
    const opening = !open.has(path);
    setOpen((o) => {
      const next = new Set(o);
      if (opening) next.add(path); else next.delete(path);
      return next;
    });
    // A folder is listed when first opened; one that failed is asked again.
    if (opening && dirs[path]?.status !== 'ok') load(path);
  };
  const seq = useRef(0);
  const openFile = (path: string) => {
    setFile(path);
    setPreview({ status: 'loading' });
    const n = ++seq.current;
    filesBridge.preview(root, path).then(
      (p) => { if (live.current && seq.current === n) setPreview({ status: 'ok', preview: p }); },
      (err: unknown) => { if (live.current && seq.current === n) setPreview({ status: 'error', message: errorText(err) }); },
    );
  };
  const closeFile = () => {
    seq.current++;
    setFile(null);
    if (file) setFocus(file);
  };
  /** Closed from inside its own panel: focus goes back to the file's row in the tree. */
  const closeViewer = () => { closeFile(); setMoved(true); };
  const reload = () => {
    load('');
    for (const dir of open) load(dir);
    if (file) openFile(file);
  };
  const activate = (row: Extract<Row, { kind: 'entry' }>) => {
    setFocus(row.path);
    if (row.entry.outside) return;
    if (row.entry.kind === 'dir') toggle(row.path);
    else openFile(row.path);
  };

  // The arrow keys move along the rows (focus follows), Right and Left open and close folders.
  const [moved, setMoved] = useState(false);
  useLayoutEffect(() => {
    if (!moved || tabStop === null) return;
    setMoved(false);
    rowEls.current.get(tabStop)?.focus({ preventScroll: false });
  }, [moved, tabStop]);
  const onTreeKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const current = tabStop;
    if (current === null) return;
    const row = entryRows.find((r) => r.path === current);
    if (!row) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(row); return; }
    if (e.key === 'ArrowRight' && row.entry.kind === 'dir' && !row.open && !row.entry.outside) { e.preventDefault(); toggle(row.path); return; }
    if (e.key === 'ArrowLeft' && row.open) { e.preventDefault(); toggle(row.path); return; }
    const next = stepFocus(rows, current, e.key);
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) e.preventDefault();
    if (next !== null) { setFocus(next); setMoved(true); }
  };

  // Esc steps back: the preview first, then the explorer itself.
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== 'Escape' || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    e.preventDefault();
    if (tab === 'Files' && file !== null) { closeFile(); setMoved(true); } else onClose();
  };

  // Each panel's right edge resizes it; the canvas keeps its room beside both.
  const page = () => shell.current?.closest('.canvas-area')?.clientWidth ?? window.innerWidth;
  const resize = (w: number, done: boolean) => {
    const next = clampExplorerWidth(w, page());
    setWidth(next);
    if (done) saveWidth(WIDTH_KEY, next);
  };
  const resizeViewer = (w: number, done: boolean) => {
    const next = clampViewerWidth(w, page(), width);
    setViewerWidth(next);
    if (done) saveWidth(VIEWER_KEY, next);
  };

  // The room beside the explorer, so the file's panel docks only where the canvas keeps its own.
  const [area, setArea] = useState(() => window.innerWidth);
  useLayoutEffect(() => {
    const el = shell.current?.closest('.canvas-area');
    if (!el) return;
    setArea(el.clientWidth);
    const watch = new ResizeObserver(() => setArea(el.clientWidth));
    watch.observe(el);
    return () => watch.disconnect();
  }, []);
  const floating = area - width - GAP - Math.min(viewerWidth, VIEWER_MAX) - GAP < CANVAS_MIN;

  // The file's panel leaves as the explorer does: it stays for its exit (docs/motion.md).
  const viewer = useLingering(file === null ? null : (
    <FileViewer root={root} file={file} preview={preview} canEdit={canEdit} width={viewerWidth} explorerWidth={width}
      resize={resizeViewer} floating={floating} onClose={closeViewer} closing={closing} />
  ), PANEL_EXIT_MS);

  const rootState = dirs[''];
  const home = homeOf(root);
  return (<>
    <aside ref={shell} className={`explorer${closing ? ' is-closing' : ''}`} aria-label={`${tab} in ${zone.name}`} inert={closing} aria-hidden={closing || undefined}
      style={{ '--ex-w': `${width}px`, '--zone-hue': zoneHue(zone) } as CSSProperties} onKeyDown={onKeyDown}>
      <header className="ex-head">
        <ZoneMark icon={zone.icon} />
        <div className="ex-title">
          <h2>{zone.name}</h2>
          <span className="ex-root" title={root}>{shortPath(root, home)}</span>
        </div>
        <button type="button" className="ex-icon" aria-label={tab === 'Files' ? 'Reload files' : 'Refresh Git changes'} title="Reload"
          onClick={() => { setTurns(n => n + 1); if (tab === 'Files') reload(); else setRevision(n => n + 1); }}>
          <svg key={turns} className={`i${turns ? ' ex-turn' : ''}`} width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M13 8a5 5 0 1 1-1.5-3.55M13 2.5v2.5h-2.5" /></svg>
        </button>
        <button type="button" className="ex-icon" aria-label="Close files" title="Close · Esc" onClick={onClose}>
          <svg className="i" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8m0-8-8 8" /></svg>
        </button>
      </header>
      <div className="ex-views ex-seg" role="tablist" aria-label="Project views">
        {(['Files', 'Git'] as const).map(view => <button key={view} type="button" role="tab" id={`ex-tab-${view}`}
          aria-selected={view === tab} aria-controls="ex-panel" className={view === tab ? 'is-on' : ''} tabIndex={view === tab ? 0 : -1}
          onClick={() => setTab(view)} onKeyDown={e => {
            if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(e.key)) return;
            e.preventDefault();
            const next = e.key === 'Home' ? 'Files' : e.key === 'End' ? 'Git' : view === 'Git' ? 'Files' : 'Git';
            setTab(next);
            document.getElementById(`ex-tab-${next}`)?.focus();
          }}>{view}</button>)}
      </div>
      <div className="ex-panel" id="ex-panel" role="tabpanel" aria-labelledby={`ex-tab-${tab}`}>
      {tab === 'Git' ? <GitPanel root={root} revision={revision} message={message} setMessage={setMessage} onOpenChat={onOpenChat} seen={gitSeen} /> : <>
      <div className="ex-tree" role="tree" aria-label={`${zone.name} files`} onKeyDown={onTreeKey}>
        {(!rootState || rootState.status === 'loading') && <p className="ex-note is-loading">Loading…</p>}
        {rootState?.status === 'error' && <p className="ex-note is-error" role="alert">{rootState.message}</p>}
        {rootState?.status === 'ok' && rootState.listing.entries.length === 0 && <p className="ex-note">This folder is empty.</p>}
        {rows.map((row, i) => row.kind === 'note'
          ? <div key={row.path} ref={(el) => arrive(el, place[i]!)} className={`ex-row ex-sub is-${row.tone}`} style={{ '--depth': row.depth } as CSSProperties} role="none">{row.text}</div>
          : <div key={row.path} ref={(el) => { arrive(el, place[i]!); if (el) rowEls.current.set(row.path, el); else rowEls.current.delete(row.path); }}
              className={`ex-row${row.entry.ignored ? ' is-ignored' : ''}${row.entry.outside ? ' is-outside' : ''}${row.path === file ? ' is-open-file' : ''}`}
              style={{ '--depth': row.depth } as CSSProperties}
              role="treeitem" aria-level={row.depth + 1} aria-expanded={row.entry.kind === 'dir' ? row.open : undefined}
              aria-selected={row.path === file} aria-disabled={row.entry.outside || undefined}
              tabIndex={row.path === tabStop ? 0 : -1} data-path={row.path}
              // An image row drags onto the canvas or into a zone, where it is shown by its path (web/src/board).
              {...explorerImageDrag(row.entry, join(root, row.path))}
              title={row.entry.outside ? `${row.entry.name}: leads outside the project folder` : row.entry.name}
              onFocus={() => setFocus(row.path)}
              onClick={() => activate(row)}>
              {row.entry.kind === 'dir' ? <Chevron /> : <span className="ex-chev-space" />}
              {row.entry.kind === 'dir' ? <FolderIcon /> : <FileIcon name={row.entry.name} />}
              <span className="ex-name">{row.entry.name}</span>
              {row.entry.outside && <span className="ex-tag" aria-label="outside the project">↗</span>}
            </div>)}
      </div>
      </>}
      </div>
      <ResizeEdge panel={shell} width={width} min={EXPLORER_MIN} fallback={EXPLORER_DEFAULT} label="Resize files panel" resize={resize} />
    </aside>
    {viewer}
  </>);
}
