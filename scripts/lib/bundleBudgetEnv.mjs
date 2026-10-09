// check-bundle-budget --build が next build に渡す env を組み立てる (CI の ci.yml と計測条件を揃える)。
//
// CI は clean な runner で e2e/prodFlags.env だけを GITHUB_ENV に読むので、ベクターに無い flag は未設定 = OFF。
// 手元は shell や .env.local に ON が残り得る (例: 2026-10-07 に廃止した NEXT_PUBLIC_ENABLE_REGISTER_FEE=1) のに
// ベクターは OFF の flag を載せないので、公開 feature flag を全部 '0' で明示してからベクターを重ねる。
// @next/env は process.env に無いキーだけを .env.local から入れるため、全 flag を明示しておけば
// ローカル dotenv の値は計測に混ざらない。
import { parseEnv } from 'node:util';

const FLAG_KEY_RE = /NEXT_PUBLIC_ENABLE_[A-Z0-9_]+/g;

// 公開 feature flag の全キー。.env.local.example (掟 9 の文書) と lib/env.ts (実装) の両方から拾って和集合にする。
export function publicFeatureFlagKeys(sources) {
  const keys = new Set();
  for (const text of sources) for (const key of text.match(FLAG_KEY_RE) ?? []) keys.add(key);
  return [...keys].sort();
}

export function budgetBuildEnv({ parentEnv, prodFlagsText, flagKeys }) {
  const allOff = Object.fromEntries(flagKeys.map((key) => [key, '0']));
  return { ...parentEnv, ...allOff, ...parseEnv(prodFlagsText) };
}
