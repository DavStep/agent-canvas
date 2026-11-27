import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { DEV_VITE_PORT } from './scripts/devPort.ts';

const repoRoot = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    host: '127.0.0.1',
    port: DEV_VITE_PORT,
    strictPort: true,
    // The page imports zoneIdFor from server/layoutOps.ts, outside the web root.
    fs: { allow: [repoRoot] },
  },
});
