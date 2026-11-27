// The board's own menu and the owner's notes, in the hidden demo app: right-click on the empty
// desk makes a zone (named at once) or a note; a note is written in place and kept on reload,
// found by search, deleted with an undo, takes a pasted picture, and drops into a chat's composer.
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';

const launch = (): Promise<ElectronApplication> =>
  electron.launch({ args: ['dist-electron/main.js', '--demo'], env: { ...process.env, AGENT_CANVAS_HIDDEN: '1' } as Record<string, string> });

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

/** A point on the empty desk (no zone, card, image or note under it), in screen px. */
const emptySpot = (page: Page, prefer: 'left' | 'right' = 'right'): Promise<{ x: number; y: number }> => page.evaluate((side) => {
  const ws = document.querySelector('.workspace')!.getBoundingClientRect();
  const xs: number[] = [];
  for (let x = ws.left + 60; x < ws.right - 300; x += 40) xs.push(x);
  if (side === 'right') xs.reverse();
  for (const x of xs) {
    for (let y = ws.top + 80; y < ws.bottom - 220; y += 40) {
      const el = document.elementFromPoint(x, y);
      if (el && !el.closest('.card, .zone, [data-item-id], button, .menu, .undo-toast') && document.querySelector('.workspace')!.contains(el)) return { x, y };
    }
  }
  throw new Error('no empty spot on the canvas');
}, prefer);

const PNG = (page: Page): Promise<string> => page.evaluate(() => {
  const c = document.createElement('canvas');
  c.width = 320; c.height = 200;
  const g = c.getContext('2d')!;
  g.fillStyle = '#2a2622'; g.fillRect(0, 0, 320, 200);
  g.fillStyle = '#e8a33d'; g.fillRect(20, 20, 130, 70);
  return c.toDataURL('image/png').split(',')[1]!;
});

const pasteImage = (page: Page, b64: string, name = 'pasted.png') => page.evaluate(([data, file]) => {
  const bytes = Uint8Array.from(atob(data!), (ch) => ch.charCodeAt(0));
  const transfer = new DataTransfer();
  transfer.items.add(new File([bytes], file!, { type: 'image/png' }));
  document.activeElement!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
}, [b64, name]);

async function newNote(page: Page, at?: { x: number; y: number }) {
  const spot = at ?? await emptySpot(page);
  await page.mouse.click(spot.x, spot.y, { button: 'right' });
  const menu = page.getByRole('menu', { name: 'Canvas' });
  await expect(menu).toBeVisible();
  await menu.getByRole('menuitem', { name: 'New note' }).click();
  await expect(menu).toHaveCount(0);
  const field = page.getByRole('textbox', { name: 'Note text' });
  await expect(field).toBeFocused();
  return field;
}

test('board menu: right-click on the empty desk makes a zone and names it; Shift+F10 opens it, Esc closes it', async () => {
  const app = await launch();
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(e.message));
    await page.reload();
    await expect(page.locator('article.card')).toHaveCount(11);
    await expect(page.locator('.zone')).toHaveCount(4);

    // The keyboard opens it too, and Esc closes it.
    await page.locator('body').focus();
    await page.keyboard.press('Shift+F10');
    const menu = page.getByRole('menu', { name: 'Canvas' });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'New note' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);

    // A card's right-click is not the desk's.
    const card = page.locator('article.card').first();
    const cb = (await card.boundingBox())!;
    await page.mouse.click(cb.x + cb.width / 2, cb.y + cb.height / 2, { button: 'right' });
    await expect(menu).toHaveCount(0);
    await page.keyboard.press('Escape');

    const spot = await emptySpot(page);
    // The board point under it: the board is drawn at its origin, scaled by the zoom.
    const wanted = await page.evaluate(({ x, y }) => {
      const board = document.querySelector<HTMLElement>('.workspace .board')!;
      const o = board.getBoundingClientRect();
      const k = new DOMMatrixReadOnly(getComputedStyle(board).transform).a || 1;
      return { x: Math.round((x - o.left) / k), y: Math.round((y - o.top) / k) };
    }, spot);
    await page.mouse.click(spot.x, spot.y, { button: 'right' });
    await expect(menu).toBeVisible();
    // The last item is there only while the clipboard holds an image.
    await expect(menu.getByRole('menuitem').nth(2)).toHaveText('New session…');
    expect((await menu.getByRole('menuitem').allTextContents()).slice(0, 3)).toEqual(['New note', 'New zone', 'New session…']);
    await settled(page);
    await page.screenshot({ path: 'e2e/shots/desk-menu.png' });
    await menu.getByRole('menuitem', { name: 'New zone' }).click();

    // It is made where the menu was, and its name is open for typing.
    await expect(page.locator('.zone')).toHaveCount(5);
    const zone = page.locator('.zone', { has: page.locator('.zone-label input') });
    const name = zone.locator('.zone-label input');
    await expect(name).toBeFocused();
    // Saved at that board point (a fresh demo view then reframes to show everything, so its place
    // on screen may move with the whole board).
    const drawnAt = await zone.evaluate((el) => el.style.translate.split(' ').map(parseFloat));
    expect(Math.abs(drawnAt[0]! - (wanted.x - 24))).toBeLessThan(2);
    expect(Math.abs(drawnAt[1]! - (wanted.y - 18))).toBeLessThan(2);
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.type('Research');
    await page.keyboard.press('Enter');
    await expect(page.locator('.zone .zone-label .name', { hasText: 'Research' })).toHaveCount(1);
    await page.reload();
    await expect(page.locator('.zone .zone-label .name', { hasText: 'Research' })).toHaveCount(1);
    expect(errors).toEqual([]);
  } finally {
    await closeApp(app);
  }
});

