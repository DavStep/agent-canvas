import { describe, expect, it, vi } from 'vitest';
import { withFiles } from '../../../shared/attachments.ts';
import { promptBlocks } from './prompt.ts';

const png = { mime: 'image/png', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' };
const message = withFiles('claude', 'Fix the header', [{ name: 'spec.md', path: '/data/attachments/t/spec.md' }]);

describe('promptBlocks', () => {
  it('sends text, images as image blocks and files as resource links to an agent that takes images', async () => {
    expect(await promptBlocks(message, [png], { image: true })).toEqual([
      { type: 'text', text: 'Fix the header' },
      { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' },
      { type: 'resource_link', name: 'spec.md', uri: 'file:///data/attachments/t/spec.md' },
    ]);
  });

  it('links saved copies of the images, saying why, for an agent that takes none', async () => {
    const keepImages = vi.fn().mockResolvedValue([{ name: 'image-1.png', path: '/data/attachments/u/image-1.png' }]);
    const blocks = await promptBlocks('Look', [png], { image: false, keepImages });
    expect(keepImages).toHaveBeenCalledWith([png]);
    expect(blocks).toEqual([
      { type: 'text', text: 'Look' },
      { type: 'text', text: '[This agent does not take images, so the 1 image attached are linked as files.]' },
      { type: 'resource_link', name: 'image-1.png', uri: 'file:///data/attachments/u/image-1.png', mimeType: 'image/png' },
    ]);
    expect((await promptBlocks('Look', [png, png], { image: false }))[1]).toEqual(
      { type: 'text', text: '[2 images attached could not be sent: this agent does not take images.]' });
  });

  it('plain text stays one text block; a path with spaces becomes a proper file URL', async () => {
    expect(await promptBlocks('Hello', [], { image: false })).toEqual([{ type: 'text', text: 'Hello' }]);
    const spaced = withFiles('claude', '', [{ name: 'My notes.txt', path: '/tmp/My notes.txt' }]);
    expect(await promptBlocks(spaced, [], { image: true })).toEqual([{ type: 'resource_link', name: 'My notes.txt', uri: 'file:///tmp/My%20notes.txt' }]);
  });
});
