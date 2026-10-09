import { defineConfig } from '@playwright/test';
import path from 'node:path';

const PORT = 3100;
export const E2E_DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  'postgresql://dnd_map:dnd_map@localhost:5432/dnd_map_e2e?schema=public';

/**
 * End-to-end tests run against the production build: the server serves the built web app, as it
 * does when deployed. `pnpm test:e2e` builds first. Locally another installed Chromium-based browser
 * can be used instead of the bundled one: E2E_BROWSER_CHANNEL=msedge (or chrome).
 */
export default defineConfig({
  testDir: '.',
  timeout: 90_000,
  expect: { timeout: 5_000 },
  // One database and one server: the scenarios run one after another.
  workers: 1,
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  globalSetup: './global-setup.ts',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    channel: process.env.E2E_BROWSER_CHANNEL || undefined,
    viewport: { width: 1280, height: 900 },
    locale: 'ru-RU',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'node apps/server/dist/index.js',
    cwd: path.resolve(import.meta.dirname, '..'),
    // Not /api/health: the server starts before global-setup has created the e2e database.
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: 'ignore',
    stderr: 'pipe',
    env: {
      NODE_ENV: 'production',
      HOST: '127.0.0.1',
      PORT: String(PORT),
      DATABASE_URL: E2E_DATABASE_URL,
      WEB_DIST_DIR: 'apps/web/dist',
      UPLOADS_DIR: 'e2e/.uploads',
      // All test browsers share one address; the limits are covered by the server tests.
      RATE_LIMIT: 'off',
      CLEANUP_INTERVAL_MINUTES: '0',
      // Long enough to see a line arrive, short enough to watch it go.
      LINE_TTL_SECONDS: '6',
    },
  },
});