test('notes: written in place, kept on reload, ticked, found by search, deleted with an undo', async () => {
  const app = await launch();
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(e.message));
    await page.reload();
    await expect(page.locator('article.card')).toHaveCount(11);

    const field = await newNote(page);
    await page.keyboard.type('# Groceries\nBuy for the week\n- [ ] oat milk\n- [x] bread\nSee https://example.com/list');
    // Esc stops writing: the note shows its text, with a heading, the to-dos and the link.
    await page.keyboard.press('Escape');
    await expect(field).toHaveCount(0);
    const unnamed = page.getByRole('button', { name: 'Edit note title: Untitled' });
    await unnamed.click();
    await page.getByRole('textbox', { name: 'Note title' }).fill('Shopping list');
    await page.keyboard.press('Enter');
    const note = page.locator('[aria-label="Note: Shopping list"]');
    await expect(note.locator('h3')).toHaveText('Groceries');
    await expect(note.getByRole('checkbox')).toHaveCount(2);
    await expect(note.getByRole('link', { name: 'https://example.com/list' })).toBeVisible();
    await settled(page);
    const profile = page.getByRole('button', { name: 'Profile and usage' });
    const appearance = page.getByRole('radiogroup', { name: 'Note appearance' });
    const thread = page.locator('.thread-note').first();
    const surfaces = [note, thread];
    await profile.click();
    await expect(appearance.getByRole('radio', { name: 'Canvas' })).toBeChecked();
    for (const surface of surfaces) await expect(surface).toHaveCSS('color', 'rgb(241, 241, 241)');
    await appearance.getByRole('radio', { name: 'Holographic' }).check();
    for (const surface of surfaces) await expect(surface).toHaveCSS('color', 'rgb(239, 246, 246)');
    await page.keyboard.press('Escape');
    await expect(appearance).toHaveCount(0);
    await note.screenshot({ path: 'e2e/shots/board-note-holographic.png' });
    await page.reload();
    await profile.click();
    await expect(appearance.getByRole('radio', { name: 'Holographic' })).toBeChecked();
    await appearance.getByRole('radio', { name: 'Holographic' }).focus();
    await page.keyboard.press('ArrowLeft');
    await expect(appearance.getByRole('radio', { name: 'Paper' })).toBeChecked();
    for (const surface of surfaces) await expect(surface).toHaveCSS('color', 'rgb(51, 46, 37)');
    await page.keyboard.press('Escape');
    await expect(appearance).toHaveCount(0);
    const paperColor = () => note.evaluate((el) => getComputedStyle(el, '::before').backgroundColor);
    const plain = await paperColor();
    // Focus reveals the note toolbar even when the hidden window has no native hover.
    await note.focus();
    await note.getByRole('button', { name: 'Note colour' }).click();
    await note.getByRole('radio', { name: 'Teal' }).click();
    await expect.poll(paperColor).not.toBe(plain);
    await note.screenshot({ path: 'e2e/shots/board-note-paper.png' });
    await page.screenshot({ path: 'e2e/shots/note.png' });

    // Ticking a to-do on the board saves it.
    await note.getByRole('checkbox').first().check();
    await expect(note.getByRole('checkbox').first()).toBeChecked();

    // Kept on reload (the demo keeps its layout in memory for the app's life).
    await page.reload();
    const again = page.locator('[aria-label="Note: Shopping list"]');
    await expect(again).toBeVisible();
    await expect(again.getByRole('checkbox').first()).toBeChecked();
    await expect(again).toContainText('Buy for the week');

    // Clicking its text writes in it again; what is typed is saved as it is typed.
    await again.locator('.bn-text p').first().click();
    const field2 = page.getByRole('textbox', { name: 'Note text' });
    await expect(field2).toBeFocused();
    await page.keyboard.type('\nand eggs');
    await page.waitForTimeout(700);
    await page.reload();
    await expect(page.locator('[aria-label="Note: Shopping list"]')).toContainText('and eggs');

    // ⌘K finds it by what it says, and picking it travels there.
    await page.keyboard.press('ControlOrMeta+K');
    await page.getByRole('combobox', { name: 'Search zones and sessions' }).fill('Shopping list');
    const hit = page.getByRole('option', { name: /Shopping list/ });
    await expect(hit).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(page.locator('[aria-label="Note: Shopping list"]')).toBeFocused();

    // Delete takes it off, ⌘Z brings it back.
    await page.keyboard.press('Delete');
    await expect(page.locator('[aria-label="Note: Shopping list"]')).toHaveCount(0);
    await expect(page.getByRole('status').filter({ hasText: 'Note deleted' })).toBeVisible();
    await page.keyboard.press('ControlOrMeta+Z');
    await expect(page.locator('[aria-label="Note: Shopping list"]')).toHaveCount(1);
    expect(errors).toEqual([]);
  } finally {
    await closeApp(app);
  }
});

