// CSV 24時間パス (都度 100 JPYC の前払い) の利用権ストア (server 専用・KV)。ゲート対象は会計CSV
// ダウンロードのみ (履歴の閲覧/決済受取/QR/レジ/チップは無料)。店主が 100 JPYC を FEE_RECEIVER へ
// 送金 → txHash を /api/csv-pass/subscribe に自己申告 → on-chain 検証 (from=SIWE wallet 束縛) →
// **支払い tx の block timestamp + 24時間** をパス期限として決定論的に付与する。設計: plans/csv-pass.md。
//
// bypass: アルファ全開放 (ALPHA_ENTITLEMENT_BYPASS・既定 ON) 中は常に active=true = 課金しない。
// 本番点灯 = NEXT_PUBLIC_ENABLE_CSV_PASS=1 + ALPHA_ENTITLEMENT_BYPASS=0 + FEE_RECEIVER 設定済。
// 値 = expiresAt(ms) の素の数値文字列・KV TTL = ceil((expiresAt-now)/1000) で自然失効 (timedGrant 共有)。
//
// Pro ⊃ CSV: status は csvpass:exp と pro:exp の **両方** を見て max を取る。有効な Pro (将来再点灯時)
// は CSV パス無しでも CSV を解放する (Pro 加入者へ CSV が自動付帯)。

import type { Address } from 'viem';
import { kvGet } from './kv';
import { entitlementBypass } from './entitlement';
import { grantTimedMax, parseExpiresAt } from './timedGrant';
import { logger } from './logger';

// 100 JPYC (= 18 decimals)。overpayment は受理するが付与は常に 24時間 1 期間のみ。
export const CSV_PASS_PRICE_JPYC = 100;
export const csvPassPriceWei = BigInt(CSV_PASS_PRICE_JPYC) * 10n ** 18n;
// 1 支払いで付与する時間。自動更新なし (手動再支払い)。再購入は新しい支払い時刻から 24時間 (合算しない)。
export const CSV_PASS_GRANT_HOURS = 24;
export const CSV_PASS_GRANT_MS = CSV_PASS_GRANT_HOURS * 3_600_000; // = 86_400_000

export type CsvPassStatus = {
  active: boolean;
  expiresAt: number | null;
  bypass: boolean;
};

function csvPassKey(wallet: string): string {
  return `csvpass:exp:${wallet.toLowerCase()}`;
}

// Pro の利用権 key (Pro ⊃ CSV 判定で読む)。proPlan の proKey と同一規約 (素の expiresAt ms 文字列)。
function proKey(wallet: string): string {
  return `pro:exp:${wallet.toLowerCase()}`;
}

/**
 * 支払い tx 起点の DETERMINISTIC + ATOMIC なパス付与。targetExpiresAtMs は呼出側 (subscribe route) が
 * 「支払い tx の block timestamp + 24時間」で算出する (now() を使わない)。共有プリミティブ
 * grantTimedMax が current と target の max を原子的に SET する (再購入は新しい支払い時刻起点の
 * target で max 合成・合算しない・crash-retry でも同 target なので二重付与しない)。
 */
export async function grantCsvPass(
  wallet: string,
  targetExpiresAtMs: number,
  nowMs: number = Date.now(),
): Promise<{ ok: boolean; expiresAt: number }> {
  return grantTimedMax(csvPassKey(wallet), targetExpiresAtMs, nowMs);
}

/**
 * KV から CSV パス状態を読む。bypass 中は KV を読まず常に active=true (expiresAt=null)。
 * それ以外は csvpass:exp と pro:exp を **並行** に読み、有効な方の max を実効 expiry とする
 * (Pro ⊃ CSV: 有効な Pro はパス無しでも CSV を解放)。
 *
 * KV 読み**失敗** (障害・ok:false) は「未付与 (ok:true で value 無し)」と峻別し、判明分で active を
 * 証明できないときは **fail-open (active=true)** に倒す (a1 延滞ゲートと同方針・Codex P1)。
 * fail-closed にすると障害中に paywall + 購入 CTA が出て、既保持者 (パス/Pro) に不要な 100 JPYC を
 * 払わせうる (grant は max 非合算なのでほぼ無駄になる)。失われるのは障害中の CSV 無料開放のみで、
 * 誤課金より遥かに安い。真の未付与 (両読み成功・両 key 無し/期限切れ) は従来どおり締まる。
 */
export async function getCsvPassStatus(
  wallet: Address | string,
  nowMs: number = Date.now(),
): Promise<CsvPassStatus> {
  if (entitlementBypass()) {
    return { active: true, expiresAt: null, bypass: true };
  }
  const [passRes, proRes] = await Promise.all([
    kvGet(csvPassKey(wallet)),
    kvGet(proKey(wallet)),
  ]);

  const candidates: number[] = [];
  if (passRes.ok && passRes.value) {
    const e = parseExpiresAt(passRes.value);
    if (e !== null) candidates.push(e);
  }
  if (proRes.ok && proRes.value) {
    const e = parseExpiresAt(proRes.value);
    if (e !== null) candidates.push(e);
  }

  const expiresAt = candidates.length > 0 ? Math.max(...candidates) : null;
  const knownActive = expiresAt !== null && expiresAt > nowMs;

  // 読み失敗側があり、かつ判明分で active を証明できない → 失敗側に有効な権利が
  // 眠っている可能性を否定できないので fail-open (誤って買わせない)。
  const readFailed = !passRes.ok || !proRes.ok;
  if (!knownActive && readFailed) {
    logger.warn('csvpass.status.kv-degraded', {
      passOk: passRes.ok,
      proOk: proRes.ok,
    });
    return { active: true, expiresAt: null, bypass: false };
  }

  return { active: knownActive, expiresAt, bypass: false };
}
