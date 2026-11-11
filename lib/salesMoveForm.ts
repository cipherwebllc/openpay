// 「売上をほかのウォレットへ移す」の画面 (components/SalesMoveForm.tsx) の入力の確かめ方と、エラーの文言の選び方 (純関数)。
// server (app/api/relay/jpyc/move/route.ts) が拒むものを、署名の前に同じ基準で止める。server が正で、ここは案内のための写し。
//   - 送り先: アドレスの形・送り元と同じ・forwarder・feeReceiver・JPYC の token・0 アドレス (relayer は server だけが知る)。
//   - 移す額: 1 JPYC 以上 (SALES_MOVE_MIN_VALUE_WEI)。移す額 + 利用料 ≤ 1 回の上限 (ORDER_LINK_GASLESS_MAX_JPYC・server の
//     RELAY_MAX_JPYC の既定 5 万の固定の写し・新しい写しを作らない)。移す額 + 利用料 ≤ ウォレットにある JPYC。

import { getAddress, isAddress, isAddressEqual, zeroAddress, type Address } from 'viem';
import { ORDER_LINK_GASLESS_MAX_JPYC } from '@/lib/orderLink';
import { SALES_MOVE_MIN_VALUE_WEI } from '@/lib/relay/salesMove';
import { isRelayIpRateLimitedError } from '@/lib/relay/relayResponseError';
import { isUserRejection } from '@/lib/walletErrors';

const WEI_PER_JPYC = 10n ** 18n;
// 10 進の数 (小数は 18 桁まで・JPYC v3 はどのチェーンでも 18 桁)。
const DECIMAL = /^\d+(\.\d{1,18})?$/;

export type SalesMoveLimits = {
  /** 移す額の下限 (wei)。 */
  minMove: bigint;
  /** 移す額の上限 (wei) = 1 回の上限 − 利用料。 */
  maxMove: bigint;
  /** 移す額 + 利用料の上限 (wei)。 */
  maxTotal: bigint;
  /** 移せるのに要るウォレットの JPYC (wei) = 利用料 + 移す額の下限。 */
  minWallet: bigint;
};

export function salesMoveLimits(fee: bigint): SalesMoveLimits {
  const maxTotal = ORDER_LINK_GASLESS_MAX_JPYC * WEI_PER_JPYC;
  return {
    minMove: SALES_MOVE_MIN_VALUE_WEI,
    maxMove: maxTotal - fee,
    maxTotal,
    minWallet: fee + SALES_MOVE_MIN_VALUE_WEI,
  };
}

/** 「全部移す」の額 (= ウォレットにある JPYC − 利用料・1 回の上限まで)。移せない (下限に届かない) ときは null。 */
export function moveAllWei(balance: bigint, fee: bigint): bigint | null {
  const limits = salesMoveLimits(fee);
  if (balance < limits.minWallet) return null;
  const all = balance - fee;
  return all > limits.maxMove ? limits.maxMove : all;
}

export type DestinationError = 'invalidAddress' | 'sameAsSender' | 'forbiddenDestination';

export type DestinationCheck = { ok: true; address: Address } | { ok: false; error: DestinationError };

/**
 * 送り先の確かめ。forbidden = 送ったら戻せない・お店のウォレットではないアドレス (forwarder・feeReceiver・JPYC の token)。
 * 0 アドレスはここで足す。
 */
export function checkDestination(
  raw: string,
  { from, forbidden }: { from: Address; forbidden: readonly (Address | null)[] },
): DestinationCheck {
  const value = raw.trim();
  if (!isAddress(value)) return { ok: false, error: 'invalidAddress' };
  const address = getAddress(value);
  if (isAddressEqual(address, from)) return { ok: false, error: 'sameAsSender' };
  for (const blocked of [zeroAddress, ...forbidden]) {
    if (blocked !== null && isAddressEqual(address, blocked)) return { ok: false, error: 'forbiddenDestination' };
  }
  return { ok: true, address };
}

export type AmountError = 'invalidAmount' | 'belowMin' | 'aboveMax' | 'insufficient';

