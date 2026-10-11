import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { COVERAGE_THRESHOLDS } from './scripts/lib/coverageThresholds.mjs';

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
    // 各 test の前に mock の呼び出し履歴を消す (vitest 5 の既定と同じ値。トレードオフがあるので理由とともに明示する・2026-10-11)。
    // false だと、vitest 4 以降の spyOn は spy 済みの関数に同じ spy を履歴つきで返すので、前の test の呼び出しで
    // 「呼ばれた」側の assertion が満たされてしまう (計測では QrGenerator の click・HistoryRow の confirm が test をまたいでいた)。
    // true の代償: module scope や beforeAll での呼び出しも test の前に消える。「読み込み時に呼ばない」型の否定の assertion は
    // 履歴に頼らず、その test の中で import / 実行してから確かめる (vitest 2 でも afterEach の restoreAllMocks で履歴は消えていた)。
    clearMocks: true,
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.{ts,tsx}'],
    exclude: ['node_modules', 'e2e/**', '.next/**'],
    coverage: {
      provider: 'v8',
      // app/api/** は「money-path と認可の実装がある層」なので計測対象に含める
      // (2026-09-02 レビュー F3: 除外されていたため route の未テスト分岐が可視化されなかった)。
      // 拡張子で絞る: vitest 4 以降の coverage-v8 は include に拾われた非 JS (.md / .d.mts / .ttf / .css / .json) も
      // 構文解析しようとして警告を出す。exclude を足していくより、今後のアセット追加にも強い。
      include: ['hooks/**/*.{ts,tsx}', 'lib/**/*.{ts,tsx,mjs}', 'components/**/*.{ts,tsx}', 'app/api/**/*.{ts,tsx}'],
      // 構造化ログや middleware など runtime に直接動かない / e2e で見る系は除外
      exclude: [
        'instrumentation*.ts',
        'app/global-error.tsx',
        '**/*.d.ts',
        '**/*.config.*',
      ],
      // 実測 -2pt (小数は切り捨て) を下限にして回帰のみ検出 (新規コードに無理なテスト追加を強要しない)。
      // CI は run-tests.mjs が coverage-summary.json とこの下限 (scripts/lib/coverageThresholds.mjs) を比べて fail させる。
      // CI の Coverage は本物の Lua (wasmoon) を使う test (2026-10-11 時点で 55 file・一覧は scripts/lib/luaRealTests.mjs) を
      // 除外して計測する (lua-real job で別途実行・2026-09-12 から)。
      // 現状値 (2026-10-11・vitest 5.0.3・Node 22・Lua 実行系を除く 715 file): statements 88.59 / branches 86.27 /
      // functions 90.39 / lines 91.34。vitest 2.1.9 の CI (更新の直前) の 92.85 / 90.07 / 92.69 / 92.85 から下がったのは
      // 測り方の変更による: vitest 4 以降の coverage-v8 は V8 の結果を AST で数え直す (v8-to-istanbul を廃止) ので、
      // 分母が型やコメントの行を数えなくなった。テストの無い分岐が増えたのではない。
      // 経緯: 2026-09-02 に app/api/** を include に加えて計測範囲が広がった (それまでは lib 中心で 95 台)。
      thresholds: { ...COVERAGE_THRESHOLDS },
      // json-summary = run-tests.mjs が下限と比べる要約 (既定の 4 つは手元で見るため残す)。
      reporter: ['text', 'html', 'clover', 'json', 'json-summary'],
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
