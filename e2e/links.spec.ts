// Links between sessions in the demo app (docs/links.md): drag a link from one card's port onto
// another, queue a prompt, see the line, and watch the next session start once the first finishes.
// AGENT_CANVAS_DEMO_TURNS lets the demo's scripted turns move the cards, as real sessions would.
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';

const launch = (): Promise<ElectronApplication> =>
  electron.launch({ args: ['dist-electron/main.js', '--demo'], env: { ...process.env, AGENT_CANVAS_HIDDEN: '1', AGENT_CANVAS_DEMO_TURNS: '1' } as Record<string, string> });

const settled = (page: Page): Promise<void> => page.evaluate(async () => {
  const finite = document.getAnimations().filter((a) => Number.isFinite(a.effect?.getComputedTiming().endTime as number));
  await Promise.allSettled(finite.map((a) => a.finished));
});

async function closeApp(app: ElectronApplication): Promise<void> {
  const proc = app.process();
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  const closed = new Promise<void>((resolve) => proc.once('exit', () => resolve()));
  proc.kill('SIGTERM');
  const deadline = setTimeout(() => proc.kill('SIGKILL'), 12_000);
  try { await closed; } finally { clearTimeout(deadline); }
}

test('links: drag a link between cards, the line shows the wait, and finishing the first starts the next', async () => {
  const app = await launch();
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(e.message));
    await page.reload();
    await expect(page.locator('article.card')).toHaveCount(11);
    await settled(page);

    // Hostly waits on its approval; Dashboard as MCP is idle, in another zone.
    const a = page.locator('.card[data-card-id="demo-hostly"]');
    const b = page.locator('.card[data-card-id="demo-mcp"]');
    await a.hover();
    const port = page.locator('.link-port');
    await expect(port).toBeVisible();
    const p = (await port.boundingBox())!;
    const t = (await b.boundingBox())!;
    await page.mouse.move(p.x + p.width / 2, p.y + p.height / 2);
    await page.mouse.down();
    await page.mouse.move(t.x + t.width / 2, t.y + t.height / 2, { steps: 12 });
    await expect(b).toHaveClass(/is-link-target/);
    await expect(page.locator('.link-temp')).toHaveCount(1);
    await page.mouse.up();

    const dialog = page.getByRole('dialog', { name: /Run “Dashboard as MCP” after/ });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('checkbox', { name: /Enable account deletion approvals on Hostly/ })).toBeChecked();
    const prompt = dialog.getByRole('textbox', { name: 'Then send' });
    await expect(prompt).toBeFocused();
    await prompt.fill('Wire the new approvals into the dashboard');
    await settled(page);
    await page.screenshot({ path: 'e2e/shots/links-dialog.png' });
    await dialog.getByRole('button', { name: 'Run after' }).click();
    await expect(dialog).toBeHidden();

    // The line from A to B, dashed while it waits, and B says what it waits for.
    const line = page.locator('g.link-line[data-from="demo-hostly"][data-to="demo-mcp"]');
    await expect(line).toHaveCount(1);
    await expect(line).toHaveAttribute('data-state', 'pending');
    await expect(line.locator('.link-path')).toHaveAttribute('d', /^M[\d.-]+ [\d.-]+C/);
    await expect(b).toHaveClass(/is-waiting/);
    await expect(b.locator('.link-wait')).toContainText('Waiting for Enable account deletion approvals on Hostly');
    await expect(b.locator('.link-wait')).toHaveAttribute('title', /Queued prompt:\nWire the new approvals into the dashboard/);
    await page.mouse.move(0, 0);
    await settled(page);
    await page.screenshot({ path: 'e2e/shots/links-waiting.png' });

    // Approving A lets its turn finish; B then gets the queued prompt by itself.
    await a.click();
    const screen = page.locator('.chat-screen');
    await screen.locator('.t-ask').getByRole('button', { name: 'Allow', exact: true }).click();
    await expect(screen.locator('.t-reply', { hasText: 'All 42 tests pass' })).toBeVisible({ timeout: 10_000 });
    await expect(line).toHaveAttribute('data-state', 'started', { timeout: 15_000 });
    await expect(b).toHaveClass(/is-working|is-needs|is-done/, { timeout: 10_000 });
    await expect(b).not.toHaveClass(/is-waiting/);
    await expect(b.locator('.link-wait')).toHaveCount(0);
    await screen.getByRole('button', { name: 'Close chat' }).click();
    await settled(page);
    await page.screenshot({ path: 'e2e/shots/links-started.png' });

    expect(errors).toEqual([]);
  } finally {
    await closeApp(app);
  }
});

test('links: a card menu queues a prompt with "Run after…", and Remove the wait takes it away', async () => {
  const app = await launch();
  try {
    const page = await app.firstWindow();
    await expect(page.locator('article.card')).toHaveCount(11);
    const b = page.locator('.card[data-card-id="demo-3d"]');
    await b.click({ button: 'right' });
    const menu = page.getByRole('menu', { name: /Agent setup 3D graph visualization actions/ });
    await expect(menu).toBeVisible();
    await menu.getByRole('menuitem', { name: 'Run after…' }).click();
    const dialog = page.getByRole('dialog', { name: /Run “Agent setup 3D graph visualization” after/ });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('searchbox', { name: 'Find a session to wait for' }).fill('reconnection');
    await dialog.getByRole('checkbox', { name: /Reconnection dialog/ }).check();
    await dialog.getByRole('textbox', { name: 'Then send' }).fill('Check the graph after the reconnect fix');
    await dialog.getByRole('button', { name: 'Run after' }).click();
    const line = page.locator('g.link-line[data-from="demo-reconnect"][data-to="demo-3d"]');
    await expect(line).toHaveAttribute('data-state', 'working');
    await expect(b.locator('.link-wait')).toContainText('Waiting for Reconnection dialog');

    // A loop is refused in the dialog, with a sentence.
    await page.locator('.card[data-card-id="demo-reconnect"]').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Run after…' }).click();
    const back = page.getByRole('dialog', { name: /Run “Reconnection dialog/ });
    await back.getByRole('searchbox').fill('3D graph');
    await back.getByRole('checkbox', { name: /Agent setup 3D graph/ }).check();
    await back.getByRole('textbox', { name: 'Then send' }).fill('loop');
    await back.getByRole('button', { name: 'Run after' }).click();
    await expect(back.getByRole('alert')).toBeVisible();
    await back.getByRole('button', { name: 'Cancel' }).click();

    // Hovering a linked card shows its line's ×; the line itself never takes the pointer.
    await b.hover();
    await expect(line).toHaveClass(/is-near/);
    await expect(line.locator('.link-x')).toBeVisible();
    expect(await line.locator('.link-hit').evaluate((el) => getComputedStyle(el).pointerEvents)).toBe('none');

    await b.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Remove the wait' }).click();
    await expect(line).toHaveCount(0);
    await expect(b.locator('.link-wait')).toHaveCount(0);
  } finally {
    await closeApp(app);
  }
});
