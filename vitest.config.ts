import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['electron/**/*.test.ts', 'server/**/*.test.ts', 'scripts/**/*.test.ts', 'shared/**/*.test.ts', 'web/src/**/*.test.ts'],
    environment: 'node',
  },
});
