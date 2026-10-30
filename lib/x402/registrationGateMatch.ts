// 新規登録 (POST /api/facilitator/resources) の probe が OpenPay 方式の 402 を返したとき、その OpenPay の
// JPYC accept が登録しようとしている内容と合っているかを確かめる (plans/full-review-2026-10-30.md E-2)。
//
// 照合するのは extra.openpay.mode === 'forwarder-split' の accept だけ:
//   - extra.openpay.merchant = 登録の payTo (出品者の JPYC 受取先)
//   - network = facilitator のチェーン (CAIP-2)。この network の OpenPay accept が 1 つも無ければ不一致
//   - その network の accept の asset = そのチェーンの JPYC・extra.openpay.forwarder と wire の payTo =
//     設定済みの forwarder (どれも書かれているときだけ見る)
// 期待値は createJpycPaymentRequirements (カタログの accepts) と同じ設定から作るので、カタログの accepts を
// そのまま返す SDK のゲート (createJpycGate / createDualGate) とスニペットのゲートは構造的に一致する。
//
// 照合しないもの:
//   - USDC (Base) と Arc の accept。受取先は出品者の USDC の受取先 (forwarder を通さない) で、JPYC の payTo
//     とは意味が違う。
//   - 金額・手数料・commitVersion。価格の編集や料率の改定とずれても、買い手の署名額は facilitator が
//     サーバー側の値で照合する。
//   - 編集 (PATCH)。SDK のゲートは自分の掲載 (/api/discovery/[id]) の受取先を固定値と照合するので、受取先を
//     変える編集の時点では、ゲートは古い受取先の 402 (5 分のキャッシュ) か 500 しか返せない (掲載を先に
//     変えないと、新しい受取先で動くゲートを置けない)。
// わざと登録の受取先を返す偽のゲートは止められない。止めるのは設定ミスと、他人の 402 をそのまま
// 使った偽の掲載まで。

import { configuredJpycForwarderFor } from '@/lib/relay/forwarderConfig';
import { resolveDeployment } from '@/lib/tokens';
import { x402FacilitatorConfig } from './facilitatorConfig';
import { caip2ForChainId } from './network';

export type RegistrationAcceptExpectation = {
  payTo: string;
  network: string;
  // そのチェーンの JPYC / forwarder が設定に無いときは null (カタログも accepts を作れない) = 照合しない。
  asset: string | null;
  forwarder: string | null;
};

export type GateAcceptMismatch = 'payTo' | 'network' | 'asset' | 'forwarder';

export function registrationAcceptExpectation(payTo: string): RegistrationAcceptExpectation {
  const chainId = x402FacilitatorConfig.chainId;
  return {
    payTo,
    network: caip2ForChainId(chainId),
    asset: resolveDeployment('jpyc', chainId)?.address ?? null,
    forwarder: configuredJpycForwarderFor(chainId),
  };
}

function sameAddress(value: unknown, expected: string): boolean {
  return typeof value === 'string' && value.toLowerCase() === expected.toLowerCase();
}

function forwarderSplit(accept: Record<string, unknown>): Record<string, unknown> | null {
  const extra = accept.extra;
  if (typeof extra !== 'object' || extra === null) return null;
  const openpay = (extra as { openpay?: unknown }).openpay;
  return typeof openpay === 'object' &&
    openpay !== null &&
    (openpay as { mode?: unknown }).mode === 'forwarder-split'
    ? (openpay as Record<string, unknown>)
    : null;
}

// 不一致の項目 (最初に見つけたもの) を返す。一致なら null。
export function gateAcceptMismatch(
  accepts: readonly unknown[],
  expected: RegistrationAcceptExpectation,
): GateAcceptMismatch | null {
  let onRegisteredNetwork = false;
  for (const accept of accepts) {
    if (typeof accept !== 'object' || accept === null) continue;
    const fields = accept as Record<string, unknown>;
    const split = forwarderSplit(fields);
    if (!split) continue;
    if (!sameAddress(split.merchant, expected.payTo)) return 'payTo';
    // 別チェーンの OpenPay accept は受取先だけを見る (asset / forwarder はチェーンごとに違う)。
    if (fields.network !== expected.network) continue;
    onRegisteredNetwork = true;
    if (expected.asset !== null && 'asset' in fields && !sameAddress(fields.asset, expected.asset)) {
      return 'asset';
    }
    if (expected.forwarder !== null) {
      if ('forwarder' in split && !sameAddress(split.forwarder, expected.forwarder)) return 'forwarder';
      if ('payTo' in fields && !sameAddress(fields.payTo, expected.forwarder)) return 'forwarder';
    }
  }
  return onRegisteredNetwork ? null : 'network';
}
