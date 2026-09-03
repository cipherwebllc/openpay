import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': resolve(__dirname, '.'),
      'server-only': resolve(__dirname, 'tests/mocks/server-only.ts'),
      'web-push': resolve(__dirname, 'tests/mocks/web-push.ts'),
    },
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
      // app/api/** は「money-path と認可の実装がある層」なので計測対象に含める
      // (2026-09-02 レビュー F3: 除外されていたため route の未テスト分岐が可視化されなかった)。
      include: ['hooks/**', 'lib/**', 'components/**', 'app/api/**'],
      // 構造化ログや middleware など runtime に直接動かない / e2e で見る系は除外
      exclude: [
        'instrumentation*.ts',
        'app/global-error.tsx',
        '**/*.d.ts',
        '**/*.config.*',
      ],
      // 現状値 (2026-09-02, components+hooks+lib+app/api): statements 89.51 /
      // branches 86.56 / functions 90.67 / lines 89.51。app/api/** を include に
      // 加えたため以前の数字 (lib 中心で 95 台) からは下がっている — 実測が下がった
      // のではなく計測範囲が広がった。
      // 実測 -2pt を下限にして回帰のみ検出 (新規コードに無理なテスト追加を強要しない)。
      // CI の Coverage ステップは continue-on-error を外したので、この下限割れは fail する。
      thresholds: {
        statements: 87,
        branches: 84,
        functions: 88,
        lines: 87,
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
