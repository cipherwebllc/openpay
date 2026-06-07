import { defineConfig, devices } from '@playwright/test';

// SNS/README 用 3 本横並び合成 (sns-row) の収録専用 config。個別 mobile デモと違い
// 1024x880 のカードレイアウトなので chromium + 固定ビューポートで録画し、video.size を
// 明示して出力を厳密に 1024x880 に揃える (従来アセットと同寸)。webServer は npm run start で
// public/demo の mp4 を配信する (個別デモを録り直したビルドで起動しておくこと)。
export default defineConfig({
  testDir: './demo-e2e',
  testMatch: /sns-row\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  outputDir: './demo-artifacts/raw',
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'off',
    viewport: { width: 1024, height: 880 },
    deviceScaleFactor: 2,
    video: { mode: 'on', size: { width: 1024, height: 880 } },
  },
  projects: [
    {
      name: 'desktop-chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1024, height: 880 },
        deviceScaleFactor: 2,
      },
    },
  ],
  webServer: {
    command: 'npm run start',
    url: 'http://localhost:3000',
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
