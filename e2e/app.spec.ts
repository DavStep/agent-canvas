// The built app in demo mode: it starts, shows the canvas and a chat, and logs no errors.
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** The demo app, hidden: no window shows, takes focus or bounces the Dock (AGENT_CANVAS_HIDDEN). */
const launch = (env: Record<string, string> = {}, demo = '--demo'): Promise<ElectronApplication> =>
  electron.launch({ args: ['dist-electron/main.js', demo], env: { ...process.env, ...env, AGENT_CANVAS_HIDDEN: '1' } as Record<string, string> });

/** Waits until every one-shot animation and transition on the page has played (docs/motion.md);
    loops (the live dot, the needs-you halo) never end and are left out. */
const settled = (page: Page): Promise<void> => page.evaluate(async () => {
  const finite = document.getAnimations().filter((a) => Number.isFinite(a.effect?.getComputedTiming().endTime as number));
  await Promise.allSettled(finite.map((a) => a.finished));
});

/** Ends the app as a signal does: busy sessions are stopped at once rather than left to finish
    in the background, as ⌘Q would. */
async function closeApp(app: ElectronApplication): Promise<void> {
  const proc = app.process();
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  const closed = new Promise<void>((resolve) => proc.once('exit', () => resolve()));
  proc.kill('SIGTERM');
  // The demo has no live sessions. Reap a wedged test app before its worker times
  // out and leaves the unthrottled renderer consuming CPU in the background.
  const deadline = setTimeout(() => proc.kill('SIGKILL'), 12_000);
  try { await closed; } finally { clearTimeout(deadline); }
}

test('demo canvas renders', async () => {
  const app = await launch();
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(e.message));
    // The window may have loaded before the listeners were attached; load it again under them.
    await page.reload();

    const bounds = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getContentBounds());
    expect(bounds).toMatchObject({ width: 1440, height: 900 });

    await expect(page.locator('.zone')).toHaveCount(4);
    await expect(page.locator('article.card')).toHaveCount(11);
    await expect(page.locator('.topbar .brand')).toHaveText('Agent canvas');
    await expect(page).toHaveTitle(/Agent canvas$/);
    // The page runs sandboxed, with the bridge and nothing else from Node.
    expect(await page.evaluate(() => typeof (window as { require?: unknown }).require)).toBe('undefined');
    expect(await page.evaluate(() => typeof window.canvas?.onSnapshot)).toBe('function');

    // Let the creatures' first animation frame settle before the picture.
    await page.waitForTimeout(500);
    await page.screenshot({ path: 'e2e/shots/canvas-1440.png' });
    expect(errors).toEqual([]);
  } finally {
    await closeApp(app);
  }
});

test('activity log reopens a cleared Done and an approval request', async () => {
  const app = await launch();
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1100, 700));
    const queue = page.getByRole('region', { name: 'Needs you' });
    await queue.getByRole('button', { name: /Done/ }).click();
    await page.locator('.workspace').click({ position: { x: 4, y: 4 } });
    await expect(queue.getByRole('button', { name: /Done/ })).toHaveCount(0);
    await page.getByRole('button', { name: 'Close chat' }).click();
    await page.reload();

    const workspace = page.getByRole('main', { name: 'Canvas' });
    const trigger = workspace.getByRole('button', { name: 'Log', exact: true });
    const corner = (await trigger.boundingBox())!;
    const globe = (await workspace.getByTestId('agent-orb').boundingBox())!;
    const desk = (await workspace.boundingBox())!;
    expect(corner.x).toBe(globe.x);
    expect(corner.width).toBe(globe.width);
    expect(corner.y - desk.y).toBeCloseTo(desk.y + desk.height - globe.y - globe.height);
    const board = workspace.locator('.board');
    const before = await board.evaluate(el => getComputedStyle(el).transform);
    await workspace.hover({ position: { x: 6, y: 80 } });
    await page.mouse.wheel(0, 120);
    await expect.poll(() => board.evaluate(el => getComputedStyle(el).transform)).not.toBe(before);
    expect(await trigger.boundingBox()).toEqual(corner);
    await trigger.click();
    const log = page.getByRole('region', { name: 'Activity log' });
    const done = log.getByRole('button', { name: /Done.*Purchases unavailable/ });
    await expect(done).toBeVisible();
    await settled(page);
    await page.screenshot({ path: 'e2e/shots/activity-log.png', scale: 'css' });
    await done.press('Enter');
    await expect(log).toBeHidden();
    await expect(page.locator('.cs-heading h1')).toHaveText('Purchases unavailable in production');
    await trigger.press('Enter');
    await page.keyboard.press('Escape');
    await expect(log).toBeHidden();
    await expect(page.locator('.cs-heading h1')).toBeVisible();
    await trigger.click();
    await log.getByRole('button', { name: /Approval requested.*Hostly/ }).click();
    await expect(page.locator('.cs-heading h1')).toHaveText('Enable account deletion approvals on Hostly');
  } finally {
    await closeApp(app);
  }
});

test('zone editor saves a name, icon and color and cancels an unfinished edit', async () => {
  const app = await launch();
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1100, 700));
    const zone = page.locator('[data-zone-id="folder:sailcloth-io"]');
    const marker = zone.getByRole('button', { name: 'Edit sailcloth-io zone' });
    await marker.click();
    const editor = page.getByRole('dialog', { name: 'Edit sailcloth-io zone' });
    const name = editor.getByRole('textbox', { name: 'Name', exact: true });
    await expect(name).toBeFocused();
    await name.fill('Game tools');
    await editor.getByRole('radio', { name: 'Teal' }).check();
    await editor.getByRole('radio', { name: 'Gamepad' }).check();
    await settled(page);
    await page.screenshot({ path: 'e2e/shots/zone-editor.png' });
    await editor.getByRole('button', { name: 'Save' }).click();
    await expect(zone.locator('.zone-label .name')).toHaveText('Game tools');
    await page.reload();
    const edited = zone.getByRole('button', { name: 'Edit Game tools zone' });
    await expect(edited.locator('svg')).toHaveAttribute('data-icon', 'gamepad');
    await expect(edited.locator('svg')).toHaveCSS('color', 'rgb(32, 168, 155)');
    await edited.focus();
    await page.keyboard.press('Enter');
    const reopened = page.getByRole('dialog', { name: 'Edit Game tools zone' });
    await expect(reopened.getByRole('radio', { name: 'Gamepad' })).toBeChecked();
    const hex = reopened.getByRole('textbox', { name: 'Hex color' });
    await hex.fill('#abc');
    await expect(reopened.getByRole('button', { name: 'Save' })).toBeDisabled();
    await hex.fill('#ff9933');
    await hex.press('Escape');
    await expect(edited).toBeFocused();
    await expect(edited.locator('svg')).toHaveCSS('color', 'rgb(32, 168, 155)');
    await page.getByRole('button', { name: 'Zones', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Game tools', exact: true }).locator('svg')).toHaveAttribute('data-icon', 'gamepad');
  } finally {
    await closeApp(app);
  }
});

test('search: ⌘K finds a zone by name and lights its cards on the canvas; Enter on a session opens it', async () => {
  const app = await launch();
  try {
    const page = await app.firstWindow();
    await expect(page.locator('article.card')).toHaveCount(11);
    await page.keyboard.press('ControlOrMeta+K');
    const box = page.getByRole('combobox', { name: 'Search zones and sessions' });
    await expect(box).toBeFocused();
    await box.fill('dashboard');
    // The zone comes first in the list, then its sessions; the canvas lights them and dims the rest.
    await expect(page.locator('.jump-hit').first()).toHaveClass(/is-zone/);
    await expect(page.locator('.board')).toHaveClass(/is-searching/);
    await expect(page.locator('.card.is-hit')).toHaveCount(4);
    await expect(page.locator('.zone.is-hit')).toHaveCount(1);
    await settled(page);
    await page.screenshot({ path: 'e2e/shots/search-1440.png' });

    // Enter on the zone centres it, and the canvas goes back to normal.
    await page.keyboard.press('Enter');
    await expect(page.locator('.board')).not.toHaveClass(/is-searching/);
    await expect(page.locator('.card.is-hit')).toHaveCount(0);

    await page.keyboard.press('ControlOrMeta+K');
    await box.fill('hostly');
    await expect(page.locator('.card.is-hit-active')).toHaveCount(1);
    await page.keyboard.press('Enter');
    await expect(page.locator('.card[data-card-id="demo-hostly"]')).toHaveClass(/is-selected/);

    // The floating search owns focus above a docked chat. Dismissing it returns to the opener.
    const trigger = page.getByRole('button', { name: /Search zones, sessions/ });
    await trigger.click();
    await expect(page.getByRole('dialog', { name: 'Search canvas' })).toBeVisible();
    await expect(box).toBeFocused();
    await box.fill('dashboard');
    await box.press('ArrowDown');
    await expect(page.getByRole('listbox', { name: 'Zones and sessions' }).getByRole('option', { selected: true }))
      .toContainText('Database visualization');
    await box.press('Escape');
    await expect(trigger).toBeFocused();
    await expect(page.locator('.chat-screen')).toBeVisible();
  } finally {
    await closeApp(app);
  }
});

test('demo: the mouse Back and Forward buttons step between the canvas and the chats opened, not between panel and full screen', async () => {
  const app = await launch();
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await expect(page.locator('article.card')).toHaveCount(11);
    const cdp = await page.context().newCDPSession(page);
    /** A real side-button press and release, as the mouse sends it. */
    const press = async (button: 'back' | 'forward') => {
      const at = { x: 700, y: 500, button, clickCount: 1 };
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...at, buttons: button === 'back' ? 8 : 16 });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...at, buttons: 0 });
    };
    const screen = page.locator('.chat-screen');
    const heading = screen.locator('.cs-heading h1');

    // Chats open in the panel; a card beside it switches the chat, and each is a step.
    await page.locator('.card', { hasText: 'Enable account deletion approvals on Hostly' }).click();
    await expect(heading).toHaveText('Enable account deletion approvals on Hostly');
    await page.locator('.card', { hasText: 'Purchases unavailable in production' }).click();
    await expect(heading).toHaveText('Purchases unavailable in production');
    await expect(screen).toHaveClass(/\bis-panel\b/);

    // Full screen is no step: Back from it goes to the previous chat (still full screen), and the
    // rail's rows are steps too.
    await screen.getByRole('button', { name: 'Full screen' }).click();
    await expect(screen).toHaveClass(/\bis-full\b/);
    await press('back');
    await expect(heading).toHaveText('Enable account deletion approvals on Hostly');
    await expect(screen).toHaveClass(/\bis-full\b/);
    await screen.locator('.rail-row', { hasText: 'Purchases unavailable in production' }).click();
    await expect(heading).toHaveText('Purchases unavailable in production');
    await press('back');
    await expect(heading).toHaveText('Enable account deletion approvals on Hostly');
    // With no chat before it, Back closes the chat; the next open is the panel again.
    await press('back');
    await expect(screen).toHaveCount(0);
    await expect(page.locator('.card').first()).toBeVisible();
    // Nothing before the canvas: Back again stays.
    await press('back');
    await expect(screen).toHaveCount(0);

    await press('forward');
    await expect(heading).toHaveText('Enable account deletion approvals on Hostly');
    await expect(screen).toHaveClass(/\bis-panel\b/);
    await press('forward');
    await expect(heading).toHaveText('Purchases unavailable in production');

    // Esc keeps its own steps: full screen → panel is no history step; panel → canvas is one.
    await screen.getByRole('button', { name: 'Full screen' }).click();
    await page.locator('.thread').click({ position: { x: 4, y: 4 } });
    await page.keyboard.press('Escape');
    await expect(screen).toHaveClass(/\bis-panel\b/);
    await page.keyboard.press('Escape');
    await expect(screen).toHaveCount(0);
    await press('back');
    await expect(heading).toHaveText('Purchases unavailable in production');
    await press('back');
    await expect(heading).toHaveText('Enable account deletion approvals on Hostly');
    expect(errors).toEqual([]);
  } finally {
    await closeApp(app);
  }
});

test('"Show in Terminal" over the bridge takes the card id only; the demo runs no real session, so no app opens', async () => {
  const app = await launch();
  try {
    const page = await app.firstWindow();
    await expect(page.locator('article.card')).toHaveCount(11);
    await app.evaluate(({ shell }) => {
      const g = globalThis as unknown as { opened?: string[] };
      g.opened = [];
      shell.openPath = (async (p: string) => { g.opened!.push(p); return ''; }) as typeof shell.openPath;
    });
    const results = await page.evaluate(async () => {
      const canvas = window.canvas!;
      const call = (...args: unknown[]) => (canvas.showHost as (...a: unknown[]) => Promise<void>)(...args)
        .then(() => 'opened', (e: unknown) => String((e as Error).message));
      // The preload sends the id alone; a path the page adds never reaches main.
      return [await call('demo-dbviz'), await call('demo-dbviz', '/System/Applications/Calculator.app'), await call(42)];
    });
    expect(results[0]).toContain('This session is not running in another app');
    expect(results[1]).toContain('This session is not running in another app');
    expect(results[2]).toMatch(/session id must be a non-empty string/);
    expect(await app.evaluate(() => (globalThis as unknown as { opened?: string[] }).opened)).toEqual([]);
  } finally {
    await closeApp(app);
  }
});

test('demo chat over the bridge: open, a scripted turn pushed on its channel, approve, close', async () => {
  const app = await launch();
  try {
    const page = await app.firstWindow();
    await expect(page.locator('article.card')).toHaveCount(11);
    const result = await page.evaluate(async () => {
      const canvas = window.canvas!;
      const kinds: string[] = [];
      let approvalId: string | null = null;
      let idle: () => void = () => {};
      const finished = new Promise<void>((r) => { idle = r; });
      const off = canvas.onChat('demo-purchases', (u) => {
        kinds.push(u.op);
        if (u.op === 'upsert' && u.item.kind === 'approval' && u.item.status === 'pending') approvalId = u.item.id;
        if (u.op === 'meta' && u.patch.turn === 'idle') idle();
      });
      const state = await canvas.openChat('demo-purchases');
      await canvas.send('demo-purchases', 'Fix the product IDs', []);
      while (approvalId === null) await new Promise((r) => setTimeout(r, 50));
      await canvas.answerApproval('demo-purchases', approvalId, 'allow');
      await finished;
      off();
      canvas.closeChat('demo-purchases');
      const refused = await canvas.send('demo-purchases', 'x'.repeat(200_001), []).then(() => 'sent', (e: Error) => e.message);
      const accounts = await canvas.accounts().then(() => 'answered', (e: Error) => e.message);
      return { title: state.title, owner: state.owner, kinds: [...new Set(kinds)], refused, accounts };
    });
    expect(result).toMatchObject({ title: 'Purchases unavailable in production', owner: 'here' });
    expect(result.kinds).toEqual(expect.arrayContaining(['upsert', 'append', 'meta']));
    expect(result.refused).toMatch(/at most 200000 characters/);
    expect(result.accounts).toBe('answered');
  } finally {
    await closeApp(app);
  }
});

test('chat links: a URL in a reply opens in the browser outside, and the window never navigates', async () => {
  const app = await launch();
  try {
    const page = await app.firstWindow();
    await expect(page.locator('article.card')).toHaveCount(11);
    // macOS never really gets the link in a test: main records it instead.
    await app.evaluate(({ shell }) => {
      const g = globalThis as unknown as { links?: string[] };
      g.links = [];
      shell.openExternal = (async (url: string) => { g.links!.push(url); }) as typeof shell.openExternal;
    });
    const url = 'https://tickets.example.com/t/4576';

    await page.locator('.card', { hasText: 'System discussion with friend notes' }).click();
    // The open chat is in the app's own URL (its #card route); pressing a link may not change it.
    const before = page.url();
    // The reply ends "…the ticket: <url>." and the full stop stays out of the link.
    const link = page.locator('.chat-screen .md a.md-link', { hasText: url });
    await expect(link).toHaveAttribute('href', url);
    await expect(link).toHaveAttribute('title', url);
    await expect(link).toHaveText(url);
    await expect(page.locator('.chat-screen .t-reply').last()).toContainText(`${url}.`);
    await link.click();

    await expect.poll(() => app.evaluate(() => (globalThis as unknown as { links?: string[] }).links)).toEqual([url]);
    // The page is the app's own, still: a link never navigates it.
    expect(page.url()).toBe(before);
  } finally {
    await closeApp(app);
  }
});

test('chat tables: a Markdown table in a reply is a real table with formatted cells, scrolling sideways when docked narrow', async () => {
  const app = await launch();
  try {
    const page = await app.firstWindow();
    await expect(page.locator('article.card')).toHaveCount(11);
    await page.locator('.card', { hasText: 'trying to analyze the progression shown' }).click();
    const table = page.locator('.chat-screen .md .md-table table');
    await expect(table.locator('thead th')).toHaveText(['Offer', 'First appears at', 'Reward', 'Lasts']);
    await expect(table.locator('tbody tr')).toHaveCount(3);
    await expect(table.locator('tbody tr').first().locator('td').first().locator('strong')).toHaveText('×2 Hit Damage');
    await expect(table.locator('tbody td.is-right').first()).toHaveText('×2');
    await expect(page.locator('.chat-screen .t-reply').last()).not.toContainText('|');
    await settled(page);
    await page.locator('.chat-screen').screenshot({ path: 'e2e/shots/chat-table-docked.png', scale: 'css' });
    // A wide table scrolls inside its own frame, never the reply.
    const frame = page.locator('.chat-screen .md-table');
    const fits = await frame.evaluate((el) => el.getBoundingClientRect().right <= el.closest('.t-reply')!.getBoundingClientRect().right + 0.5);
    expect(fits).toBe(true);
  } finally {
    await closeApp(app);
  }
});

