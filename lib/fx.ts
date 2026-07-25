// JPYC⇄USDC の FX 換算と動的 QR の画面上の期限目安を扱う純粋ユーティリティ。
//
// 設計の肝:
//   - **スワップ (交換業) ではない**。店主が「1000 JPYC (≈1000 円)」と価格を入力したら、
//     その瞬間のレートで USDC 等価額を **算出して QR に焼き込む**だけ。顧客はその固定額の
//     USDC を払い、店主はその USDC をそのまま受け取る (オンチェーン変換ゼロ)。
//   - レートは生成時に固定されるため **オンチェーンのスリッページは発生しない**。レートの
//     陳腐化は短い UI カウントダウン (QR_EXPIRY_SECONDS) で正規利用者へ再計算を促す。ただし
//     QR パラメータは未署名なので、敵対的な支払者に対するサーバ強制の有効期限ではない。
//   - **チェーン非依存**: 1 USDC = R 円 は受取チェーンに依らない。decimals は token symbol で
//     決まる (JPYC=18, USDC=6)。
//   - **前提: peg**。JPYC=¥1 / USDC=$1 を仮定し usdcJpy 1 本で両建てを換算する。どちらかが
//     depeg すると換算額はその分ずれる (sanity band はグロスな異常レートのみ弾き、depeg は検知しない)。
//
// 本モジュールは React にも env にも依存しない (ユニットテスト容易・generator/route で共有)。

import { formatUnits, parseUnits } from 'viem';
import type { TokenSymbol } from './tokens';

// usdcJpy (= 1 USDC が何円か) の異常値バンド。CoinGecko が単位ミス (USD を返す等) や
// 桁化けを起こしたとき、絶対額をミスって焼き込まないための sanity guard。
// USD/JPY は近代史上 ~75〜360 の範囲なので 50〜500 は十分広い「あり得ない値」検出帯。
// app/api/market/rates/route.ts と本モジュールの単一情報源。
export const FX_RATE_MIN = 50;
export const FX_RATE_MAX = 500;

// 動的 QR を再計算する UI 上の目安 (秒)。生成時刻 + これを exp に焼き込むが、
// 未署名 URL のためサーバ側の認可条件には使わない。
export const QR_EXPIRY_SECONDS = 180;

// token symbol → decimals。token の本質的属性で不変 (lib/tokens.ts の TokenDeployment.decimals
// と一致)。fx.ts を env-free に保つためここに固定で持つ (tests/lib/fx.test.ts で drift を fence)。
const TOKEN_DECIMALS: Record<TokenSymbol, number> = {
  jpyc: 18,
  usdc: 6,
};

// レートを整数 bigint 化する際のスケール (6 桁精度)。CoinGecko は概ね 2 桁なので十分。
const RATE_SCALE = 1_000_000n;

export function rateIsSane(usdcJpy: number): boolean {
  return (
    typeof usdcJpy === 'number' &&
    Number.isFinite(usdcJpy) &&
    usdcJpy >= FX_RATE_MIN &&
    usdcJpy <= FX_RATE_MAX
  );
}

export type ConvertAnchorArgs = {
  // 店主が入力した価格 (anchor token の人間可読 decimal、例 "1000")。
  anchorAmount: string;
  // 価格の建て (= anchor) トークン。
  anchorSymbol: TokenSymbol;
  // 顧客が支払う (= target) トークン。anchorSymbol の反対。
  targetSymbol: TokenSymbol;
  // 1 USDC = usdcJpy 円。
  usdcJpy: number;
};

export type ConvertAnchorResult =
  | { ok: true; amount: string }
  | { ok: false; reason: 'out-of-band' | 'invalid-amount' };

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

