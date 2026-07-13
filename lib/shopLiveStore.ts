// shop:live の KV I/O (server 専用)。pure ロジックは lib/shopLive.ts。
// - 読取は **fail-open** (KV 未設定/障害時は制限なし=注文可)。advisory 原則 + 静的
//   storefront.acceptingOrders は別途効くため、live 読取の失敗で公開ページを壊さない。
// - 書込は **楽観 CAS + リトライ** で複数端末 (店主の builder / Phase3 キッチン) の同時
//   トグルによる lost-update を防ぐ (handleStore の CAS_UPDATE と同流儀)。

import { kvGet, kvEval, isKvConfigured } from '@/lib/kv';
import { logger } from '@/lib/logger';
import {
  shopLiveKey,
  parseShopLive,
  serializeShopLive,
  applyShopLivePatch,
  EMPTY_SHOP_LIVE,
  type ShopLiveState,
  type ShopLivePatch,
} from '@/lib/shopLive';

// 現在値が expected と一致 (または両方未存在) のときだけ next を SET する楽観 CAS。
// 実保存値は必ず JSON ('{' 始まり) ゆえ、未存在の sentinel に空文字 '' を使える (衝突しない)。
// 戻り: 1=書込成功 / 0=競合 (read→write の隙に別書込が割り込み → 呼出側がリトライ)。
const CAS_SET =
  "local c=redis.call('GET',KEYS[1]); " +
  "if ((not c) and ARGV[1]=='') or c==ARGV[1] then redis.call('SET',KEYS[1],ARGV[2]); return 1 end; " +
  'return 0';

const CAS_MAX_RETRY = 3;

/** handle のライブ状態を読む。KV 未設定/障害は EMPTY (fail-open)。 */
export async function readShopLive(handle: string): Promise<ShopLiveState> {
  if (!isKvConfigured()) return { ...EMPTY_SHOP_LIVE };
  const res = await kvGet(shopLiveKey(handle));
  if (!res.ok) {
    // fail-open (制限なし) だが outage を黙殺しない: 観測できるよう warn (公開ページは壊さない)。
    // ※ KV 全断時は @handle ページが resolveHandle 段階で先に 5xx になるため、ここに到達するのは
    //   shop:live 読取だけが transient に失敗した狭いケース。
    logger.warn('shop.live.read_failed', { reason: res.reason });
    return { ...EMPTY_SHOP_LIVE };
  }
  return parseShopLive(res.value);
}

/**
 * strict read 用の raw validator。未保存は「停止指定なし」の正常状態だが、壊れた保存値は
 * 判定不能として null にする。公開ページ向け parseShopLive の fail-open 契約は変更しない。
 */
export function parseShopLiveStrictValue(
  raw: string | null,
): ShopLiveState | null {
  if (raw === null) return { ...EMPTY_SHOP_LIVE };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const rawSoldOut = record.soldOut;
  if (
    !Array.isArray(rawSoldOut) ||
    rawSoldOut.some((item) => typeof item !== 'string') ||
    typeof record.paused !== 'boolean' ||
    typeof record.updatedAt !== 'number' ||
    !Number.isSafeInteger(record.updatedAt) ||
    record.updatedAt < 0
  ) {
    return null;
  }
  const parsed = parseShopLive(raw);
  // sanitize で値が変わる保存データは、全品売切判定に使うには不確実なので fail-open しない。
  if (
    parsed.soldOut.length !== rawSoldOut.length ||
    parsed.soldOut.some((item, index) => item !== rawSoldOut[index])
  ) {
    return null;
  }
  return parsed;
}

/** Shops API 向け strict read。KV 未設定/障害/保存値破損は判定不能の null。 */
export async function readShopLiveStrict(
  handle: string,
): Promise<ShopLiveState | null> {
  if (!isKvConfigured()) return null;
  const res = await kvGet(shopLiveKey(handle));
  if (!res.ok) {
    // 検索 API で「受付中」と誤表示する波及を断つため、既存 readShopLive と異なり fail-open しない。
    logger.warn('shop.live.strict_read_failed', { reason: res.reason });
    return null;
  }
  return parseShopLiveStrictValue(res.value);
}

export type ApplyShopLiveResult =
  | { ok: true; state: ShopLiveState }
  | { ok: false; reason: 'kv_error' | 'conflict' };

/** パッチを CAS で適用 (read→modify→CAS-set・競合は最大 CAS_MAX_RETRY 回リトライ)。 */
export async function applyShopLive(
  handle: string,
  patch: ShopLivePatch,
  nowMs: number,
): Promise<ApplyShopLiveResult> {
  if (!isKvConfigured()) return { ok: false, reason: 'kv_error' };
  const key = shopLiveKey(handle);
  for (let attempt = 0; attempt < CAS_MAX_RETRY; attempt++) {
    const cur = await kvGet(key);
    if (!cur.ok) return { ok: false, reason: 'kv_error' };
    const prevRaw = cur.value; // string | null
    const next = applyShopLivePatch(parseShopLive(prevRaw), patch, nowMs);
    const expected = prevRaw === null ? '' : prevRaw; // 未存在は '' sentinel (実値は '{' 始まりで衝突せず)
    const cas = await kvEval<number>(CAS_SET, [key], [expected, serializeShopLive(next)]);
    if (!cas.ok) return { ok: false, reason: 'kv_error' };
    if (cas.value === 1) return { ok: true, state: next };
    // cas.value === 0: 競合 → 再読込してリトライ
  }
  return { ok: false, reason: 'conflict' };
}
