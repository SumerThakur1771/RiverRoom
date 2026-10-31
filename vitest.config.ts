import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 60_000,
    coverage: {
      provider: 'v8',
      // the rules engine, bots and simulator; the UI layer (src/ui) is covered by the browser smoke test
      include: ['src/engine/**/*.ts', 'src/ai/**/*.ts', 'src/sim/**/*.ts'],
      reporter: ['text-summary', 'json-summary', 'html'],
    },
  },
});
