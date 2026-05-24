#!/usr/bin/env node
// Tip widget production smoke: HTTP status only (i18n / DOM レベルは e2e で検証)。
// 使い方: node scripts/smoke-tip-production.mjs [base-url]
// 既定 base = https://open-pay.jp。exit 0=全 pass / 1=失敗。

const BASE = process.argv[2] ?? 'https://open-pay.jp';
const TO = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';

const urls = [
  ['Tip JPYC + chain=kaia', `/ja/tip/${TO}?token=jpyc&chain=kaia`],
  ['Tip JPYC default (polygon)', `/ja/tip/${TO}?token=jpyc`],
  ['Tip USDC default', `/ja/tip/${TO}?token=usdc`],
  ['Tip USDC + crossChain=false', `/ja/tip/${TO}?token=usdc&crossChain=false`],
  ['URL parser reject: jpyc+base', `/ja/tip/${TO}?token=jpyc&chain=base`],
  ['URL parser reject: usdc+ethereum', `/ja/tip/${TO}?token=usdc&chain=ethereum`],
  ['Creator dashboard /ja', '/ja'],
  ['Tip /en/tip', `/en/tip/${TO}?token=jpyc`],
  ['Speed Insights script', '/_vercel/speed-insights/script.js'],
  ['Vercel Analytics script', '/_vercel/insights/script.js'],
];

let failed = 0;
for (const [name, path] of urls) {
  const r = await fetch(`${BASE}${path}`);
  if (r.status === 200) {
    console.log(`  ✓ ${name}`);
  } else {
    console.log(`  ✗ ${name} — status ${r.status}`);
    failed += 1;
  }
}

const total = urls.length;
console.log('');
if (failed > 0) {
  console.log(`❌ ${failed}/${total} failed against ${BASE}`);
  process.exit(1);
}
console.log(`✅ ${total}/${total} passed against ${BASE}`);
