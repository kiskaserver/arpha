/**
 * Renders apps/web/public/badge.svg to the 96×96 PNG Android uses as the notification badge
 * (status bar / notification header). Android keeps only the alpha channel, so a full-colour
 * icon on an opaque background shows up as a solid square.
 *
 *   pnpm exec tsx scripts/build-badge.ts
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { chromium } from '@playwright/test'

const root = resolve(import.meta.dirname, '..')
const svg = readFileSync(resolve(root, 'apps/web/public/badge.svg'), 'utf8')
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 96, height: 96 } })
await page.setContent(
  `<html><body style="margin:0;background:transparent">${svg.replace('<svg ', '<svg width="96" height="96" ')}</body></html>`,
)
await page.screenshot({
  path: resolve(root, 'apps/web/public/badge-96.png'),
  omitBackground: true,
  clip: { x: 0, y: 0, width: 96, height: 96 },
})
await browser.close()
console.log('Wrote apps/web/public/badge-96.png')
