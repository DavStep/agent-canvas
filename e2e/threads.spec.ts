// Board thread notes and their actions in the hidden Electron test fixture.
import { writeFile } from 'node:fs/promises';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';

const launch = (): Promise<ElectronApplication> =>
  electron.launch({ args: ['dist-electron/main.js', '--demo'], env: { ...process.env, AGENT_CANVAS_HIDDEN: '1' } as Record<string, string> });

async function closeApp(app: ElectronApplication): Promise<void> {
  const proc = app.process();
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  const closed = new Promise<void>((resolve) => proc.once('exit', () => resolve()));
  proc.kill('SIGTERM');
  const deadline = setTimeout(() => proc.kill('SIGKILL'), 12_000);
  try { await closed; } finally { clearTimeout(deadline); }
}

const settled = (page: Page): Promise<void> => page.evaluate(async () => {
  const finite = document.getAnimations().filter((a) => Number.isFinite(a.effect?.getComputedTiming().endTime as number));
  await Promise.allSettled(finite.map((a) => a.finished));
});

/** Drags the ticket titled `title` over the element `selector` names, and drops it there unless `drop` is false. */
const dragThread = (page: Page, title: string, selector: string, drop = true): Promise<void> => page.evaluate(({ title, selector, drop }) => {
  const ticket = [...document.querySelectorAll<HTMLElement>('.thread-note')].find((el) => el.querySelector('.tn-title')?.textContent === title);
  const target = document.querySelector(selector);
  if (!ticket || !target) throw new Error(`no ticket ${title} or no ${selector}`);
  const dataTransfer = new DataTransfer();
  const r = target.getBoundingClientRect();
  const at = { bubbles: true, cancelable: true, dataTransfer, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 };
  ticket.dispatchEvent(new DragEvent('dragstart', at));
  target.dispatchEvent(new DragEvent('dragenter', at));
  target.dispatchEvent(new DragEvent('dragover', at));
  if (!drop) return;
  target.dispatchEvent(new DragEvent('drop', at));
  ticket.dispatchEvent(new DragEvent('dragend', at));
}, { title, selector, drop });

test('open threads: notes sit beside their chats, drag into a chat, abort with undo, and start a session on a zone', async () => {
  const app = await launch();
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await expect(page.locator('article.card')).toHaveCount(11);

    const notes = page.locator('.board .thread-note');
    await expect(notes).toHaveCount(2);
    const events = notes.filter({ hasText: 'Timed events for the miner' });
    await expect(events.locator('.tn-question')).toContainText('gated by location or by Coins');
    await expect(events.locator('.tn-project')).toHaveText('garden-sim');
    await expect(events.locator('.tn-age')).toHaveText('yesterday');
    await expect(events.getByRole('button', { name: 'Preview improvement suggestions' })).toBeEnabled();
    await settled(page);
    const noteBox = (await events.boundingBox())!;
    const cardBox = (await page.locator('[data-card-id="demo-preview"]').boundingBox())!;
    expect(Math.abs(noteBox.y - cardBox.y)).toBeLessThan(2);
    expect(noteBox.x).toBeGreaterThan(cardBox.x + cardBox.width);
    await page.screenshot({ path: 'e2e/shots/threads-1440.png' });
    // Export the same frame at reading size, with the source card beside its note.
    const scale = await events.evaluate((el) => (el as HTMLElement).offsetWidth / el.getBoundingClientRect().width);
    const pad = 10 / scale;
    const client = await page.context().newCDPSession(page);
    try {
      const detail = await client.send('Page.captureScreenshot', { clip: {
        x: cardBox.x - pad, y: noteBox.y - pad,
        width: noteBox.x + noteBox.width - cardBox.x + 2 * pad,
        height: Math.max(noteBox.height, cardBox.height) + 2 * pad, scale,
      } });
      await writeFile('e2e/shots/thread-canvas.png', Buffer.from(detail.data, 'base64'));
    } finally { await client.detach(); }


    await events.getByRole('button', { name: 'Continue Timed events for the miner' }).click();
    await expect(page.locator('.chat-screen .composer textarea')).toHaveValue(/Should events be gated/);
    await expect(page).toHaveURL(/#demo-preview$/);
    await page.getByRole('status').filter({ hasText: 'Thread moved to the message' }).getByRole('button', { name: /Undo/ }).click();
    await page.getByRole('button', { name: 'Close chat', exact: true }).click();
    await page.getByRole('button', { name: 'Fit', exact: true }).click();
    await settled(page);

    // Into an open chat's composer: the message is added there for the owner to read and send.
    await page.locator('[data-card-id="demo-reconnect"]').click();
    const field = page.locator('.chat-screen .composer textarea');
    await expect(field).toBeVisible();
    await field.fill('Also:');
    await dragThread(page, 'Timed events for the miner', '.chat-screen .composer textarea', false);
    await expect(page.locator('.chat-screen .composer')).toHaveClass(/\bis-thread-target\b/);
    await expect(page.locator('.thread-hint')).toHaveText('Add to this message');
    await page.screenshot({ path: 'e2e/shots/threads-drag-1440.png' });
    await dragThread(page, 'Timed events for the miner', '.chat-screen .composer textarea');
    await expect(page.locator('.is-thread-target')).toHaveCount(0);
    await expect(field).toHaveValue(/^Also:\n\nPicking up something we left open: \*\*Timed events for the miner\*\*\./);
    await expect(field).toHaveValue(/\*\*Still open:\*\* Should events be gated by location or by Coins/);
    await expect(field).toHaveValue(/This came from “Preview improvement suggestions” about \d+ hours ago, working in \/Users\/demo\/Documents\/garden-sim\./);
    // It leaves the board, and Undo brings it back.
    await expect(events).toHaveCount(0);
    await expect(notes).toHaveCount(1);
    const moved = page.getByRole('status').filter({ hasText: 'Thread moved to the message' });
    await moved.getByRole('button', { name: /Undo/ }).click();
    await expect(events).toHaveCount(1);
    await expect(notes).toHaveCount(2);

    // Return to the board to abort the other note with the keyboard, then undo.
    await page.getByRole('button', { name: 'Close chat', exact: true }).click();
    await page.getByRole('button', { name: 'Fit', exact: true }).click();
    await settled(page);
    const rollback = notes.filter({ hasText: 'Rollback step for deploys' });
    const abort = rollback.getByRole('button', { name: 'Abort Rollback step for deploys' });
    await abort.focus();
    await abort.press('Enter');
    await expect(rollback).toHaveCount(0);
    await page.getByRole('status').filter({ hasText: 'Thread aborted' }).getByRole('button', { name: /Undo/ }).click();
    await expect(rollback).toHaveCount(1);
    await rollback.getByRole('button', { name: 'Done: Rollback step for deploys' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Thread marked done' })).toBeVisible();
    await expect(rollback).toHaveCount(0);
    await expect(notes).toHaveCount(1);

    // Onto a zone: a session starts in its folder with the message as its first prompt, and opens.
    await page.keyboard.press('Escape');
    const zoneId = await page.locator('.zone', { has: page.locator('.zone-label .name', { hasText: /^sailcloth-io$/ }) }).getAttribute('data-zone-id');
    await dragThread(page, 'Timed events for the miner', `.zone[data-zone-id="${zoneId}"]`);
    await expect(page.locator('article.card')).toHaveCount(12, { timeout: 15_000 });
    await expect(notes).toHaveCount(0);
    await expect(page.locator('.chat-screen')).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await closeApp(app);
  }
});