test('demo chat: a card opens its chat in the panel; answer its approval, see the turn finish, go full screen and back, return to the same canvas', async () => {
  const app = await launch();
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(e.message));
    await page.reload();
    await expect(page.locator('article.card')).toHaveCount(11);
    const boardBefore = await page.locator('.board').getAttribute('style');

    await page.locator('.card', { hasText: 'Enable account deletion approvals on Hostly' }).click();
    const screen = page.locator('.chat-screen');
    await expect(screen).toBeVisible();
    // The chat opens as a panel docked right; the canvas stays in view and in use to its left.
    await expect(screen).toHaveClass(/\bis-panel\b/);
    await expect(page.locator('[inert]')).toHaveCount(0);
    await expect(page.locator('.card').first()).toBeVisible();
    await expect(page.locator('.card.is-selected')).toContainText('Enable account deletion');
    await expect(screen.locator('.rail')).toHaveCount(0);
    await expect(screen.locator('.cs-preview')).toHaveCount(0);
    await settled(page);
    const workspaceBox = (await page.locator('.workspace').boundingBox())!;
    const panelBox = (await screen.boundingBox())!;
    expect(workspaceBox.x + workspaceBox.width).toBeLessThanOrEqual(panelBox.x);
    expect(panelBox.width).toBe(560); // min(560px, 45vw) at 1440
    expect(panelBox.x + panelBox.width).toBeLessThanOrEqual(1440);
    await expect(screen.getByRole('button', { name: 'Full screen' })).toHaveAttribute('title', 'Full screen');
    await expect(screen.locator('.cs-heading h1')).toHaveText('Enable account deletion approvals on Hostly');
    await expect(screen.locator('.cs-meta')).toContainText('garden-sim');
    await expect(screen.locator('.cs-meta')).toContainText('Fable 5.2');
    await expect(screen.locator('.cs-meta')).toContainText("Desktop-app plugins aren't loaded here");

    const ask = screen.locator('.t-ask');
    await expect(ask).toBeVisible();
    await expect(ask.locator('.t-ask-command')).toContainText('ssh hostly systemctl restart api');
    await expect(ask.getByRole('button', { name: 'Always allow' })).toBeVisible();
    await expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    await expect(screen.getByLabel('Model')).toHaveValue('demo-large');
    await expect(screen.getByLabel('Permissions')).toHaveValue('auto');

    await page.waitForTimeout(400);
    await page.screenshot({ path: 'e2e/shots/chat-1440.png' });
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.setContentSize(1680, 1050); });
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(1680);
    await page.waitForTimeout(300);
    await page.screenshot({ path: 'e2e/shots/chat-1680.png' });

    await ask.getByRole('button', { name: 'Allow', exact: true }).click();
    await expect(screen.locator('.t-asked.is-allowed')).toBeVisible();
    await expect(screen.locator('.t-log .t-tool.is-done', { hasText: 'ssh hostly systemctl restart api' })).toBeVisible({ timeout: 10_000 });
    await expect(screen.locator('.t-reply', { hasText: 'All 42 tests pass' })).toBeVisible({ timeout: 10_000 });
    await expect(screen.getByRole('button', { name: 'Stop' })).toHaveCount(0);
    // The finished turn closes the thread with a Done line.
    await expect(screen.locator('.t-done')).toContainText('Done');
    await page.waitForTimeout(400);
    await page.screenshot({ path: 'e2e/shots/chat-done-1440.png' });

    // A second turn draws every kind of row the mockup shows: thought, reply, read, edit with
    // its diff, and a command waiting on an approval.
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 900); });
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(1440);
    const field = screen.getByLabel('Message Claude');
    await field.fill('Enable deletion approvals on Hostly and restart the API so it takes effect.');
    await expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();
    await field.press('Enter');
    await expect(field).toHaveValue('');
    await expect(screen.locator('.t-thought', { hasText: 'Thought for 6s' })).toBeVisible({ timeout: 10_000 });
    // Live work lists the same calls; these are the thread's rows.
    const thread = screen.locator('.thread');
    const read = thread.getByRole('button', { name: 'Read src/purchases/products.ts' });
    const edit = thread.getByRole('button', { name: 'Edit src/purchases/products.ts +2 −1' });
    const activity = thread.getByRole('button', { name: '1 read, 1 edit' });
    await expect(activity).toHaveAttribute('aria-expanded', 'false');
    await activity.click();
    await expect(read).toBeVisible({ timeout: 10_000 });
    await expect(read).toContainText('5 lines');
    await expect(edit).toBeVisible();
    await expect(screen.locator('.t-ask-command')).toContainText('npm test', { timeout: 10_000 });
    await edit.click();
    await expect(edit).toHaveAttribute('aria-expanded', 'true');
    const diff = screen.locator('.t-log .t-diff');
    await expect(diff.locator('.ln.del')).toHaveCount(1);
    await expect(diff.locator('.ln.del')).toContainText("gems: 'gems_100_sandbox',");
    await expect(diff.locator('.ln.add')).toHaveCount(2);
    await expect(diff.locator('.ln.add').first()).toContainText("isProduction ? 'gems_100'");
    await expect(diff.locator('.ln.del .no')).toHaveText('2');
    // Opening a row while at the bottom keeps the newest item (the waiting approval) in view.
    await expect(screen.locator('.t-ask').getByRole('button', { name: 'Allow', exact: true })).toBeInViewport();
    await page.waitForTimeout(300);
    await page.screenshot({ path: 'e2e/shots/chat-turn-1440.png' });

    // Full screen is today's whole layout: title bar, rail, conversation, and the preview. The
    // chat is the same one (the draft is kept), and the canvas underneath is out of reach.
    await field.fill('A draft kept across layouts');
    await screen.getByRole('button', { name: 'Full screen' }).click();
    await expect(screen).toHaveClass(/\bis-full\b/);
    await expect(screen.locator('.rail-row.is-selected')).toContainText('Enable account deletion');
    await expect(screen.getByRole('tablist', { name: 'Preview' })).toBeHidden();
    await screen.getByRole('button', { name: 'Preview controls' }).click();
    await expect(screen.locator('.cs-preview').getByRole('tab', { name: 'Live work' })).toHaveAttribute('aria-selected', 'true');
    await expect(screen.locator('.cs-preview').getByRole('tab', { name: 'Browser' })).toBeVisible();
    await expect(screen.getByRole('button', { name: 'Back to canvas' })).toBeVisible();
    await expect(page.locator('.app-under')).toHaveAttribute('inert', '');
    await expect(field).toHaveValue('A draft kept across layouts');
    const exit = screen.getByRole('button', { name: 'Exit full screen' });
    await expect(exit).toHaveAttribute('title', 'Exit full screen');
    await page.waitForTimeout(300);
    await page.screenshot({ path: 'e2e/shots/chat-full-1440.png' });
    // Exit full screen returns to the panel; so does Esc.
    await exit.click();
    await expect(screen).toHaveClass(/\bis-panel\b/);
    await expect(screen.locator('.rail')).toHaveCount(0);
    await expect(page.locator('[inert]')).toHaveCount(0);
    await expect(field).toHaveValue('A draft kept across layouts');
    await screen.getByRole('button', { name: 'Full screen' }).click();
    await expect(screen).toHaveClass(/\bis-full\b/);
    await page.keyboard.press('Escape');
    await expect(screen).toHaveClass(/\bis-panel\b/);
    await field.fill('');

    // Esc in the panel (focus is on no field) closes the chat: the canvas is panned and zoomed as it was.
    await page.locator('.thread').click({ position: { x: 4, y: 4 } });
    await page.keyboard.press('Escape');
    await expect(screen).toHaveCount(0);
    await expect(page.locator('.card').first()).toBeVisible();
    expect(await page.locator('.board').getAttribute('style')).toBe(boardBefore);
    expect(errors).toEqual([]);

    // Quitting with that approval pending: no dialog and nothing stopped. ⌘Q, the menu and the
    // Dock all ask app.quit(); the window goes away and the app keeps running so the session can
    // finish. Opening the app again brings the canvas back as it was.
    await app.evaluate(({ app: a }) => { a.quit(); a.quit(); a.quit(); });
    await page.waitForTimeout(800);
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.isVisible()))).toEqual([false]);
    expect(app.process().exitCode).toBeNull();
    await app.evaluate(({ app: a }) => { a.emit('activate'); });
    await expect(page.locator('.card').first()).toBeVisible(); // still running, the session too
    // Closing the window only hides it; the app and the session keep going.
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.close(); });
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.isVisible()))).toEqual([false]);
  } finally {
    await closeApp(app);
  }
});

/** The Browser tab's native view (the window's only child view), as main sees it. */
const previewView = (app: ElectronApplication) => app.evaluate(({ BrowserWindow }) => {
  const view = BrowserWindow.getAllWindows()[0]?.contentView.children[0];
  return view ? { visible: view.getVisible(), bounds: view.getBounds() } : null;
});
/** The title and bridge of the page loaded at `url` in the preview. */
const previewPage = (app: ElectronApplication, url: string) => app.evaluate(async ({ webContents }, u) => {
  const wc = webContents.getAllWebContents().find((w) => !w.isDestroyed() && w.getURL() === u);
  if (!wc || wc.isLoading()) return null;
  return { title: wc.getTitle(), reach: await wc.executeJavaScript('typeof window.canvas + " " + typeof window.require') as string };
}, url);

test('running sessions open from the canvas, and a local video plays in the docked conversation', async () => {
  const app = await launch();
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1100, 700));
    await page.evaluate(() => localStorage.setItem('agent-canvas:panel-width', '380'));
    await page.reload();
    const running = page.getByRole('button', { name: /Show .* running sessions/ });
    await running.press('Enter');
    const list = page.getByLabel('Running sessions', { exact: true });
    await expect(list.getByRole('button')).toHaveCount(3);
    await list.getByRole('button', { name: /Reconnection dialog/ }).click();
    const screen = page.locator('.chat-screen');
    await screen.getByRole('button', { name: 'Preview', exact: true }).click();
    await expect(page.locator('.preview-window').getByRole('heading', { name: 'Running tasks' })).toBeVisible();
    await expect(page.locator('.preview-window .pv-call.is-running')).toBeVisible();
    await screen.getByRole('button', { name: 'Close chat' }).click();

    await page.locator('[data-card-id="demo-purchases"]').click();
    await screen.locator('input[type=file]').setInputFiles(path.resolve('fixtures/media/preview.webm'));
    await screen.getByLabel('Message Claude').fill('Review this recording');
    await screen.getByRole('button', { name: 'Send', exact: true }).click();
    const video = screen.getByLabel('preview.webm', { exact: true });
    await expect(video).toBeVisible();
    await expect.poll(() => video.evaluate(el => (el as HTMLVideoElement).videoWidth)).toBe(128);
    await video.evaluate(async el => {
      const player = el as HTMLVideoElement;
      player.muted = true;
      await player.play();
    });
    await expect.poll(() => video.evaluate(el => (el as HTMLVideoElement).currentTime)).toBeGreaterThan(0);
    await video.scrollIntoViewIfNeeded();
    await screen.screenshot({ path: 'e2e/shots/chat-video-380.png', scale: 'css' });
  } finally { await closeApp(app); }
});

test('a long command run stays compact and opens to the failed command output', async () => {
  const app = await launch();
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1100, 700));
    await page.evaluate(() => localStorage.setItem('agent-canvas:panel-width', '380'));
    await page.reload();
    await page.locator('[data-card-id="demo-codex"]').click();
    const thread = page.locator('.thread');
    await expect(thread).toBeVisible();
    await app.evaluate(({ BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows()[0]!.webContents;
      const at = Date.now();
      contents.send('canvas:chat:demo-codex', { op: 'upsert', item: {
        kind: 'user', id: 'demo-codex-u0', at: at - 64_000, text: 'Check how we count Codex usage credits.', images: [],
      } });
      contents.send('canvas:chat:demo-codex', { op: 'upsert', item: {
        kind: 'assistant', id: 'demo-codex-a0', at: at - 60_000, text: 'I’ll check the usage records and run the accounting tests.', streaming: false,
      } });
      for (let index = 0; index < 18; index++) {
        const failed = index === 2;
        contents.send('canvas:chat:demo-codex', { op: 'upsert', item: {
          kind: 'tool', id: `cmd-${index}`, at, tool: 'command', name: 'shell', target: `npm run check-${index}`,
          status: failed ? 'failed' : 'done', output: failed ? 'Check timed out' : 'Passed', exitCode: failed ? 1 : 0, diffs: [],
        } });
      }
      contents.send('canvas:chat:demo-codex', { op: 'upsert', item: {
        kind: 'assistant', id: 'result', at, text: 'The retry passed.', streaming: false,
      } });
    });
    const summary = thread.getByRole('button', { name: '18 commands · 1 failed' });
    await expect(summary).toHaveAttribute('aria-expanded', 'false');
    await expect(thread.locator('.t-tool')).toHaveCount(0);
    await expect(thread.getByText('The retry passed.')).toBeInViewport();
    await page.locator('.chat-screen').screenshot({ path: 'e2e/shots/command-run-380.png', scale: 'css' });
    await summary.press('Enter');
    await expect(summary).toBeInViewport();
    await expect(thread.locator('.t-tool')).toHaveCount(18);
    await thread.getByRole('button', { name: 'Bash npm run check-2', exact: true }).click();
    await expect(thread.locator('.t-output')).toHaveText('Check timed out');
    await summary.click();
    await expect(thread.locator('.t-tool')).toHaveCount(0);
    await expect(thread.getByText('The retry passed.')).toBeInViewport();
  } finally {
    await closeApp(app);
  }
});

test('preview: Live work shows the picked edit in full; the Browser tab opens the address the turn printed', async () => {
  // A dev server stand-in: loopback only, a port of its own, closed by the test.
  const pages: Record<string, string> = {
    '/': '<!doctype html><title>Demo preview</title><h1>Demo preview</h1>',
    '/typed.html': '<!doctype html><title>Typed page</title><p>Typed</p>',
  };
  const server = createServer((req, res) => {
    const body = pages[req.url ?? ''];
    if (body === undefined) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  const app = await launch({ AGENT_CANVAS_DEMO_URL: url });
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(e.message));
    // Stand-ins for macOS: VS Code is registered, and links handed out are recorded, not opened.
    await app.evaluate(({ app: electronApp, shell }) => {
      electronApp.getApplicationNameForProtocol = () => 'Visual Studio Code';
      const opened: string[] = [];
      (globalThis as { opened?: string[] }).opened = opened;
      shell.openExternal = async (link: string) => { opened.push(link); };
    });
    await page.reload();
    await page.locator('.card', { hasText: 'Enable account deletion approvals on Hostly' }).click();
    const screen = page.locator('.chat-screen');
    // The preview is full screen's: the panel has none.
    await expect(screen.locator('.thread')).toBeVisible();
    await expect(screen.locator('.cs-preview')).toHaveCount(0);
    await screen.getByRole('button', { name: 'Full screen' }).click();
    const thread = screen.locator('.thread');
    const pane = page.locator('.cs-preview');
    await pane.getByRole('button', { name: 'Preview controls' }).click();
    const follow = pane.getByRole('button', { name: 'Follow newest' });
    const selected = pane.locator('.pv-call.is-selected');

    // Live work is the first tab, and follows the newest call: the command waiting for approval.
    await expect(pane.getByRole('tab', { name: 'Live work' })).toHaveAttribute('aria-selected', 'true');
    await expect(follow).toHaveAttribute('aria-pressed', 'true');
    await expect(pane.locator('.pv-head')).toContainText('1 call');
    await expect(selected).toContainText('ssh hostly systemctl restart api');
    await expect(selected).toContainText('waiting for you');

    await screen.locator('.t-ask').getByRole('button', { name: 'Allow', exact: true }).click();
    await expect(thread.locator('.t-reply', { hasText: 'All 42 tests pass' })).toBeVisible({ timeout: 10_000 });
    // The command's output, with the terminal's colour codes gone.
    await expect(pane.locator('.pv-output')).toContainText('✓ 42 tests passed');
    expect(await pane.locator('.pv-output').textContent()).not.toContain('\u001b');

    // The next turn: read, edit, and a command waiting again.
    const field = screen.getByLabel('Message Claude');
    await field.fill('Enable deletion approvals on Hostly and restart the API so it takes effect.');
    await field.press('Enter');
    await expect(screen.locator('.t-ask-command')).toContainText('npm test', { timeout: 10_000 });
    await expect(pane.locator('.pv-head')).toContainText('3 calls');
    await expect(pane.locator('.pv-call')).toHaveText([/Read\s*src\/purchases\/products.ts\s*5 lines/, /Edit/, /Bash\s*npm test/]);
    await expect(selected).toContainText('npm test');

    // Picking the edit stops following and shows its whole diff; the thread marks the same row.
    await pane.getByRole('button', { name: 'Edit src/purchases/products.ts +2 −1' }).click();
    await expect(follow).toHaveAttribute('aria-pressed', 'false');
    await expect(selected).toContainText('Edit');
    const diff = pane.locator('.pv-detail .t-diff.is-full');
    await expect(diff.locator('.hunk')).toHaveText('@@ -1,4 +1,6 @@');
    await expect(diff.locator('.ln.del')).toHaveCount(1);
    await expect(diff.locator('.ln.add')).toHaveCount(2);
    await expect(diff.locator('.ln.del .no').first()).toHaveText('2');
    await expect(diff.locator('.ln.add').first()).toContainText("isProduction ? 'gems_100'");
    await expect(pane.locator('.pv-d-foot')).toContainText('applied');
    await expect(pane.getByRole('button', { name: 'Open in editor' })).toBeVisible();
    await expect(thread.locator('.t-tool.is-selected')).toHaveAttribute('aria-label', 'Edit src/purchases/products.ts +2 −1');
    await page.waitForTimeout(300);
    await page.screenshot({ path: 'e2e/shots/preview-1440.png' });

    await pane.getByRole('button', { name: 'Open in editor' }).click();
    await expect.poll(() => app.evaluate(() => (globalThis as { opened?: string[] }).opened))
      .toEqual(['vscode://file/Users/demo/Documents/garden-sim/src/purchases/products.ts']);

    // Following again shows the newest call; picking a row in the thread also stops following.
    await follow.click();
    await expect(follow).toHaveAttribute('aria-pressed', 'true');
    await expect(selected).toContainText('npm test');
    await thread.getByRole('button', { name: 'Read src/purchases/products.ts' }).click();
    await expect(follow).toHaveAttribute('aria-pressed', 'false');
    await expect(pane.locator('.pv-output')).toContainText("export const PRODUCT_IDS");
    await follow.click();

    // The test run prints the local address; the Browser tab opens it once shown, and never
    // switches tabs by itself.
    await screen.locator('.t-ask').getByRole('button', { name: 'Allow', exact: true }).click();
    await expect(pane.locator('.pv-output')).toContainText(`Preview: ${url}`, { timeout: 10_000 });
    await expect(pane.getByRole('tab', { name: 'Live work' })).toHaveAttribute('aria-selected', 'true');
    expect(await previewView(app)).toBeNull();
    await pane.getByRole('tab', { name: 'Browser' }).click();
    await expect(pane.getByLabel('Address')).toHaveValue(url);
    await expect.poll(() => previewPage(app, url), { timeout: 10_000 }).toEqual({ title: 'Demo preview', reach: 'undefined undefined' });
    // Demo mode writes nothing: the preview's session is in memory.
    expect(await app.evaluate(({ webContents }, u) => webContents.getAllWebContents().find((w) => !w.isDestroyed() && w.getURL() === u)?.session.isPersistent(), url)).toBe(false);

    // The persistent toolbar has its own row above the guest viewport.
    const frame = await pane.locator('.pv-frame').evaluate(el => {
      const r = el.getBoundingClientRect();
      const top = r.top;
      return { x: Math.round(r.left), y: Math.round(top), width: el.clientWidth, height: Math.round(r.bottom - top) };
    });
    await expect.poll(() => previewView(app)).toEqual({ visible: true, bounds: frame });

    // A typed address opens; a file: one is refused by the main process.
    const address = pane.getByLabel('Address');
    await address.fill(`127.0.0.1:${new URL(url).port}/typed.html`);
    await address.press('Enter');
    await expect.poll(() => previewPage(app, `${url}typed.html`), { timeout: 10_000 }).toMatchObject({ title: 'Typed page' });
    await expect(pane.getByRole('button', { name: 'Back' })).toBeEnabled();
    await address.fill('file:///etc/passwd');
    await address.press('Enter');
    await expect(pane.locator('.pv-refusal')).toHaveText('file: addresses are not opened here');

    // Another session's chat never shows this page: the view is emptied for a session with none,
    // and this session's page comes back with it (as typed, with a history of its own).
    await screen.locator('.rail-row', { hasText: 'Purchases unavailable' }).click();
    await expect(screen.locator('.cs-heading h1')).toHaveText('Purchases unavailable in production');
    // Each session keeps its own preview state: this one starts with its controls folded and
    // no tab picked, so it opens on Live work.
    await expect(pane.getByRole('tabpanel', { name: 'Live work' })).toBeVisible();
    await pane.getByRole('button', { name: 'Preview controls' }).click();
    await pane.getByRole('tab', { name: 'Browser' }).click();
    await expect(address).toHaveValue('');
    await expect(pane.locator('.pv-refusal')).toHaveCount(0);
    // The view is gone (cleared), and no web contents still holds a page from the test server.
    await expect.poll(() => previewView(app)).toBeNull();
    await expect.poll(() => app.evaluate(({ webContents }, u) =>
      webContents.getAllWebContents().some((w) => !w.isDestroyed() && w.getURL().startsWith(u)), url)).toBe(false);
    // That session gets a page of its own; moving between two sessions with pages carries no
    // history across: Back stays off in each.
    await address.fill(`127.0.0.1:${new URL(url).port}/`);
    await address.press('Enter');
    await expect.poll(() => previewPage(app, url), { timeout: 10_000 }).toMatchObject({ title: 'Demo preview' });
    for (const [row, page, title] of [
      ['Enable account deletion', `${url}typed.html`, 'Typed page'], ['Purchases unavailable', url, 'Demo preview'],
      ['Enable account deletion', `${url}typed.html`, 'Typed page'],
    ] as const) {
      await screen.locator('.rail-row', { hasText: row }).click();
      await expect(address).toHaveValue(page);
      await expect.poll(() => previewPage(app, page), { timeout: 10_000 }).toMatchObject({ title });
      await expect.poll(async () => (await previewView(app))?.visible).toBe(true);
      // A switch replaces the view: one in the window, and one live web contents for the test server.
      expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.contentView.children.length)).toBe(1);
      await expect.poll(() => app.evaluate(({ webContents }, u) =>
        webContents.getAllWebContents().filter((w) => !w.isDestroyed() && w.getURL().startsWith(u)).length, url)).toBe(1);
      // Each session's preview starts with its controls (Back among them) folded.
      const controls = pane.getByRole('button', { name: 'Preview controls' });
      if (await controls.getAttribute('aria-expanded') !== 'true') await controls.click();
      await expect(pane.getByRole('button', { name: 'Back' })).toBeDisabled();
      expect(await app.evaluate(({ webContents }, u) => webContents.getAllWebContents().find((w) => !w.isDestroyed() && w.getURL() === u)?.navigationHistory.canGoBack(), page)).toBe(false);
    }

    // The profile page and the New session dialog cover the pane: the view hides under each.
    await screen.getByRole('button', { name: 'Profile and usage' }).click();
    await expect(page.getByRole('dialog', { name: 'Profile' })).toBeVisible();
    await expect.poll(async () => (await previewView(app))?.visible).toBe(false);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Profile' })).toHaveCount(0);
    await expect(screen).toBeVisible();
    await expect.poll(async () => (await previewView(app))?.visible).toBe(true);
    await page.keyboard.press('Meta+N');
    await expect(page.getByRole('dialog', { name: 'New session' })).toBeVisible();
    await expect.poll(async () => (await previewView(app))?.visible).toBe(false);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'New session' })).toHaveCount(0);
    await expect.poll(async () => (await previewView(app))?.visible).toBe(true);

    // Leaving the tab, full screen, or the chat, hides the view.
    await pane.getByRole('tab', { name: 'Live work' }).click();
    await expect.poll(async () => (await previewView(app))?.visible).toBe(false);
    await pane.getByRole('tab', { name: 'Browser' }).click();
    await expect.poll(async () => (await previewView(app))?.visible).toBe(true);
    await screen.getByRole('button', { name: 'Exit full screen' }).click();
    // The panel starts with its preview collapsed; the header's toggle docks the running app beside it.
    await expect(pane).toHaveCount(0);
    await expect.poll(async () => (await previewView(app))?.visible).toBe(false);
    await screen.getByRole('button', { name: 'Preview', exact: true }).click();
    await expect(pane).toBeVisible();
    if (await pane.getByRole('button', { name: 'Preview controls' }).getAttribute('aria-expanded') !== 'true') await pane.getByRole('button', { name: 'Preview controls' }).click();
    await pane.getByRole('tab', { name: 'Browser' }).click();
    await expect.poll(async () => (await previewView(app))?.visible).toBe(true);
    await settled(page);
    await page.screenshot({ path: 'e2e/shots/docked-app-preview.png', scale: 'css' });
    await page.getByRole('button', { name: 'Hide preview' }).click();
    await expect(pane).toHaveCount(0);
    await expect.poll(async () => (await previewView(app))?.visible).toBe(false);
    await page.waitForTimeout(500);
    expect((await previewView(app))?.visible).toBe(false);
    await screen.getByRole('button', { name: 'Full screen' }).click();
    if (await pane.getByRole('button', { name: 'Preview controls' }).getAttribute('aria-expanded') !== 'true') await pane.getByRole('button', { name: 'Preview controls' }).click();
    await pane.getByRole('tab', { name: 'Browser' }).click();
    await expect.poll(async () => (await previewView(app))?.visible).toBe(true);
    await screen.getByRole('button', { name: 'Back to canvas' }).click();
    await expect(screen).toHaveCount(0);
    await expect.poll(async () => (await previewView(app))?.visible).toBe(false);
    expect(errors).toEqual([]);
  } finally {
    await closeApp(app);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('new session: folders most recent first, provider defaults, Start once there is a message; the card lands in its zone', async () => {
  const app = await launch();
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(e.message));
    // The system folder picker, stood in for: it answers with a folder no zone has yet.
    await app.evaluate(({ dialog }) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: ['/Users/demo/Documents/lumen-notes'] })) as typeof dialog.showOpenDialog;
    });
    await page.reload();
    await expect(page.locator('article.card')).toHaveCount(11);

    await page.locator('.topbar').getByRole('button', { name: /New session/ }).click();
    const dialog = page.getByRole('dialog', { name: 'New session' });
    await expect(dialog).toBeVisible();
    const folder = dialog.getByLabel('Folder');
    // The zones' folders, most recently used first (No folder offers none), then the picker.
    await expect(folder.locator('option')).toHaveText([
      'garden-sim — /Users/demo/Documents/garden-sim', 'garden-dashboard — /Users/demo/Documents/garden-dashboard',
      'sailcloth-io — /Users/demo/Documents/sailcloth-io', 'Choose folder…',
    ]);
    await expect(folder).toHaveValue('/Users/demo/Documents/garden-sim');
    await expect(dialog.getByRole('radio', { name: 'Claude' })).toHaveAttribute('aria-checked', 'true');
    await expect(dialog.getByLabel('Model')).toHaveValue('demo-large');
    await expect(dialog.getByLabel('Permissions')).toHaveValue('auto');
    const start = dialog.getByRole('button', { name: 'Start' });
    await expect(start).toBeDisabled();

    // Another provider: its own defaults.
    await dialog.getByLabel('Permissions').selectOption('plan');
    await dialog.getByLabel('Model').selectOption('demo-small');
    await dialog.getByRole('radio', { name: 'Codex' }).click();
    await expect(dialog.getByLabel('Model')).toHaveValue('demo-large');
    await expect(dialog.getByLabel('Permissions')).toHaveValue('auto');
    await expect(dialog.getByLabel('Permissions').locator('option')).toHaveText(['Read only', 'Auto', 'Full access']);
    await dialog.getByRole('radio', { name: 'Claude' }).click();
    await expect(dialog.getByLabel('Permissions')).toHaveValue('auto');

    // "Choose folder…" asks the system picker; the folder chosen is offered first.
    await folder.selectOption('Choose folder…');
    await expect(folder).toHaveValue('/Users/demo/Documents/lumen-notes');
    await expect(folder.locator('option').first()).toHaveText('lumen-notes — /Users/demo/Documents/lumen-notes');
    await dialog.getByLabel('First message').fill('Sketch the note sync design');
    await expect(start).toBeEnabled();
    await page.waitForTimeout(200);
    await page.screenshot({ path: 'e2e/shots/new-session-1440.png' });

    // Start: the chat opens with the first message sent and the scripted turn running.
    await start.click();
    await expect(dialog).toHaveCount(0);
    const screen = page.locator('.chat-screen');
    await expect(screen).toBeVisible();
    await expect(screen.locator('.cs-heading h1')).toHaveText('Sketch the note sync design');
    await expect(screen.locator('.cs-meta')).toContainText('lumen-notes');
    await expect(screen.locator('.t-you', { hasText: 'Sketch the note sync design' })).toBeVisible();
    await expect(screen.locator('.t-thought', { hasText: 'Thought for 6s' })).toBeVisible({ timeout: 10_000 });
    // It opens in the panel, like a card; the rail is full screen's.
    await expect(screen).toHaveClass(/\bis-panel\b/);
    await screen.getByRole('button', { name: 'Full screen' }).click();
    await expect(screen.locator('.rail-row.is-selected')).toContainText('Sketch the note sync design');

    // The rail's "+ New session" opens the dialog too; ⌘N as well. Esc closes it and leaves the chat.
    await screen.getByRole('button', { name: /New session/ }).click();
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(screen).toBeVisible();

    // Back on the canvas the card is in a new zone for its folder.
    await screen.getByRole('button', { name: 'Back to canvas' }).click();
    // (Its zone's Project orchestrator card is a .card too, so the session cards are counted.)
    await expect(page.locator('.zone', { has: page.locator('.zone-label', { hasText: 'lumen-notes' }) }).locator('article.card')).toHaveCount(1);

    // A zone's "+" starts in that zone's folder.
    const sailcloth = page.locator('.zone', { has: page.locator('.zone-label', { hasText: 'sailcloth-io' }) });
    await sailcloth.locator('.zone-label').hover();
    await sailcloth.getByRole('button', { name: 'New session in sailcloth-io' }).click();
    await expect(folder).toHaveValue('/Users/demo/Documents/sailcloth-io');
    await dialog.getByRole('radio', { name: 'Codex' }).click();
    await dialog.getByLabel('First message').fill('Tidy the deploy script');
    await dialog.getByLabel('First message').press('Enter');
    await expect(screen.locator('.cs-heading h1')).toHaveText('Tidy the deploy script');
    await expect(screen.locator('.cs-meta')).toContainText('Codex');
    await expect(screen).toHaveClass(/\bis-panel\b/);
    await page.keyboard.press('Meta+N');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await screen.getByRole('button', { name: 'Close chat' }).click();
    await expect(screen).toHaveCount(0);
    await expect(sailcloth.locator('.card', { hasText: 'Tidy the deploy script' })).toHaveCount(1);
    expect(errors).toEqual([]);
  } finally {
    await closeApp(app);
  }
});

