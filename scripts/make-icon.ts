// Render the canvas agent’s dot-matrix globe at each macOS icon size.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { ORB_DOTS } from '../web/src/components/dots.ts';

type RGB = [number, number, number];
const INK: RGB = [241, 241, 241];
const SPARK: RGB = [202, 157, 250];
const TILE_TOP: RGB = [47, 45, 51];
const TILE_BOTTOM: RGB = [24, 24, 26];
const SIZE = 1024;
const TILE = { x: 100, y: 100, size: 824, radius: 185 };
const GLOBE_SIZE = 690;

function inTile(x: number, y: number): boolean {
  const { x: tx, y: ty, size, radius: r } = TILE;
  if (x < tx || y < ty || x >= tx + size || y >= ty + size) return false;
  const cx = Math.min(Math.max(x, tx + r), tx + size - r);
  const cy = Math.min(Math.max(y, ty + r), ty + size - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

/** Render the tile with antialiased corners, then composite each globe dot by its pixel coverage. */
function render(size: number): Buffer {
  const out = Buffer.alloc(size * size * 4);
  const scale = size / SIZE;
  const samples = 4;
  for (let y = 0; y < size; y++) {
    const t = Math.max(0, Math.min(1, ((y + 0.5) / scale - TILE.y) / TILE.size));
    for (let x = 0; x < size; x++) {
      let covered = 0;
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          if (inTile((x + (sx + 0.5) / samples) / scale, (y + (sy + 0.5) / samples) / scale)) covered++;
        }
      }
      if (!covered) continue;
      const i = (y * size + x) * 4;
      for (let c = 0; c < 3; c++) out[i + c] = Math.round(TILE_TOP[c]! * (1 - t) + TILE_BOTTOM[c]! * t);
      out[i + 3] = Math.round(255 * covered / (samples * samples));
    }
  }

  const unit = GLOBE_SIZE * scale / 40; // AgentOrb's 40 × 40 viewBox
  const inset = (size - 40 * unit) / 2;
  for (const [x, y, width, height, opacity, spark] of ORB_DOTS) {
    const left = inset + x * unit;
    const top = inset + y * unit;
    const right = left + width * unit;
    const bottom = top + height * unit;
    const ink = spark ? SPARK : INK;
    // Lift the shaded hemisphere so the silhouette survives at Finder list sizes.
    const strength = Math.sqrt(opacity);
    for (let py = Math.floor(top); py < bottom; py++) {
      const dy = Math.min(bottom, py + 1) - Math.max(top, py);
      for (let px = Math.floor(left); px < right; px++) {
        const dx = Math.min(right, px + 1) - Math.max(left, px);
        const alpha = dx * dy * strength;
        const i = (py * size + px) * 4;
        for (let c = 0; c < 3; c++) out[i + c] = Math.round(out[i + c]! * (1 - alpha) + ink[c]! * alpha);
      }
    }
  }
  return out;
}

function png(size: number, rgba: Buffer): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

const outDir = path.resolve(import.meta.dirname, '..', 'build');
fs.mkdirSync(outDir, { recursive: true });
const iconset = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-canvas-icon-')) + '/icon.iconset';
fs.mkdirSync(iconset);
const rendered = new Map<number, Buffer>();
const at = (size: number) => {
  if (!rendered.has(size)) rendered.set(size, png(size, render(size)));
  return rendered.get(size)!;
};
for (const base of [16, 32, 128, 256, 512]) {
  fs.writeFileSync(path.join(iconset, `icon_${base}x${base}.png`), at(base));
  fs.writeFileSync(path.join(iconset, `icon_${base}x${base}@2x.png`), at(base * 2));
}
fs.writeFileSync(path.join(outDir, 'icon.png'), at(1024));
const made = spawnSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(outDir, 'icon.icns')], { stdio: 'inherit' });
fs.rmSync(path.dirname(iconset), { recursive: true, force: true });
if (made.status !== 0) {
  process.stderr.write('make-icon: iconutil failed\n');
  process.exit(1);
}
process.stdout.write(`make-icon: wrote ${path.join(outDir, 'icon.png')} and icon.icns\n`);
