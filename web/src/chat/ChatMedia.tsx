import { createContext, useContext, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ChatMedia } from '../../../shared/chatMedia.ts';
import { ImageViewer } from './images.tsx';

export const MediaSession = createContext('');
export function MediaPreview({ media }: { media: ChatMedia }) {
  const session = useContext(MediaSession);
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const { src, kind } = media;
  const remote = /^https:\/\//i.test(src);
  const direct = remote || new RegExp(`^data:${kind}/[\\w.+-]+;base64,`, 'i').test(src);
  const url = direct ? src : `canvas-media://item/?${new URLSearchParams({ session, src })}`;
  const label = media.label || (direct ? kind : src.split('/').pop()) || kind;
  if (failed === url) return <span className="media-missing">{label} · Preview unavailable</span>;
  if (kind === 'video') return <video className="chat-video" controls preload="metadata" src={url} aria-label={label} onError={() => setFailed(url)} />;
  return <>
    <button type="button" className="chat-image" aria-label={`View ${label}`} onClick={() => setOpen(true)}>
      <img loading="lazy" referrerPolicy="no-referrer" src={url} alt={label} onError={() => setFailed(url)} />
    </button>
    {open && createPortal(<ImageViewer images={[{ mime: 'image/*', dataUrl: url }]} index={0} onIndex={() => {}} onClose={() => setOpen(false)} />, document.body)}
  </>;
}
