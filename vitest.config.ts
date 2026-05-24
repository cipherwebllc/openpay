import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': resolve(__dirname, '.') },
  },
  test: {
    environment: 'jsdom',
    environmentOptions: {
      jsdom: {
        url: 'https://test.local/',
      },
    },
    globals: false,
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.{ts,tsx}'],
    exclude: ['node_modules', 'e2e/**', '.next/**'],
    coverage: {
      provider: 'v8',
      include: ['hooks/**', 'lib/**', 'components/**'],
      // 構造化ログや middleware など runtime に直接動かない / e2e で見る系は除外
      exclude: [
        'instrumentation*.ts',
        'app/global-error.tsx',
        '**/*.d.ts',
        '**/*.config.*',
      ],
      // 現状値 (2026-04-27, components+hooks+lib): statements 95.89 /
      // branches 94.87 / functions 89.25 / lines 95.89。functions が低めなのは
      // QrGenerator / TipEmbedGenerator の inner handler が未テストなため。
      // 現状値 - 1% を下限にして回帰のみ検出 (新規コードに無理なテスト追加を強要しない)。
      thresholds: {
        statements: 95,
        branches: 93,
        functions: 88,
        lines: 95,
      },
    },
    // 環境変数はモジュール評価より前にセットされる必要があるため、
    // setupFiles ではなくここで定義する。
    env: {
      NEXT_PUBLIC_NETWORK_ENV: 'testnet',
      NEXT_PUBLIC_PIMLICO_API_KEY: 'test_pimlico_key',
      NEXT_PUBLIC_PIMLICO_SPONSORSHIP_POLICY_ID: 'sp_test',
      NEXT_PUBLIC_FEE_RECEIVER_ADDRESS:
        '0xdead000000000000000000000000000000001234',
      NEXT_PUBLIC_JPYC_TESTNET_ADDRESS:
        '0x0000000000000000000000000000000000000abc',
      // mainnet 切替 test が SENTRY_DSN 必須 guard (lib/env.ts:287) を超えるよう
      // default を提供。tests/lib/env.test.ts の SENTRY_DSN 未設定検証は明示的
      // `delete process.env.NEXT_PUBLIC_SENTRY_DSN` で上書きしている。
      NEXT_PUBLIC_SENTRY_DSN:
        'https://test_sentry@o12345.ingest.us.sentry.io/67890',
    },
  },
});