// 店主の価格入力を、顧客が支払う target トークンの人間可読 decimal 文字列に換算。
// generator の amount 欄に直接入れられる形で返す。
export function convertAnchorAmount(args: ConvertAnchorArgs): ConvertAnchorResult {
  const { anchorAmount, anchorSymbol, targetSymbol, usdcJpy } = args;
  if (!rateIsSane(usdcJpy)) {
    return { ok: false, reason: 'out-of-band' };
  }
  const anchorDecimals = TOKEN_DECIMALS[anchorSymbol];
  const targetDecimals = TOKEN_DECIMALS[targetSymbol];
  let anchorAtomic: bigint;
  try {
    anchorAtomic = parseUnits(anchorAmount, anchorDecimals);
  } catch {
    return { ok: false, reason: 'invalid-amount' };
  }
  if (anchorAtomic <= 0n) {
    return { ok: false, reason: 'invalid-amount' };
  }
  const rateScaled = BigInt(Math.round(usdcJpy * Number(RATE_SCALE)));
  const tenAnchor = 10n ** BigInt(anchorDecimals);
  const tenTarget = 10n ** BigInt(targetDecimals);
  // 丸めは常に切り上げ (ceil): 顧客が円換算で下回らない = 店主保護 (dust ≤1 atomic で無視可)。
  // anchorAtomic>0 & rateScaled>0 (rateIsSane で usdcJpy≥50) なので targetAtomic は必ず ≥1。
  const targetAtomic =
    anchorSymbol === 'jpyc'
      ? // JPYC(円)→USDC(ドル): targetUSD = anchorJPY / R
        ceilDiv(anchorAtomic * tenTarget * RATE_SCALE, tenAnchor * rateScaled)
      : // USDC(ドル)→JPYC(円): targetJPY = anchorUSD * R
        ceilDiv(anchorAtomic * tenTarget * rateScaled, tenAnchor * RATE_SCALE);
  return { ok: true, amount: formatUnits(targetAtomic, targetDecimals) };
}

// ---------------------------------------------------------------------------
// last-known-good (LKG) レート急変検知 (F8・defense-in-depth)
// ---------------------------------------------------------------------------
//
// CoinGecko の障害 / MITM が ~300s のキャッシュ窓内で歪んだレートを返し、それが動的 QR に
// 焼き込まれる事故を「警告」で捕まえる (hard-reject はしない — 実際の >20% 相場変動で正当な
// マーチャントを止めないため)。FX_RATE_MIN/MAX の sanity band はそのまま維持し、その内側で
// 前回良好値 (LKG) から ±20% を超える跳ねだけを検知する。DOM/localStorage には依存しない
// 純関数 (呼出側の hook が LKG の永続化を担う)。

// LKG の鮮度上限。これより古い LKG は「無し」扱い (bootstrap・警告しない)。
export const FX_LKG_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h
// LKG から新レートへの許容乖離 (±20%)。これを超えると警告。
export const FX_DEVIATION_THRESHOLD = 0.2;

export type FxLkg = { rate: number; ts: number };

export type FxDeviationResult =
  | { warn: false }
  | { warn: true; lkgRate: number; newRate: number; deviation: number };

// LKG (前回良好レート) と新レートを比較し、警告すべきかを返す純関数。
//   - LKG が無い / 不正 / stale (24h 超) / 未来 ts → bootstrap 扱いで warn=false
//     (呼出側は新レートを LKG として silently 採用する)。
//   - 鮮度 OK かつ乖離 > ±20% → warn=true (呼出側は開示 + acknowledge を要求するが生成は止めない)。
//   - 鮮度 OK かつ乖離 ≤ ±20% → warn=false (silently 採用)。
export function fxRateDeviationWarning(
  lkg: FxLkg | null,
  newRate: number,
  nowMs: number,
): FxDeviationResult {
  if (
    !lkg ||
    !Number.isFinite(lkg.rate) ||
    lkg.rate <= 0 ||
    !Number.isFinite(newRate) ||
    newRate <= 0 ||
    !Number.isFinite(lkg.ts) ||
    lkg.ts > nowMs || // 未来 ts = 不整合 → bootstrap 扱い
    nowMs - lkg.ts > FX_LKG_MAX_AGE_MS // stale
  ) {
    return { warn: false };
  }
  const deviation = Math.abs(newRate - lkg.rate) / lkg.rate;
  if (deviation > FX_DEVIATION_THRESHOLD) {
    return { warn: true, lkgRate: lkg.rate, newRate, deviation };
  }
  return { warn: false };
}

// 有効期限 (unix 秒) を過ぎているか。expUnixSec が未定義なら期限なし扱い (false)。
export function isExpired(
  expUnixSec: number | undefined,
  nowMs: number,
): boolean {
  if (expUnixSec === undefined) return false;
  return Math.floor(nowMs / 1000) > expUnixSec;
}

// 有効期限までの残り秒。期限なし or 過ぎていれば 0。
export function secondsRemaining(
  expUnixSec: number | undefined,
  nowMs: number,
): number {
  if (expUnixSec === undefined) return 0;
  return Math.max(0, expUnixSec - Math.floor(nowMs / 1000));
}

// 残り秒を "m:ss" に整形 (カウントダウン表示用)。
export function formatRemaining(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${sec.toString().padStart(2, '0')}`;
}
