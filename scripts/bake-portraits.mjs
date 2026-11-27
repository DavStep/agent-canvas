// Bake the portrait loops and the reversible, 13-pose turn toward the pointer.
// Requires Chrome and libwebp's img2webp. No application window or profile is opened.
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';
import typing from '../web/src/creature/typing.json' with { type: 'json' };

const root = path.resolve(import.meta.dirname, '..');
const directory = path.join(root, 'web/src/creature');
const bundle = await build({
  entryPoints: [path.join(directory, 'dotScene.ts')], bundle: true, write: false, globalName: 'portraitScene',
  loader: { '.png': 'dataurl', '.webp': 'dataurl', '.glb': 'dataurl' },
});
const temp = await mkdtemp(path.join(tmpdir(), 'canvas-portraits-'));
const browser = await chromium.launch({ channel: 'chrome', args: ['--use-angle=metal'] });
try {
  const page = await browser.newPage();
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.evaluate(async () => { window.stage = await portraitScene.loadDotScene(); });
  for (const provider of ['codex', 'claude', 'orchestrator']) {
    for (const working of [false, true]) {
      const stem = provider + (working ? '-working' : '-idle');
      const strip = await page.evaluate(({ provider, working }) => {
        const { canvas } = stage;
        const sheet = document.createElement('canvas');
        const steps = 12;
        sheet.width = canvas.width * (steps + 1);
        sheet.height = canvas.height;
        const context = sheet.getContext('2d');
        for (let i = 0; i <= steps; i++) {
          // The gaze eases out as it turns face-on. Keep the working hands still.
          const rest = Math.exp(-4 * i / steps) * (1 - i / steps);
          stage.render(provider, working, (working ? portraitScene.typingYaw : .09) * rest, .025 * rest, 0, 0);
          context.drawImage(canvas, i * canvas.width, 0);
        }
        return sheet.toDataURL('image/webp', .95).split(',')[1];
      }, { provider, working });
      await writeFile(path.join(directory, stem + '-gaze.webp'), Buffer.from(strip, 'base64'));
      if (process.argv.includes('--gaze-only')) continue;
      const args = ['-loop', '0', '-lossy', '-q', '90', '-m', '4'];
      const count = working ? typing.length : 6 * 24;
      for (let frame = 0; frame < count; frame++) {
        const png = await page.evaluate(({ provider, working, frame, count }) => {
          stage.render(provider, working, working ? portraitScene.typingYaw : .09, .025, frame / 24, working ? frame / count : 0);
          return stage.canvas.toDataURL().split(',')[1];
        }, { provider, working, frame, count });
        const file = path.join(temp, frame + '.png');
        await writeFile(file, Buffer.from(png, 'base64'));
        const ms = Math.round((frame + 1) * 1000 / 24) - Math.round(frame * 1000 / 24);
        args.push('-d', String(ms), file);
      }
      execFileSync('img2webp', [...args, '-o', path.join(directory, stem + '.webp')], { stdio: 'inherit' });
    }
  }
} finally {
  await browser.close();
  await rm(temp, { recursive: true, force: true });
}