test('new session: a refused start shows its reason and keeps the dialog; Cancel closes during a slow start, which still lands', async () => {
  const app = await launch();
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(e.message));
    // The folder picker, stood in for: it answers with whatever the test sets next.
    await app.evaluate(({ dialog }) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [(globalThis as { nextFolder?: string }).nextFolder ?? ''] })) as typeof dialog.showOpenDialog;
    });
    const pickNext = (folder: string) => app.evaluate((_e, f) => { (globalThis as { nextFolder?: string }).nextFolder = f; }, folder);
    await page.reload();
    await expect(page.locator('article.card')).toHaveCount(11);
    const dialog = page.getByRole('dialog', { name: 'New session' });
    const folder = dialog.getByLabel('Folder');
    const start = dialog.getByRole('button', { name: /^(Start|Starting…)$/ });

    // A folder that is gone (the demo's stand-in): main refuses, the reason shows, the dialog stays.
    await page.keyboard.press('Meta+N');
    await pickNext('/Users/demo/Documents/missing-folder');
    await folder.selectOption('Choose folder…');
    await expect(folder).toHaveValue('/Users/demo/Documents/missing-folder');
    await dialog.getByLabel('First message').fill('Look around');
    await start.click();
    await expect(dialog.getByRole('alert')).toHaveText('The folder /Users/demo/Documents/missing-folder no longer exists');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('First message')).toHaveValue('Look around');
    await expect(start).toBeEnabled();
    await expect(page.locator('.chat-screen')).toHaveCount(0);

    // A slow start: Start stays off while it runs, and Cancel still closes the dialog.
    await pickNext('/Users/demo/Documents/slow-start');
    await folder.selectOption('Choose folder…');
    await expect(folder).toHaveValue('/Users/demo/Documents/slow-start');
    await start.click();
    await expect(start).toHaveText('Starting…');
    await expect(start).toBeDisabled();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);
    // The start carries on: its card lands in its folder's zone, and no chat opens over the canvas.
    const zone = page.locator('.zone', { has: page.locator('.zone-label', { hasText: 'slow-start' }) });
    await expect(zone.locator('.card', { hasText: 'Look around' })).toHaveCount(1, { timeout: 10_000 });
    await page.waitForTimeout(300);
    await expect(page.locator('.chat-screen')).toHaveCount(0);

    // Esc closes during a start too.
    await page.keyboard.press('Meta+N');
    await folder.selectOption('Choose folder…');
    await dialog.getByLabel('First message').fill('Again');
    await start.click();
    await expect(start).toHaveText('Starting…');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(zone.locator('.card', { hasText: 'Again' })).toHaveCount(1, { timeout: 10_000 });
    expect(errors).toEqual([]);
  } finally {
    await closeApp(app);
  }
});

test('profile: both demo accounts with plans and usage bars, Refresh, and Open at login kept in memory', async () => {
  const app = await launch();
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(e.message));
    const loginBefore = await app.evaluate(({ app: a }) => a.getLoginItemSettings().openAtLogin);
    await page.reload();
    await expect(page.locator('article.card')).toHaveCount(11);

    const avatar = page.locator('.topbar').getByRole('button', { name: 'Profile and usage' });
    await expect(avatar).toHaveText('D');
    await avatar.click();
    const profile = page.getByRole('dialog', { name: 'Profile' });
    await expect(profile).toBeVisible();
    const claude = profile.getByRole('region', { name: 'Claude', exact: true });
    const codex = profile.getByRole('region', { name: 'Codex', exact: true });
    await expect(claude.locator('.pf-plan')).toHaveText('Max');
    await expect(codex.locator('.pf-plan')).toHaveText('Pro');
    await expect(codex.locator('.pf-window-row').filter({ hasText: 'Available resets' })).toHaveText('Available resets2');
    await expect(claude.locator('.pf-email')).toHaveText('demo@example.com');
    await expect(claude.locator('.pf-window-label')).toHaveText(['5 h', 'Weekly']);
    await expect(claude.locator('.pf-window-text').first()).toHaveText(/^12% used · resets \w{3} \d{2}:\d{2}$/);
    await expect(codex.locator('.pf-window-text').nth(1)).toHaveText('Not reported');
    await expect(claude.getByRole('meter', { name: 'Weekly used' })).toHaveAttribute('aria-valuenow', '40');

    await profile.getByRole('button', { name: 'Refresh' }).click();
    await expect(profile.getByRole('button', { name: 'Refresh' })).toBeEnabled();
    const toggle = profile.getByRole('switch', { name: 'Open at login' });
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await page.waitForTimeout(300);
    await page.screenshot({ path: 'e2e/shots/profile-1440.png' });

    // Demo mode keeps the switch in memory: the real login item is never touched.
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    expect(await page.evaluate(() => window.canvas!.getSettings())).toMatchObject({ openAtLogin: true });
    expect(await app.evaluate(({ app: a }) => a.getLoginItemSettings().openAtLogin)).toBe(loginBefore);
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');

    await profile.getByRole('button', { name: 'Close' }).click();
    await expect(profile).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await closeApp(app);
  }
});

test('settings: switch canvas agent API connections and start conversations with each', async () => {
  const app = await launch();
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1100, 700));
    for (const provider of ['codex', 'claude'] as const) {
      await page.getByRole('button', { name: 'Profile and usage' }).click();
      const profile = page.getByRole('dialog', { name: 'Profile' });
      await profile.getByLabel('Canvas agent connection').selectOption(`${provider}-api`);
      const save = profile.getByRole('button', { name: 'Save connection' });
      await expect(save).toBeDisabled();
      const key = profile.locator('input[type=password]');
      await key.fill('demo-key');
      await key.press('Enter');
      await expect(key).toHaveValue('');
      await expect(key).toHaveAttribute('placeholder', /Key saved/);
      if (provider === 'codex') {
        await settled(page);
        await profile.locator('.agent-settings').screenshot({ path: 'e2e/shots/agent-settings.png' });
      }
      await profile.getByRole('button', { name: 'Close' }).click();
      await page.getByTestId('agent-orb').click();
      if (provider === 'claude') {
        await expect(page.locator('.cs-meta')).toContainText('Codex API'); // the existing conversation
        await page.getByTestId('agent-new').click();
      }
      await expect(page.locator('.cs-meta')).toContainText(provider === 'codex' ? 'Codex API' : 'Claude API');
      const field = page.locator('.cp-field');
      await field.fill('Report on my canvas');
      await field.press('Enter');
      await expect(page.getByTestId('agent-new')).toBeVisible();
      await expect(page.locator('.chat-screen')).toContainText('canvas_overview');
      await expect.poll(() => page.evaluate(async () => {
        const state = await new Promise<import('../shared/types.ts').Snapshot>(resolve => {
          const off = window.canvas!.onSnapshot(snapshot => { off(); resolve(snapshot); });
        });
        return state.agent?.provider;
      })).toBe(provider);
      await expect(page.locator('article.card')).toHaveCount(11);
      await page.keyboard.press('Meta+j');
    }
  } finally { await closeApp(app); }
});

test('settings: Claude and Codex ACP adapters appear in New session only when enabled for testing', async () => {
  const app = await launch();
  try {
    const page = await app.firstWindow();
    const bar = page.locator('.topbar');
    const profile = page.getByRole('dialog', { name: 'Profile' });
    const dialog = page.getByRole('dialog', { name: 'New session' });
    const openSettings = () => bar.getByRole('button', { name: 'Profile and usage' }).click();
    const openSession = () => bar.getByRole('button', { name: /New session/ }).click();
    await openSettings();
    const agents = profile.getByRole('region', { name: 'ACP agents' });
    for (const name of ['Gemini CLI', 'Claude Code (ACP)', 'Codex (ACP)']) {
      await agents.getByRole('button', { name: `Add ${name}` }).click();
      await expect(agents.getByRole('button', { name: `Remove ${name}` })).toBeEnabled();
    }
    const showCodex = agents.getByRole('checkbox', { name: 'Show Codex (ACP) in New session' });
    await expect(showCodex).not.toBeChecked();
    await expect(agents.getByRole('checkbox', { name: 'Show Claude Code (ACP) in New session' })).not.toBeChecked();
    await expect(agents.getByRole('checkbox', { name: 'Show Gemini CLI in New session' })).toBeChecked();
    await profile.getByRole('button', { name: 'Close' }).click();
    await openSession();
    await expect(dialog.getByRole('radio', { name: 'Claude', exact: true })).toBeVisible();
    await expect(dialog.getByRole('radio', { name: 'Codex', exact: true })).toBeVisible();
    await expect(dialog.getByRole('radio', { name: /Gemini CLI/ })).toBeVisible();
    await expect(dialog.getByRole('radio', { name: /\(ACP\)/ })).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Cancel' }).click();

    await openSettings();
    await showCodex.click();
    await expect(showCodex).toBeChecked();
    await profile.getByRole('button', { name: 'Close' }).click();
    await page.reload();
    await openSession();
    await expect(dialog.getByRole('radio', { name: /Codex \(ACP\)/ })).toBeVisible();
    await expect(dialog.getByRole('radio', { name: /Claude Code \(ACP\)/ })).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await openSettings();
    await showCodex.click();
    await expect(showCodex).not.toBeChecked();
    await profile.getByRole('button', { name: 'Close' }).click();
    await openSession();
    await expect(dialog.getByRole('radio', { name: /Gemini CLI/ })).toBeVisible();
    await expect(dialog.getByRole('radio', { name: /\(ACP\)/ })).toHaveCount(0);
  } finally {
    await closeApp(app);
  }
});

test('settings: a default model and thinking level open New session with them, and unticked models leave the menus', async () => {
  const app = await launch();
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(e.message));
    await page.reload();
    await expect(page.locator('article.card')).toHaveCount(11);

    await page.locator('.topbar').getByRole('button', { name: 'Profile and usage' }).click();
    const profile = page.getByRole('dialog', { name: 'Profile' });
    const claude = profile.getByRole('region', { name: 'Claude new sessions' });
    await claude.getByLabel('Claude default model').selectOption('demo-small');
    await claude.getByLabel('Claude default thinking').selectOption('high');
    await expect(claude.getByLabel('Claude default thinking')).toHaveValue('high');
    // Fable 5.2 leaves Codex's menu; the last one left cannot be unticked.
    const codex = profile.getByRole('region', { name: 'Codex new sessions' });
    const large = codex.getByRole('checkbox', { name: 'Fable 5.2', exact: true });
    await expect(large).toBeChecked();
    await large.click();
    await expect(large).not.toBeChecked();
    await expect(codex.getByRole('checkbox', { name: 'Fable 5.2 Mini' })).toBeDisabled();
    await codex.getByLabel('Codex default model').selectOption('demo-small');
    await profile.locator('.ms').scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    await page.screenshot({ path: 'e2e/shots/settings-models-1440.png' });
    expect(await page.evaluate(() => window.canvas!.getSettings())).toMatchObject({
      defaults: { claude: { model: 'demo-small', effort: 'high' }, codex: { model: 'demo-small', effort: 'low' } },
      shownModels: { claude: null, codex: ['demo-small'] },
    });
    await profile.getByRole('button', { name: 'Close' }).click();
    await expect(profile).toHaveCount(0);

    await page.locator('.topbar').getByRole('button', { name: /New session/ }).click();
    const dialog = page.getByRole('dialog', { name: 'New session' });
    await expect(dialog.getByLabel('Model')).toHaveValue('demo-small');
    await expect(dialog.getByLabel('Thinking')).toHaveValue('high');
    await expect(dialog.getByLabel('Thinking').locator('option')).toHaveText(['Low', 'Medium', 'High']);
    await dialog.getByLabel('Model').selectOption('demo-large');
    await expect(dialog.getByLabel('Thinking')).toHaveValue('high');
    await dialog.getByLabel('First message').fill('Tidy the tests');
    await page.waitForTimeout(300);
    await page.screenshot({ path: 'e2e/shots/new-session-thinking-1440.png' });
    await dialog.getByRole('radio', { name: 'Codex' }).click();
    await expect(dialog.getByLabel('Model').locator('option')).toHaveText(['Fable 5.2 Mini']);
    await expect(dialog.getByLabel('Thinking')).toHaveValue('low');
    expect(errors).toEqual([]);
  } finally {
    await closeApp(app);
  }
});

test('profile: Snap to grid makes a dragged zone land with its corner between four dots', async () => {
  const app = await launch();
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(e.message));
    await page.reload();
    await expect(page.locator('article.card')).toHaveCount(11);

    await page.locator('.topbar').getByRole('button', { name: 'Profile and usage' }).click();
    const profile = page.getByRole('dialog', { name: 'Profile' });
    const snap = profile.getByRole('switch', { name: 'Snap to grid' });
    if (await snap.getAttribute('aria-checked') === 'true') await snap.click();
    await expect(snap).toHaveAttribute('aria-checked', 'false');
    await snap.click();
    await expect(snap).toHaveAttribute('aria-checked', 'true');
    await profile.getByRole('button', { name: 'Close' }).click();
    await expect(page.locator('.board')).toHaveClass(/is-snapping/);

    const zone = page.locator('.zone').first();
    // A zone's place is its translate property; a zero y may be left out of what the browser reports.
    const at = async () => {
      const n = ((await zone.evaluate((el) => (el as HTMLElement).style.translate)).match(/-?[\d.]+/g) ?? []).map(Number);
      return [n[0] ?? 0, n[1] ?? 0];
    };
    const label = zone.locator('.zone-label');
    const box = (await label.boundingBox())!;
    await page.mouse.move(box.x + 40, box.y + 8);
    await page.mouse.down();
    // Odd, uneven steps: without snapping the zone would land off the grid.
    for (const [dx, dy] of [[7, 3], [23, 11], [61, 37], [97, 53]]) {
      await page.mouse.move(box.x + 40 + dx!, box.y + 8 + dy!);
      const [x, y] = await at();
      expect([x! % 20, y! % 20].map(Math.abs)).toEqual([0, 0]);
    }
    await page.mouse.up();
    await expect.poll(async () => (await at()).map((v) => Math.abs(v % 20))).toEqual([0, 0]);
    await page.waitForTimeout(300);
    await page.screenshot({ path: 'e2e/shots/snap-1440.png' });

    // Off again: the next drag moves freely.
    await page.locator('.topbar').getByRole('button', { name: 'Profile and usage' }).click();
    await profile.getByRole('switch', { name: 'Snap to grid' }).click();
    await expect(profile.getByRole('switch', { name: 'Snap to grid' })).toHaveAttribute('aria-checked', 'false');
    await profile.getByRole('button', { name: 'Close' }).click();
    await expect(page.locator('.board')).not.toHaveClass(/is-snapping/);
    expect(errors).toEqual([]);
  } finally {
    await closeApp(app);
  }
});