test('notes: a pasted picture shows as a thumbnail that opens large, and can be removed', async () => {
  const app = await launch();
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(e.message));
    await page.reload();
    await expect(page.locator('article.card')).toHaveCount(11);
    const png = await PNG(page);

    await newNote(page);
    await page.keyboard.type('Hero mock');
    await pasteImage(page, png, 'hero.png');
    const note = page.locator('[aria-label="Note: Untitled"]');
    const pics = note.getByRole('list', { name: 'Pictures' }).getByRole('button', { name: 'Open hero.png' });
    await expect(pics).toHaveCount(1);
    // The board adds no image of its own: the picture is the note's.
    await expect(page.locator('.board-image')).toHaveCount(0);
    await expect.poll(() => pics.locator('img').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
    await page.keyboard.press('Escape');
    await settled(page);
    await page.screenshot({ path: 'e2e/shots/note-picture.png' });

    await pics.click();
    const viewer = page.getByRole('dialog', { name: 'Image' });
    await expect(viewer).toBeVisible();
    await expect.poll(() => viewer.locator('img').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(320);
    await page.keyboard.press('Escape');
    await expect(page.locator('dialog.img-viewer')).toHaveCount(0);

    // Kept on reload, then removed.
    await page.reload();
    await expect(page.locator('[aria-label="Note: Untitled"]').getByRole('button', { name: 'Open hero.png' })).toBeVisible();
    await page.locator('[aria-label="Note: Untitled"]').hover();
    await page.getByRole('button', { name: 'Remove hero.png from the note' }).click();
    await expect(page.locator('[aria-label="Note: Untitled"]').getByRole('button', { name: 'Open hero.png' })).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await closeApp(app);
  }
});

