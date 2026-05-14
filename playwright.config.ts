import { defineConfig, devices } from '@playwright/test';

// e2e は本番ビルドの dev server を使う (next dev の HMR ノイズを避ける)。
// 実ウォレット接続は CI で再現困難なため、本セットでは UI 遷移と URL parse
// のみ smoke する。
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'on-first-retry',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'mobile-safari',
      use: { ...devices['iPhone 14'] },
    },
  ],
  webServer: {
    command: 'npm run start',
    url: 'http://localhost:3000',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    // x402 paid route の挙動を deterministic にするため env を pin する。
    // local の X402_TEST_MODE が漏れると e2e が path を変えてしまうので明示的に
    // false 側を選び、testnet fallback の payTo を渡しておく。
    env: {
      X402_TEST_MODE: 'false',
      X402_NETWORK: 'base-sepolia',
      X402_PAY_TO_ADDRESS: '0x52d4901142e2B5680027da5EB47C86CB02a3cA81',
    },
  },
});