test('canvas: Tidy canvas asks first, packs the zones in rows, and can be undone (button or ⌘Z) for a while', async () => {
  const app = await launch();
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(e.message));
    await page.reload();
    await expect(page.locator('article.card')).toHaveCount(11);

    const positions = () => page.locator('.zone').evaluateAll((els) =>
      Object.fromEntries(els.map((el) => {
        const [x = '0px', y = '0px'] = (el as HTMLElement).style.translate.split(' ').filter(Boolean);
        return [(el as HTMLElement).dataset.zoneId!, `${x} ${y}`];
      })));
    // Messy first: one zone dragged well out of its row.
    const zone = page.locator('.zone').first();
    const label = zone.locator('.zone-label');
    const box = (await label.boundingBox())!;
    await page.mouse.move(box.x + 40, box.y + 8);
    await page.mouse.down();
    for (const [dx, dy] of [[60, 80], [180, 240], [260, 330]]) await page.mouse.move(box.x + 40 + dx!, box.y + 8 + dy!);
    await page.mouse.up();
    await page.waitForTimeout(300);
    const messy = await positions();

    const menuButton = page.locator('.topbar').getByRole('button', { name: 'Zones', exact: true });
    const menu = page.locator('.zones-menu');
    // Cancel changes nothing.
    await menuButton.click();
    await menu.getByRole('button', { name: 'Tidy canvas' }).click();
    const confirm = menu.getByRole('group', { name: 'Tidy canvas' });
    await expect(confirm).toContainText('undo for 30 seconds');
    await expect(confirm.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await expect(confirm).toHaveCount(0);
    expect(await positions()).toEqual(messy);

    await menu.getByRole('button', { name: 'Tidy canvas' }).click();
    await confirm.getByRole('button', { name: 'Tidy', exact: true }).click();
    await expect(menu).toHaveCount(0);
    const toast = page.getByRole('status').filter({ hasText: 'Canvas tidied' });
    await expect(toast).toBeVisible();
    await expect.poll(positions).not.toEqual(messy);
    const tidy = await positions();
    // The zone that was first in reading order now sits at the origin.
    expect(Object.values(tidy)).toContain('0px 0px');
    await page.waitForTimeout(400);
    await page.screenshot({ path: 'e2e/shots/tidy-1440.png' });

    await toast.getByRole('button', { name: 'Undo' }).click();
    await expect(toast).toHaveCount(0);
    await expect.poll(positions).toEqual(messy);

    // Again, undone from the keyboard this time.
    await menuButton.click();
    await menu.getByRole('button', { name: 'Tidy canvas' }).click();
    await confirm.getByRole('button', { name: 'Tidy', exact: true }).click();
    await expect.poll(positions).toEqual(tidy);
    await page.locator('.workspace').click({ position: { x: 4, y: 4 } });
    await page.keyboard.press('Meta+z');
    await expect.poll(positions).toEqual(messy);
    await expect(toast).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await closeApp(app);
  }
});

test('canvas: holding Space, a drag on a card or a zone label pans the view and moves nothing; a tap of Space on a focused card still opens it', async () => {
  const app = await launch();
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(e.message));
    await page.reload();
    await expect(page.locator('article.card')).toHaveCount(11);
    const board = page.locator('.board');
    const view = async () => (await board.evaluate((el) => (el as HTMLElement).style.transform)).match(/-?[\d.]+/g)!.map(Number);
    const before = await cardPositions(page);

    for (const handle of [page.locator('.card').first(), page.locator('.zone-label').first()]) {
      const [x0, y0] = await view();
      const box = (await handle.boundingBox())!;
      await page.mouse.move(box.x + 20, box.y + 8);
      await page.keyboard.down('Space');
      await expect(page.locator('.workspace')).toHaveClass(/is-space-pan/);
      await page.mouse.down();
      await page.mouse.move(box.x + 60, box.y + 38, { steps: 4 });
      await page.mouse.move(box.x + 100, box.y + 68, { steps: 4 });
      await page.mouse.up();
      await page.keyboard.up('Space');
      await expect(page.locator('.workspace')).not.toHaveClass(/is-space-pan/);
      const [x1, y1] = await view();
      expect([Math.round(x1! - x0!), Math.round(y1! - y0!)]).toEqual([80, 60]);
      await expect(board).not.toHaveClass(/is-dragging/);
      expect(page.locator('.chat-screen')).toHaveCount(0);
    }
    expect(await cardPositions(page)).toEqual(before);

    // A plain click while Space is held opens nothing either.
    const card = page.locator('.card').first();
    await page.keyboard.down('Space');
    await card.click();
    await page.keyboard.up('Space');
    await expect(page.locator('.chat-screen')).toHaveCount(0);

    await card.focus();
    await page.keyboard.press('Space');
    await expect(page.locator('.chat-screen')).toHaveCount(1);
    expect(errors).toEqual([]);
  } finally {
    await closeApp(app);
  }
});

test('panel: the canvas keeps its zoom and keys beside it, the edge resizes it (remembered), and it fits the smallest window', async () => {
  const app = await launch();
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(e.message));
    await page.reload();
    await expect(page.locator('article.card')).toHaveCount(11);
    const screen = page.locator('.chat-screen');
    const board = page.locator('.board');
    const workspace = page.locator('.workspace');
    const width = async () => (await screen.boundingBox())!.width;
    const open = async () => {
      await page.locator('.card', { hasText: 'Purchases unavailable in production' }).click();
      await expect(screen).toHaveClass(/\bis-panel\b/);
      await expect(screen.locator('.cs-heading h1')).toHaveText('Purchases unavailable in production');
    };
    await open();

    // F typed in the composer is text, not Fit.
    const field = screen.getByLabel('Message Claude');
    await field.click();
    const before = await board.getAttribute('style');
    await page.keyboard.press('f');
    await expect(field).toHaveValue('f');
    expect(await board.getAttribute('style')).toBe(before);
    await field.fill('');

    // The canvas beside the panel still scrolls under the wheel; clicking its empty space leaves the
    // panel open, and F there fits.
    const ws = (await workspace.boundingBox())!;
    await page.mouse.move(ws.x + ws.width / 2, ws.y + ws.height / 2);
    await page.mouse.wheel(0, -240);
    await expect.poll(() => board.getAttribute('style')).not.toBe(before);
    const scrolled = await board.getAttribute('style');
    await workspace.click({ position: { x: 6, y: ws.height - 6 } });
    await expect(screen).toBeVisible();
    await page.keyboard.press('f');
    await expect.poll(() => board.getAttribute('style')).not.toBe(scrolled);

    // Another card switches the panel to its chat.
    await page.locator('.card', { hasText: 'Enable account deletion approvals on Hostly' }).click();
    await expect(screen.locator('.cs-heading h1')).toHaveText('Enable account deletion approvals on Hostly');
    await expect(screen).toHaveClass(/\bis-panel\b/);

    // The left edge resizes the panel: wider by dragging left, never past leaving the canvas 320 px.
    expect(await width()).toBe(560);
    const drag = async (dx: number) => {
      const e = (await screen.locator('.panel-edge').boundingBox())!;
      const x = e.x + e.width / 2;
      const y = e.y + e.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + dx / 2, y, { steps: 4 });
      await page.mouse.move(x + dx, y, { steps: 4 });
      await page.mouse.up();
    };
    await drag(-100);
    await expect.poll(width).toBe(660);
    await drag(-2000);
    await expect.poll(width).toBe(1440 - 344);
    expect((await workspace.boundingBox())!.width).toBe(320);
    await drag(2000);
    await expect.poll(width).toBe(380);
    await drag(-220);
    await expect.poll(width).toBe(600);

    // The width is remembered; a reload opens nothing, and the next open starts as the panel at that width.
    await page.reload();
    await expect(page.locator('article.card')).toHaveCount(11);
    await open();
    expect(await width()).toBe(600);

    // The smallest window: canvas and panel both fit, the panel's controls in reach.
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.setContentSize(1100, 700); });
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(1100);
    const small = (await screen.boundingBox())!;
    expect(small.width).toBe(600);
    expect(small.x + small.width).toBeLessThanOrEqual(1100);
    expect((await workspace.boundingBox())!.width).toBeGreaterThanOrEqual(320);
    await expect(screen.getByRole('button', { name: 'Full screen' })).toBeInViewport();
    await expect(screen.getByRole('button', { name: 'Close chat' })).toBeInViewport();
    await expect(screen.getByRole('button', { name: 'Send' })).toBeInViewport();
    await drag(-2000);
    await expect.poll(width).toBe(1100 - 344);
    await drag(2000);
    await expect.poll(width).toBe(380);
    await page.waitForTimeout(300);
    await page.screenshot({ path: 'e2e/shots/panel-1100.png' });
    await screen.getByRole('button', { name: 'Full screen' }).click();
    await expect(screen.locator('.rail')).toBeInViewport();
    await expect(screen.getByRole('button', { name: 'Exit full screen' })).toBeInViewport();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await expect(screen).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await closeApp(app);
  }
});

/** Where every card sits: its zone, the zone's transform and size, the card's offset in it. */
const cardPositions = (page: import('@playwright/test').Page) => page.evaluate(() =>
  [...document.querySelectorAll<HTMLElement>('.card')].map((c) => {
    const zone = c.closest<HTMLElement>('.zone')!;
    return [c.dataset.cardId, zone.dataset.zoneId, zone.style.translate, c.offsetLeft, c.offsetTop, zone.offsetWidth, zone.offsetHeight].join(' ');
  }));

test('waiting requests stay reachable by keyboard at minimum window width', async () => {
  const app = await launch({}, '--demo=large');
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1100, 700));
    const queue = page.getByRole('region', { name: 'Needs you' });
    const titles = queue.locator('.brief-tag strong');
    await expect(titles).toHaveCount(2);
    await expect.poll(() => queue.locator('.brief-detail').evaluateAll((els) =>
      els.every((el) => el.scrollWidth <= el.clientWidth))).toBe(true);
    await queue.screenshot({ path: 'e2e/shots/queue-1100.png', scale: 'css' });
    const initial = await titles.allTextContents();
    const next = queue.getByRole('button', { name: 'Next requests' });
    await next.focus();
    await page.keyboard.press('Enter');
    await expect(titles.first()).not.toHaveText(initial[0]!);
    await queue.getByRole('button', { name: 'Previous requests' }).click();
    expect(await titles.allTextContents()).toEqual(initial);
    await queue.locator('.brief-tag').first().focus();
    await page.keyboard.press('Enter');
    const heading = page.locator('.cs-heading h1');
    await expect(heading).toHaveText(initial[0]!);
    await expect(heading).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(queue.locator('.brief-tag').first()).toBeFocused();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1440, 900));
    await expect(titles).toHaveCount(3);
  } finally {
    await closeApp(app);
  }
});

test('narrow keyboard approval shows the full command and restores canvas focus', async () => {
  const app = await launch();
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1100, 700));
    await page.evaluate(() => localStorage.setItem('agent-canvas:panel-width', '380'));
    await page.reload();
    const queue = page.getByRole('region', { name: 'Needs you' });
    const opener = queue.getByRole('button', { name: /Approval requested/ });
    await opener.press('Enter');
    const panel = page.locator('.chat-screen');
    const heading = panel.locator('h1');
    const ask = panel.getByRole('group', { name: 'Permission request' });
    await expect(ask).toBeVisible();
    await expect(heading).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(ask.locator('code')).toHaveText('ssh hostly systemctl restart api');
    expect(await heading.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    expect(await ask.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.screenshot({ path: 'e2e/shots/approval-380.png', scale: 'css' });
    await ask.getByRole('button', { name: 'Allow', exact: true }).click();
    await expect(panel.locator('.t-asked.is-allowed')).toBeVisible();
    await panel.getByRole('button', { name: 'Close chat' }).click();
    await expect(opener).toBeFocused();

    // The finished reply keeps its "Done" while its chat is open; leaving clears it from the strip,
    // so Close returns to its card.
    const reply = queue.getByRole('button', { name: /Done/ });
    const card = page.locator('[data-card-id="demo-purchases"]');
    await reply.press('Enter');
    await expect(heading).toBeFocused();
    await expect(reply).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(card).toBeFocused();
    await expect(reply).toHaveCount(0);
    // Opened from its card, Close returns to the card.
    await card.focus();
    await card.press('Enter');
    await expect(heading).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(card).toBeFocused();
  } finally {
    await closeApp(app);
  }
});

test('request queue opens the right chat, nothing floats over the canvas, and a finished reply reads Done until its chat is left', async () => {
  const app = await launch();
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(e.message));
    await page.reload();
    await expect(page.locator('article.card')).toHaveCount(11);
    const card = (id: string) => page.locator(`.card[data-card-id="${id}"]`);

    // No card wears a dot, and hovering a card floats nothing over its neighbours: the card says it all.
    await expect(page.locator('.card-dot')).toHaveCount(0);
    const before = await cardPositions(page);
    await card('demo-dbviz').hover();
    await page.waitForTimeout(400);
    await expect(page.getByRole('tooltip')).toHaveCount(0);
    await expect(card('demo-dbviz').locator('.run-step.is-current')).toHaveText('Running tests');
    expect(await cardPositions(page)).toEqual(before);
    await card('demo-hostly').hover();
    await page.waitForTimeout(400);
    await expect(page.getByRole('tooltip')).toHaveCount(0);
    await page.screenshot({ path: 'e2e/shots/cards-hover.png' });

    // Every card line fits its card: no text runs past the card's edge.
    expect(await page.locator('.card').evaluateAll((cards) => cards.every((c) =>
      [...c.querySelectorAll<HTMLElement>('.title, .run-step > span, .card-fact > span, .chip')].every((el) => {
        const r = el.getBoundingClientRect(); const box = c.getBoundingClientRect();
        return r.left >= box.left - 0.5 && r.right <= box.right + 0.5;
      })))).toBe(true);

    const queue = page.getByRole('region', { name: 'Needs you' });
    await expect(queue.getByRole('button')).toHaveCount(2);
    await queue.getByRole('button', { name: /Approval requested/ }).click();
    const screen = page.locator('.chat-screen');
    await expect(screen.locator('.cs-heading h1')).toHaveText('Enable account deletion approvals on Hostly');
    await screen.getByRole('button', { name: 'Close chat' }).click();

    // A finished reply is Done: green, with a check, not the amber of a request.
    const reply = queue.getByRole('button', { name: /Done/ });
    await expect(reply).toHaveCount(1);
    await expect(card('demo-purchases')).toHaveClass(/\bis-done\b/);
    await expect(card('demo-purchases')).not.toHaveClass(/\bis-needs\b/);
    await expect(card('demo-hostly')).toHaveClass(/\bis-needs\b/);
    await page.screenshot({ path: 'e2e/shots/done-vs-needs.png', clip: { x: 0, y: 40, width: 1440, height: 440 } });

    // Opening it is seeing it: the Done clears when the chat is left, with no button to press.
    // While it is open the card stays where it was, still Done.
    const doneBox = await card('demo-purchases').boundingBox();
    await reply.click();
    await expect(screen.locator('.cs-heading h1')).toHaveText('Purchases unavailable in production');
    await expect(screen.getByRole('button', { name: 'Mark seen' })).toHaveCount(0);
    await page.waitForTimeout(600);
    await expect(reply).toHaveCount(1);
    await expect(card('demo-purchases')).toHaveClass(/\bis-done\b/);
    expect(await card('demo-purchases').boundingBox()).toEqual(doneBox);
    await expect(card('demo-purchases')).toHaveClass(/\bis-selected\b/);
    await page.mouse.move(6, 6);
    await settled(page);
    const selected = (await card('demo-purchases').boundingBox())!;
    await page.screenshot({ path: 'e2e/shots/selected-done.png', clip: {
      x: selected.x - 12, y: selected.y - 12, width: selected.width + 24, height: selected.height + 24,
    } });

    // Turning back to the canvas checks it off there and then: the Done leaves the queue and the
    // card while the chat stays open on it, still the selected card.
    await page.locator('.workspace').click({ position: { x: 4, y: 4 } });
    await expect(reply).toHaveCount(0);
    await expect(card('demo-purchases')).not.toHaveClass(/\bis-done\b/);
    await expect(screen.locator('.cs-heading h1')).toHaveText('Purchases unavailable in production');
    await expect(card('demo-purchases')).toHaveClass(/\bis-selected\b/);

    await screen.getByRole('button', { name: 'Close chat' }).click();
    await expect(reply).toHaveCount(0);
    await expect(card('demo-purchases')).not.toHaveClass(/\bis-done\b/);
    // The approval is still waiting: only answering clears a request.
    await expect(queue.getByRole('button', { name: /Approval requested/ })).toHaveCount(1);
    expect(errors).toEqual([]);
  } finally {
    await closeApp(app);
  }
});

