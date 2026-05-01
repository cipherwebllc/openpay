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
];

export default eslintConfig;
