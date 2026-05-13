// alpha 取引 log: ブラウザ → /api/log/payment → Vercel KV (Upstash Redis)。
// 弁護士 review / 金融庁事前相談時の事実関係資料、および demand signal 集計に使う。
// 失敗時は silent (UI を阻害しない); 解析は console / Vercel runtime log を併用。

import type { Address, Hex } from 'viem';

export type PaymentLogEvent = {
  // 必須
  flow: 'batch' | 'direct';
  result: 'success' | 'reverted' | 'error';
  chainId: number;
  tokenAddress: Address;
  merchant: Address;
  merchantAmount: string;        // bigint を 10 進文字列で送信 (JSON で bigint 不可)

  // optional / flow 依存
  customer?: Address;
  feeReceiver?: Address;
  feeAmount?: string;
  userOpHash?: Hex;
  txHash?: Hex;
  blockNumber?: string;
  errorMessage?: string;
};

export async function logPaymentEvent(event: PaymentLogEvent): Promise<void> {
  // fire-and-forget。fetch 失敗で payment 成功 UI が崩れないように catch する。
  // network 障害 / CSP block / test 環境などで silently 失敗してよい
  // (KV 側で受信できなくとも、server route 経由なら Vercel runtime log が
  // 残るため、fallback は重ねて確保されている)。
  try {
    await fetch('/api/log/payment', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(event),
      // keepalive: tab close / navigation 直後でも POST 完了させる
      keepalive: true,
    });
  } catch {
    // intentionally silent: ここで warn を出すと test や CSP 環境で大量ノイズになる
  }
}
