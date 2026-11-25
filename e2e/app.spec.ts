import { expect, type Page, test } from '@playwright/test'

/** Collect page errors, ignoring third-party tile hiccups. */
function trackErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => {
    if (m.type() === 'error' && !/openfreemap|Failed to load resource/i.test(m.text()))
      errors.push(m.text())
  })
  return errors
}

test.describe('Арфа', () => {
  test('renders the Ukrainian shell, live demo data and the map', async ({ page }) => {
    const errors = trackErrors(page)
    await page.goto('/')
    await expect(page).toHaveTitle(/Арфа/)
    await expect(page.locator('html')).toHaveAttribute('lang', 'uk')
    await expect(page.getByText('Демо')).toBeVisible()
    await expect(page.getByTestId('alert-chip')).toContainText('Повітряна тривога')
    await expect(page.getByTestId('threat-count')).toContainText(/загроз/)
    await expect(page.locator('canvas.maplibregl-canvas')).toBeVisible()
    await expect(page.getByText('Завантаження карти…')).toBeHidden({ timeout: 30_000 })
    expect(errors).toEqual([])
  })

  test('selecting a threat opens its card with kinematics and ETA', async ({ page, isMobile }) => {
    await page.goto('/')
    if (isMobile)
      await page
        .getByRole('button', { name: /загроз/ })
        .first()
        .click()
    const row = page.getByTestId('threat-row').filter({ hasText: 'Шахед' }).first()
    await expect(row).toBeVisible({ timeout: 20_000 })
    await row.click()
    const card = page.getByTestId('threat-card')
    await expect(card).toBeVisible()
    await expect(card).toContainText('Швидкість')
    await expect(card).toContainText('км/год')
    await expect(card).toContainText('Курс')
    await expect(card.getByTestId('card-eta')).not.toBeEmpty()
    await expect(page).toHaveURL(/\?track=t[0-9a-f]+/)
    await card.getByRole('button', { name: 'Закрити' }).click()
    await expect(card).toBeHidden()
  })

  test('deep link opens the threat card directly', async ({ page, request }) => {
    const state = await (await request.get('/api/state')).json()
    const id = state.tracks.find((t: { status: string }) => t.status === 'active').id
    await page.goto(`/?track=${id}`)
    await expect(page.getByTestId('threat-card')).toBeVisible()
  })

  test('alert chip lists alerted locations', async ({ page }) => {
    await page.goto('/')
    await page.getByTestId('alert-chip').click()
    await expect(page.getByRole('list', { name: 'Тривоги в області' })).toContainText(
      'Запорізька область',
    )
  })

  test('settings: theme, radius and manual point', async ({ page }) => {
    await page.goto('/')
    await page.getByTestId('open-settings').click()
    const dialog = page.getByTestId('settings')
    await expect(dialog).toBeVisible()
    await dialog.getByRole('radio', { name: 'Темна' }).click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await dialog.locator('#radius').fill('25')
    await expect(dialog).toContainText('25 км')
    await dialog.getByRole('button', { name: 'Вибрати на карті' }).click()
    const hint = page.getByText('Торкніться карти, щоб поставити точку')
    await expect(hint).toBeVisible()
    // Regression: picking may start before the map has loaded.
    await expect(page.getByText('Завантаження карти…')).toBeHidden({ timeout: 30_000 })
    const canvas = page.locator('canvas.maplibregl-canvas')
    const box = (await canvas.boundingBox())!
    await canvas.click({ position: { x: box.width * 0.6, y: box.height * 0.4 } })
    await expect(hint).toBeHidden()
    await page.getByTestId('open-settings').click()
    await expect(page.getByTestId('point-value')).toHaveText(/^\d+\.\d{3}, \d+\.\d{3}$/)
    // Preferences persist across reloads.
    await page.reload()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  })

  test('layout fits the viewport without horizontal scroll', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByTestId('threat-panel')).toBeVisible()
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    )
    expect(overflow).toBeLessThanOrEqual(0)
    const panel = (await page.getByTestId('threat-panel').boundingBox())!
    const vp = page.viewportSize()!
    expect(panel.x).toBeGreaterThanOrEqual(0)
    expect(panel.x + panel.width).toBeLessThanOrEqual(vp.width + 1)
  })

  test('is installable: manifest, icons and service worker', async ({
    page,
    request,
    browserName,
  }) => {
    const manifest = await (await request.get('/manifest.webmanifest')).json()
    expect(manifest).toMatchObject({ lang: 'uk', short_name: 'Арфа', display: 'standalone' })
    expect(manifest.icons.some((i: { purpose?: string }) => i.purpose === 'maskable')).toBe(true)
    for (const icon of manifest.icons) expect((await request.get(`/${icon.src}`)).ok()).toBe(true)
    test.skip(browserName === 'webkit', 'Playwright WebKit has no service workers')
    await page.goto('/')
    const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope)
    expect(scope).toMatch(/\/$/)
  })

  test('works offline from the service worker cache', async ({ page, context, browserName }) => {
    test.skip(browserName === 'webkit', 'Playwright WebKit has no service workers')
    await page.goto('/')
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready
    })
    await page.reload() // now controlled by the SW
    await expect(page.getByTestId('alert-chip')).toBeVisible()
    await context.setOffline(true)
    await page.reload()
    await expect(page.getByText('Арфа').first()).toBeVisible()
    await expect(page.getByTestId('conn')).toBeVisible()
    await context.setOffline(false)
  })
})

test.describe('API', () => {
  test('health, security headers and SSE', async ({ request, page }) => {
    const res = await request.get('/api/health')
    expect(res.ok()).toBe(true)
    expect(await res.json()).toMatchObject({ ok: true, demo: true })
    const csp = res.headers()['content-security-policy']!
    expect(csp).toContain("frame-ancestors 'none'")

    await page.goto('/')
    const first = await page.evaluate(
      () =>
        new Promise<string>((resolve) => {
          const es = new EventSource('/api/stream')
          es.onmessage = (m) => {
            es.close()
            resolve(JSON.parse(m.data).type)
          }
        }),
    )
    expect(first).toBe('snapshot')
  })

  test('stale hashed assets 404 instead of returning HTML', async ({ request }) => {
    const res = await request.get('/assets/does-not-exist.js')
    expect(res.status()).toBe(404)
  })
})
