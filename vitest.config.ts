import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 60_000,
    coverage: {
      provider: 'v8',
      // everything that runs outside the page; the screens (src/ui, src/mp, src/pwa) are
      // covered by the browser tests in tools/ui instead
      include: ['src/engine/**/*.ts', 'src/ai/**/*.ts', 'src/sim/**/*.ts', 'src/coach/**/*.ts', 'src/review/**/*.ts', 'src/ledger/**/*.ts', 'server/src/**/*.ts'],
      // generated Prisma client, and the process entry point (exercised by the browser test)
      exclude: ['server/src/generated/**', 'server/src/main.ts'],
      reporter: ['text-summary', 'json-summary', 'html'],
    },
  },
});
