import { defineConfig } from 'vitest/config'

/*
 * Coverage is collected per environment (node: shared+server, jsdom: web) —
 * see the test:coverage script. Mixing both in one v8 run yields an empty report.
 */

export default defineConfig({
  test: {
    projects: ['packages/*', 'apps/server', 'apps/web'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov', 'json-summary'],
      // Patterns are relative to each project root.
      include: ['src/**/*.ts'],
      exclude: [
        '**/*.d.ts',
        '**/index.ts',
        // Composition root and thin I/O adapters: covered by e2e / smoke tests instead.
        'src/main.ts',
        'src/telegram/client.ts',
        'src/push/webpush.ts',
        'src/sw.ts',
        'src/lib/map.ts',
      ],
      thresholds: { lines: 90, functions: 90, branches: 85, statements: 90 },
    },
  },
})
