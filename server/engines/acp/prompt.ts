// A message as an ACP prompt (session/prompt's content blocks). Files attached by path come as the
// `@"<path>"` mentions shared/attachments.ts writes (the chat shows them as file chips) and go as
// `resource_link` blocks, which every ACP agent takes. Images go as `image` blocks when the agent
// says it takes them (promptCapabilities.image, AcpConnection.canImage); otherwise they are saved
// as files and linked, with a line saying why, so the agent can still open them.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type * as acp from '@agentclientprotocol/sdk';
import { splitFiles } from '../../../shared/attachments.ts';
import type { ImageRef } from '../../../shared/chat.ts';
import { mediaTypes } from '../../../shared/chatMedia.ts';

export interface PromptOptions {
  /** The agent takes `image` blocks. */
  image: boolean;
  /** Saves images as files (AttachmentStore.keepImages), for an agent that takes no images. */
  keepImages?(images: ImageRef[]): Promise<{ name: string; path: string }[]>;
}

function link(file: { name: string; path: string }, mime?: string): acp.ContentBlock {
  const mimeType = mime ?? mediaTypes[path.extname(file.path).slice(1).toLowerCase()];
  return { type: 'resource_link', name: file.name, uri: pathToFileURL(file.path).href, ...(mimeType ? { mimeType } : {}) };
}

export async function promptBlocks(message: string, images: ImageRef[], opts: PromptOptions): Promise<acp.ContentBlock[]> {
  const { text, files } = splitFiles(message);
  const blocks: acp.ContentBlock[] = text !== '' ? [{ type: 'text', text }] : [];
  if (opts.image) {
    for (const img of images) {
      const data = /^data:[^;,]+;base64,(.*)$/s.exec(img.dataUrl)?.[1];
      if (data !== undefined) blocks.push({ type: 'image', mimeType: img.mime, data });
    }
  } else if (images.length > 0) {
    const kept = opts.keepImages ? await opts.keepImages(images) : [];
    const count = `${images.length} image${images.length === 1 ? '' : 's'}`;
    blocks.push({ type: 'text', text: kept.length > 0
      ? `[This agent does not take images, so the ${count} attached are linked as files.]`
      : `[${count} attached could not be sent: this agent does not take images.]` });
    blocks.push(...kept.map((f, i) => link(f, images[i]?.mime)));
  }
  blocks.push(...files.map((f) => link(f)));
  return blocks;
}
