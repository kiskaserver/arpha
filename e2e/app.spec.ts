import { expect, type Page, test } from '@playwright/test'

/**
 * Collect page errors and browser warnings (deprecations, unused preloads),
 * ignoring third-party tile hiccups.
 */
function trackErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => {
    if (
      (m.type() === 'error' || m.type() === 'warning') &&
      // GL Driver Message: the headless software renderer, not the app.
      !/openfreemap|Failed to load resource|GL Driver Message/i.test(m.text())
    )
      errors.push(`${m.type()}: ${m.text()}`)
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
    await expect(page.getByTestId('alert-chip')).toContainText('Тривога в області')
    await expect(page.getByTestId('threat-count')).toContainText(/загроз/)
    await expect(page.locator('canvas.maplibregl-canvas')).toBeVisible()
    await expect(page.getByText('Завантаження карти…')).toBeHidden({ timeout: 30_000 })
    // Chrome reports unused preloads a few seconds after load.
    await page.waitForTimeout(3500)
    expect(errors).toEqual([])
  })

  test('selecting a threat opens its card with kinematics and ETA', async ({ page, isMobile }) => {
    await page.goto('/')
    if (isMobile) await page.getByRole('tab', { name: 'Загрози' }).click()
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
    await dialog.getByRole('button', { name: '+ На карті' }).click()
    const hint = page.getByText('Торкніться карти, щоб поставити точку')
    await expect(hint).toBeVisible()
    // Regression: picking may start before the map has loaded.
    await expect(page.getByText('Завантаження карти…')).toBeHidden({ timeout: 30_000 })
    const canvas = page.locator('canvas.maplibregl-canvas')
    const box = (await canvas.boundingBox())!
    await canvas.click({ position: { x: box.width * 0.6, y: box.height * 0.4 } })
    await expect(hint).toBeHidden()
    await page.getByTestId('open-settings').click()
    const points = page.getByTestId('points')
    await expect(points.getByRole('listitem')).toHaveCount(1)
    await expect(points.getByRole('textbox')).toHaveValue('Дім')
    // Each place has its own zone; the shared one becomes the default.
    await points.getByTestId('point-zone').selectOption('5')
    await expect(page.getByTestId('settings')).toContainText('Зона за замовчуванням')
    // The legend lives behind the "i" button, not in settings.
    await expect(
      page.getByTestId('settings').getByRole('button', { name: 'Умовні позначки' }),
    ).toHaveCount(0)
    await page.keyboard.press('Escape')
    // Preferences persist across reloads.
    await page.reload()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await page.getByTestId('open-settings').click()
    await expect(page.getByTestId('point-zone')).toHaveValue('5')
    // The trail of the selected threat can be switched off entirely.
    await page.getByTestId('trails').selectOption('off')
    await page.reload()
    await page.getByTestId('open-settings').click()
    await expect(page.getByTestId('trails')).toHaveValue('off')
  })

  test('legend explains every symbol in Ukrainian', async ({ page }) => {
    await page.goto('/')
    await page.getByTestId('open-legend').click()
    const legend = page.getByTestId('legend')
    await expect(legend).toBeVisible()
    for (const text of [
      'Шахед',
      'FPV-дрон',
      'Молнія / Ланцет',
      'КАБ',
      'Балістика',
      'Вибухи',
      'Ймовірна зона ураження',
      'Мости / гребля перекриті',
    ]) {
      await expect(legend).toContainText(text)
    }
  })

  test('feed tab shows channel posts with source chips', async ({ page, isMobile }) => {
    await page.goto('/')
    if (isMobile) await page.getByRole('tab', { name: 'Загрози' }).click()
    await page.getByTestId('tab-feed').click()
    await expect(page.getByTestId('feed')).toBeVisible()
  })

  test('forecast: the selected drone shows likely targets', async ({ page, isMobile }) => {
    await page.goto('/')
    if (isMobile) await page.getByRole('tab', { name: 'Загрози' }).click()
    const row = page.getByTestId('threat-row').filter({ hasText: 'Шахеди' }).first()
    await expect(row).toBeVisible({ timeout: 20_000 })
    await row.click()
    await expect(page.getByTestId('likely-targets')).toContainText('%')
  })

  test('mobile sheet can be dragged open and closed', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'bottom sheet is a mobile layout')
    await page.goto('/')
    const panel = page.getByTestId('threat-panel')
    const closed = (await panel.boundingBox())!.height
    // A finger swipe on the handle: touch pointer events, as phones send them.
    const swipe = (dy: number) =>
      page.getByTestId('sheet-handle').evaluate(async (el, dy) => {
        const r = el.getBoundingClientRect()
        const x = r.left + r.width / 2
        let y = r.top + 10
        const fire = (type: string) =>
          el.dispatchEvent(
            new PointerEvent(type, {
              bubbles: true,
              pointerId: 7,
              pointerType: 'touch',
              clientX: x,
              clientY: y,
              button: 0,
              isPrimary: true,
            }),
          )
        fire('pointerdown')
        for (let i = 0; i < 12; i++) {
          y += dy / 12
          fire('pointermove')
          await new Promise((res) => setTimeout(res, 16))
        }
        fire('pointerup')
      }, dy)
    await swipe(-450)
    await expect.poll(async () => (await panel.boundingBox())!.height).toBeGreaterThan(closed + 200)
    await swipe(700)
    await expect.poll(async () => (await panel.boundingBox())!.height).toBeLessThan(closed + 10)
  })

  test('analytics tab explains learned routes', async ({ page, isMobile }) => {
    await page.goto('/')
    if (isMobile) await page.getByRole('tab', { name: 'Загрози' }).click()
    await page.getByTestId('tab-analytics').click()
    await expect(page.getByTestId('analytics')).toBeVisible()
  })

  test('selected threat shows weapon characteristics with sources', async ({ page, isMobile }) => {
    await page.goto('/')
    if (isMobile) await page.getByRole('tab', { name: 'Загрози' }).click()
    const row = page.getByTestId('threat-row').filter({ hasText: 'Шахеди' }).first()
    await expect(row).toBeVisible({ timeout: 20_000 })
    await row.click()
    const specs = page.getByTestId('specs')
    await expect(specs).toContainText('Шахед-136')
    await expect(specs).toContainText('км/год')
    await expect(specs.getByRole('link').first()).toHaveAttribute('href', /^https:/)
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

  test('settings with several places fit the screen (no sideways stretch)', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem(
        'arpha:settings:v1',
        JSON.stringify({
          points: [
            { id: 'a', name: 'Дім біля Дніпровського парку', lat: 47.78, lon: 35.22, radiusKm: 5 },
            { id: 'b', name: 'Робота на Бородинському', lat: 47.89, lon: 35.07 },
          ],
        }),
      )
    })
    await page.goto('/')
    await page.getByTestId('open-settings').click()
    const dialog = page.getByTestId('settings')
    await expect(dialog.getByTestId('point-zone')).toHaveCount(2)
    const fits = await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)
    expect(fits).toBe(true)
    const box = (await dialog.boundingBox())!
    expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1)
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
