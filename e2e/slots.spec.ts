// Card slots in the built demo app (hidden): cards stay where they are through state changes and
// new sessions, a zone tidies on demand with an undo, a drag puts a card in a slot that is kept,
// and idle sessions untouched for long fold into "Earlier" on start (web/src/canvas/cardSlots.ts).
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

/** Every session card's slot: its zone, its column, its place in the column and the column's x. */
const slotsOf = (page: Page): Promise<Record<string, string>> => page.evaluate(() => Object.fromEntries(
  [...document.querySelectorAll<HTMLElement>('.zone')].flatMap((zone) =>
    [...zone.querySelectorAll<HTMLElement>(':scope > .cards > .col')].flatMap((col, c) =>
      [...col.querySelectorAll<HTMLElement>(':scope > .card[data-card-id]:not(.project-chat-card)')].map((card, i) =>
        [card.dataset.cardId!, `${zone.dataset.zoneId} col ${c} row ${i} x ${card.offsetLeft}`]))),
));

const zone = (page: Page, name: string) => page.locator('.zone', { has: page.locator('.zone-label .name', { hasText: new RegExp(`^${name}$`) }) });

test('slots: a session changing state moves no card, and a new session lands without reshuffling', async () => {
  const app = await launch();
  try {
    const page = await app.firstWindow();
    await expect(page.locator('article.card')).toHaveCount(11);
    await settled(page);
    const before = await slotsOf(page);
    expect(Object.keys(before)).toHaveLength(11);

    // A finished reply is seen (needs you → idle), an approval is answered (needs you → working):
    // under the old sort both would have jumped; now every card keeps its slot.
    await expect(page.locator('[data-card-id="demo-purchases"]')).toHaveClass(/\bis-done\b/);
    await page.evaluate(() => window.canvas!.markSeen(['demo-purchases']));
    await expect(page.locator('[data-card-id="demo-purchases"]')).not.toHaveClass(/\bis-done\b/);
    await settled(page);
    expect(await slotsOf(page)).toEqual(before);
    // Still in place after a reload: the slots are saved in the layout.
    await page.reload();
    await expect(page.locator('article.card')).toHaveCount(11);
    await settled(page);
    expect(await slotsOf(page)).toEqual(before);

    // A new session in garden-sim: it takes a free slot; no card already there moves.
    await zone(page, 'garden-sim').getByRole('button', { name: 'New session in garden-sim' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('First message').fill('Check the slot model');
    await dialog.getByRole('button', { name: 'Start' }).click();
    await expect(dialog).toHaveCount(0);
    await page.locator('.chat-screen').getByRole('button', { name: 'Close chat' }).click();
    await expect(page.locator('article.card')).toHaveCount(12);
    await settled(page);
    const after = await slotsOf(page);
    const added = Object.keys(after).filter((id) => !(id in before));
    expect(added).toHaveLength(1);
    expect(after[added[0]!]).toMatch(/^folder:garden-sim /);
    for (const [id, slot] of Object.entries(before)) expect(after[id], id).toBe(slot);
    await page.screenshot({ path: 'e2e/shots/slots-new-session.png' });
  } finally {
    await closeApp(app);
  }
});

test('slots: Tidy orders a zone by recent activity and can be undone; a dragged card keeps its new slot', async () => {
  const app = await launch();
  try {
    const page = await app.firstWindow();
    await expect(page.locator('article.card')).toHaveCount(11);
    await settled(page);
    const before = await slotsOf(page);

    const garden = zone(page, 'garden-sim');
    await garden.getByRole('button', { name: 'Tidy garden-sim' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'garden-sim tidied' })).toBeVisible();
    await settled(page);
    const tidied = await slotsOf(page);
    // Most recent first, row by row: the approval asked 2 min ago leads, the 6-min-old work next.
    expect(tidied['demo-hostly']).toMatch(/col 0 row 0 /);
    expect(tidied['demo-reconnect']).toMatch(/col 1 row 0 /);
    expect(tidied).not.toEqual(before);
    // Other zones are untouched.
    for (const [id, slot] of Object.entries(before)) if (!slot.startsWith('folder:garden-sim ')) expect(tidied[id]).toBe(slot);
    await page.getByRole('status').getByRole('button', { name: /Undo/ }).click();
    await settled(page);
    expect(await slotsOf(page)).toEqual(before);

    // Drag the Codex card to the top of the zone's first column.
    const card = page.locator('[data-card-id="demo-codex"]');
    const top = (await garden.locator(':scope > .cards > .col').first().locator('article.card').first().boundingBox())!;
    const from = (await card.boundingBox())!;
    await page.mouse.move(from.x + 60, from.y + 20);
    await page.mouse.down();
    await page.mouse.move(from.x + 40, from.y + 30, { steps: 4 });
    await page.mouse.move(top.x + 60, top.y + 10, { steps: 10 });
    await page.mouse.up();
    await settled(page);
    const moved = await slotsOf(page);
    expect(moved['demo-codex']).toMatch(/^folder:garden-sim col 0 row 0 /);
    await page.reload();
    await expect(page.locator('article.card')).toHaveCount(11);
    await settled(page);
    expect((await slotsOf(page))['demo-codex']).toMatch(/^folder:garden-sim col 0 row 0 /);
  } finally {
    await closeApp(app);
  }
});

test('slots: idle sessions untouched past the fold limit gather in Earlier on start, and open on demand', async () => {
  const app = await launch();
  try {
    const page = await app.firstWindow();
    await expect(page.locator('article.card')).toHaveCount(11);
    // Fold after 12 hours: the Codex card (idle 20 h) and the progression one (22 h) qualify.
    await page.evaluate(() => localStorage.setItem('agent-canvas.card-slots', JSON.stringify({ autoTidy: false, foldAfterHours: 12 })));
    await page.reload();
    await expect(page.locator('article.card')).toHaveCount(9);
    const garden = zone(page, 'garden-sim');
    const fold = garden.locator('.zone-earlier-toggle');
    await expect(fold).toHaveText('Earlier·1');
    await expect(fold).toHaveAttribute('aria-expanded', 'false');
    await fold.click();
    await expect(garden.locator('.zone-earlier [data-card-id="demo-codex"]')).toBeVisible();
    await settled(page);
    await garden.screenshot({ path: 'e2e/shots/slots-earlier.png' });
  } finally {
    await closeApp(app);
  }
});

test('slots: the Needs you strip opens a session and its card stays where it is', async () => {
  const app = await launch();
  try {
    const page = await app.firstWindow();
    await expect(page.locator('article.card')).toHaveCount(11);
    await settled(page);
    const before = await slotsOf(page);
    const queue = page.getByRole('region', { name: 'Needs you' });
    // Each chip shows the session's creature, its name and why it waits.
    await expect(queue.locator('.brief-tag .brief-icon .cr')).toHaveCount(2);
    await queue.getByRole('button', { name: /Approval requested/ }).click();
    await expect(page.locator('.chat-screen .cs-heading h1')).toHaveText('Enable account deletion approvals on Hostly');
    await settled(page);
    expect(await slotsOf(page)).toEqual(before);
  } finally {
    await closeApp(app);
  }
});
