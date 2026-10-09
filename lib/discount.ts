// レジの任意の値引き (2026-10・plans/register-discount.md)。1 回の会計に 1 つ、小計から引く額。
// 金額はトークン単位 (JPYC は 1 JPYC = 1 円)。表示の最小単位 (JPYC 1 円・USDC 0.01) の倍数だけを扱う。
// React/DOM 非依存の純関数。レジ (作る側)・URL の parse (受ける側)・支払い画面・履歴の明細 (配賦) が共有する。
//
// 税率が混ざる会計の値引きは「値引き前の税率ごとの合計」の比で按分し (インボイス Q&A の一括値引き)、
// 値引き後の税率ごとの合計から消費税を税率ごとに 1 回丸める (lib/invoice.ts)。按分した額は支払い時に
// 明細へ固定する (HistoryLineItem.discount)。後から計算し直さない (控え・CSV がずれない)。

import { parseUnits } from 'viem';

// lib/url/shared の DECIMAL_PATTERN / exceedsTokenPrecision と同じ (url/shared → invoice → 本 module の循環 import を避けて自前で持つ)。
const DECIMAL_PATTERN = /^\d+(\.\d+)?$/;
function exceedsTokenPrecision(amountStr: string, decimals: number): boolean {
  const dot = amountStr.indexOf('.');
  return dot !== -1 && amountStr.length - dot - 1 > decimals;
}

/** 割引率の小数の桁 (2.5% など)。 */
export const DISCOUNT_PERCENT_MAX_DECIMALS = 2;
const PERCENT_PATTERN = /^\d+(\.\d{1,2})?$/;

/** 表示の最小単位 (wei)。JPYC (18 桁・表示 0 桁) = 10^18 = 1 円・USDC (6 桁・表示 2 桁) = 10^4 = 0.01。 */
export function discountUnit(decimals: number, displayDecimals: number): bigint {
  return 10n ** BigInt(Math.max(0, decimals - displayDecimals));
}

/**
 * 値引き額の文字列 (トークン単位の 10 進) を wei に。形式が正しく・0 より大きく・表示の最小単位の倍数で・
 * 小計より小さい (支払額が 0 より大きい) ときだけ返す。それ以外は null。
 */
export function parseDiscountAmount(
  raw: string,
  subtotalWei: bigint,
  decimals: number,
  displayDecimals: number,
): bigint | null {
  const s = raw.trim();
  if (!DECIMAL_PATTERN.test(s) || exceedsTokenPrecision(s, decimals)) return null;
  let wei: bigint;
  try {
    wei = parseUnits(s, decimals);
  } catch {
    return null;
  }
  if (wei <= 0n || wei % discountUnit(decimals, displayDecimals) !== 0n) return null;
  if (wei >= subtotalWei) return null;
  return wei;
}

/**
 * 割引率 (% の 10 進・小数 2 桁まで・0 より大きく 100 より小さい) から値引き額 (wei)。
 * 小計 × 率 を表示の最小単位で切り捨てる (JPYC は円未満切り捨て)。0 になる・率が不正なら null。
 */
export function discountFromPercent(
  subtotalWei: bigint,
  percentRaw: string,
  decimals: number,
  displayDecimals: number,
): bigint | null {
  const s = percentRaw.trim();
  if (!PERCENT_PATTERN.test(s)) return null;
  const [whole, frac = ''] = s.split('.');
  const bps = BigInt(whole) * 100n + BigInt(frac.padEnd(DISCOUNT_PERCENT_MAX_DECIMALS, '0'));
  if (bps <= 0n || bps >= 10000n) return null;
  const unit = discountUnit(decimals, displayDecimals);
  const raw = (subtotalWei * bps) / 10000n;
  const wei = raw - (raw % unit);
  if (wei <= 0n || wei >= subtotalWei) return null;
  return wei;
}

/**
 * 重み (= 各要素の金額) の比で total を配る。表示の最小単位 (unit) で切り捨て、余りの単位は端数の大きい順
 * (同点は重みの大きい順 → 先の順) に 1 単位ずつ。各要素は自分の重みを超えない。最小単位では置けない残り
 * (重みが単位より小さい要素ばかり等) は、余力の大きい順に wei で置く。total は Σ重み 以下であること。
 */
