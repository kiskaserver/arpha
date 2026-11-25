import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/main.ts'],
  format: 'esm',
  platform: 'node',
  target: 'node26',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  // The shared package ships TypeScript sources, so it must be bundled in.
  deps: { alwaysBundle: ['@arpha/shared'] },
})
