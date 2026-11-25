import { svelte } from '@sveltejs/vite-plugin-svelte'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

const API = process.env.ARPHA_API ?? 'http://localhost:8080'

export default defineConfig({
  plugins: [
    svelte(),
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      registerType: 'autoUpdate',
      injectRegister: false,
      includeAssets: [
        'favicon.ico',
        'apple-touch-icon-180x180.png',
        'logo.svg',
        'boundaries.geojson',
      ],
      injectManifest: {
        globPatterns: ['**/*.{js,mjs,css,html,svg,png,ico,geojson,woff2}'],
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
      },
      manifest: {
        id: '/',
        name: 'Арфа — повітряні загрози Запорізької області',
        short_name: 'Арфа',
        description:
          'Карта повітряних загроз Запоріжжя та області в реальному часі: шахеди, ракети, КАБи, тривоги.',
        lang: 'uk',
        dir: 'ltr',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'any',
        background_color: '#0b1220',
        theme_color: '#0b1220',
        categories: ['news', 'utilities', 'navigation'],
        icons: [
          { src: 'pwa-64x64.png', sizes: '64x64', type: 'image/png' },
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          {
            src: 'maskable-icon-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
  build: {
    target: 'es2022',
    cssCodeSplit: true,
    sourcemap: true,
    reportCompressedSize: true,
    rolldownOptions: {
      output: {
        // MapLibre is big and changes rarely: its own long-cached chunk.
        manualChunks: (id: string) => (id.includes('maplibre-gl') ? 'maplibre' : undefined),
      },
    },
  },
  server: {
    port: 5173,
    proxy: { '/api': { target: API, changeOrigin: true } },
  },
  preview: {
    port: 4173,
    proxy: { '/api': { target: API, changeOrigin: true } },
  },
})