export type AmountCheck = { ok: true; wei: bigint } | { ok: false; error: AmountError };

/** 移す額の確かめ (JPYC の 10 進・18 桁)。balance はウォレットにある JPYC (wei)。 */
export function checkMoveAmount(raw: string, { fee, balance }: { fee: bigint; balance: bigint }): AmountCheck {
  const value = raw.trim();
  if (!DECIMAL.test(value)) return { ok: false, error: 'invalidAmount' };
  const [whole, fraction = ''] = value.split('.');
  const wei = BigInt(whole) * WEI_PER_JPYC + BigInt(fraction.padEnd(18, '0'));
  const limits = salesMoveLimits(fee);
  if (wei < limits.minMove) return { ok: false, error: 'belowMin' };
  if (wei > limits.maxMove) return { ok: false, error: 'aboveMax' };
  if (wei + fee > balance) return { ok: false, error: 'insufficient' };
  return { ok: true, wei };
}

export type SalesMoveErrorKey =
  | 'rejected'
  | 'rateLimited'
  | 'insufficient'
  | 'belowMin'
  | 'aboveMax'
  | 'sameAsSender'
  | 'forbiddenDestination'
  | 'unavailable'
  | 'storageUnavailable'
  | 'signatureRejected'
  | 'generic';

/**
 * 署名・送信の失敗 (hooks/useSalesMove が投げたもの) → 画面の文言のキー (Create.salesMove.errors.*)。
 * 応答不明 (RelayResponseUnknownError) は文言ではなく「送信済みかもしれない」の表示にするので、呼出側が先に分ける。
 */
export function salesMoveErrorKey(error: unknown): SalesMoveErrorKey {
  if (isUserRejection(error)) return 'rejected';
  if (isRelayIpRateLimitedError(error)) return 'rateLimited';
  if (!(error instanceof Error)) return 'generic';
  switch (error.message) {
    // 払い元の rate limit (server の relay:rl:・冪等 claim を戻してから返す)。
    case 'rate_limited':
      return 'rateLimited';
    case 'insufficient_balance':
      return 'insufficient';
    case 'amount_below_minimum':
      return 'belowMin';
    case 'value_exceeds_max':
      return 'aboveMax';
    case 'merchant_is_sender':
      return 'sameAsSender';
    case 'merchant_is_forwarder':
    case 'merchant_is_fee_receiver':
    case 'merchant_is_relayer':
    case 'merchant_is_token':
    case 'zero_merchant':
      return 'forbiddenDestination';
    // 機能が使えない (flag OFF の 404・relay の未構成・mainnet の前提・日次予算・ウォレットの JPYC を読めない)。
    case 'not_found':
    case 'unsupported_chain':
    case 'relay_not_configured':
    case 'gas_ceiling_required':
    case 'kv_required':
    case 'storage_unavailable':
    case 'daily_budget_exceeded':
    case 'balance_unavailable':
      return 'unavailable';
    // この端末に復旧の枠 (公開 metadata) を書けないので、送らずに止めた (hooks/useSalesMove・第 10 回レビュー G-1)。
    // 時間をおいても直らないので、「いまは移せません」とは別の文言にする。
    case 'intent_storage_unavailable':
      return 'storageUnavailable';
    // server が、署名から送り元のアドレスを確かめられなかった (lib/relay/forwarderRecover.ts の verifyForwarderSettle・署名を
    // 復元できない = signature_invalid・復元したアドレスが送り元と違う = signature_mismatch)。broadcast より前の拒否で、JPYC は
    // 動いていない。待っても変わらないので、「時間をおいて」の generic にしない (第 10 回レビュー D-4)。
    case 'signature_invalid':
    case 'signature_mismatch':
      return 'signatureRejected';
    default:
      return 'generic';
  }
}

/** 待つ秒数 (Retry-After)。無ければ IP の枠と払い元の枠の窓 (60 秒)。 */
export function salesMoveRetrySeconds(error: unknown): number {
  if (isRelayIpRateLimitedError(error) && error.retryAfterSeconds !== null) return error.retryAfterSeconds;
  return 60;
}