test('images: attached or pasted show as small previews that open large; a removed zone leaves the canvas and comes back from the menu', async () => {
  const app = await launch();
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(e.message));
    await page.reload();
    await expect(page.locator('article.card')).toHaveCount(11);
    // A wide screenshot-like image, drawn in the page.
    const png = Buffer.from(await page.evaluate(() => {
      const c = document.createElement('canvas');
      c.width = 640; c.height = 400;
      const g = c.getContext('2d')!;
      g.fillStyle = '#2a2622'; g.fillRect(0, 0, 640, 400);
      g.fillStyle = '#e8a33d'; g.fillRect(40, 40, 260, 140);
      g.fillStyle = '#5b8def'; g.fillRect(340, 220, 260, 140);
      return c.toDataURL('image/png').split(',')[1]!;
    }), 'base64');

    // New session: the attach button adds a small preview; pressing it opens the image large.
    await page.locator('.topbar').getByRole('button', { name: /New session/ }).click();
    const dialog = page.getByRole('dialog', { name: 'New session' });
    await dialog.locator('input[type="file"]').setInputFiles({ name: 'screen.png', mimeType: 'image/png', buffer: png });
    const thumbs = dialog.getByRole('list', { name: 'Images to send' }).getByRole('button', { name: /View image/ });
    await expect(thumbs).toHaveCount(1);
    expect((await thumbs.first().boundingBox())!.width).toBeLessThanOrEqual(56);
    // Pasting an image adds another.
    await dialog.getByLabel('First message').focus();
    await page.evaluate((b64) => {
      const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
      const data = new DataTransfer();
      data.items.add(new File([bytes], 'pasted.png', { type: 'image/png' }));
      document.activeElement!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    }, png.toString('base64'));
    await expect(thumbs).toHaveCount(2);
    await page.screenshot({ path: 'e2e/shots/images-new-session.png' });
    await thumbs.first().click();
    const viewer = page.getByRole('dialog', { name: 'Image 1 of 2' });
    await expect(viewer).toBeVisible();
    const big = (await viewer.locator('.img-stage img').boundingBox())!;
    expect(big.width).toBeGreaterThan(500);
    expect(await viewer.locator('.img-stage img').evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('dialog', { name: 'Image 2 of 2' })).toBeVisible();
    await page.screenshot({ path: 'e2e/shots/images-viewer.png' });
    // Esc closes the viewer only: the dialog and its images stay.
    await page.keyboard.press('Escape');
    await expect(page.locator('dialog.img-viewer')).toHaveCount(0);
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Remove image 2' }).click();
    await expect(thumbs).toHaveCount(1);
    await dialog.getByLabel('First message').fill('What is wrong on this screen?');
    await dialog.getByRole('button', { name: 'Start' }).click();

    // The chat shows the image sent as a small preview, which opens large; Esc leaves the chat open.
    const screen = page.locator('.chat-screen');
    const sent = screen.getByRole('list', { name: 'Images sent' }).getByRole('button', { name: 'View image 1' });
    await expect(sent).toBeVisible();
    expect((await sent.boundingBox())!.width).toBeLessThanOrEqual(124);
    await sent.click();
    await expect(page.getByRole('dialog', { name: 'Image' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('dialog.img-viewer')).toHaveCount(0);
    await expect(screen).toBeVisible();
    // The composer takes a pasted image too.
    await screen.getByLabel(/^Message /).focus();
    await page.evaluate((b64) => {
      const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
      const data = new DataTransfer();
      data.items.add(new File([bytes], 'pasted.png', { type: 'image/png' }));
      document.activeElement!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    }, png.toString('base64'));
    await expect(screen.getByRole('list', { name: 'Images to send' }).getByRole('button', { name: 'View image 1' })).toBeVisible();
    await page.screenshot({ path: 'e2e/shots/images-chat.png' });
    await screen.getByRole('button', { name: 'Close chat' }).click();

    // Zones: a folder zone can be removed, and the menu brings it back.
    const zone = page.locator('.zone', { hasText: 'sailcloth-io' });
    await expect(zone).toHaveCount(1);
    const menuButton = page.locator('.topbar').getByRole('button', { name: 'Zones', exact: true });
    await menuButton.click();
    const menu = page.locator('.zones-menu');
    await menu.getByRole('button', { name: 'Remove sailcloth-io' }).click();
    await expect(menu.getByText(/Remove “sailcloth-io” from the canvas\?/)).toBeVisible();
    await page.screenshot({ path: 'e2e/shots/zones-remove.png' });
    await menu.getByRole('group', { name: 'Remove sailcloth-io' }).getByRole('button', { name: 'Remove', exact: true }).click();
    await expect(zone).toHaveCount(0);
    await expect(menu.getByText('Removed')).toBeVisible();
    await page.screenshot({ path: 'e2e/shots/zones-removed.png' });
    await menu.getByRole('button', { name: 'Show sailcloth-io' }).click();
    await expect(zone).toHaveCount(1);
    await expect(menu.getByText('Removed')).toHaveCount(0);

    // Right-clicking a zone asks first; Escape keeps it, Remove takes it off the canvas.
    await menuButton.click();
    await expect(menu).toHaveCount(0);
    await zone.locator('.zone-label').click({ button: 'right' });
    await page.getByRole('button', { name: 'Remove…', exact: true }).click();
    const ask = page.getByRole('dialog', { name: 'Remove sailcloth-io' });
    await expect(ask.getByText(/Remove “sailcloth-io” from the canvas\?.*the Zones menu\./)).toBeVisible();
    await expect(ask.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await page.screenshot({ path: 'e2e/shots/zones-context-remove.png' });
    await page.keyboard.press('Escape');
    await expect(ask).toHaveCount(0);
    await expect(zone).toHaveCount(1);
    await zone.locator('.zone-label').click({ button: 'right' });
    await page.getByRole('button', { name: 'Remove…', exact: true }).click();
    await ask.getByRole('button', { name: 'Remove', exact: true }).click();
    await expect(zone).toHaveCount(0);
    await menuButton.click();
    await menu.getByRole('button', { name: 'Show sailcloth-io' }).click();
    await expect(zone).toHaveCount(1);
    expect(errors).toEqual([]);
  } finally {
    await closeApp(app);
  }
});

test('files: any file attaches by path as a name chip, in New session and the chat composer, and shows in the message sent', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ac-files-'));
  const report = path.join(dir, 'Quarterly report.pdf');
  const notes = path.join(dir, 'notes.txt');
  await writeFile(report, '%PDF-1.4 demo');
  await writeFile(notes, 'notes');
  const app = await launch();
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(e.message));
    await page.reload();
    await expect(page.locator('article.card')).toHaveCount(11);

    await page.locator('.topbar').getByRole('button', { name: /New session/ }).click();
    const dialog = page.getByRole('dialog', { name: 'New session' });
    await expect(dialog.getByRole('button', { name: 'Attach files' })).toBeVisible();
    await dialog.locator('input[type="file"]').setInputFiles([report, notes]);
    const chips = dialog.getByRole('list', { name: 'Files to send' }).locator('.file-chip');
    await expect(chips).toHaveCount(2);
    await expect(chips.first()).toHaveAttribute('title', report);
    // A file alone is a first message.
    await expect(dialog.getByRole('button', { name: 'Start' })).toBeEnabled();
    await page.screenshot({ path: 'e2e/shots/files-new-session.png' });
    await dialog.getByRole('button', { name: 'Remove notes.txt' }).click();
    await expect(chips).toHaveCount(1);
    await dialog.getByLabel('First message').fill('Summarise this report');
    await dialog.getByRole('button', { name: 'Start' }).click();

    // The chat shows the file as a chip above the words, not the block the agent was sent.
    const screen = page.locator('.chat-screen');
    const sent = screen.getByRole('list', { name: 'Files sent' });
    await expect(sent.getByRole('button', { name: 'Show Quarterly report.pdf in Finder' })).toBeVisible();
    await expect(screen.locator('.t-you-text').first()).toHaveText('Summarise this report');
    await expect(screen.getByText(/@"/)).toHaveCount(0);
    await expect(page.locator('.card', { hasText: 'Summarise this report' })).toHaveCount(1);
    // The composer takes files too.
    await screen.locator('input[type="file"]').setInputFiles(notes);
    await expect(screen.getByRole('list', { name: 'Files to send' }).locator('.file-chip')).toHaveCount(1);
    await page.screenshot({ path: 'e2e/shots/files-chat.png' });
    expect(errors).toEqual([]);
  } finally {
    await closeApp(app);
    await rm(dir, { recursive: true, force: true });
  }
});

test('a Claude session open in another app takes a message between its turns, and waits while that app works', async () => {
  const app = await launch();
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(e.message));
    await page.reload();
    await expect(page.locator('article.card')).toHaveCount(11);
    const screen = page.locator('.chat-screen');

    // Working there: the composer waits, with the read-only banner.
    await page.locator('.card[data-card-id="demo-dbviz"]').click();
    await expect(screen.locator('.cs-banner.is-readonly')).toBeVisible();
    await expect(screen.locator('.cp-field')).toBeDisabled();
    await screen.getByRole('button', { name: 'Close chat' }).click();

    // Idle there: the composer is on, the banner says what writing here means, and a message sends.
    await page.locator('.card[data-card-id="demo-deploy"]').click();
    await expect(screen.locator('.cs-banner.is-alongside')).toContainText('Also open in another app');
    await expect(screen.locator('.cs-banner.is-readonly')).toHaveCount(0);
    await expect(screen.getByRole('button', { name: 'Move here' })).toHaveCount(0);
    const field = screen.locator('.cp-field');
    await expect(field).toBeEnabled();
    await expect(field).toHaveAttribute('placeholder', 'Message Claude…');
    await page.screenshot({ path: 'e2e/shots/alongside-before.png' });
    await field.fill('Ship it');
    await field.press('Enter');
    await expect(screen.locator('.t-you-text', { hasText: 'Ship it' })).toBeVisible();
    await expect(screen.getByText(/It shows what you send here only after you reopen the session there/)).toBeVisible();
    await expect(screen.locator('.cs-banner.is-alongside')).toHaveCount(0);
    await page.screenshot({ path: 'e2e/shots/alongside-sent.png' });
    expect(errors).toEqual([]);
  } finally {
    await closeApp(app);
  }
});

test('merged: the panel sits beside a canvas whose cards stay put; full screen keeps the resizable rail and preview', async () => {
  const app = await launch();
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(e.message));
    await page.reload();
    await page.evaluate(() => localStorage.removeItem('agent-canvas.panel-widths'));
    await page.reload();
    await expect(page.locator('article.card')).toHaveCount(11);
    const screen = page.locator('.chat-screen');

    // The panel is open, and hovering a card on the canvas beside it moves no card.
    await page.locator('.card', { hasText: 'Enable account deletion approvals on Hostly' }).click();
    await expect(screen).toHaveClass(/\bis-panel\b/);
    const before = await cardPositions(page);
    const dbviz = page.locator('.card[data-card-id="demo-dbviz"]');
    await dbviz.hover();
    await page.waitForTimeout(250);
    await expect(page.getByRole('tooltip')).toHaveCount(0);
    expect(await cardPositions(page)).toEqual(before);
    await page.screenshot({ path: 'e2e/shots/merged-panel.png' });

    // Full screen: the rail and the preview columns drag wider, and the conversation keeps its room.
    await screen.getByRole('button', { name: 'Full screen' }).click();
    await expect(screen).toHaveClass(/\bis-full\b/);
    const rail = screen.locator('.rail');
    const preview = screen.locator('.cs-preview');
    expect((await rail.boundingBox())!.width).toBe(240);
    expect((await preview.boundingBox())!.width).toBe(380);
    const drag = async (handle: string, dx: number) => {
      const h = (await screen.locator(handle).boundingBox())!;
      const x = h.x + h.width / 2;
      const y = h.y + h.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + dx / 2, y, { steps: 4 });
      await page.mouse.move(x + dx, y, { steps: 4 });
      await page.mouse.up();
    };
    await drag('.cs-resize.is-rail', 60);
    await expect.poll(async () => (await rail.boundingBox())!.width).toBe(300);
    await drag('.cs-resize.is-preview', -100);
    await expect.poll(async () => (await preview.boundingBox())!.width).toBe(480);
    expect((await screen.locator('.desk').boundingBox())!.width).toBeGreaterThanOrEqual(380);
    await page.waitForTimeout(300);
    await page.screenshot({ path: 'e2e/shots/merged-full.png' });

    // Back in the panel there are no column handles; full screen again finds the widths kept.
    await page.keyboard.press('Escape');
    await expect(screen).toHaveClass(/\bis-panel\b/);
    await expect(screen.locator('.cs-resize')).toHaveCount(0);
    await screen.getByRole('button', { name: 'Full screen' }).click();
    expect((await rail.boundingBox())!.width).toBe(300);
    expect((await preview.boundingBox())!.width).toBe(480);
    await page.evaluate(() => localStorage.removeItem('agent-canvas.panel-widths'));
    expect(errors).toEqual([]);
  } finally {
    await closeApp(app);
  }
});

test('motion: a dialog leaves with a short exit, Fit travels and lands, and reduced motion does both at once', async () => {
  const app = await launch();
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.locator('.card').first()).toBeVisible();
    await settled(page);
    // Cards arrive with an entrance that ends: after it, nothing is left mid-way.
    expect(await page.locator('.card').first().evaluate((el) => getComputedStyle(el).opacity)).toBe('1');

    const board = page.locator('.board');
    const view = () => board.evaluate((el) => (el as HTMLElement).style.transform);
    // Zoom out, then Fit: the view passes through places between where it was and where it lands.
    await page.locator('.workspace').hover({ position: { x: 40, y: 40 } });
    await page.keyboard.down('Meta');
    await page.mouse.wheel(0, 400);
    await page.keyboard.up('Meta');
    const before = await view();
    const seen = new Set<string>();
    await page.getByRole('button', { name: 'Fit', exact: true }).click();
    await expect.poll(async () => { seen.add(await view()); return seen.size; }, { intervals: [15] }).toBeGreaterThan(2);
    await expect.poll(async () => { const a = await view(); await page.waitForTimeout(80); return a === await view(); }).toBe(true);
    const landed = await view();
    expect(landed).not.toBe(before);

    // Esc on New session: the dialog is marked closing, then gone.
    await page.keyboard.press('Meta+n');
    const dialog = page.locator('dialog.ns');
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('dialog.ns.is-closing')).toHaveCount(1);
    await expect(dialog).toHaveCount(0);

    // Reduced motion: the same two actions happen in one step.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.keyboard.down('Meta');
    await page.mouse.wheel(0, 400);
    await page.keyboard.up('Meta');
    await page.getByRole('button', { name: 'Fit', exact: true }).click();
    await expect.poll(view).toBe(landed);
    await page.keyboard.press('Meta+n');
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    expect(await page.locator('.card').first().evaluate((el) => getComputedStyle(el).animationName)).toBe('none');
  } finally {
    await closeApp(app);
  }
});

test('motion: a card dragged to another zone, and the cards it displaces, move there; none of them arrives again', async () => {
  const app = await launch();
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.locator('.card').first()).toBeVisible();
    await settled(page);
    const count = await page.locator('article.card').count();
    const card = page.locator('.card', { hasText: 'Deploy changes' });
    const from = (await card.boundingBox())!;
    const to = (await page.locator('.zone', { hasText: 'garden-dashboard' }).locator('.zone-label').boundingBox())!;
    await page.mouse.move(from.x + 60, from.y + 20);
    await page.mouse.down();
    await page.mouse.move(from.x + 20, from.y + 40, { steps: 4 });
    await page.mouse.move(to.x + 200, to.y + 60, { steps: 8 });
    await page.mouse.up();
    await expect(page.locator('.zone', { hasText: 'garden-dashboard' }).locator('.card', { hasText: 'Deploy changes' })).toHaveCount(1);
    // Straight after the drop: the card is whole (never faded out and in), marked as moved, and
    // on its way by a glide of its own, not by the entrance a new card plays.
    const state = await card.evaluate((el) => ({
      moved: 'moved' in (el as HTMLElement).dataset,
      opacity: getComputedStyle(el).opacity,
      entering: el.getAnimations().some((a) => (a as CSSAnimation).animationName === 'card-in'),
    }));
    expect(state).toEqual({ moved: true, opacity: '1', entering: false });
    expect(await page.locator('.card').evaluateAll((els) => els.filter((el) =>
      el.getAnimations().some((a) => (a as CSSAnimation).animationName === 'card-in')).length)).toBe(0);
    await settled(page);
    await expect(page.locator('article.card')).toHaveCount(count);
    await expect(page.locator('.card.is-leaving')).toHaveCount(0);
  } finally {
    await closeApp(app);
  }
});

test('motion: the panel slides in beside a canvas that gives way, swaps its chat without arriving again, and leaves with an exit', async () => {
  const app = await launch();
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(e.message));
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.locator('.card').first()).toBeVisible();
    await settled(page);
    const shell = page.locator('.app');
    const screen = page.locator('.chat-screen');
    const canvasWidth = async () => Math.round((await page.locator('.workspace').boundingBox())!.width);
    const whole = await canvasWidth();

    // Opening: the panel has its full width from the first frame (its conversation is laid out
    // once) and slides in as its column opens; the canvas passes through widths in between.
    await page.locator('.card', { hasText: 'Purchases unavailable in production' }).click();
    await expect(screen).toHaveClass(/\bis-panel\b/);
    await expect(shell).toHaveClass(/\bis-panel-opening\b/);
    expect((await screen.boundingBox())!.width).toBe(560);
    const widths = new Set<number>();
    await expect.poll(async () => { widths.add(await canvasWidth()); return widths.size; }, { intervals: [10] }).toBeGreaterThan(2);
    await settled(page);
    expect(await canvasWidth()).toBe(whole - 568);
    expect(await screen.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
    await expect(shell).not.toHaveClass(/\bis-panel-opening\b/);

    // Another card: the same panel, with the new chat's conversation rising into it. The panel
    // itself does not enter again, and the canvas does not move.
    const panel = await screen.elementHandle();
    await page.locator('.card', { hasText: 'Enable account deletion approvals on Hostly' }).click();
    await expect(screen.locator('.cs-heading h1')).toHaveText('Enable account deletion approvals on Hostly');
    expect(await screen.evaluate((el, was) => el === was, panel)).toBe(true);
    expect(await screen.evaluate((el) => ({
      arriving: el.getAnimations().some((a) => (a as CSSAnimation).animationName === 'panel-in'),
      opacity: getComputedStyle(el).opacity,
    }))).toEqual({ arriving: false, opacity: '1' });
    expect(await screen.locator('.desk').evaluate((el) => el.getAnimations().some((a) => (a as CSSAnimation).animationName === 'rise'))).toBe(true);
    expect(await canvasWidth()).toBe(whole - 568);

    // Closing: the panel stays for its exit, out of reach, then is gone and the canvas has its room back.
    await screen.getByRole('button', { name: 'Close chat' }).click();
    await expect(page.locator('.chat-screen.is-closing[inert]')).toHaveCount(1);
    await expect(page.getByRole('complementary', { name: 'Chat panel' })).toHaveCount(0);
    await expect(screen).toHaveCount(0);
    await settled(page);
    expect(await canvasWidth()).toBe(whole);

    // Reduced motion: open and closed in one step each.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.locator('.card', { hasText: 'Purchases unavailable in production' }).click();
    await expect(screen).toHaveClass(/\bis-panel\b/);
    expect(await canvasWidth()).toBe(whole - 568);
    expect(await screen.evaluate((el) => el.getAnimations().length)).toBe(0);
    await screen.getByRole('button', { name: 'Close chat' }).click();
    expect(await screen.count()).toBe(0);
    expect(await canvasWidth()).toBe(whole);
    expect(errors).toEqual([]);
  } finally {
    await closeApp(app);
  }
});

test('layout: zoomed in at the smallest window, the whole app fits, the canvas agent and a session panel included', async () => {
  const app = await launch();
  try {
    const page = await app.firstWindow();
    await expect(page.locator('.card').first()).toBeVisible();
    // ⌘+ leaves the page fewer CSS pixels than the window has points (1100 at 150% is 733).
    await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]!; w.setContentSize(1100, 700); w.webContents.setZoomFactor(1.5); });
    await expect.poll(() => page.evaluate(() => innerWidth)).toBeLessThan(760);
    /** Everything outside the board that reaches past the window's right edge. */
    const outside = () => page.evaluate(() => {
      const vw = document.documentElement.clientWidth;
      // The moving dot grid extends one tile past the workspace so panning never
      // exposes a seam. Its visible edge is the workspace's own clipping edge.
      const grid = document.querySelector('.workspace > .workspace-grid');
      const clippedGrid = grid?.parentElement && getComputedStyle(grid.parentElement).overflowX === 'hidden' ? grid : null;
      return [...document.querySelectorAll('body *')].filter((el) => el !== clippedGrid && !el.closest('.board, .zone'))
        .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.right > vw + 1; })
        .map((el) => `${el.tagName.toLowerCase()}.${[...el.classList].join('.')}`);
    });
    const insideRight = async (selector: string) => {
      const vw = await page.evaluate(() => document.documentElement.clientWidth);
      const box = (await page.locator(selector).first().boundingBox())!;
      expect(box.x + box.width, selector).toBeLessThanOrEqual(vw + 1);
    };
    await settled(page);
    expect(await outside()).toEqual([]);
    await insideRight('button.avatar');

    await page.keyboard.press('Meta+J');
    const agent = page.getByRole('complementary', { name: 'Chat panel' });
    await expect(agent).toBeVisible();
    await settled(page);
    expect(await outside()).toEqual([]);
    await insideRight('.chat-screen .cs-bar');
    await insideRight('.chat-screen .composer');
    await page.keyboard.press('Meta+J');
    await expect(agent).toHaveCount(0);

    await page.locator('[data-card-id="demo-codex"]').click();
    await expect(page.locator('.chat-screen .thread')).toBeVisible();
    await settled(page);
    expect(await outside()).toEqual([]);
    await insideRight('.chat-screen .composer');
    await insideRight('.chat-screen .cs-window');
  } finally {
    await closeApp(app);
  }
});

