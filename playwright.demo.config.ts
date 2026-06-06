import { defineConfig, devices } from '@playwright/test';

// ランディング用デモ動画の収録専用 config (e2e 本体 playwright.config.ts とは独立)。
// mobile-safari (iPhone 14) で実 UI のまま /ja/create の決済QR作成フローを録画する。
// video: 'on' で必ず webm を残し、後段で ffmpeg → mp4/gif へ変換する。
export default defineConfig({
  testDir: './demo-e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  outputDir: './demo-artifacts/raw',
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'off',
    video: 'on',
  },
  projects: [
    {
      name: 'mobile-safari',
      use: { ...devices['iPhone 14'] },
    },
  ],
  webServer: {
    command: 'npm run start',
    url: 'http://localhost:3000',
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
