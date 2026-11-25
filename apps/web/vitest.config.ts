import { svelte } from '@sveltejs/vite-plugin-svelte'
import { svelteTesting } from '@testing-library/svelte/vite'
import { defineProject } from 'vitest/config'

export default defineProject({
  // svelteTesting() resolves Svelte's browser build and auto-cleans the DOM between tests.
  plugins: [svelte(), svelteTesting()],
  test: {
    name: 'web',
    include: ['test/**/*.test.ts'],
    environment: 'jsdom',
  },
})
