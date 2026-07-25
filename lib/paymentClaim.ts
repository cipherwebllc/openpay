// FEE_RECEIVER 宛 JPYC tx の用途横断 claim。Pro / CSV / 月次清算 / standard 注文手数料が
// 同じ chainId×txHash キーを共有し、1 本の送金を複数商品へ二重利用する競合を Redis NX/EVAL で断つ。

const PAYMENT_CLAIMED_KEY_PREFIX = 'payment:claimed:';
const PAYMENT_CLAIM_PENDING_PREFIX = 'p:';
const PAYMENT_CLAIM_RESULT_PREFIX = 'r:';

export type PaymentClaimKind =
  | 'pro'
  | 'csvpass'
  | 'billing'
  | 'order'
  | 'register';

export function paymentClaimKey(chainId: number, txHash: string): string {
  return `${PAYMENT_CLAIMED_KEY_PREFIX}${chainId}:${txHash.toLowerCase()}`;
}

/** global claim 導入前から存在する billing settle の txHash 冪等キー。移行期間の二重利用検査に使う。 */
export function legacyBillingPaymentKey(
  chainId: number,
  txHash: string,
): string {
  return `billing:settled:${chainId}:${txHash.toLowerCase()}`;
}

/**
 * Pro / CSV の既存 production 値 `p:{"tier":...,"owner":...}` を byte 同等に保つ。
 * 新用途も同じ envelope を共有し、旧 reader は未知 tier を確定 claim と誤認しない。
 */
export function paymentClaimPendingValue(
  kind: PaymentClaimKind,
  owner: string,
): string {
  return `${PAYMENT_CLAIM_PENDING_PREFIX}${JSON.stringify({
    tier: kind,
    owner,
  })}`;
}

/** Pro / CSV の既存 production 値 `r:pro` / `r:csvpass` を byte 同等に保つ。 */
export function paymentClaimResultValue(kind: PaymentClaimKind): string {
  return `${PAYMENT_CLAIM_RESULT_PREFIX}${kind}`;
}

export function parsePaymentClaimKind(
  value: string | null,
): PaymentClaimKind | null {
  if (!value) return null;
  if (value.startsWith(PAYMENT_CLAIM_RESULT_PREFIX)) {
    const kind = value
      .slice(PAYMENT_CLAIM_RESULT_PREFIX.length)
      .split(':', 1)[0];
    return isPaymentClaimKind(kind) ? kind : null;
  }
  if (!value.startsWith(PAYMENT_CLAIM_PENDING_PREFIX)) return null;
  try {
    const parsed = JSON.parse(
      value.slice(PAYMENT_CLAIM_PENDING_PREFIX.length),
    ) as { tier?: unknown };
    return isPaymentClaimKind(parsed.tier) ? parsed.tier : null;
  } catch {
    return null;
  }
}

function isPaymentClaimKind(value: unknown): value is PaymentClaimKind {
  return (
    value === 'pro' ||
    value === 'csvpass' ||
    value === 'billing' ||
    value === 'order' ||
    value === 'register'
  );
}

/** 自分が置いた pending/result だけを解放し、他用途が同時取得した claim の削除波及を断つ。 */
export const RELEASE_PAYMENT_CLAIM_IF_OWNED =
  'if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) else return 0 end';

/**
 * global claim 導入前の billing:settled と payment:claimed を同時確認して恒久 claim を置く。
 * 戻り: 1=取得、0=global 既存、-1=legacy billing 既存。確認と SET を同じ Lua に閉じ、
 * order/entitlement が legacy billing tx をすり抜けて先取りする race の波及を断つ。
 */
export const CLAIM_PAYMENT_UNLESS_LEGACY_BILLING =
  "if redis.call('EXISTS',KEYS[2])==1 then return -1 end; " +
  "if redis.call('EXISTS',KEYS[1])==1 then return 0 end; " +
  "redis.call('SET',KEYS[1],ARGV[1]); return 1";