test('notes: dragged onto a chat’s message field, its text goes in and its pictures are attached', async () => {
  const app = await launch();
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(e.message));
    await page.reload();
    await expect(page.locator('article.card')).toHaveCount(11);
    const png = await PNG(page);

    // An idle chat, so its composer takes messages.
    await page.locator('.card[data-card-id="demo-deploy"]').click();
    const chat = page.locator('.chat-screen');
    const composer = chat.locator('.composer');
    await expect(composer).toBeVisible();
    await expect(chat.locator('.cp-field')).toBeEnabled();

    await newNote(page, await emptySpot(page, 'left'));
    await page.keyboard.type('Ship the release notes today');
    await pasteImage(page, png, 'notes.png');
    const note = page.locator('[data-note-id]');
    await expect(note.getByRole('button', { name: 'Open notes.png' })).toHaveCount(1);
    await page.keyboard.press('Escape');
    await settled(page);

    await note.getByRole('button', { name: 'Edit note title: Untitled' }).click();
    await note.getByRole('textbox', { name: 'Note title' }).fill('Release checklist');
    await page.keyboard.press('Enter');
    const nb = (await note.locator('.bn-title').boundingBox())!;
    const cb = (await composer.boundingBox())!;
    await page.mouse.move(nb.x + nb.width / 2, nb.y + nb.height / 2);
    await page.mouse.down();
    await page.mouse.move(cb.x + cb.width / 2, cb.y + cb.height / 2, { steps: 12 });
    await expect(composer).toHaveClass(/is-board-drop/);
    await page.mouse.up();
    await expect(chat.locator('.cp-field')).toHaveValue('Release checklist\n\nShip the release notes today');
    await expect(chat.getByRole('list', { name: 'Images to send' }).getByRole('button', { name: 'View image 1' })).toBeVisible();
    // The note stays on the board where it was.
    await expect(note).toBeVisible();
    await page.screenshot({ path: 'e2e/shots/note-to-chat.png' });
    expect(errors).toEqual([]);
  } finally {
    await closeApp(app);
  }
});

for (const zoom of [0.53, 1.5]) test(`notes: the grabbed point stays under the pointer at ${zoom * 100}% zoom`, async () => {
  const app = await launch();
  try {
    const page = await app.firstWindow();
    await expect(page.locator('article.card')).toHaveCount(11);
    await page.addInitScript(k => {
      if (sessionStorage.getItem('drag-test-view')) return;
      localStorage.setItem('agent-canvas:view', JSON.stringify({ x: 4000, y: 4000, k }));
      sessionStorage.setItem('drag-test-view', '1');
    }, zoom);
    await page.reload();
    const board = page.locator('.workspace .board');
    await expect.poll(() => board.evaluate(el => new DOMMatrixReadOnly(getComputedStyle(el).transform).a)).toBe(zoom);
    await newNote(page, { x: 320, y: 240 });
    await page.keyboard.type('A note with a picture');
    await pasteImage(page, await PNG(page));
    const note = page.locator('[data-note-id]');
    await expect(note.locator('img')).toBeVisible();
    await page.keyboard.press('Escape');
    await settled(page);

    const body = (await note.locator('.bn-text p').boundingBox())!;
    await page.mouse.move(body.x + 2 * zoom, body.y + body.height / 2);
    await page.mouse.down();
    await page.mouse.move(body.x + 80 * zoom, body.y + body.height / 2, { steps: 5 });
    await page.mouse.up();
    expect(await page.evaluate(() => window.getSelection()?.toString())).toContain('note');
    await expect(note.getByLabel('Note text')).toHaveCount(0);

    for (const dx of [96, -75]) {
      if (dx < 0) await page.emulateMedia({ reducedMotion: 'reduce' });
      const start = (await note.boundingBox())!;
      const button = (await note.locator('.bn-title').boundingBox())!;
      const x = Math.round(button.x + button.width / 2);
      const y = Math.round(button.y + button.height / 2);
      const check = async (mx: number, my: number) => {
        await expect.poll(async () => {
          const box = (await note.boundingBox())!;
          return Math.max(Math.abs(box.x - start.x - mx), Math.abs(box.y - start.y - my));
        }).toBeLessThan(1.1);
      };
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + 6, y + 1);
      await check(6, 1);
      // Moving the camera under a stationary pointer must repaint the held note.
      const beforePan = await board.evaluate(el => getComputedStyle(el).transform);
      await page.locator('.workspace').dispatchEvent('wheel', { deltaX: 24, deltaY: -12 });
      await expect.poll(() => board.evaluate(el => getComputedStyle(el).transform)).not.toBe(beforePan);
      await check(6, 1);
      await page.mouse.move(x + dx, y + 38, { steps: 12 });
      await check(dx, 38);
      await page.mouse.up();
      await settled(page);
      await check(dx, 38);
      await expect.poll(() => note.evaluate(el => el.style.translate)).toBe('');
    }
    // The camera saves separately from the note, after wheel input settles.
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('agent-canvas:view')!).x)).toBe(3952);
    // The camera keeps travelling under a stationary hand at the edge. Releasing
    // there must save both the new board coordinate and the camera position.
    const ws = (await page.locator('.workspace').boundingBox())!;
    const before = (await note.boundingBox())!;
    const title = (await note.locator('.bn-title').boundingBox())!;
    const grabX = Math.round(title.x + title.width / 2);
    const grabY = Math.round(title.y + title.height / 2);
    const edgeX = Math.floor(ws.x + ws.width - 6);
    const cameraX = () => board.evaluate(el => new DOMMatrixReadOnly(getComputedStyle(el).transform).e);
    const initialCamera = await cameraX();
    await page.mouse.move(grabX, grabY);
    await page.mouse.down();
    await page.mouse.move(edgeX, grabY);
    await expect.poll(cameraX).toBeLessThan(initialCamera - 30);
    const inHand = (await note.boundingBox())!;
    expect(Math.abs(inHand.x - before.x - (edgeX - grabX))).toBeLessThan(1.1);
    await page.mouse.up();
    await settled(page);
    const final = (await note.boundingBox())!;
    expect(Math.abs(final.x - inHand.x)).toBeLessThan(1.1);
    const stoppedAt = await cameraX();
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('agent-canvas:view')!).x as number))
      .toBeCloseTo(stoppedAt, 1);
    await page.reload();
    await expect(note).toBeVisible();
    await settled(page);
    expect((await note.boundingBox())!.x).toBeCloseTo(final.x, 0);
    expect((await note.boundingBox())!.y).toBeCloseTo(final.y, 0);
  } finally { await closeApp(app); }
});

