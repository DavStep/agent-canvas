// `node --import tsx scripts/build-electron.ts`: bundles the main process (ESM) and the preload
// (CommonJS, as sandboxed preloads must be) into dist-electron/.
import { build, type BuildOptions } from 'esbuild';

const common: BuildOptions = {
  bundle: true,
  platform: 'node',
  target: 'node24',
  sourcemap: true,
  logLevel: 'warning',
  external: ['electron', '@anthropic-ai/claude-agent-sdk'],
};

await Promise.all([
  build({ ...common, entryPoints: ['electron/main.ts'], outfile: 'dist-electron/main.js', format: 'esm' }),
  build({ ...common, entryPoints: ['electron/preload.cts'], outfile: 'dist-electron/preload.cjs', format: 'cjs' }),
  build({ ...common, entryPoints: ['electron/previewClip.cts'], outfile: 'dist-electron/previewClip.cjs', format: 'cjs' }),
  build({ ...common, entryPoints: ['electron/previewPreload.cts'], outfile: 'dist-electron/previewPreload.cjs', format: 'cjs' }),
]);
