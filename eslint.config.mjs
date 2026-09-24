// ESLint v9 flat config。Next.js 16 で `next lint` が削除されるための前倒し移行。
// `next/core-web-vitals` の eslintrc プリセットを @eslint/eslintrc の
// FlatCompat 経由でフラット化して読み込む (eslint-config-next 公式の推奨方法)。

import { FlatCompat } from '@eslint/eslintrc';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

// lib/handle/* は `@/lib/handle` (facade) の内部実装 (R13)。外から deep import すると
// vi.mock('@/lib/handle') を黙ってすり抜け、内部 helper (sanitizeEmoji 等) が事実上の
// 公開 API になる。facade (lib/handle.ts) と lib/handle/* 同士の import は対象外。
const HANDLE_FACADE_MESSAGE =
  "lib/handle/* は内部モジュール。'@/lib/handle' (facade) から import する (vi.mock の対象を 1 つに保つ)。";
// `@/lib/handle/x` と、ルート直下のディレクトリからの相対 `../lib/handle/x`。
const HANDLE_DEEP_IMPORT = '^(?:@/|(?:\\.\\.?/)+)lib/handle/';
// lib/ 配下からの相対 `./handle/x`・`../handle/x`。
const HANDLE_DEEP_IMPORT_FROM_LIB = '^(?:\\./|(?:\\.\\./)+)handle/';

// lib/x402/hostedStore/* も同じ理由で `@/lib/x402/hostedStore` (facade) だけを入口にする (R15a)。
// 30 超の test が facade を vi.mock しており、deep import はその mock を黙ってすり抜ける。
// lib/x402/purchase/* は `@/lib/x402/purchaseIntent` (facade) の内部実装 (R3a〜)。同じ理由で
// vi.mock('@/lib/x402/purchaseIntent') を黙ってすり抜けさせない (storeUsdcIntent の ownership/key helper 等)。
//
// facade 1 つにつき: family = facade file + 内部 dir (この中の import は自由)、
// outsideLib = `@/lib/<dir>/x` とルート直下のディレクトリからの相対 `../lib/<dir>/x`、
// inLib = lib/ 配下からの相対 `./<dir>/x`・`../<dir>/x` (lib/x402/* からは `./purchase/x` 等)。
const FACADES = [
  {
    family: ['lib/handle.ts', 'lib/handle/**'],
    message: HANDLE_FACADE_MESSAGE,
    outsideLib: HANDLE_DEEP_IMPORT,
    inLib: HANDLE_DEEP_IMPORT_FROM_LIB,
  },
  {
    family: ['lib/x402/hostedStore.ts', 'lib/x402/hostedStore/**'],
    message:
      "lib/x402/hostedStore/* は内部モジュール。'@/lib/x402/hostedStore' (facade) から import する (vi.mock の対象を 1 つに保つ)。",
    outsideLib: '^(?:@/|(?:\\.\\.?/)+)lib/x402/hostedStore/',
    inLib: '^(?:\\./|(?:\\.\\./)+)(?:x402/)?hostedStore/',
  },
  {
    family: ['lib/x402/purchaseIntent.ts', 'lib/x402/purchase/**'],
    message:
      "lib/x402/purchase/* は内部モジュール。'@/lib/x402/purchaseIntent' (facade) から import する (vi.mock の対象を 1 つに保つ)。",
    outsideLib: '^(?:@/|(?:\\.\\.?/)+)lib/x402/purchase/',
    inLib: '^(?:\\./|(?:\\.\\./)+)(?:x402/)?purchase/',
  },
];
const outsideLibRules = (facades) =>
  facades.map(({ outsideLib, message }) => ({ regex: outsideLib, message }));
const inLibRules = (facades) =>
  facades.flatMap(({ outsideLib, inLib, message }) => [
    { regex: outsideLib, message },
    { regex: inLib, message },
  ]);

// flat config は同じ rule を後の block が丸ごと上書きするため、1 file に効く facade の規則は
// 1 つの block にまとめて渡す。
function restrictFacadeDeepImports(entries) {
  return {
    'no-restricted-imports': ['error', {
      patterns: entries.map(({ regex, message }) => ({ regex, message })),
    }],
    // no-restricted-imports は動的 import() を検査しないため、文字列リテラルの import() も止める。
    // esquery の正規表現リテラルは `/` を含められないので \x2F で表す。
    'no-restricted-syntax': ['error', ...entries.map(({ regex, message }) => ({
      selector: `ImportExpression[source.value=/${regex.replaceAll('/', '\\x2F')}/]`,
      message,
    }))],
  };
}

const LINTED_SOURCES = ['**/*.{js,jsx,mjs,cjs,ts,tsx}'];

const eslintConfig = [
  ...compat.extends('next/core-web-vitals'),
  {
    ignores: [
      'node_modules/',
      '.next/',
      'playwright-report/',
      'test-results/',
      'coverage/',
      '.lighthouseci/',
      '.claude/',
      'dist/',
      'build/',
      'out/',
    ],
  },
  {
    files: LINTED_SOURCES,
    ignores: ['lib/**'],
    rules: restrictFacadeDeepImports(outsideLibRules(FACADES)),
  },
  {
    files: LINTED_SOURCES.map((glob) => `lib/${glob}`),
    ignores: FACADES.flatMap((facade) => facade.family),
    rules: restrictFacadeDeepImports(inLibRules(FACADES)),
  },
  // 各 facade の family (facade file + 内部 module) は自分同士は自由・他 facade の内部へは facade 経由。
  ...FACADES.map((facade) => ({
    files: facade.family,
    rules: restrictFacadeDeepImports(inLibRules(FACADES.filter((other) => other !== facade))),
  })),
];

export default eslintConfig;
