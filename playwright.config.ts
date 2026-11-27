import { defineConfig } from '@playwright/test';

// Drives the built app (`npm run build` first) through Playwright's Electron support; no browser
// download is needed.
export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  workers: 1,
  reporter: 'list',
});
