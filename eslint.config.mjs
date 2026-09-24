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
const HOSTED_STORE_FACADE_MESSAGE =
  "lib/x402/hostedStore/* は内部モジュール。'@/lib/x402/hostedStore' (facade) から import する (vi.mock の対象を 1 つに保つ)。";
// `@/lib/x402/hostedStore/x` と、ルート直下のディレクトリからの相対 `../lib/x402/hostedStore/x`。
const HOSTED_STORE_DEEP_IMPORT = '^(?:@/|(?:\\.\\.?/)+)lib/x402/hostedStore/';
// lib/ 配下からの相対 `./x402/hostedStore/x`・`../x402/hostedStore/x`・`./hostedStore/x` (lib/x402/*)・`../hostedStore/x`。
const HOSTED_STORE_DEEP_IMPORT_FROM_LIB = '^(?:\\./|(?:\\.\\./)+)(?:x402/)?hostedStore/';

const HANDLE_RULES = [
  { regex: HANDLE_DEEP_IMPORT, message: HANDLE_FACADE_MESSAGE },
  { regex: HANDLE_DEEP_IMPORT_FROM_LIB, message: HANDLE_FACADE_MESSAGE },
];
const HOSTED_STORE_RULES = [
  { regex: HOSTED_STORE_DEEP_IMPORT, message: HOSTED_STORE_FACADE_MESSAGE },
  { regex: HOSTED_STORE_DEEP_IMPORT_FROM_LIB, message: HOSTED_STORE_FACADE_MESSAGE },
];

// flat config は同じ rule を後の block が丸ごと上書きするため、1 file に効く facade の規則は
// 1 つの block にまとめて渡す。
function restrictFacadeDeepImports(rules) {
  return {
    'no-restricted-imports': ['error', {
      patterns: rules.map(({ regex, message }) => ({ regex, message })),
    }],
    // no-restricted-imports は動的 import() を検査しないため、文字列リテラルの import() も止める。
    // esquery の正規表現リテラルは `/` を含められないので \x2F で表す。
    'no-restricted-syntax': ['error', ...rules.map(({ regex, message }) => ({
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
    rules: restrictFacadeDeepImports([HANDLE_RULES[0], HOSTED_STORE_RULES[0]]),
  },
  {
    files: LINTED_SOURCES.map((glob) => `lib/${glob}`),
    ignores: ['lib/handle.ts', 'lib/handle/**', 'lib/x402/hostedStore.ts', 'lib/x402/hostedStore/**'],
    rules: restrictFacadeDeepImports([...HANDLE_RULES, ...HOSTED_STORE_RULES]),
  },
  {
    // handle の内部同士は自由・hostedStore の内部へは facade 経由。
    files: ['lib/handle.ts', ...LINTED_SOURCES.map((glob) => `lib/handle/${glob}`)],
    rules: restrictFacadeDeepImports(HOSTED_STORE_RULES),
  },
  {
    // hostedStore の内部同士は自由・handle の内部へは facade 経由。
    files: ['lib/x402/hostedStore.ts', ...LINTED_SOURCES.map((glob) => `lib/x402/hostedStore/${glob}`)],
    rules: restrictFacadeDeepImports(HANDLE_RULES),
  },
];

export default eslintConfig;