test('motion: the header toggle opens a collapsed preview out from under the chat with its page live, closes it back, and settles when interrupted', async () => {
  // A live page that counts its own reloads and resizes: neither may happen while the dock moves.
  const server = createServer((_req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(
    '<title>Toggle game</title><style>body{margin:0;height:100vh;background:#1d3b5c;color:white;font:28px system-ui;display:grid;place-items:center}</style>'
    + '<h1>Live page</h1><script>window.sizes=[];addEventListener("resize",()=>sizes.push(innerWidth))</script>'));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  const app = await launch();
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(e.message));
    await page.locator('[data-card-id="demo-codex"]').click();
    const chat = page.getByRole('complementary', { name: 'Chat panel' });
    await expect(chat.locator('.thread')).toBeVisible();
    await settled(page);
    const toggle = chat.getByRole('button', { name: 'Preview', exact: true });
    const pane = page.locator('.preview-window');
    // A capture gives the session something to preview (the demo session has none of its own).
    const capture = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>').toString('base64');
    const giveCapture = () => app.evaluate(({ BrowserWindow }, src) => {
      BrowserWindow.getAllWindows()[0]!.webContents.send('canvas:chat:demo-codex', { op: 'meta', patch: { browserCapture: { id: 'screen', src } } });
    }, 'data:image/svg+xml;base64,' + capture);
    await giveCapture();

    // Collapsed by default, even with something to show; the toggle sits just before Close.
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await expect(toggle).not.toHaveAttribute('aria-disabled', 'true');
    await expect(toggle).toHaveAttribute('title', 'Show preview (⇧⌘P)');
    expect(await toggle.evaluate((el) => el.nextElementSibling?.getAttribute('aria-label'))).toBe('Close chat');
    await expect(pane).toHaveCount(0);
    const canvasWidth = async () => Math.round((await page.locator('.workspace').boundingBox())!.width);
    const whole = await canvasWidth();
    await chat.screenshot({ path: 'e2e/shots/preview-toggle-off.png', scale: 'css' });

    // Opening: the canvas passes through widths in between as the dock comes out.
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect(toggle).toHaveAttribute('title', 'Hide preview (⇧⌘P)');
    await expect(pane).toHaveClass(/pv-right/);
    const widths = new Set<number>();
    await expect.poll(async () => { widths.add(await canvasWidth()); return widths.size; }, { intervals: [10] }).toBeGreaterThan(2);
    await settled(page);
    const docked = await canvasWidth();
    expect(docked).toBeLessThan(whole - 200);
    // At rest nothing is clipped: the whole pane shows, right edge at the area's.
    const rest = await pane.evaluate((el) => {
      const r = el.getBoundingClientRect(); const a = el.parentElement!.getBoundingClientRect();
      return { right: Math.round(r.right), area: Math.round(a.right) };
    });
    expect(rest.right).toBe(rest.area);

    await pane.getByRole('button', { name: 'Preview controls' }).click();
    await pane.getByRole('tab', { name: 'Browser' }).click();
    await pane.getByLabel('Address').fill(url);
    await pane.getByLabel('Address').press('Enter');
    await expect.poll(() => previewPage(app, url), { timeout: 10_000 }).toMatchObject({ title: 'Toggle game' });
    await pane.getByRole('button', { name: 'Preview controls' }).click();
    await settled(page);
    const frame = () => pane.locator('.pv-frame').evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + el.clientLeft), y: Math.round(r.top + el.clientTop), width: el.clientWidth, height: el.clientHeight };
    });
    const full = await frame();
    await expect.poll(() => previewView(app)).toEqual({ visible: true, bounds: full });
    await page.screenshot({ path: 'e2e/shots/preview-toggle-open.png', scale: 'css' });
    const guest = (js: string) => app.evaluate(({ webContents }, { url, js }) =>
      webContents.getAllWebContents().find(w => w.getURL() === url)!.executeJavaScript(js), { url, js }) as Promise<unknown>;
    await guest('window.kept = 1; sizes = []; window.wide = innerWidth');

    /** The native page's visible width, sampled for `ms` (0 while hidden). */
    const sample = (ms: number) => app.evaluate(async ({ BrowserWindow }, ms) => {
      const out: number[] = [];
      const end = Date.now() + ms;
      while (Date.now() < end) {
        const view = BrowserWindow.getAllWindows()[0]?.contentView.children[0];
        out.push(view?.getVisible() ? view.getBounds().width : 0);
        await new Promise((resolve) => setTimeout(resolve, 4));
      }
      return out;
    }, ms);
    const between = (ws: number[]) => ws.filter((w) => w > 0 && w < full.width);

    // Closing: the page slides back under the chat's edge, cropped (never hidden first), then goes.
    const closingSamples = sample(450);
    await toggle.click();
    const closing = await closingSamples;
    await expect(pane).toHaveCount(0);
    await expect.poll(async () => (await previewView(app))?.visible).toBe(false);
    expect(between(closing).length).toBeGreaterThan(0);
    expect(closing.every((w, i) => i === 0 || w <= closing[i - 1]!)).toBe(true);
    await settled(page);
    expect(await canvasWidth()).toBe(whole);

    // Opening again: the page comes out with the dock, growing, and lands where the frame is.
    const openingSamples = sample(550);
    await toggle.click();
    const opening = await openingSamples;
    expect(between(opening).length).toBeGreaterThan(0);
    const shown = opening.filter((w) => w > 0);
    expect(shown.every((w, i) => i === 0 || w >= shown[i - 1]!)).toBe(true);
    await settled(page);
    await expect.poll(() => previewView(app)).toEqual({ visible: true, bounds: await frame() });
    // The same page throughout: not reloaded, and never laid out narrower while it moved.
    const seen = await guest('[window.kept, window.wide, sizes]') as [number, number, number[]];
    expect(seen[0]).toBe(1);
    expect(seen[2].filter((w) => w !== seen[1]), `widths the page was laid out at: ${seen[2].join(', ')} (whole ${seen[1]})`).toEqual([]);

    // From open, a quick double press settles open again and a triple press closed: one pane or none, no ghost.
    await toggle.click();
    await toggle.click();
    await settled(page);
    await page.waitForTimeout(250);
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect(pane).toHaveCount(1);
    await expect(pane).not.toHaveClass(/is-closing/);
    await expect.poll(() => previewView(app)).toEqual({ visible: true, bounds: await frame() });
    await toggle.click();
    await toggle.click();
    await toggle.click();
    await settled(page);
    await page.waitForTimeout(250);
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await expect(pane).toHaveCount(0);
    await expect.poll(async () => (await previewView(app))?.visible).toBe(false);
    expect(await canvasWidth()).toBe(whole);

    // ⇧⌘P does the same from the composer.
    await chat.getByLabel('Message Codex').focus();
    await page.keyboard.press('Meta+Shift+P');
    await expect(pane).toHaveCount(1);
    await page.keyboard.press('Meta+Shift+P');
    await settled(page);
    await page.waitForTimeout(250);
    await expect(pane).toHaveCount(0);

    // Another session mid-way: its preview is collapsed, so this one leaves; and back here it is
    // still open (its choice lasts this run).
    const codexTitle = await chat.locator('.cs-heading h1').textContent();
    await toggle.click();
    await page.locator('[data-card-id="demo-purchases"]').click();
    await expect(chat.locator('.cs-heading h1')).not.toHaveText(codexTitle!);
    await settled(page);
    await page.waitForTimeout(250);
    await expect(pane).toHaveCount(0);
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(async () => (await previewView(app))?.visible).toBe(false);
    await page.locator('[data-card-id="demo-codex"]').click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect(pane).toHaveCount(1);
    await settled(page);
    await expect.poll(async () => (await previewView(app))?.visible).toBe(true);
    // Its page lived through the other chat: never emptied, never reloaded.
    expect(await guest('window.kept')).toBe(1);
    // The chat opened afresh: the stand-in capture again, so the toggle can open it once closed.
    await giveCapture();

    // Esc mid-way closes the chat, and the preview leaves with it.
    await toggle.click();
    await settled(page);
    await toggle.click();
    await page.keyboard.press('Escape');
    await settled(page);
    await page.waitForTimeout(250);
    await expect(chat).toHaveCount(0);
    await expect(pane).toHaveCount(0);
    await expect.poll(async () => (await previewView(app))?.visible).toBe(false);

    // Reduced motion: open and closed in one step each.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.locator('[data-card-id="demo-codex"]').click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect(pane).toHaveCount(1);
    await giveCapture();
    await toggle.click();
    expect(await pane.count()).toBe(0);
    await toggle.click();
    expect(await pane.evaluate((el) => el.getAnimations().length)).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await closeApp(app);
    server.closeAllConnections();
    server.close();
  }
});

test('motion: the agent orb flies out and becomes its panel, comes home when it closes, and turns round or ends cleanly when interrupted', async () => {
  const app = await launch();
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(e.message));
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.locator('.card').first()).toBeVisible();
    await settled(page);
    const shell = page.locator('.app');
    const orb = page.getByTestId('agent-orb');
    const agent = page.locator('.chat-screen.is-agent');
    const layer = page.locator('.agent-flight');
    const morph = () => shell.getAttribute('data-morph');
    const seen = (el: Element) => getComputedStyle(el).opacity;
    const home = (await orb.boundingBox())!;
    /** Nothing of a flight is left: no layer, no phase, the button whole and where it was. */
    const atRest = async () => {
      await expect(layer).toHaveCount(0);
      await expect.poll(morph).toBeNull();
      expect(await orb.evaluate(seen)).toBe('1');
      expect(await orb.boundingBox()).toEqual(home);
    };

    // Out: one layer carries the button to the panel's place. The panel is laid out under it,
    // ready to type in, but not seen until the layer lands.
    await orb.click();
    await expect(shell).toHaveAttribute('data-morph', 'open');
    await expect(layer).toHaveCount(1);
    await expect(layer.locator('.agent-flight-shape')).toHaveCount(1);
    await expect(agent).toHaveCount(1);
    expect(await orb.evaluate(seen)).toBe('0');
    expect(await agent.locator('.desk').evaluate(seen)).toBe('0');
    const shape = layer.locator('.agent-flight-shape');
    const sizes = new Set<number>();
    await expect.poll(async () => { const b = await shape.boundingBox().catch(() => null); if (b) sizes.add(Math.round(b.width)); return sizes.size; }, { intervals: [10] }).toBeGreaterThan(2);
    // Landed: the layer is gone and the real panel shows, exactly where the layer stood.
    await expect(layer).toHaveCount(0);
    await expect(page.getByTestId('agent-start')).toBeVisible();
    await settled(page);
    expect(await agent.locator('.desk').evaluate(seen)).toBe('1');
    expect(await agent.evaluate(seen)).toBe('1');
    const stood = (await agent.boundingBox())!;
    expect(stood).toMatchObject({ x: 1440 - 8 - 560, width: 560 });
    await expect(page.getByLabel('Message the canvas agent')).toBeFocused();
    await page.screenshot({ path: 'e2e/shots/agent-panel-landed.png' });

    // Home: ⌘J closes it; the layer starts as the panel and lands as the button, which takes focus back.
    await page.keyboard.press('Meta+j');
    await expect(shell).toHaveAttribute('data-morph', 'close');
    await expect(layer).toHaveCount(1);
    await expect(agent).toHaveCount(0);
    await atRest();
    await expect(orb).toBeFocused();
    await expect(orb).toHaveAttribute('aria-expanded', 'false');

    // A fast double click opens and closes before it has arrived: it turns round mid-air.
    await orb.dblclick();
    await expect(agent).toHaveCount(0);
    await atRest();
    expect(await page.evaluate(() => window.location.hash)).toBe('');
    // And three clicks leave it open, having turned round twice.
    await orb.click({ clickCount: 3 });
    await expect(page.getByTestId('agent-start')).toBeVisible();
    await atRest();
    expect(await agent.locator('.desk').evaluate(seen)).toBe('1');
    await page.keyboard.press('Meta+j');
    await page.keyboard.press('Meta+j');
    await page.keyboard.press('Meta+j');
    await expect(agent).toHaveCount(0);
    await atRest();

    // A session opened mid-flight takes the panel: the layer ends there and then, and the
    // session's chat is an ordinary panel.
    await orb.click();
    await expect(layer).toHaveCount(1);
    await page.locator('.card', { hasText: 'Purchases unavailable in production' }).click();
    const chat = page.locator('.chat-screen');
    await expect(chat.locator('.cs-heading h1')).toHaveText('Purchases unavailable in production');
    await atRest();
    await settled(page);
    expect(await chat.evaluate(seen)).toBe('1');
    expect(await chat.locator('.desk').evaluate(seen)).toBe('1');
    // With a panel already open the orb does not fly: the agent's chat swaps in, and out.
    await orb.click();
    await expect(page.getByTestId('agent-start')).toBeVisible();
    expect(await layer.count()).toBe(0);
    expect(await morph()).toBeNull();
    await page.locator('.card', { hasText: 'Purchases unavailable in production' }).click();
    await expect(chat.locator('.cs-heading h1')).toHaveText('Purchases unavailable in production');
    await chat.getByRole('button', { name: 'Close chat' }).click();
    await expect(chat).toHaveCount(0);
    await atRest();

    // Reduced motion: no flight either way.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await orb.click();
    await expect(page.getByTestId('agent-start')).toBeVisible();
    expect(await layer.count()).toBe(0);
    expect(await morph()).toBeNull();
    expect(await orb.evaluate(seen)).toBe('1');
    await page.keyboard.press('Meta+j');
    expect(await agent.count()).toBe(0);
    expect(await layer.count()).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await closeApp(app);
  }
});

test('a capture detaches, and a playable preview keeps its score across drops, scaling and closing chat', async () => {
  const server = createServer((_req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(
    '<title>Scoreboard</title><style>body{background:#142d26;color:white;font:24px system-ui}button{padding:12px}</style>'
    + '<h1>Score <output>0</output></h1><button onclick="document.querySelector(\'output\').value++">Score a point</button>'));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  const app = await launch();
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1100, 700));
    await page.locator('[data-card-id="demo-codex"]').click();
    await expect(page.locator('.thread')).toBeVisible();
    const capture = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="180" height="300"><rect width="180" height="300" fill="#204736"/><text x="35" y="150" fill="white">Game capture</text></svg>').toString('base64');
    await app.evaluate(({ BrowserWindow }, src) => {
      BrowserWindow.getAllWindows()[0]!.webContents.send('canvas:chat:demo-codex', { op: 'meta', patch: { browserCapture: { id: 'screen', src } } });
    }, 'data:image/svg+xml;base64,' + capture);
    const panel = page.locator('.preview-window');
    // Collapsed until the header's toggle opens it.
    await expect(panel).toHaveCount(0);
    await page.getByRole('complementary', { name: 'Chat panel' }).getByRole('button', { name: 'Preview', exact: true }).click();
    await expect(panel.getByRole('tablist')).toBeHidden();
    await panel.getByRole('button', { name: 'Preview controls' }).click();
    await expect(panel.getByRole('tab', { name: 'Capture' })).toHaveAttribute('aria-selected', 'true');
    await expect(panel.getByRole('img', { name: 'Browser capture' })).toBeVisible();
    const chat = page.getByRole('complementary', { name: 'Chat panel' });
    expect(await chat.locator('.preview-window').count()).toBe(0);

    const area = (await page.locator('.canvas-area').boundingBox())!;
    const drop = async (x: number, y: number) => {
      const h = (await panel.locator('.pv-handle').boundingBox())!;
      await page.mouse.move(h.x + 10, h.y + h.height / 2);
      await page.mouse.down();
      await page.mouse.move(x, y, { steps: 8 });
      await expect(page.locator('.pv-drop-layer')).toBeVisible();
      await page.mouse.up();
    };
    await drop(area.x + 20, area.y + 36);
    await expect(panel).toHaveClass(/pv-left/);
    await expect(panel.getByRole('img')).toBeVisible();
    await panel.getByRole('tab', { name: 'Browser' }).click();
    const address = panel.getByLabel('Address');
    await address.fill(url);
    await address.press('Enter');
    await expect.poll(() => previewPage(app, url)).toMatchObject({ title: 'Scoreboard' });

    // Input reaches the live guest. Its in-memory score detects any reload while the tile moves.
    const score = (click: boolean) => app.evaluate(async ({ webContents }, { url, click }) => {
      const wc = webContents.getAllWebContents().find(w => w.getURL() === url)!;
      if (click) {
        const pt = await wc.executeJavaScript('(() => { const r = document.querySelector("button").getBoundingClientRect(); return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) }; })()');
        wc.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...pt });
        wc.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...pt });
      }
      return wc.executeJavaScript('document.querySelector("output").value') as Promise<string>;
    }, { url, click });
    await score(true);
    await expect.poll(() => score(false)).toBe('1');
    // The explicit canvas destination stays a free tile even when a project fills the viewport.
    await panel.getByRole('combobox', { name: 'Move preview' }).selectOption('canvas');
    await expect(panel).toHaveClass(/pv-canvas/);
    await settled(page);
    const before = (await panel.boundingBox())!;
    const grip = (await panel.getByRole('button', { name: 'Resize preview' }).boundingBox())!;
    await page.mouse.move(grip.x + grip.width - 3, grip.y + grip.height - 3);
    await page.mouse.down();
    await page.mouse.move(grip.x + grip.width + 32, grip.y + grip.height + 26, { steps: 5 });
    await page.mouse.up();
    const after = (await panel.boundingBox())!;
    expect(after.width).toBeGreaterThan(before.width + 18);
    expect(after.height).toBeGreaterThan(before.height + 18);
    await chat.getByRole('button', { name: 'Close chat' }).click();
    await expect(chat).toHaveCount(0);
    await expect(panel).toBeVisible();
    await expect.poll(() => score(false)).toBe('1');
    // The closing chat changes the viewport until its exit has finished.
    await settled(page);
    const initial = (await panel.boundingBox())!;
    await page.locator('.workspace').dispatchEvent('wheel', { deltaX: 55, deltaY: 12 });
    await expect.poll(async () => (await panel.boundingBox())!.x).toBeCloseTo(initial.x - 55, 0);
    await page.locator('.workspace').dispatchEvent('wheel', { deltaY: 8, ctrlKey: true, clientX: initial.x, clientY: initial.y });
    await expect.poll(async () => (await panel.boundingBox())!.width).toBeLessThan(initial.width - 5);
    await expect.poll(async () => (await previewView(app))?.visible).toBe(true);
    // Panning across an edge clips the page without moving its contents or changing its layout viewport.
    const guestSize = () => app.evaluate(({ webContents }, u) => webContents.getAllWebContents()
      .find(w => w.getURL() === u)!.executeJavaScript('[innerWidth, innerHeight]') as Promise<number[]>, url);
    const wholePage = await guestSize();
    await page.locator('.workspace').dispatchEvent('wheel', { deltaX: 190, deltaY: 0 });
    const edge = await page.locator('.workspace').evaluate(el => Math.round(el.getBoundingClientRect().left + el.clientLeft));
    await expect.poll(async () => (await previewView(app))?.bounds.x).toBe(edge);
    const gameFrame = (await panel.locator('.pv-frame').boundingBox())!;
    expect(gameFrame.x).toBeLessThan(edge);
    const visibleWidth = Math.round(gameFrame.x + gameFrame.width - edge);
    expect(visibleWidth).toBeGreaterThan(0);
    await expect.poll(async () => (await previewView(app))!.bounds.width).toBe(visibleWidth);
    expect(await guestSize()).toEqual(wholePage);
    await page.locator('.workspace').dispatchEvent('wheel', { deltaX: 0, deltaY: 170 });
    const clipTop = await page.locator('.workspace').evaluate(el => Math.round(el.getBoundingClientRect().top + el.clientTop));
    await expect.poll(async () => (await previewView(app))?.bounds.y).toBe(clipTop);
    expect(await guestSize()).toEqual(wholePage);
    await page.locator('.workspace').dispatchEvent('wheel', { deltaX: -190, deltaY: -170 });
    await expect.poll(guestSize).toEqual(wholePage);
    expect(await score(false)).toBe('1');
    // Renderer screenshots include the capture. The interactive browser is a separate native surface.
    await panel.getByRole('tab', { name: 'Capture' }).click();
    await page.screenshot({ path: 'e2e/shots/movable-capture-preview.png', scale: 'css' });

    await page.getByRole('button', { name: /Show .* running sessions/ }).click();
    await page.getByLabel('Running sessions', { exact: true }).getByRole('button', { name: /Reconnection dialog/ }).click();
    await expect(panel.locator('.pv-handle')).toHaveAttribute('title', /Codex usage credits analysis/);
    await chat.getByRole('button', { name: 'Full screen' }).click();
    await expect(panel.getByRole('tab', { name: 'Capture' })).toHaveAttribute('aria-selected', 'true');
    await page.getByRole('button', { name: 'Exit full screen' }).click();
    await expect(panel).toHaveClass(/pv-canvas/);
    await chat.getByRole('button', { name: 'Close chat' }).click();
    await panel.getByRole('combobox', { name: 'Move preview' }).selectOption('right');
    await expect(panel).toHaveClass(/pv-right/);
    await panel.getByRole('tab', { name: 'Browser' }).click();
    await expect.poll(async () => (await previewView(app))?.visible).toBe(true);
    await expect.poll(() => score(false)).toBe('1');
    await score(true);
    await expect.poll(() => score(false)).toBe('2');
    await panel.getByRole('button', { name: 'Hide preview' }).click();
    await expect(panel).toHaveCount(0);
    await expect.poll(async () => (await previewView(app))?.visible).toBe(false);
  } finally {
    await closeApp(app);
    server.closeAllConnections();
    server.close();
  }
});

