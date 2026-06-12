// OpenPay Pro (月額固定 ¥500 = 500 JPYC の前払いサブスク) の利用権ストア (server 専用・KV)。
// 店主が 500 JPYC を FEE_RECEIVER へ送金 → txHash を /api/pro/subscribe に自己申告 → on-chain 検証 →
// **支払い tx の block timestamp + 30日** を Pro 期限として付与する。ゲート対象は CSV ダウンロードのみ
// (lib/feeCurrent の a1 利用料とは別系統・両立する)。設計: plans/pro-plan.md。
//
// bypass: アルファ全開放 (entitlement と共有の ALPHA_ENTITLEMENT_BYPASS スイッチ) 中は常に pro=true
// = 課金しない。本番点灯 = NEXT_PUBLIC_ENABLE_PRO=1 + ALPHA_ENTITLEMENT_BYPASS=0 + FEE_RECEIVER 設定済。
// 値 = expiresAt(ms) の素の数値文字列 (例 "1750000000000")・KV TTL = ceil((expiresAt-now)/1000) で
// 自然失効 (固定 30d ではない・早期更新で 60日 expiry を持つ key が 30日で消える不整合を防ぐ)。

import type { Address } from 'viem';
import { kvGet, kvEval } from './kv';
import { entitlementBypass } from './entitlement';

// ¥500 / 月 (= 500 JPYC・18 decimals)。overpayment は受理するが付与は常に 30日 1 期間のみ。
export const PRO_PRICE_JPYC = 500;
export const proPriceWei = BigInt(PRO_PRICE_JPYC) * 10n ** 18n;
// 1 支払いで付与する日数。自動更新なし (手動再支払い)。
export const PRO_GRANT_DAYS = 30;
export const PRO_GRANT_MS = PRO_GRANT_DAYS * 86_400_000;

export type ProStatus = {
  pro: boolean;
  expiresAt: number | null;
  bypass: boolean;
};

function proKey(wallet: string): string {
  return `pro:exp:${wallet.toLowerCase()}`;
}

// 数値 (ms) として妥当な expiresAt を取り出す。値は素の数値文字列 (例 "1750000000000")。
function parseExpiresAt(raw: string | null): number | null {
  if (raw === null || raw === '') return null;
  const n = Number(raw.trim());
  if (!Number.isFinite(n)) return null;
  return n;
}

// 原子的 max-grant: 既存 expiry と targetExpiresAt の大きい方を SET し、その値の残り秒を TTL にする。
// read-modify-write を 1 つの Lua で不可分にすることで、(a) 2 つの並行支払いが互いを上書きしない、
// (b) 同一 txHash の再適用 (= 同じ target) が max で no-op になり冪等、を同時に満たす。
// KEYS[1]=key, ARGV[1]=targetExpiresAt(ms), ARGV[2]=nowMs。戻り = 確定した expiresAt(ms・数値)。
// TTL は ceil((final-now)/1000)・最低 1 秒 (final<=now の遅延付与でも key を一瞬は残す)。
const GRANT_MAX_SCRIPT =
  "local cur = redis.call('GET', KEYS[1]); " +
  'local target = tonumber(ARGV[1]); ' +
  'local now = tonumber(ARGV[2]); ' +
  'local final = target; ' +
  'if cur then local c = tonumber(cur); if c and c > final then final = c end end; ' +
  'local ttl = math.ceil((final - now) / 1000); if ttl < 1 then ttl = 1 end; ' +
  "redis.call('SET', KEYS[1], tostring(final), 'EX', ttl); " +
  'return tostring(final)';

/**
 * 支払い tx 起点の DETERMINISTIC + ATOMIC な付与。targetExpiresAtMs は呼出側 (subscribe route) が
 * 「支払い tx の block timestamp + 30日」で算出する (now() を使わない)。current と target の
 * max を原子的に SET し、TTL = ceil((確定 expiry - now)/1000) を張る。
 * `ok` は KV 書込成功 (false=未永続化→呼出側で付与失敗扱い・同 txHash 再提出で再試行可)。
 */
export async function grantPro(
  wallet: string,
  targetExpiresAtMs: number,
  nowMs: number = Date.now(),
): Promise<{ ok: boolean; expiresAt: number }> {
  const res = await kvEval<string | number | null>(
    GRANT_MAX_SCRIPT,
    [proKey(wallet)],
    [String(Math.floor(targetExpiresAtMs)), String(Math.floor(nowMs))],
  );
  if (!res.ok) {
    // KV 不調 → 付与未確定。target を返しつつ ok:false (route が 503 で再試行導線へ)。
    return { ok: false, expiresAt: targetExpiresAtMs };
  }
  // Lua は tostring(final) を返すので number/string 双方を許容してパースする。
  const final = parseExpiresAt(
    typeof res.value === 'number' ? String(res.value) : res.value,
  );
  if (final === null) return { ok: false, expiresAt: targetExpiresAtMs };
  return { ok: true, expiresAt: final };
}

/** KV から Pro 状態を読む。bypass 中は KV を読まず常に pro=true (expiresAt=null)。 */
export async function getProStatus(
  wallet: string,
  nowMs: number = Date.now(),
): Promise<ProStatus> {
  if (entitlementBypass()) {
    return { pro: true, expiresAt: null, bypass: true };
  }
  const res = await kvGet(proKey(wallet));
  if (!res.ok || !res.value) {
    return { pro: false, expiresAt: null, bypass: false };
  }
  const expiresAt = parseExpiresAt(res.value);
  if (expiresAt === null) {
    return { pro: false, expiresAt: null, bypass: false };
  }
  return { pro: expiresAt > nowMs, expiresAt, bypass: false };
}

/** 将来機能ゲート共通入口。.pro と同義 (bypass 込み)。 */
export async function isPro(
  wallet: Address | string,
  nowMs: number = Date.now(),
): Promise<boolean> {
  return (await getProStatus(wallet, nowMs)).pro;
}
