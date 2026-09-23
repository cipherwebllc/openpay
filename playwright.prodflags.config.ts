import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { defineConfig, devices } from '@playwright/test';

// CI exports this same file BEFORE next build: NEXT_PUBLIC_* is compiled into JS.
// Setting only webServer.env would leave the browser running the flags-OFF bundle.
const prodFlags = parseEnv(readFileSync(resolve(__dirname, 'e2e/prodFlags.env'), 'utf8')) as Record<string, string>;

export default defineConfig({
  testDir: './e2e/prodflags',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // No retries while measuring stability: an intermittent first failure stays visible.
  retries: 0,
  workers: 2,
  timeout: 30_000,
  outputDir: 'test-results/prodflags',
  reporter: process.env.CI
    ? [
        ['github'],
        ['html', { open: 'never', outputFolder: 'playwright-prodflags-report' }],
        ['json', { outputFile: 'playwright-prodflags-report/results.json' }],
      ]
    : 'list',
  use: {
    baseURL: 'http://127.0.0.1:3100',
    // Service workers could bypass page.route, leaking fixture requests to real APIs.
    serviceWorkers: 'block',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run start -- --hostname 127.0.0.1 --port 3100',
    url: 'http://127.0.0.1:3100',
    reuseExistingServer: false,
    timeout: 120_000,
    env: prodFlags,
  },
});
