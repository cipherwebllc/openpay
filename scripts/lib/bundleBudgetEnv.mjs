// check-bundle-budget --build が next build に渡す env を組み立てる (CI の ci.yml と計測条件を揃える)。
//
// CI は clean な runner で e2e/prodFlags.env だけを GITHUB_ENV に読むので、ベクターに無い flag は未設定 = OFF。
// 手元は shell や .env.local に ON が残り得る (例: 2026-10-07 に廃止した NEXT_PUBLIC_ENABLE_REGISTER_FEE=1) のに
// ベクターは OFF の flag を載せないので、公開 boolean flag を全部 '0' で明示してからベクターを重ねる。
// @next/env は process.env に無いキーだけを .env.local から入れるため、全 flag を明示しておけば
// ローカル dotenv の値は計測に混ざらない。
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';

// 公開 boolean flag の見つけ方 (接頭辞だけに頼らない):
//   (a) NEXT_PUBLIC_ENABLE_* という名前 (.env.local.example の文書と実装の両方から)
//   (b) parseBoolFlag(['名前',] process.env.NEXT_PUBLIC_X) で読んでいるキー
//       (lib/crossChain/config.ts の NEXT_PUBLIC_EXPERIMENTAL_CROSS_CHAIN_ENABLED・NEXT_PUBLIC_CROSS_CHAIN_DISABLED・
//        NEXT_PUBLIC_CROSS_CHAIN_BURN_AUTORESUME のように ENABLE_ 接頭辞を持たない flag)
const ENABLE_KEY_RE = /NEXT_PUBLIC_ENABLE_[A-Z0-9_]+/g;
const BOOL_READ_RE = /parseBoolFlag\(\s*(?:'[A-Z0-9_]+',\s*)?process\.env\.(NEXT_PUBLIC_[A-Z0-9_]+)/g;

export function publicFeatureFlagKeys(sources) {
  const keys = new Set();
  for (const text of sources) {
    for (const key of text.match(ENABLE_KEY_RE) ?? []) keys.add(key);
    for (const m of text.matchAll(BOOL_READ_RE)) keys.add(m[1]);
  }
  return [...keys].sort();
}

// dirs 配下の .ts / .tsx (test ファイルを除く) の本文。flag の読み取り箇所を漏れなく走査するため。
export function sourceTextsUnder(root, dirs) {
  const texts = [];
  for (const dir of dirs) {
    for (const entry of readdirSync(join(root, dir), { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) continue;
      texts.push(readFileSync(join(entry.parentPath, entry.name), 'utf8'));
    }
  }
  return texts;
}

export function budgetBuildEnv({ parentEnv, prodFlagsText, flagKeys }) {
  const allOff = Object.fromEntries(flagKeys.map((key) => [key, '0']));
  return { ...parentEnv, ...allOff, ...parseEnv(prodFlagsText) };
}
