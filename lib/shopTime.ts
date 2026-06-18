// モバイル注文の時間系 純ロジック (Phase 4)。タイムゾーンは **Asia/Tokyo 固定** (UTC+9・DST 無し
// = 1951 以降 日本に夏時間は無いので固定オフセットで厳密)。JPYC=国内市場ゆえ単一 TZ で割り切る
// (越境/多拠点は将来)。すべて now (ms) を引数で受ける純関数 = テスト容易・SSR/CSR で挙動一致。
// enforcement は **advisory** (authority は on-chain・Phase1 の停止と同じ割り切り)。
// 設計: plans/restaurant-pos-roadmap.md Phase 4 §3-D。

export const TOKYO_UTC_OFFSET_MIN = 9 * 60; // +09:00 固定
const TOKYO_OFFSET_MS = TOKYO_UTC_OFFSET_MIN * 60_000;
const DAY_MS = 86_400_000;
export const PICKUP_SLOT_MIN = 15; // 受取スロットの刻み (分)
const SLOT_MS = PICKUP_SLOT_MIN * 60_000;
export const PICKUP_MAX_SLOTS = 48; // スロット候補の上限 (15分×48=12h・暴走/巨大 UI 防止)
export const MIN_LEAD_MAX = 24 * 60; // 最短受け渡し分数の上限 (24h)

/** "HH:mm" を 0..1439 の当日内分へ。形式/範囲不正は null (untrusted 入力の検証兼用)。 */
export function parseHHMM(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(v);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** 当日内分 (0..1439) → "HH:mm"。範囲外は null。 */
export function formatHHMM(minutes: number): string | null {
  if (!Number.isInteger(minutes) || minutes < 0 || minutes >= 24 * 60) return null;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** now (ms・UTC epoch) を Tokyo 壁時計に直したときの当日内分 (0..1439)。 */
export function tokyoMinutesOfDay(nowMs: number): number {
  const shifted = nowMs + TOKYO_OFFSET_MS;
  const dayMs = ((shifted % DAY_MS) + DAY_MS) % DAY_MS; // 負 epoch も正規化
  return Math.floor(dayMs / 60_000);
}

/** now (ms) の Tokyo 壁時計 "HH:mm" (受取予定時刻など表示用)。 */
export function tokyoHHMM(nowMs: number): string {
  return formatHHMM(tokyoMinutesOfDay(nowMs)) ?? '00:00';
}

/** refMs と **同じ Tokyo 当日** の、指定 Tokyo 当日内分 (0..1439) の絶対 ms。 */
export function tokyoTimeOfDayToMs(refMs: number, minutesOfDay: number): number {
  const shifted = refMs + TOKYO_OFFSET_MS;
  const dayStartShifted = Math.floor(shifted / DAY_MS) * DAY_MS; // Tokyo 当日 00:00 (shifted 軸)
  return dayStartShifted + minutesOfDay * 60_000 - TOKYO_OFFSET_MS;
}

// ms を PICKUP_SLOT_MIN 分グリッド境界へ切り上げ。Tokyo offset (540分) は 15 の倍数ゆえ UTC epoch
// の 15 分グリッドはそのまま Tokyo の :00/:15/:30/:45 に一致する (= shift 不要)。
function ceilToSlot(ms: number): number {
  return Math.ceil(ms / SLOT_MS) * SLOT_MS;
}

/**
 * ラストオーダー超過か (同日 Tokyo 時刻ベース)。lastOrder 未設定/不正は false (=制限なし)。
 * **同日セマンティクス**: `tokyoMinutesOfDay(now) >= lastOrder` で past 判定。日跨ぎ (深夜まで営業=
 * lastOrder 02:00 等) は非対応 — 夕方を誤って停止しないため、深夜営業店は本機能を使わず手動 pause
 * を使う。advisory ゆえこの割り切りで足る (誤判定の影響は受付の可否表示のみ・authority は on-chain)。
 */
export function isPastLastOrder(nowMs: number, lastOrder: string | undefined): boolean {
  const lo = parseHHMM(lastOrder);
  if (lo === null) return false;
  return tokyoMinutesOfDay(nowMs) >= lo;
}

/**
 * 最短受け渡し時刻 (ms)。`now + minLeadMinutes` を 15 分スロット境界へ切り上げ (Tokyo の
 * :00/:15/:30/:45 に整列)。minLeadMinutes 未設定/不正/負は 0 = now を次スロット境界へ切り上げ。
 */
export function earliestPickup(nowMs: number, minLeadMinutes: number | undefined): number {
  const lead =
    typeof minLeadMinutes === 'number' && Number.isFinite(minLeadMinutes) && minLeadMinutes > 0
      ? Math.min(Math.floor(minLeadMinutes), MIN_LEAD_MAX)
      : 0;
  return ceilToSlot(nowMs + lead * 60_000);
}

/**
 * 受取スロット候補 (絶対 ms・昇順)。`earliestPickup` から 15 分刻みで、lastOrder があれば **同日
 * Tokyo の lastOrder 時刻まで (その時刻も含む)**、無ければ PICKUP_MAX_SLOTS 個まで。lastOrder を
 * 既に過ぎている (lead が押し出した等) なら空配列 (= 本日の preorder 受付不可)。
 * 返り値の各 ms を顧客が選び pickupAt として注文へ付与する。
 */
export function pickupSlots(
  nowMs: number,
  minLeadMinutes: number | undefined,
  lastOrder?: string,
): number[] {
  const start = earliestPickup(nowMs, minLeadMinutes);
  const lo = parseHHMM(lastOrder);
  // 終端 (exclusive)。lastOrder あり → 同日 lastOrder を 15分グリッドへ **floor** し、その枠まで含める。
  // floor することで off-grid な lastOrder (例 13:07) でも 13:15 を出さない (= ラストオーダー超過の
  // スロットを作らない)。lastOrder なし → start から上限本数。
  const endExclusive =
    lo !== null
      ? Math.floor(tokyoTimeOfDayToMs(start, lo) / SLOT_MS) * SLOT_MS + SLOT_MS
      : start + PICKUP_MAX_SLOTS * SLOT_MS;
  const slots: number[] = [];
  for (let t = start; t < endExclusive && slots.length < PICKUP_MAX_SLOTS; t += SLOT_MS) {
    slots.push(t);
  }
  return slots;
}

/** minLeadMinutes の検証 (整数・1..MIN_LEAD_MAX)。それ以外は null (= 未設定扱い)。 */
export function sanitizeMinLead(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > MIN_LEAD_MAX) return null;
  return v;
}