test('board preview: dragged and resized inside its zone, the page stays live and the cards make room', async () => {
  // A "game": a frame counter, a score kept in memory (a reload would zero it) and its viewport.
  const server = createServer((_req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(
    '<title>Board game</title><style>body{margin:0;background:#142d26;color:white;font:20px system-ui}</style>'
    + '<h1>Frames <output id=f>0</output></h1><button onclick="score++">Score</button>'
    + '<script>var score=0,frames=0;(function t(){frames++;f.value=frames;requestAnimationFrame(t)})();setInterval(()=>frames++,16)</script>'));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  const app = await launch();
  try {
    const page = await app.firstWindow();
    await page.locator('[data-card-id="demo-preview"]').click();
    await expect(page.locator('.thread')).toBeVisible();
    // A capture gives the session a preview, opened from the header; its Browser tab then opens the game.
    const capture = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>').toString('base64');
    await app.evaluate(({ BrowserWindow }, src) => {
      BrowserWindow.getAllWindows()[0]!.webContents.send('canvas:chat:demo-preview', { op: 'meta', patch: { browserCapture: { id: 'screen', src } } });
    }, 'data:image/svg+xml;base64,' + capture);
    const panel = page.locator('.preview-window');
    await page.getByRole('complementary', { name: 'Chat panel' }).getByRole('button', { name: 'Preview', exact: true }).click();
    await panel.getByRole('button', { name: 'Preview controls' }).click();
    await panel.getByRole('tab', { name: 'Browser' }).click();
    await panel.getByLabel('Address').fill(url);
    await panel.getByLabel('Address').press('Enter');
    await expect.poll(() => previewPage(app, url), { timeout: 10_000 }).toMatchObject({ title: 'Board game' });
    const guest = (js: string) => app.evaluate(({ webContents }, { url, js }) =>
      webContents.getAllWebContents().find(w => w.getURL() === url)!.executeJavaScript(js), { url, js }) as Promise<number>;
    await guest('score = 7');

    // Onto the board, in the zone of its own session.
    const zoneId = await page.locator('[data-card-id="demo-preview"]').evaluate(el => el.closest<HTMLElement>('.zone')!.dataset.zoneId!);
    const zoneName = await page.locator(`.zone[data-zone-id="${zoneId}"]`).getAttribute('aria-label');
    await panel.getByRole('combobox', { name: 'Add to board' }).selectOption({ label: zoneName! });
    await page.getByRole('complementary', { name: 'Chat panel' }).getByRole('button', { name: 'Close chat' }).click();
    const tile = page.locator(`.zone[data-zone-id="${zoneId}"] .board-tile .pv-board`);
    await expect(tile).toBeVisible();
    await settled(page);
    await expect.poll(async () => (await previewView(app))?.visible).toBe(true);
    const pins = () => page.evaluate(() => JSON.parse(localStorage.getItem('agent-canvas:board-previews') ?? '[]') as { col: number; top: number; width: number; height: number; zone: string }[]);
    await expect.poll(async () => (await pins())[0]).toMatchObject({ zone: zoneId, col: 0, top: 0 });
    const cardsAt = () => page.locator(`.zone[data-zone-id="${zoneId}"] [data-card-id]`).evaluateAll(els => els.map(el => `${el.getAttribute('data-card-id')}@${(el as HTMLElement).offsetLeft},${(el as HTMLElement).offsetTop}`).join(' '));
    const cardsBefore = await cardsAt();

    // Drag it right along the zone: mid-drag it follows the pointer with its native page shown
    // and placed with it, the page keeps running, and the cards re-flow around the slot.
    const k = await page.locator('.board').evaluate(el => new DOMMatrix(getComputedStyle(el).transform).a);
    const handle = (await tile.locator('.pv-handle').boundingBox())!;
    const startView = (await previewView(app))!;
    await page.mouse.move(handle.x + 40, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(handle.x + 40 + 260 * k, handle.y + handle.height / 2 + 30 * k, { steps: 10 });
    await expect(page.locator(`.zone[data-zone-id="${zoneId}"] .board-tile-slot`)).toBeVisible();
    await expect.poll(async () => (await previewView(app))?.bounds.x).toBeGreaterThan(startView.bounds.x + 200 * k);
    expect((await previewView(app))?.visible).toBe(true);
    const f1 = await guest('frames');
    await expect.poll(() => guest('frames')).toBeGreaterThan(f1);
    await expect.poll(cardsAt).not.toBe(cardsBefore);
    await settled(page);
    await page.screenshot({ path: 'e2e/shots/board-preview-dragging.png', scale: 'css' });
    await page.mouse.up();
    await expect.poll(async () => (await pins())[0]!.col).toBe(1);
    await settled(page);
    await expect(page.locator('.board-tile-slot')).toHaveCount(0);
    // It came to rest on its slot, with its page placed over it.
    const rest = (await tile.locator('.pv-frame').boundingBox())!;
    await expect.poll(async () => Math.abs((await previewView(app))!.bounds.x - Math.round(rest.x))).toBeLessThan(3);
    expect(await guest('score')).toBe(7);

    // Resize from the corner: the page's own viewport widens during the drag, not only after.
    const width0 = await guest('innerWidth');
    const grip = (await tile.getByRole('button', { name: 'Resize preview' }).boundingBox())!;
    // The grip's middle: its outer corner lies outside the window's rounded clip at some zooms.
    await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
    await page.mouse.down();
    await page.mouse.move(grip.x + grip.width + 140 * k, grip.y + grip.height + 90 * k, { steps: 8 });
    await expect.poll(() => guest('innerWidth')).toBeGreaterThan(width0 + 100);
    expect((await previewView(app))?.visible).toBe(true);
    await page.mouse.up();
    const saved = (await pins())[0]!;
    expect(saved.width).toBeGreaterThan(390);
    await settled(page);
    await page.screenshot({ path: 'e2e/shots/board-preview-placed.png', scale: 'css' });

    // Slot and size come back with the board.
    await page.reload();
    await expect(page.locator(`.zone[data-zone-id="${zoneId}"] .board-tile .pv-board`)).toBeVisible();
    expect((await pins())[0]).toMatchObject({ col: 1, width: saved.width, height: saved.height });
    expect(await page.locator('.board-tile .pv-board').evaluate(el => (el as HTMLElement).offsetWidth)).toBe(saved.width + 0);

    // Dragged onto another zone it moves there, still the same live page (its score is kept),
    // and its own view follows it. The target is a zone with room in sight, so the page is not
    // simply clipped away at the workspace edge.
    await expect.poll(() => previewPage(app, url), { timeout: 10_000 }).toMatchObject({ title: 'Board game' });
    await guest('score = 9');
    // Fit includes thread notes and the resized preview. Wait for a reachable drop point
    // while the camera travels and the zones settle after reload.
    await page.getByRole('button', { name: 'Fit', exact: true }).click();
    const targetSpot = () => page.evaluate((home) => {
      const ws = document.querySelector('.workspace')!.getBoundingClientRect();
      for (const el of document.querySelectorAll<HTMLElement>('.zone[data-zone-id]')) {
        const id = el.dataset.zoneId!;
        if (id === home) continue;
        const r = el.getBoundingClientRect();
        const x = r.left + r.width / 3;
        const y = r.top + Math.min(40, r.height / 3);
        if (x > ws.left && x < ws.right && y > ws.top && y < ws.bottom - 40 &&
            document.elementFromPoint(x, y)?.closest('.zone') === el) return { id, x, y };
      }
      return null;
    }, zoneId);
    await expect.poll(targetSpot).not.toBeNull();
    await settled(page);
    const spot = (await targetSpot())!;
    const other = page.locator(`.zone[data-zone-id="${spot!.id}"]`);
    const grab = (await page.locator('.board-tile .pv-handle').boundingBox())!;
    await page.mouse.move(grab.x + 40, grab.y + grab.height / 2);
    await page.mouse.down();
    await page.mouse.move(spot!.x, spot!.y, { steps: 10 });
    await expect(other.locator('.board-tile-slot')).toBeVisible();
    await page.mouse.up();
    await expect(other.locator('.board-tile .pv-board')).toBeVisible();
    await expect.poll(async () => (await pins())[0]!.zone).toBe(spot!.id);
    expect(await guest('score')).toBe(9);
    await settled(page);
    await expect.poll(async () => (await previewView(app))?.visible).toBe(true);
    const moved = (await other.locator('.board-tile .pv-frame').boundingBox())!;
    await expect.poll(async () => Math.abs((await previewView(app))!.bounds.x - Math.round(moved.x))).toBeLessThan(3);
  } finally {
    await closeApp(app);
    server.closeAllConnections();
    server.close();
  }
});

test('project explorer: a zone\'s Files button opens its folder on the left, folders open on demand, JSON and images preview, and nothing outside is read', async () => {
  // A real folder stands in for the demo's invented ones (AGENT_CANVAS_DEMO_FILES).
  const base = await mkdtemp(path.join(tmpdir(), 'canvas-explorer-'));
  const root = path.join(base, 'project');
  const secret = path.join(base, 'secret');
  await mkdir(path.join(root, 'src', 'components'), { recursive: true });
  await mkdir(path.join(root, 'assets'), { recursive: true });
  await mkdir(path.join(root, 'node_modules', 'left-pad'), { recursive: true });
  await mkdir(path.join(root, '.git'), { recursive: true });
  await mkdir(secret, { recursive: true });
  await writeFile(path.join(secret, 'key.txt'), 'not for the page');
  await writeFile(path.join(root, '.gitignore'), 'coverage/\n*.log\n');
  await writeFile(path.join(root, 'debug.log'), 'noise');
  await writeFile(path.join(root, 'package.json'), JSON.stringify({
    name: 'sailcloth-io', version: '0.4.2', private: true,
    scripts: { dev: 'vite', build: 'tsc && vite build', test: 'vitest run' },
    dependencies: { react: '^19.3.1', three: '^0.187.0' }, workspaces: ['packages/*'], engines: { node: '>=24' }, sideEffects: false, license: null,
  }, null, 2));
  await writeFile(path.join(root, 'tsconfig.json'), '{\n  // strict everywhere\n  "compilerOptions": { "strict": true, },\n}\n');
  await writeFile(path.join(root, 'broken.json'), '{\n  "name": "sailcloth",\n  "ports": [3000 3001]\n}\n');
  await writeFile(path.join(root, 'src', 'main.ts'), "import { start } from './components/game.ts';\n\nstart(document.body);\n");
  await writeFile(path.join(root, 'src', 'components', 'game.ts'), 'export function start(el: HTMLElement) {\n  el.textContent = "ready";\n}\n');
  await writeFile(path.join(root, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1;\n');
  await copyFile('build/icon.png', path.join(root, 'assets', 'logo.png'));
  await symlink(secret, path.join(root, 'escape'));
  const app = await launch({ AGENT_CANVAS_DEMO_FILES: root });
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(e.message));
    await page.reload();
    await expect(page.locator('article.card')).toHaveCount(11);

    const zone = page.locator('[data-zone-id="folder:sailcloth-io"]');
    const files = zone.getByRole('button', { name: 'Files in sailcloth-io' });
    await zone.locator('.zone-label').hover();
    await files.click();
    const explorer = page.getByRole('complementary', { name: 'Files in sailcloth-io' });
    await expect(explorer).toBeVisible();
    await expect(files).toHaveAttribute('aria-pressed', 'true');
    // Docked left of the canvas, inside the same area.
    const [ex, ws] = [(await explorer.boundingBox())!, (await page.locator('.workspace').boundingBox())!];
    expect(ex.x + ex.width).toBeLessThanOrEqual(ws.x);

    const tree = explorer.getByRole('tree');
    const item = (name: string) => tree.getByRole('treeitem', { name, exact: true });
    await expect(item('src')).toHaveAttribute('aria-expanded', 'false');
    await expect(item('node_modules')).toHaveClass(/is-ignored/);
    await expect(item('debug.log')).toHaveClass(/is-ignored/);
    await expect(item('.git')).toHaveCount(0);
    await expect(item('.gitignore')).toBeVisible();
    // Nothing below the top level is listed until its folder opens.
    await expect(item('main.ts')).toHaveCount(0);
    await item('src').click();
    await expect(item('src')).toHaveAttribute('aria-expanded', 'true');
    await expect(item('main.ts')).toBeVisible();
    await expect(item('components')).toBeVisible();
    await expect(item('game.ts')).toHaveCount(0);

    // JSON: a coloured outline that folds.
    await item('package.json').click();
    const pv = page.getByRole('region', { name: 'Preview of package.json' });
    await expect(pv.locator('.jv-key').first()).toHaveText('"name"');
    await expect(pv.locator('.jv-string').first()).toHaveText('"sailcloth-io"');
    await pv.getByRole('button', { name: 'Fold scripts' }).click();
    await expect(pv.locator('.jv-fold')).toHaveText('3 keys');
    await settled(page);
    await page.screenshot({ path: 'e2e/shots/explorer-json-1440.png' });

    // Invalid JSON: its text, with where it broke.
    await item('broken.json').click();
    const broken = page.getByRole('region', { name: 'Preview of broken.json' });
    await expect(broken.locator('.ex-parse-error')).toContainText('Not valid JSON');
    await expect(broken.locator('.ex-parse-error')).toContainText('line 3');
    await expect(broken.locator('.ex-text')).toContainText('[3000 3001]');
    await settled(page);
    await explorer.screenshot({ path: 'e2e/shots/explorer-json-invalid.png' });

    // An image, with its pixel size and file size.
    await item('assets').click();
    await item('logo.png').click();
    const image = page.getByRole('region', { name: 'Preview of logo.png' });
    await expect(image.locator('img')).toBeVisible();
    await expect(image.locator('.ex-image-facts')).toContainText(/\d+ × \d+ px/);
    await expect(image.locator('.ex-image-facts')).toContainText('KB');
    await settled(page);
    await page.screenshot({ path: 'e2e/shots/explorer-image-1440.png' });

    // A link out of the project is listed but never opened; the bridge refuses climbing out too.
    await expect(tree.locator('[data-path="escape"]')).toHaveAttribute('aria-disabled', 'true');
    const rootPath = await explorer.locator('.ex-root').getAttribute('title');
    const refusals = await page.evaluate(async (r) => {
      const tries = [() => window.canvas!.listFiles(r!, '..'), () => window.canvas!.listFiles(r!, 'escape'),
        () => window.canvas!.previewFile(r!, 'escape/key.txt'), () => window.canvas!.listFiles('/etc', ''), () => window.canvas!.previewFile('/', 'etc/hosts')];
      return Promise.all(tries.map((t) => t().then(() => 'read', (e: Error) => e.message)));
    }, rootPath);
    expect(refusals.every((m) => m !== 'read')).toBe(true);
    expect(refusals[1]).toContain('outside the project');

    // Beside a chat at the smallest window: the explorer left, the chat right, the canvas between.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1100, 700));
    await page.locator('.card', { hasText: 'Purchases unavailable in production' }).click();
    const chat = page.locator('.chat-screen.is-panel');
    await expect(chat).toBeVisible();
    await settled(page);
    const [ex2, ws2, chat2] = [(await explorer.boundingBox())!, (await page.locator('.workspace').boundingBox())!, (await chat.boundingBox())!];
    expect(ex2.x + ex2.width).toBeLessThanOrEqual(ws2.x);
    expect(ws2.x + ws2.width).toBeLessThanOrEqual(chat2.x);
    expect(ws2.width).toBeGreaterThanOrEqual(300);
    // The image shrinks to fit; its size line stays in view at the smallest window.
    await expect(image.locator('.ex-image-facts')).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: 'e2e/shots/explorer-with-chat-1100.png' });

    // Esc in the explorer closes the preview, then the explorer; focus goes back to the button.
    await item('logo.png').focus();
    await page.keyboard.press('Escape');
    await expect(image).toHaveCount(0);
    await expect(chat).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(explorer).toHaveCount(0);
    await expect(chat).toBeVisible();
    await expect(files).toBeFocused();
    // The button again opens it, and once more closes it.
    await files.click();
    await expect(explorer).toBeVisible();
    await files.click();
    await expect(explorer).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await closeApp(app);
    await rm(base, { recursive: true, force: true });
  }
});

test('project explorer: Git opens on a frame that stays put, comes back with the status it last showed, and the explorer arrives only once', async () => {
  // A real repository with a few changes stands in for the demo's invented folders.
  const base = await mkdtemp(path.join(tmpdir(), 'canvas-git-'));
  const root = path.join(base, 'project');
  const git = (...args: string[]) => execFileSync('/usr/bin/git', ['-c', 'user.name=Canvas', '-c', 'user.email=canvas@example.com', ...args], { cwd: root });
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'README.md'), '# Sailcloth\n');
  await writeFile(path.join(root, 'src', 'main.ts'), 'start();\n');
  await writeFile(path.join(root, 'src', 'old.ts'), 'export const old = 1;\n');
  git('init', '-q', '-b', 'main'); git('add', '.'); git('commit', '-q', '-m', 'first');
  await writeFile(path.join(root, 'README.md'), '# Sailcloth\n\nA naval game.\n');
  await writeFile(path.join(root, 'src', 'main.ts'), 'start();\nscore();\n');
  await rm(path.join(root, 'src', 'old.ts'));
  await writeFile(path.join(root, 'notes.txt'), 'todo\n');
  const app = await launch({ AGENT_CANVAS_DEMO_FILES: root });
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(e.message));
    await page.reload();
    await expect(page.locator('article.card')).toHaveCount(11);

    const zone = page.locator('[data-zone-id="folder:sailcloth-io"]');
    await zone.locator('.zone-label').hover();
    await zone.getByRole('button', { name: 'Files in sailcloth-io' }).click();
    const explorer = page.locator('aside.explorer');
    await expect(explorer).toBeVisible();
    // Once it has opened it is simply there: no entrance starts again when "opening" ends.
    const replayed = await page.evaluate(async () => {
      const shell = document.querySelector('.app')!;
      while (shell.classList.contains('is-explorer-opening')) await new Promise((r) => requestAnimationFrame(r));
      await new Promise((r) => requestAnimationFrame(r));
      return document.querySelector('aside.explorer')!.getAnimations().filter((a) => a.playState === 'running').map((a) => (a as CSSAnimation).animationName);
    });
    expect(replayed).toEqual([]);

    // Git: the composer is in place from the start, and the rows arrive in it.
    const [filesTab, gitTab] = [explorer.getByRole('tab', { name: 'Files' }), explorer.getByRole('tab', { name: 'Git' })];
    await gitTab.click();
    const panel = explorer.locator('.git-panel');
    await expect(panel.getByRole('textbox', { name: 'Commit message' })).toBeVisible();
    const row = explorer.getByRole('button', { name: 'View diff for src/main.ts' });
    await expect(row).toBeVisible();
    await expect(panel).toHaveAttribute('aria-busy', 'false');
    await settled(page);
    const composer = (await panel.locator('.git-compose').boundingBox())!;
    await page.screenshot({ path: 'e2e/shots/explorer-git-1440.png' });

    // A diff takes its share under the list; another file's takes the same place.
    await row.click();
    const diff = explorer.getByRole('region', { name: 'Diff for src/main.ts' });
    await expect(diff.locator('.git-patches')).toContainText('score();');
    await settled(page);
    const first = (await diff.boundingBox())!;
    await explorer.getByRole('button', { name: 'View diff for notes.txt' }).click();
    const second = explorer.getByRole('region', { name: 'Diff for notes.txt' });
    await expect(second.locator('.git-patches')).toContainText('todo');
    expect((await second.boundingBox())!.y).toBe(first.y);
    expect((await panel.locator('.git-compose').boundingBox())!.y).toBe(composer.y);
    await explorer.screenshot({ path: 'e2e/shots/explorer-git-diff.png' });

    // Files and back: the tab is drawn afresh, with the status it last showed there at once.
    await filesTab.click();
    await expect(explorer.getByRole('tree')).toBeVisible();
    await gitTab.click();
    expect(await explorer.locator('.git-file').count()).toBe(4);
    await settled(page);
    expect((await panel.locator('.git-compose').boundingBox())!.y).toBe(composer.y);
    expect(errors).toEqual([]);
  } finally {
    await closeApp(app);
    await rm(base, { recursive: true, force: true });
  }
});

test('preview on the board: ⌘ wheel and ⌘= over its page zoom the canvas, never the page; a plain wheel scrolls the page', async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      .end('<!doctype html><title>Zoom page</title><body style="margin:0;height:4000px"><h1>Zoom page</h1></body>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  const app = await launch();
  try {
    const page = await app.firstWindow();
    await page.locator('[data-card-id="demo-purchases"]').waitFor();
    const zone = await page.locator('[data-card-id="demo-purchases"]').evaluate((el) => el.closest('[data-zone-id]')!.getAttribute('data-zone-id'));
    await page.evaluate(({ zone, url }) => {
      localStorage.setItem('agent-canvas:view', JSON.stringify({ x: 0, y: 0, k: 1 }));
      localStorage.setItem('agent-canvas:board-previews', JSON.stringify([
        { session: 'demo-purchases', zone, title: 'Zoom page', tab: 'browser', address: url, width: 640, height: 420, open: true },
      ]));
    }, { zone, url });
    await page.reload();
    await expect.poll(async () => (await previewView(app))?.visible ?? false, { timeout: 10_000 }).toBe(true);
    await expect.poll(() => previewPage(app, url).then((p) => p?.title ?? null)).toBe('Zoom page');
    await settled(page);

    const zoomLabel = () => page.locator('.tool.mono[title="Reset zoom to 100%"]').getAttribute('aria-label');
    const canvasK = () => page.evaluate(() => (JSON.parse(localStorage.getItem('agent-canvas:view') ?? '{}') as { k?: number }).k ?? null);
    /** Real input to the preview's page, at a point inside it; and what the page saw. */
    const guest = <T,>(fn: string, arg?: unknown) => app.evaluate(async ({ webContents }, { u, fn, arg }) => {
      const wc = webContents.getAllWebContents().find((w) => !w.isDestroyed() && w.getURL() === u)!;
      if (fn === 'state') return await wc.executeJavaScript('({ scrollY, scale: visualViewport.scale })');
      if (fn === 'zoom') return wc.getZoomFactor();
      wc.sendInputEvent(arg as Parameters<typeof wc.sendInputEvent>[0]);
      return null;
    }, { u: url, fn, arg }) as Promise<T>;
    const before = await zoomLabel();
    const pageZoom = await guest<number>('zoom');

    // ⌘ + wheel over the page: the canvas zooms in; the page neither scrolls nor zooms.
    // One notch (a step of about 28%), leaving room under the 200% cap for ⌘= below.
    await guest('send', { type: 'mouseWheel', x: 200, y: 150, deltaX: 0, deltaY: 120, modifiers: ['meta'], canScroll: true });
    await expect.poll(zoomLabel).not.toBe(before);
    await expect.poll(canvasK).toBeGreaterThan(1);
    expect(await guest('state')).toEqual({ scrollY: 0, scale: 1 });
    // The page's zoom is only the canvas's (the board draws it at the canvas's scale), never its own.
    const k = (await canvasK())!;
    await expect.poll(() => guest<number>('zoom')).toBeCloseTo(pageZoom * k, 2);

    // A plain wheel scrolls the page and leaves the canvas where it is.
    const zoomed = await zoomLabel();
    await guest('send', { type: 'mouseWheel', x: 200, y: 150, deltaX: 0, deltaY: -240, canScroll: true });
    await expect.poll(() => guest<{ scrollY: number }>('state').then((s) => s.scrollY)).toBeGreaterThan(0);
    expect(await zoomLabel()).toBe(zoomed);

    // ⌘= and ⌘0 with the page focused zoom the canvas, not the page.
    await guest('send', { type: 'mouseDown', x: 200, y: 150, button: 'left', clickCount: 1 });
    await guest('send', { type: 'mouseUp', x: 200, y: 150, button: 'left', clickCount: 1 });
    await guest('send', { type: 'keyDown', keyCode: '=', modifiers: ['meta'] });
    await expect.poll(canvasK).toBeGreaterThan(k * 1.1);
    await guest('send', { type: 'keyDown', keyCode: '0', modifiers: ['meta'] });
    await expect.poll(canvasK).toBe(1);
    expect((await guest<{ scale: number }>('state')).scale).toBe(1);
  } finally {
    await closeApp(app);
    server.close();
  }
});

