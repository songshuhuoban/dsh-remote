import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../../', import.meta.url));
export default defineConfig({
  testDir: '.',
  testMatch: 'actual-dsh.spec.ts',
  timeout: 90000,
  workers: 1,
  reporter: 'list',
  outputDir: '../test-results/runtime',
  use: {
    baseURL: 'http://127.0.0.1:3108',
    launchOptions: {
      // Default to the browser revision installed by the locked Playwright.
      executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `${JSON.stringify(process.env.BUN_PATH ?? 'bun')} apps/web/e2e/start-runtime.ts`,
    cwd: root,
    url: 'http://127.0.0.1:3110',
    timeout: 180000,
    reuseExistingServer: false,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 15000 },
  },
});
