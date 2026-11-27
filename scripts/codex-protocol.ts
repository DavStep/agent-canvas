// `node --import tsx scripts/codex-protocol.ts`: regenerates server/engines/codex/protocol from the
// installed `codex` and records its version. The generator writes extensionless relative imports,
// which NodeNext resolution rejects, so each one gets its `.ts` (or `/index.ts`) here.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { findCodex } from '../electron/paths.ts';

const OUT = path.resolve(import.meta.dirname, '../server/engines/codex/protocol');
const codex = process.env.CODEX_BIN ?? await findCodex();
if (!codex) throw new Error('Codex not found');

const version = execFileSync(codex, ['--version'], { encoding: 'utf8' }).trim().split(/\s+/).at(-1) ?? '';
fs.rmSync(OUT, { recursive: true, force: true });
execFileSync(codex, ['app-server', 'generate-ts', '--out', OUT], { stdio: 'inherit' });

function withExtension(file: string, spec: string): string {
  const target = path.resolve(path.dirname(file), spec);
  if (fs.existsSync(`${target}.ts`)) return `${spec}.ts`;
  if (fs.existsSync(path.join(target, 'index.ts'))) return `${spec}/index.ts`;
  throw new Error(`${path.relative(OUT, file)}: cannot resolve ${spec}`);
}

for (const entry of fs.readdirSync(OUT, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
  const file = path.join(entry.parentPath, entry.name);
  const text = fs.readFileSync(file, 'utf8');
  const fixed = text.replace(/(from\s+")(\.{1,2}\/[^"]*)(")/g, (_m, pre: string, spec: string, post: string) =>
    spec.endsWith('.ts') ? `${pre}${spec}${post}` : `${pre}${withExtension(file, spec)}${post}`);
  if (fixed !== text) fs.writeFileSync(file, fixed);
}
fs.writeFileSync(path.join(OUT, 'VERSION'), `${version}\n`);
console.log(`codex protocol ${version} → ${path.relative(process.cwd(), OUT)}`);
