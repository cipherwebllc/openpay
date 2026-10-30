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

// 層の向き (F-4): lib/ は app/・hooks/・components/ を import しない (型だけの import も)。
// lib から route 固有の module や client hook を引くと、app 側を動かしただけで lib が連鎖して壊れる。
// 共有する実体・型は lib/ へ移す (SIWE session → lib/siweSession.ts・下書きの型 → lib/handleProfileDraft.ts 等)。
const LIB_LAYER_RULE = {
  regex: '^(?:@/|(?:\\.\\./)+)(?:app|hooks|components)(?:/|$)',
  message:
    'lib/ から app/・hooks/・components/ を import しない (層の逆向き)。共有する実体・型は lib/ へ移す。',
};

// SIWE session (F-4): 実体は lib/siweSession.ts、app/ 側の入口は app/api/auth/siwe/_session.ts
// (再エクスポートだけの facade)。lib/ は app/ を import できないので実体を直接 import する。
// そのため上の FACADES と向きが逆で、facade を vi.mock しても実体を import する lib/* には届かず、
// 本物の cookies()/kvGet に当たる。mock の対象は実体 1 つ、app/ の import 先は facade 1 つに固定する。
const SIWE_SESSION_IMPL = '^(?:@/|(?:\\.\\.?/)+)lib/siweSession(?:\\.ts)?$';
const SIWE_SESSION_FACADE = '^(?:@/|(?:\\.\\.?/)+)app/api/auth/siwe/_session(?:\\.ts)?$';
const SIWE_SESSION_FACADE_FILE = 'app/api/auth/siwe/_session.ts';
// app/ の route は facade から import する (facade 自身は除く)。
const SIWE_IMPL_FROM_APP_RULE = {
  regex: SIWE_SESSION_IMPL,
  message:
    "app/ は SIWE session を '@/app/api/auth/siwe/_session' (facade) から import する。'@/lib/siweSession' を直接 import するのは lib/ と tests だけ。",
};
// tests は facade を import も vi.mock もしない。mock するのは実体の '@/lib/siweSession'。
const SIWE_FACADE_FROM_TESTS_RULE = {
  regex: SIWE_SESSION_FACADE,
  message:
    "tests は SIWE session を '@/lib/siweSession' (実体) で vi.mock / import する。facade の mock は実体を直接 import する lib/* に届かない。",
  viMock: true,
};
// vi.mock の第 1 引数 (文字列) を検査する vitest API。
const VI_MODULE_APIS = '^(?:mock|doMock|unmock|doUnmock|importActual|importMock)$';

// esquery の正規表現リテラルは `/` を含められないので \x2F で表す。
const esqueryRegex = (regex) => `/${regex.replaceAll('/', '\\x2F')}/`;

// flat config は同じ rule を後の block が丸ごと上書きするため、1 file に効く facade の規則は
// 1 つの block にまとめて渡す。
function restrictFacadeDeepImports(entries) {
  return {
    'no-restricted-imports': ['error', {
      patterns: entries.map(({ regex, message }) => ({ regex, message })),
    }],
    // no-restricted-imports は動的 import() を検査しないため、文字列リテラルの import() も止める。
    // viMock の entry は vi.mock('…') 等の第 1 引数も止める (import しなくても mock の対象になるため)。
    'no-restricted-syntax': ['error', ...entries.flatMap(({ regex, message, viMock }) => [
      { selector: `ImportExpression[source.value=${esqueryRegex(regex)}]`, message },
      ...(viMock
        ? [{
          selector: `CallExpression[callee.object.name='vi'][callee.property.name=${esqueryRegex(VI_MODULE_APIS)}][arguments.0.value=${esqueryRegex(regex)}]`,
          message,
        }]
        : []),
    ])],
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
  // app/ と tests/ は上の block を丸ごと上書きするので、facade の規則も同じ block に入れ直す。
  {
    files: LINTED_SOURCES.map((glob) => `app/${glob}`),
    ignores: [SIWE_SESSION_FACADE_FILE],
    rules: restrictFacadeDeepImports([...outsideLibRules(FACADES), SIWE_IMPL_FROM_APP_RULE]),
  },
  {
    files: LINTED_SOURCES.map((glob) => `tests/${glob}`),
    rules: restrictFacadeDeepImports([...outsideLibRules(FACADES), SIWE_FACADE_FROM_TESTS_RULE]),
  },
  {
    files: LINTED_SOURCES.map((glob) => `lib/${glob}`),
    ignores: FACADES.flatMap((facade) => facade.family),
    rules: restrictFacadeDeepImports([...inLibRules(FACADES), LIB_LAYER_RULE]),
  },
  // 各 facade の family (facade file + 内部 module) は自分同士は自由・他 facade の内部へは facade 経由。
  ...FACADES.map((facade) => ({
    files: facade.family,
    rules: restrictFacadeDeepImports([
      ...inLibRules(FACADES.filter((other) => other !== facade)),
      LIB_LAYER_RULE,
    ]),
  })),
];

export default eslintConfig;
