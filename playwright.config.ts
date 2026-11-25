import { defineConfig, devices } from '@playwright/test'

const PORT = Number(process.env.E2E_PORT ?? 8123)

/**
 * End-to-end tests run the real production build (server + PWA) in DEMO_MODE,
 * so they need no Telegram/Anthropic credentials. Map tiles come from
 * OpenFreeMap, so the network must be available.
 */
export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? `http://localhost:${PORT}`,
    locale: 'uk-UA',
    timezoneId: 'Europe/Kyiv',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'android', use: { ...devices['Pixel 7'] } },
    { name: 'iphone', use: { ...devices['iPhone 14'] } },
  ],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: 'node --disable-warning=ExperimentalWarning apps/server/dist/main.mjs',
        url: `http://localhost:${PORT}/api/health`,
        reuseExistingServer: !process.env.CI,
        env: {
          DEMO_MODE: 'true',
          PORT: String(PORT),
          DATA_DIR: './data/runtime/e2e',
          WEB_DIST: './apps/web/dist',
          LOG_LEVEL: 'warn',
          NODE_ENV: 'production',
        },
      },
})
