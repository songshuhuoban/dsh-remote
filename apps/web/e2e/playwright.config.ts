import { defineConfig } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const data = mkdtempSync(join(tmpdir(), 'dsh-web-e2e-'));
export default defineConfig({
  testDir: '.',
  testMatch: 'real-relay.spec.ts',
  timeout: 30000,
  workers: 1,
  reporter: 'list',
  outputDir: '../test-results',
  use: {
    baseURL: 'http://127.0.0.1:3107',
    launchOptions: {
      // Default to the browser revision installed by the locked Playwright.
      executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `${JSON.stringify(process.env.BUN_PATH ?? 'bun')} apps/server/src/index.ts`,
    cwd: root,
    env: {
      PORT: '3107',
      HOST: '127.0.0.1',
      DATABASE_PATH: join(data, 'relay.sqlite'),
      REGISTRATION: 'enabled',
      WEB_DIST: 'apps/web/dist',
    },
    url: 'http://127.0.0.1:3107',
    reuseExistingServer: false,
    timeout: 15000,
  },
});