test('profile: usage shows the overhead of the canvas agent and orchestrators against work, by period', async () => {
  const app = await launch();
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(e.message));
    await page.reload();
    await expect(page.locator('article.card')).toHaveCount(11);
    await page.locator('.topbar').getByRole('button', { name: 'Profile and usage' }).click();
    const usage = page.getByRole('dialog', { name: 'Profile' }).getByRole('region', { name: 'Usage' });
    await expect(usage.locator('.us-headline')).toHaveText(/^Agent canvas overhead: [\d.]+[KMB]? tokens \(≈ \$[\d.,]+ · [\d.]+% of all usage\) in the last 7 days$/);
    await expect(usage.locator('.us-chart path.us-bar.is-work')).toHaveCount(7);
    await expect(usage.getByRole('rowheader', { name: /^Orchestrator · storefront/ })).toBeVisible();
    await page.waitForTimeout(400);
    await page.screenshot({ path: 'e2e/shots/usage-dialog-1440.png' });
    await usage.scrollIntoViewIfNeeded();
    await usage.screenshot({ path: 'e2e/shots/usage-7d.png' });

    // A bar's hover names its day and both costs.
    const bar = usage.locator('.us-chart path.us-bar.is-work').nth(5);
    await bar.hover();
    await expect(usage.locator('.us-tip')).toContainText(/overhead/);
    await usage.locator('.us-chart').screenshot({ path: 'e2e/shots/usage-hover.png' });

    await usage.getByLabel('Usage period').selectOption('30d');
    await expect(usage.locator('.us-headline')).toHaveText(/in the last 30 days$/);
    await expect(usage.locator('.us-chart path.us-bar.is-work')).toHaveCount(30);
    await page.mouse.move(0, 0);
    await usage.screenshot({ path: 'e2e/shots/usage-30d.png' });
    expect(errors).toEqual([]);
  } finally {
    await closeApp(app);
  }
});

test('board images: dropped on a zone from outside, dragged in from the explorer, pasted; moved, resized, opened, attached to a chat, found by search, removed and undone, and kept on reload', async () => {
  const { readFile } = await import('node:fs/promises');
  const base = await mkdtemp(path.join(tmpdir(), 'canvas-board-images-'));
  const root = path.join(base, 'project');
  await mkdir(path.join(root, 'assets'), { recursive: true });
  await copyFile('build/icon.png', path.join(root, 'assets', 'logo.png'));
  const png = (await readFile('build/icon.png')).toString('base64');
  const app = await launch({ AGENT_CANVAS_DEMO_FILES: root });
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(e.message));
    await page.reload();
    const zone = page.locator('[data-zone-id="folder:sailcloth-io"]');
    await expect(zone.locator('article.card').first()).toBeVisible();
    const images = page.locator('.board-image');
    /** Every image on the board has been drawn (its picture loaded, not a placeholder). */
    const allDrawn = () => page.evaluate(() => [...document.querySelectorAll<HTMLImageElement>('.board-image img')].every((i) => i.complete && i.naturalWidth > 0));

    // 1. A file dropped from Finder onto a zone: the zone is ringed while it is over it, and the image joins it.
    const zb = (await zone.boundingBox())!;
    const dropAt = { x: zb.x + zb.width / 2, y: zb.y + zb.height / 2 };
    await page.evaluate(({ b64, x, y }) => {
      const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
      const data = new DataTransfer();
      data.items.add(new File([bytes], 'mockup.png', { type: 'image/png' }));
      const target = document.elementFromPoint(x, y)!;
      target.dispatchEvent(new DragEvent('dragover', { dataTransfer: data, clientX: x, clientY: y, bubbles: true, cancelable: true }));
      (window as unknown as { dropData: DataTransfer }).dropData = data;
    }, { b64: png, ...dropAt });
    await expect(zone).toHaveClass(/is-drop/);
    await page.evaluate(({ x, y }) => {
      const data = (window as unknown as { dropData: DataTransfer }).dropData;
      document.elementFromPoint(x, y)!.dispatchEvent(new DragEvent('drop', { dataTransfer: data, clientX: x, clientY: y, bubbles: true, cancelable: true }));
    }, dropAt);
    await expect(zone).not.toHaveClass(/is-drop/);
    const mockup = zone.getByRole('group', { name: 'mockup.png' });
    await expect(mockup).toBeVisible();
    // Square like the picture, one card column wide; the zone's cards make room for it.
    await settled(page);
    const mb = (await mockup.boundingBox())!;
    expect(Math.abs(mb.width - mb.height)).toBeLessThan(2);
    const overlaps = await page.evaluate(() => {
      const tile = document.querySelector('.zone .board-image')!;
      const img = tile.getBoundingClientRect();
      return [...tile.closest('.zone')!.querySelectorAll('.card')].some((c) => {
        const r = c.getBoundingClientRect();
        return r.left < img.right && img.left < r.right && r.top < img.bottom && img.top < r.bottom;
      });
    });
    expect(overlaps).toBe(false);

    // 2. An image file dragged from the project explorer onto empty canvas: free, shown by its path.
    await zone.locator('.zone-label').hover();
    await zone.getByRole('button', { name: 'Files in sailcloth-io' }).click();
    const explorer = page.getByRole('complementary', { name: 'Files in sailcloth-io' });
    await explorer.getByRole('treeitem', { name: 'assets' }).click();
    const row = explorer.getByRole('treeitem', { name: 'logo.png' });
    await expect(row).toHaveAttribute('draggable', 'true');
    const ws = (await page.locator('.workspace').boundingBox())!;
    /** A point on bare canvas, clear of zones, panels and bars by `room` px, scanning from the lower left. */
    const bare = (room: number) => page.evaluate((room) => {
      const w = document.querySelector('.workspace')!.getBoundingClientRect();
      const blocked = (x: number, y: number) => [[0, 0], [-room, -room], [room, -room], [-room, room], [room, room]].some(([dx, dy]) => {
        const el = document.elementFromPoint(x + dx!, y + dy!);
        return !el || !!el.closest('.zone, aside, header, [role="dialog"], .board-image, button, .chat-screen');
      });
      for (let y = w.bottom - room - 20; y > w.top + room; y -= 20) {
        for (let x = w.left + room + 20; x < w.right - room; x += 20) if (!blocked(x, y)) return { x: x - w.left, y: y - w.top };
      }
      return null;
    }, room);
    const spot = (await bare(180))!;
    expect(spot).not.toBeNull();
    await row.dragTo(page.locator('.workspace'), { targetPosition: spot });
    const logo = page.locator('.board-item-free').getByRole('group', { name: 'logo.png' });
    await expect(logo).toBeVisible();
    await expect.poll(allDrawn).toBe(true);
    expect(await logo.getAttribute('title')).toMatch(/\/assets\/logo\.png$/);
    await page.keyboard.press('Escape');
    await expect(explorer).toHaveCount(0);

    // Resize by the corner keeps the shape; Shift frees it.
    await logo.hover();
    const lb = (await logo.boundingBox())!;
    const grip = logo.locator('.bi-resize');
    const gb = (await grip.boundingBox())!;
    await page.mouse.move(gb.x + gb.width / 2, gb.y + gb.height / 2);
    await page.mouse.down();
    await page.mouse.move(gb.x + 60, gb.y + 10, { steps: 4 });
    await page.mouse.up();
    const lb2 = (await logo.boundingBox())!;
    expect(lb2.width).toBeGreaterThan(lb.width + 40);
    expect(Math.abs(lb2.width - lb2.height)).toBeLessThan(2);

    // Moved by hand into the zone: it leaves the free layer and joins the zone.
    await page.mouse.move(lb2.x + lb2.width / 2, lb2.y + lb2.height / 3);
    await page.mouse.down();
    // Aimed by its label (lower down, a neighbouring zone may have grown over it), measured again
    // while in the hand, since the zones settle as the image leaves its place.
    await expect(async () => {
      const zb2 = (await zone.boundingBox())!;
      await page.mouse.move(zb2.x + zb2.width / 2, zb2.y + 24, { steps: 4 });
      await expect(zone.locator('.board-item-slot')).toHaveCount(1, { timeout: 600 });
    }).toPass({ timeout: 8000 });
    await page.mouse.up();
    await expect(zone.getByRole('group', { name: 'logo.png' })).toBeVisible();
    await expect(page.locator('.board-item-free').getByRole('group', { name: 'logo.png' })).toHaveCount(0);
    // 3. ⌘V on the canvas: a pasted image lands under the pointer.
    await settled(page);
    const spot2 = (await bare(130))!;
    await page.mouse.move(ws.x + spot2.x, ws.y + spot2.y);
    await page.evaluate((b64) => {
      const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
      const data = new DataTransfer();
      data.items.add(new File([bytes], 'clipboard.png', { type: 'image/png' }));
      document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    }, png);
    await expect(images).toHaveCount(3);
    const pasted = page.locator('.board-item-free').getByRole('group', { name: 'clipboard.png' });
    await expect(pasted).toBeVisible();
    await expect.poll(allDrawn).toBe(true);

    await settled(page);
    await page.screenshot({ path: 'e2e/shots/board-images-1440.png' });

    // Double-click opens it full size in the image viewer; Esc closes only the viewer.
    await pasted.dblclick();
    const viewer = page.getByRole('dialog', { name: 'Image' });
    await expect(viewer).toBeVisible();
    await expect.poll(() => viewer.locator('img').evaluate((i: HTMLImageElement) => i.naturalWidth)).toBe(1024);
    await page.keyboard.press('Escape');
    await expect(viewer).toHaveCount(0);

    // A caption, and ⌘K finds the image by it.
    await pasted.hover();
    await pasted.getByRole('button', { name: 'Add a caption to clipboard.png' }).click();
    await page.getByRole('textbox', { name: 'Caption' }).fill('Landing hero');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('group', { name: 'clipboard.png: Landing hero' })).toBeVisible();
    await page.keyboard.press('Meta+K');
    await page.getByRole('combobox', { name: 'Search zones and sessions' }).fill('hero');
    await expect(page.getByRole('option', { name: /Landing hero/ })).toBeVisible();
    await expect(page.getByRole('group', { name: 'mockup.png' })).toHaveCSS('opacity', '0.26');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('group', { name: 'clipboard.png: Landing hero' })).toBeFocused();

    // Delete takes it off; Undo (⌘Z) brings it back.
    await page.keyboard.press('Delete');
    await expect(images).toHaveCount(2);
    await expect(page.getByRole('status').filter({ hasText: 'Image removed' })).toBeVisible();
    await page.keyboard.press('Meta+z');
    await expect(images).toHaveCount(3);
    await expect(page.getByRole('group', { name: 'clipboard.png: Landing hero' })).toBeVisible();

    // Kept on reload: all three, in their places, captions and all.
    await page.reload();
    await expect(images).toHaveCount(3);
    await expect(zone.getByRole('group', { name: 'mockup.png' })).toBeVisible();
    await expect(zone.getByRole('group', { name: 'logo.png' })).toBeVisible();
    await expect(page.locator('.board-item-free').getByRole('group', { name: 'clipboard.png: Landing hero' })).toBeVisible();
    await expect.poll(allDrawn).toBe(true);

    // Board items can grow the zone. Frame it before clicking the first chat.
    await page.getByRole('button', { name: 'Fit', exact: true }).click();
    await settled(page);
    await page.locator('article.card').first().click();
    const chat = page.locator('.chat-screen');
    await expect(chat.locator('.composer')).toBeVisible();
    const free = page.locator('.board-item-free').getByRole('group', { name: 'clipboard.png: Landing hero' });
    await free.scrollIntoViewIfNeeded().catch(() => {});
    const fb = (await free.boundingBox())!;
    const cb = (await chat.locator('.composer').boundingBox())!;
    await page.mouse.move(fb.x + fb.width / 2, fb.y + fb.height / 3);
    await page.mouse.down();
    await page.mouse.move(cb.x + cb.width / 2, cb.y + cb.height / 2, { steps: 10 });
    await expect(chat.locator('.composer')).toHaveClass(/is-board-drop/);
    await page.mouse.up();
    await expect(chat.getByRole('list', { name: 'Images to send' }).getByRole('button', { name: 'View image 1' })).toBeVisible();
    // It stays on the board where it was.
    await expect(images).toHaveCount(3);
    expect(errors).toEqual([]);
  } finally {
    await closeApp(app);
    await rm(base, { recursive: true, force: true });
  }
});

test('an interrupted session: a calm red card with a "!" dot, and Abort or Continue at the end of its chat', async () => {
  const app = await launch({}, '--demo=large');
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    // demo-large-3 hit a usage limit that resets in two hours; demo-large-5 was cut off mid-turn.
    const limitCard = page.locator('.card[data-card-id="demo-large-3"]');
    const cutCard = page.locator('.card[data-card-id="demo-large-5"]');
    await expect(limitCard).toHaveClass(/is-interrupted/);
    await expect(limitCard.locator('.request-state')).toContainText(/Limit hit · resets \d\d:\d\d/);
    await expect(limitCard.locator('.request-state')).toHaveAttribute('title', "You've hit your 5-hour limit · resets 9pm");
    await expect(limitCard.locator('.alert-dot')).toHaveText('!');
    await expect(cutCard.locator('.request-state')).toHaveText(/Cut off/);
    // Calm: a red hairline, no glow, ring or side stripe.
    const look = await limitCard.evaluate((el) => {
      const cs = getComputedStyle(el);
      const before = getComputedStyle(el, '::before');
      return { left: cs.borderLeftWidth, top: cs.borderTopWidth, leftColor: cs.borderLeftColor, topColor: cs.borderTopColor, glow: before.content === 'none' ? 'none' : before.boxShadow };
    });
    expect(look.left).toBe(look.top);
    expect(look.leftColor).toBe(look.topColor);
    expect(look.glow).toBe('none');
    await settled(page);
    await limitCard.scrollIntoViewIfNeeded();
    await limitCard.screenshot({ path: 'e2e/shots/interrupted-card.png' });

    // Its chat ends on a red "Limit hit" divider (not Done) and the banner; Continue waits for the reset.
    await limitCard.focus();
    await page.keyboard.press('Enter');
    const banner = page.locator('.cs-banner.is-interrupted');
    await expect(banner).toContainText(/Limit hit · resets \d{2}:\d{2} · in /);
    await expect(page.locator('.t-done.is-interrupted')).toContainText('Limit hit · resets');
    await expect(page.locator('.t-done:not(.is-interrupted):not(.is-stopped)')).toHaveCount(0);
    await expect(banner.getByRole('button', { name: /^Continue in / })).toBeDisabled();
    await settled(page);
    await page.locator('.chat-screen').screenshot({ path: 'e2e/shots/interrupted-chat.png' });

    // Abort: a normal idle card, nothing sent; Undo brings it back.
    await banner.getByRole('button', { name: 'Abort' }).click();
    await expect(banner).toHaveCount(0);
    await expect(limitCard).not.toHaveClass(/is-interrupted/);
    await expect(limitCard).toHaveClass(/is-idle/);
    await expect(page.locator('.thread .t-you')).toHaveCount(1);
    await page.locator('.cs-banner.is-dismissed').getByRole('button', { name: 'Undo' }).click();
    await expect(limitCard).toHaveClass(/is-interrupted/);
    await expect(banner).toBeVisible();
    // Esc on the focused banner aborts, as on a permission card.
    await banner.focus();
    await page.keyboard.press('Escape');
    await expect(limitCard).not.toHaveClass(/is-interrupted/);

    // Cut off: Enter on the focused banner continues, through the usual send, and the card works again.
    await cutCard.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.t-done.is-interrupted')).toContainText('Cut off');
    await expect(banner).toContainText('Cut off mid-turn');
    await banner.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.thread .t-you').last()).toContainText('Your previous turn was interrupted (its process ended mid-turn). Continue where you left off.');
    await expect(banner).toHaveCount(0);
    await expect(cutCard).toHaveClass(/is-working/);
    expect(errors).toEqual([]);
  } finally {
    await closeApp(app);
  }
});

test('model policy: only allowed pairs, owner changes affect the launch picker', async () => {
  const app = await launch({ AGENT_CANVAS_DEMO_MODEL_POLICY: '1' });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1100, 700));
    await page.getByRole('button', { name: 'Profile and usage' }).click();
    const claude = page.getByRole('region', { name: 'Claude model settings' });
    const codex = page.getByRole('region', { name: 'Codex model settings' });
    await expect(claude.getByRole('combobox')).toHaveValue('claude-opus-5-5|high');
    await expect(codex.getByRole('combobox')).toHaveValue('gpt-6.2-astra|high');
    await expect(claude.getByRole('option')).toHaveText(['Opus 5.5 High', 'Opus 5.5 Medium', 'Fable 5.2 Medium', 'Fable 5.2 High']);
    await expect(codex.getByRole('option')).toHaveText(['Astra 6.2 High', 'Sol 6.2 High']);
    await expect(claude.getByRole('button', { name: /Fable 5.5/ })).toHaveCount(0);
    await claude.getByRole('button', { name: 'Remove Opus 5.5 Medium', exact: true }).click();
    await expect(claude.getByRole('option')).toHaveText(['Opus 5.5 High', 'Fable 5.2 Medium', 'Fable 5.2 High']);
    await expect.poll(() => page.evaluate(async () => (await window.canvas!.getSettings()).modelPermissions?.claude)).toEqual(['claude-opus-5-5|high', 'claude-fable-5-2|medium', 'claude-fable-5-2|high']);
    // Add a pair: the inline picker offers the model's own thinking levels, and the default menu lists it.
    await claude.getByRole('button', { name: 'Add model' }).click();
    await claude.getByRole('combobox', { name: 'Claude model to add' }).selectOption('claude-sonnet-5-5');
    await claude.getByRole('combobox', { name: 'Thinking level to add' }).selectOption('low');
    await settled(page);
    await claude.screenshot({ path: 'e2e/shots/model-policy-add.png' });
    await claude.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(claude.getByRole('combobox', { name: 'Claude default model and thinking' }).getByRole('option'))
      .toHaveText(['Opus 5.5 High', 'Fable 5.2 Medium', 'Fable 5.2 High', 'Sonnet 5.5 Low']);
    await expect(claude.getByRole('button', { name: 'Add model' })).toBeVisible();
    await claude.scrollIntoViewIfNeeded();
    await settled(page);
    await page.screenshot({ path: 'e2e/shots/model-policy.png' });
  } finally {
    await closeApp(app);
  }
});

test('permissions onboarding dismisses persistently and opens from Profile', async () => {
  const app = await launch({ AGENT_CANVAS_DEMO_PERMISSIONS: JSON.stringify({ notifications: 'not-asked' }) });
  try {
    const page = await app.firstWindow();
    const sheet = page.getByRole('dialog', { name: 'Permissions and agent setup' });
    await expect(sheet).toBeVisible();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1100, 700));
    await settled(page);
    await sheet.screenshot({ path: 'e2e/shots/permissions.png', animations: 'disabled' });
    await sheet.getByRole('button', { name: 'Skip for now' }).click();
    await expect(sheet).toHaveCount(0);
    await page.reload();
    const review = async () => {
      await page.getByRole('button', { name: 'Profile and usage' }).click();
      await page.getByRole('button', { name: 'Review permissions' }).click();
      await expect(sheet).toBeVisible();
    };
    await review();
    await sheet.getByRole('button', { name: 'Allow notifications' }).click();
    await expect(sheet.getByText('Allowed', { exact: true })).toBeVisible();
    await sheet.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(sheet).toHaveCount(0);
    // Remove the dismissal so only the granted status can keep onboarding closed.
    await page.evaluate(() => localStorage.removeItem('agent-canvas:permissions-sheet'));
    await page.reload();
    await review();
    await sheet.getByRole('button', { name: 'Don’t show again' }).click();
    await expect(sheet).toHaveCount(0);
  } finally { await closeApp(app); }
});
