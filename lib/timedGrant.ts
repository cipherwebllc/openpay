// 期限付き利用権 (Pro / CSV パス等) の **DETERMINISTIC + ATOMIC** な付与プリミティブ (server 専用・KV)。
// 値 = expiresAt(ms) の素の数値文字列 (例 "1750000000000")・KV TTL = ceil((expiresAt-now)/1000) で
// 自然失効する。proPlan / csvPass がそれぞれ自分の key 名前空間で本関数を流用する (Lua の atomic max を
// 1 箇所に集約し、read-modify-write の不可分性を全 tier で共有する)。設計: plans/csv-pass.md。

import { kvEval } from './kv';

// 数値 (ms) として妥当な expiresAt を取り出す。値は素の数値文字列 (例 "1750000000000")。
export function parseExpiresAt(raw: string | null): number | null {
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
export const GRANT_MAX_SCRIPT =
  "local cur = redis.call('GET', KEYS[1]); " +
  'local target = tonumber(ARGV[1]); ' +
  'local now = tonumber(ARGV[2]); ' +
  'local final = target; ' +
  'if cur then local c = tonumber(cur); if c and c > final then final = c end end; ' +
  'local ttl = math.ceil((final - now) / 1000); if ttl < 1 then ttl = 1 end; ' +
  "redis.call('SET', KEYS[1], tostring(final), 'EX', ttl); " +
  'return tostring(final)';

// 数値 (ms) として妥当な expiresAt を取り出す。値は素の数値文字列 (例 "1750000000000")。
function parseExpiresAtMs(raw: unknown): number | null {
  if (raw === null) return null;
  // kvEval は Redis の値の形 (配列を含む) までしか確かめない。文字列・数値以外で下の .trim() が投げ、支払い後の付与
  // route を 500 にする波及を断つ (未付与の ok:false にして、route の 503 と同じ txHash の再試行に委ねる)。
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const s = typeof raw === 'number' ? String(raw) : raw;
  return parseExpiresAt(s);
}

/**
 * 支払い tx 起点の DETERMINISTIC + ATOMIC な付与。targetExpiresAtMs は呼出側 (subscribe route) が
 * 「支払い tx の block timestamp + 付与期間」で算出する (now() を使わない)。current と target の
 * max を原子的に SET し、TTL = ceil((確定 expiry - now)/1000) を張る。
 * `ok` は KV 書込成功 (false=未永続化→呼出側で付与失敗扱い・同 txHash 再提出で再試行可)。
 */
export async function grantTimedMax(
  key: string,
  targetExpiresAtMs: number,
  nowMs: number = Date.now(),
): Promise<{ ok: boolean; expiresAt: number }> {
  const res = await kvEval<unknown>(
    GRANT_MAX_SCRIPT,
    [key],
    [String(Math.floor(targetExpiresAtMs)), String(Math.floor(nowMs))],
  );
  if (!res.ok) {
    // KV 不調 → 付与未確定。target を返しつつ ok:false (route が 503 で再試行導線へ)。
    return { ok: false, expiresAt: targetExpiresAtMs };
  }
  // Lua は tostring(final) を返すので number/string 双方を許容してパースする。
  const final = parseExpiresAtMs(res.value);
  if (final === null) return { ok: false, expiresAt: targetExpiresAtMs };
  // Lua は max(既存, target) を返すので、確定した期限は必ず target 以上。それ未満 ("1"・空白 = 0 等) は付与の応答ではない。
  // 付与したと読むと、未保存のまま加入が 200 になり、同じ tx の再送も replay で付与をやり直さない波及を断つ (未付与の ok:false)。
  if (final < Math.floor(targetExpiresAtMs)) return { ok: false, expiresAt: targetExpiresAtMs };
  return { ok: true, expiresAt: final };
}
