import { describe, expect, it } from 'vitest';
import { chatBlocks } from './useChat.ts';

const READ_ONLY = 'Open in another app — read-only here';
const WARNING = "Codex didn't answer";

describe('chatBlocks', () => {
  it('is read-only while another app has the session', () => {
    expect(chatBlocks({ owner: 'elsewhere', banner: READ_ONLY }, null)).toEqual({ readOnly: true, provider: null, warning: null, blocked: READ_ONLY });
    // A Claude chat open elsewhere takes messages between that app's turns; Codex can queue at any time.
    expect(chatBlocks({ owner: 'elsewhere', banner: READ_ONLY, provider: 'claude' }, null)).toEqual({ readOnly: true, provider: null, warning: null, blocked: null });
    expect(chatBlocks({ owner: 'elsewhere', banner: READ_ONLY, provider: 'claude' }, null, true).blocked).toBe(READ_ONLY);
    expect(chatBlocks({ owner: 'elsewhere', banner: READ_ONLY, provider: 'codex' }, null, true).blocked).toBeNull();
  });

  it('shows the provider banner and blocks sending while it is set', () => {
    const banner = 'Claude Code is signed out on this Mac. Run claude, then /login.';
    expect(chatBlocks({ owner: 'here', banner: null }, { text: banner, blocking: true }))
      .toEqual({ readOnly: false, provider: banner, warning: null, blocked: banner });
  });

  it('takes a provider reason from the chat banner, without the read-only part', () => {
    expect(chatBlocks({ owner: 'elsewhere', banner: `${READ_ONLY} · Codex didn't start` }, null))
      .toEqual({ readOnly: true, provider: "Codex didn't start", warning: null, blocked: READ_ONLY });
  });

  it('blocks nothing for a chat run here with no banner', () => {
    expect(chatBlocks({ owner: 'here', banner: null }, null)).toEqual({ readOnly: false, provider: null, warning: null, blocked: null });
    expect(chatBlocks({ owner: 'nobody', banner: null }, null)).toEqual({ readOnly: false, provider: null, warning: null, blocked: null });
  });

  it("a Codex timeout is shown and sending stays on", () => {
    expect(chatBlocks({ owner: 'here', banner: WARNING }, { text: WARNING, blocking: false }))
      .toEqual({ readOnly: false, provider: null, warning: WARNING, blocked: null });
    // Before the snapshot has it, from the chat banner alone.
    expect(chatBlocks({ owner: 'nobody', banner: WARNING }, null))
      .toEqual({ readOnly: false, provider: null, warning: WARNING, blocked: null });
  });
});
