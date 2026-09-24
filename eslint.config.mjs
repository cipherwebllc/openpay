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

function restrictHandleDeepImports(regexes) {
  return {
    'no-restricted-imports': ['error', {
      patterns: regexes.map((regex) => ({ regex, message: HANDLE_FACADE_MESSAGE })),
    }],
    // no-restricted-imports は動的 import() を検査しないため、文字列リテラルの import() も止める。
    // esquery の正規表現リテラルは `/` を含められないので \x2F で表す。
    'no-restricted-syntax': ['error', ...regexes.map((regex) => ({
      selector: `ImportExpression[source.value=/${regex.replaceAll('/', '\\x2F')}/]`,
      message: HANDLE_FACADE_MESSAGE,
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
    rules: restrictHandleDeepImports([HANDLE_DEEP_IMPORT]),
  },
  {
    files: LINTED_SOURCES.map((glob) => `lib/${glob}`),
    ignores: ['lib/handle.ts', 'lib/handle/**'],
    rules: restrictHandleDeepImports([HANDLE_DEEP_IMPORT, HANDLE_DEEP_IMPORT_FROM_LIB]),
  },
];

export default eslintConfig;
