// What the owner said: a right-aligned bubble, with any images above the text as small previews
// that open large when pressed, and any files attached by path as name chips (pressing one shows
// it in Finder). The files are read back from the provider's own block in the text.
import { memo } from 'react';
import { mediaKind } from '../../../../shared/chatMedia.ts';
import { MediaPreview } from '../ChatMedia.tsx';
import { splitFiles } from '../../../../shared/attachments.ts';
import type { ChatItem } from '../../../../shared/chat.ts';
import { revealFile } from '../../bridge.ts';
import { FileStrip, ImageStrip } from '../images.tsx';
import { LinkedText } from '../Markdown.tsx';

/** Drawn again only when its props change: unchanged items keep their identity (applyUpdate),
    so a streaming chat redraws only the item that grows. */
export const UserItem = memo(function UserItem({ item }: { item: Extract<ChatItem, { kind: 'user' }> }) {
  const { text, files } = splitFiles(item.text);
  return (
    <div className="t-you">
      <ImageStrip images={item.images} label="Images sent" className="t-you-images" />
      {files.filter(f => mediaKind(f.path) === 'video').map(f => <MediaPreview key={f.path} media={{ kind: 'video', src: f.path, label: f.name }} />)}
      <FileStrip files={files.filter(f => mediaKind(f.path) !== 'video')} label="Files sent" className="t-you-files" onOpen={(f) => { revealFile(f.path).catch(() => {}); }} />
      {text.trim() !== '' && <div className="t-you-text"><LinkedText text={text} /></div>}
      {item.queued && <small role="status">Queued in Codex</small>}
    </div>
  );
});
