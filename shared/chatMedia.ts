// Media supported by the transcript and by the local file protocol.
export interface ChatMedia { kind: 'image' | 'video'; src: string; label?: string }
export const mediaTypes: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', ogv: 'video/ogg',
};

export function mediaKind(src: string): ChatMedia['kind'] | null {
  const mime = src.startsWith('data:') ? /^data:([\w/+.-]+);base64,/i.exec(src)?.[1]
    : mediaTypes[/\.([a-z0-9]+)(?:[?#]|$)/i.exec(src.split(/[?#]/, 1)[0]!)?.[1]?.toLowerCase() ?? ''];
  if (!mime || !Object.values(mediaTypes).includes(mime)) return null;
  return mime.startsWith('video/') ? 'video' : 'image';
}

// Both Codex's ![image](path) and its [recording](<path with spaces>) are previews.
export const mediaLinkPattern = /!?\[([^\]\n]*)\]\((<[^>\n]+>|[^()\s]*(?:\([^()\s]*\)[^()\s]*)*)\)/g;

export function mediaLink(target: string, label: string): ChatMedia | null {
  const src = target.startsWith('<') && target.endsWith('>') ? target.slice(1, -1) : target;
  if (!src || src.startsWith('//') || (/^[a-z][\w+.-]*:/i.test(src) && !/^(https:\/\/|file:\/\/\/|data:)/i.test(src))) return null;
  const kind = mediaKind(src);
  return kind ? { kind, src, label } : null;
}