test('zone rim animates both axes when its last note leaves and returns', async () => {
  const app = await launch();
  try {
    const page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await expect(page.locator('article.card')).toHaveCount(11);
    await page.evaluate(() => window.canvas!.layoutOp({ type: 'createZone', name: 'Notes' }));
    const zone = page.getByRole('region', { name: 'Notes', exact: true });
    const id = await zone.getAttribute('data-zone-id');
    await page.evaluate(zoneId => window.canvas!.layoutOp({ type: 'addNote', note: {
      id: 'note:1234abcd', place: { zone: zoneId!, col: 0, top: 0 }, title: 'Last note',
      width: 420, height: 240, text: 'One note in this zone.', hueIndex: 6,
    } }), id);
    const note = zone.locator('[data-note-id]');
    await expect(note).toBeVisible();
    const size = () => zone.evaluate((el: HTMLElement) => [el.offsetWidth, el.offsetHeight]);
    const full = await size();
    await settled(page);

    // Sample the actual painted plate during reflow. Its layout and hit box must
    // already be at the destination while both visible edges are still travelling.
    const watch = () => zone.evaluate((el: HTMLElement) => new Promise<number[]>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('The rim never moved')), 3000);
      const sample = (event: TransitionEvent) => {
        if (event.target !== el || event.pseudoElement !== '::after' || event.propertyName !== 'width') return;
        el.removeEventListener('transitionstart', sample);
        clearTimeout(timer);
        const rim = getComputedStyle(el, '::after');
        resolve([parseFloat(rim.width), parseFloat(rim.height), el.offsetWidth, el.offsetHeight]);
      };
      el.addEventListener('transitionstart', sample);
    }));
    const shrinking = watch();
    await note.focus();
    await page.keyboard.press('Delete');
    const [w, h, emptyW, emptyH] = await shrinking;
    expect(w).toBeGreaterThan(emptyW!);
    expect(h).toBeGreaterThan(emptyH!);
    await settled(page);
    expect(await zone.evaluate(el => ['width', 'height'].map(p => parseFloat(getComputedStyle(el, '::after').getPropertyValue(p))))).toEqual([emptyW, emptyH]);

    const growing = watch();
    await page.getByRole('button', { name: /Undo/ }).click();
    const [gw, gh, fullW, fullH] = await growing;
    expect([fullW, fullH]).toEqual(full);
    expect(gw).toBeLessThan(fullW!);
    expect(gh).toBeLessThan(fullH!);
    await settled(page);

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await note.focus();
    await page.keyboard.press('Delete');
    await expect(note).toHaveCount(0);
    expect(await size()).toEqual([emptyW, emptyH]);
    expect(await zone.evaluate(el => parseFloat(getComputedStyle(el, '::after').width))).toBe(emptyW);
    expect(await zone.evaluate(el => el.getAnimations({ subtree: true }).length)).toBe(0);
  } finally { await closeApp(app); }
});