function apportionByWeight(weights: readonly bigint[], total: bigint, unit: bigint): bigint[] {
  const out = weights.map(() => 0n);
  const sum = weights.reduce((a, w) => a + w, 0n);
  if (total <= 0n || sum <= 0n) return out;
  const units = total / unit;
  const fracs: Array<{ i: number; frac: bigint }> = [];
  let placed = 0n;
  weights.forEach((w, i) => {
    const exact = units * w;
    out[i] = (exact / sum) * unit;
    placed += out[i];
    fracs.push({ i, frac: exact % sum });
  });
  let leftUnits = (total - placed) / unit;
  fracs.sort((a, b) =>
    a.frac !== b.frac
      ? (a.frac > b.frac ? -1 : 1)
      : weights[a.i] !== weights[b.i]
        ? (weights[a.i] > weights[b.i] ? -1 : 1)
        : a.i - b.i,
  );
  for (const { i } of fracs) {
    if (leftUnits <= 0n) break;
    if (out[i] + unit <= weights[i]) {
      out[i] += unit;
      leftUnits -= 1n;
    }
  }
  // 最小単位で置けなかった残り (と total が単位の倍数でないときの端数) を、余力の大きい順に wei で。
  let rest = total - out.reduce((a, v) => a + v, 0n);
  const byRoom = weights
    .map((w, i) => ({ i, room: w - out[i] }))
    .sort((a, b) => (a.room !== b.room ? (a.room > b.room ? -1 : 1) : a.i - b.i));
  for (const { i, room } of byRoom) {
    if (rest <= 0n) break;
    const take = room < rest ? room : rest;
    out[i] += take;
    rest -= take;
  }
  return out;
}

export type DiscountLine = {
  /** 行の金額 (値引き前・wei)。 */
  amount: bigint;
  /** 税率 (%)。未指定は null。値引きはまず税率ごとに按分する。 */
  taxRate: number | null;
};

/**
 * 値引きを明細へ配る。① 税率ごとの値引き前合計の比で税率に配り、② 各税率の中で明細の金額の比で配る。
 * 戻り値は行ごとの値引き額 (wei・合計 = discount・各行の金額を超えない)。discount が 0 以下・小計以上なら
 * 全行 0 (呼び出し側が先に parseDiscountAmount で確かめる)。
 */
export function allocateDiscount(
  lines: readonly DiscountLine[],
  discount: bigint,
  unit: bigint,
): bigint[] {
  const subtotal = lines.reduce((a, l) => a + l.amount, 0n);
  if (discount <= 0n || discount >= subtotal) return lines.map(() => 0n);
  const keyOf = (l: DiscountLine) => (l.taxRate == null ? 'none' : String(l.taxRate));
  const keys: string[] = [];
  const groupSum = new Map<string, bigint>();
  for (const l of lines) {
    const k = keyOf(l);
    if (!groupSum.has(k)) keys.push(k);
    groupSum.set(k, (groupSum.get(k) ?? 0n) + l.amount);
  }
  const groupShare = apportionByWeight(keys.map((k) => groupSum.get(k) ?? 0n), discount, unit);
  const out = lines.map(() => 0n);
  keys.forEach((k, gi) => {
    const idx = lines.map((l, i) => (keyOf(l) === k ? i : -1)).filter((i) => i >= 0);
    const shares = apportionByWeight(idx.map((i) => lines[i].amount), groupShare[gi], unit);
    idx.forEach((i, j) => {
      out[i] = shares[j];
    });
  });
  return out;
}

/**
 * 明細 1 行に配った値引き (HistoryLineItem.discount・decimal 文字列) を wei に。無い = 0n。
 * 形が不正・行の金額 (amount) を超える (= 壊れた保存値) は null (呼び出し側が「数字を出さない」側に倒す)。
 */
export function lineDiscountWei(
  li: { amount: string; discount?: string },
  decimals: number,
): bigint | null {
  if (li.discount === undefined) return 0n;
  // 保存値は壊れうる (端末の localStorage)。文字列でない・10 進でない値は数字を出さない側に倒す。
  if (typeof li.discount !== 'string' || typeof li.amount !== 'string') return null;
  if (!DECIMAL_PATTERN.test(li.discount) || exceedsTokenPrecision(li.discount, decimals)) return null;
  if (!DECIMAL_PATTERN.test(li.amount) || exceedsTokenPrecision(li.amount, decimals)) return null;
  const d = parseUnits(li.discount, decimals);
  return d <= parseUnits(li.amount, decimals) ? d : null;
}

/** 明細に配った値引きの合計 (wei)。どこか 1 行でも壊れていれば null。 */
export function lineItemsDiscountWei(
  lineItems: ReadonlyArray<{ amount: string; discount?: string }> | null | undefined,
  decimals: number,
): bigint | null {
  let sum = 0n;
  for (const li of lineItems ?? []) {
    const d = lineDiscountWei(li, decimals);
    if (d === null) return null;
    sum += d;
  }
  return sum;
}
