// Serve only media named in the open conversation. Chromium handles byte ranges on file URLs.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { ChatState } from '../shared/chat.ts';
import { splitFiles } from '../shared/attachments.ts';
import { mediaLink, mediaLinkPattern, mediaTypes } from '../shared/chatMedia.ts';

export async function serveChatMedia(request: Request, stateFor: (id: string) => ChatState | null,
  fetchFile: (url: string, init: RequestInit) => Promise<Response>): Promise<Response> {
  const url = new URL(request.url);
  const state = stateFor(url.searchParams.get('session') ?? '');
  const src = url.searchParams.get('src') ?? '';
  const missing = () => new Response(null, { status: 404 });
  if (!state || !src || url.host !== 'item' || !['GET', 'HEAD'].includes(request.method)) return missing();
  const referenced = state.items.some(item => {
    if (item.kind === 'tool') return item.media?.some(media => media.src === src);
    if (item.kind === 'user') return splitFiles(item.text).files.some(file => file.path === src);
    if (item.kind !== 'assistant') return false;
    for (const match of item.text.matchAll(mediaLinkPattern)) {
      if (mediaLink(match[2]!, match[1]!)?.src === src) return true;
    }
    return false;
  });
  if (!referenced || (/^[a-z][\w+.-]*:/i.test(src) && !src.startsWith('file:///'))) return missing();
  try {
    const file = src.startsWith('file:///') ? fileURLToPath(src) : path.resolve(state.cwd, src);
    const mime = mediaTypes[path.extname(file).slice(1).toLowerCase()];
    if (!mime || !(await fs.stat(file)).isFile()) return missing();
    const range = request.headers.get('Range');
    const fileResponse = await fetchFile(pathToFileURL(file).href, { method: request.method, headers: range ? { Range: range } : {} });
    const headers = new Headers(fileResponse.headers);
    headers.set('Content-Type', mime);
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('Cache-Control', 'no-store');
    return new Response(fileResponse.body, { status: fileResponse.status, headers });
  } catch { return missing(); }
}
