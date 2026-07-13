import 'server-only';

import {
  AGENT_SHOP_INDEX_KEY,
  AGENT_SHOP_INDEX_MAX,
  agentShopSummaryKey,
} from '@/lib/handleStore';
import { kvLrange, kvMget } from '@/lib/kv';
import { shopLiveKey, type ShopLiveState } from '@/lib/shopLive';
import { parseShopLiveStrictValue } from '@/lib/shopLiveStore';
import { parseShopSummary, type ShopSummary } from '@/lib/shops/query';

export type ShopSummarySnapshot = {
  summaries: readonly ShopSummary[];
};

/** index と全 materialized summary を LRANGE + MGET の 2 round-trip で確定する。 */
export async function readShopSummarySnapshot(): Promise<ShopSummarySnapshot | null> {
  const index = await kvLrange(
    AGENT_SHOP_INDEX_KEY,
    0,
    AGENT_SHOP_INDEX_MAX - 1,
  );
  if (!index.ok || !Array.isArray(index.value)) return null;
  const handles = [...new Set(index.value.filter((value) => typeof value === 'string'))];
  const values = await kvMget(handles.map(agentShopSummaryKey));
  if (
    !values.ok ||
    !Array.isArray(values.value) ||
    values.value.length !== handles.length
  ) {
    return null;
  }

  const summaries: ShopSummary[] = [];
  for (let indexPosition = 0; indexPosition < handles.length; indexPosition++) {
    const summary = parseShopSummary(values.value[indexPosition]);
    // stale/corrupt summary と別 handle のすり替わりは応答から落とす。index 順は保持する。
    if (summary && summary.handle === handles[indexPosition]) summaries.push(summary);
  }
  return { summaries };
}

/**
 * live を一括 strict read。MGET 自体の障害時は summary snapshot を捨てず、全店を判定不能 null にする。
 * これによりデータ無しへ偽装せず、課金後も acceptingNow:null の有効な snapshot を返せる。
 */
export async function readShopLiveSnapshot(
  handles: readonly string[],
): Promise<ReadonlyMap<string, ShopLiveState | null>> {
  const uniqueHandles = [...new Set(handles)];
  const values = await kvMget(uniqueHandles.map(shopLiveKey));
  const result = new Map<string, ShopLiveState | null>();
  if (
    !values.ok ||
    !Array.isArray(values.value) ||
    values.value.length !== uniqueHandles.length
  ) {
    for (const handle of uniqueHandles) result.set(handle, null);
    return result;
  }
  for (let index = 0; index < uniqueHandles.length; index++) {
    result.set(uniqueHandles[index], parseShopLiveStrictValue(values.value[index]));
  }
  return result;
}
