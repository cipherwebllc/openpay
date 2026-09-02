// Base mainnet USDC で有料 API を 1 回購入する smoke (vanilla x402)。
// JPYC forwarder-split とは別経路: 買い手は EIP-3009 の typed-data に署名するだけで、
// broadcast とガスは facilitator 側。買い手ウォレットに ETH は不要・USDC のみ。
//
// 実行 (このファイルに秘密鍵は書かない・env で渡す):
//   SMOKE_MAINNET_OK=1 PRIVATE_KEY=0x... node scripts/x402-vanilla-buyer-smoke.mjs
//   SMOKE_MAINNET_OK=1 PRIVATE_KEY=0x... TARGET_URL=https://open-pay.jp/api/paid/usdc/stores \
//     node scripts/x402-vanilla-buyer-smoke.mjs
//
// ⚠️ 既定の TARGET_URL は **本番 (open-pay.jp)**・署名するのは Base mainnet の実 USDC。
// fat-finger で実マネーを動かさないよう、本番ホスト / Base mainnet を叩くには
// SMOKE_MAINNET_OK=1 の明示 opt-in が必要 (scripts/smoke-circle-crossswitch.mjs と同じ規約)。
//
// env: TARGET_URL (既定 /api/paid/hello)・MAX_USDC (支払い上限・既定 0.05)・SMOKE_MAINNET_OK。
// 成功 = HTTP 200 + 本文 + settlement に tx hash。
//
// 用途: CDP Bazaar / agentic.market への掲載は **settle 時に確定する** (2026-08-20 実測) ため、
// 402 の description を変えたら該当 endpoint を 1 回買い直してカタログを更新する。

import {
  createSigner,
  decodeXPaymentResponse,
  wrapFetchWithPayment,
} from 'x402-fetch';

const TARGET = process.env.TARGET_URL ?? 'https://open-pay.jp/api/paid/hello';
// 買い手側の支払い上限 (atomic 6 桁)。402 の要求額を鵜呑みにせず、改竄 requirements を
// ここで止めるための保険なので **402 から導出しない**。既定 0.05 USDC は現行カタログの
// 最高額 (stores $0.04) を 1 段上回る値。別の額を試すときだけ MAX_USDC で上書きする。
const MAX_USDC = process.env.MAX_USDC ?? '0.05';
const m = /^([0-9]+)(?:\.([0-9]{1,6}))?$/.exec(MAX_USDC);
if (!m) {
  console.error(`MAX_USDC の形式が不正です (例: 0.05): ${MAX_USDC}`);
  process.exit(1);
}
const MAX_VALUE = BigInt(m[1]) * 1_000_000n + BigInt((m[2] ?? '').padEnd(6, '0'));

const pk = process.env.PRIVATE_KEY;
if (!pk || !pk.startsWith('0x')) {
  console.error('PRIVATE_KEY env (0x...) が必要です');
  process.exit(1);
}

// 実マネー保護: 本 smoke は Base **mainnet** の signer で署名するため、既定 target を
// 含む本番ホストへの実行は常に実 USDC を消費する。明示 opt-in が無ければ何も送らない。
const SIGNER_NETWORK = 'base'; // Base mainnet (chainId 8453)
const targetHost = (() => {
  try {
    return new URL(TARGET).hostname.toLowerCase();
  } catch {
    console.error(`TARGET_URL が URL として不正です: ${TARGET}`);
    process.exit(1);
  }
})();
const isProdHost = targetHost === 'open-pay.jp' || targetHost.endsWith('.open-pay.jp');
if ((isProdHost || SIGNER_NETWORK === 'base') && process.env.SMOKE_MAINNET_OK !== '1') {
  console.error(
    `この smoke は ${TARGET} を Base mainnet の実 USDC (上限 ${MAX_USDC}) で購入します。`,
  );
  console.error('意図的なら SMOKE_MAINNET_OK=1 を付けて再実行してください:');
  console.error(
    `  SMOKE_MAINNET_OK=1 PRIVATE_KEY=0x... TARGET_URL=${TARGET} node scripts/x402-vanilla-buyer-smoke.mjs`,
  );
  console.error('使い捨て・低残高ウォレットのみ使用すること。');
  process.exit(2);
}

const signer = await createSigner(SIGNER_NETWORK, pk);
const fetchWithPay = wrapFetchWithPayment(fetch, signer, MAX_VALUE);

console.log('buying:', TARGET);
const res = await fetchWithPay(TARGET, { method: 'GET' });
console.log('HTTP', res.status);
console.log('body :', await res.text());

const paymentResponse = res.headers.get('x-payment-response');
if (paymentResponse) {
  console.log('settlement:', decodeXPaymentResponse(paymentResponse));
} else {
  console.log('settlement: (x-payment-response ヘッダなし)');
}
