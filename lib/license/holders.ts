import 'server-only';

import type { Address } from 'viem';
import { kvEval } from '@/lib/kv';
import { getHostedProduct, isHostedId } from '@/lib/x402/hostedStore';
import { licenseNftEnabled } from './config';
import { LICENSE_REGISTRATION_INDEX } from './product';
import { resolveLicenseRights } from './rights';

// 恒久登録 index を stable member cursor で走査。購入 index に holder を書き込まない。
const PAGE =
  'local t=redis.call("TYPE",KEYS[1]); if type(t)=="table" then t=t.ok end; ' +
  'if t~="none" and t~="zset" then return {"__storage__"} end; ' +
  'local start=0; if ARGV[1]~="" then local rank=redis.call("ZREVRANK",KEYS[1],ARGV[1]); if not rank then return {"__cursor__"} end; start=rank+1 end; ' +
  'return redis.call("ZREVRANGE",KEYS[1],start,start+7); ';

export async function listHeldLicenses(address: Address, cursor: string | null) {
  if (!licenseNftEnabled()) return { ok: false as const, reason: 'not_found' as const };
  if (cursor !== null && !isHostedId(cursor)) return { ok: false as const, reason: 'invalid_cursor' as const };
  const deadline = Date.now() + 15_000;
  const result = await kvEval<string[]>(PAGE, [LICENSE_REGISTRATION_INDEX], [cursor ?? '']);
  if (!result.ok || !Array.isArray(result.value)) return { ok: false as const, reason: 'storage_unavailable' as const };
  if (result.value[0] === '__cursor__') return { ok: false as const, reason: 'invalid_cursor' as const };
  if (result.value.some((id) => !isHostedId(id))) return { ok: false as const, reason: 'storage_unavailable' as const };
  const items = [];
  let last = cursor;
  for (const id of result.value) {
    // 多商品の遅い RPC が request 寿命を使い切らないよう、未処理 member の手前で返す。
    if (Date.now() >= deadline) return { ok: true as const, page: { items, nextCursor: last } };
    const product = await getHostedProduct(id);
    if (product === 'storage') return { ok: false as const, reason: 'storage_unavailable' as const };
    // index/key と商品 ID の破損を、別商品の保有権利として投影しない。
    if (product && product.id !== id) return { ok: false as const, reason: 'storage_unavailable' as const };
    if (product?.productKind === 'license' && product.license?.transferable && product.registration?.status === 'registered') {
      const rights = await resolveLicenseRights({ address, productId: id, definition: product.license, ownership: null });
      // RPC 不明で holder をページから消したまま cursor を進める波及を断つ。
      if (rights.entitled === null) return { ok: false as const, reason: 'license_rights_unknown' as const };
      if (rights.entitled) items.push({ resourceId: id, productKind: 'license' as const, title: product.title, contentRevision: 1,
        contentKind: 'text' as const, license: product.license, ...rights,
        state: product.contentAvailable ? 'ready' as const : 'provided-ended' as const });
    }
    last = id;
  }
  return { ok: true as const, page: { items, nextCursor: result.value.length === 8 ? last : null } };
}
