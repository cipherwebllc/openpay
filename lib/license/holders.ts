import 'server-only';

import type { Address } from 'viem';
import { kvEval } from '@/lib/kv';
import { getHostedProduct, isHostedId } from '@/lib/x402/hostedStore';
import { licenseNftEnabled } from './config';
import type { LicenseDefinition } from './definition';
import { LICENSE_REGISTRATION_INDEX } from './product';
import { resolveLicenseRights, type LicenseRights } from './rights';
import { pageScopedLicenseRightsAdmission } from './rightsAdmission';
import { acquireLicenseRightsBudget, releaseLicenseRightsBudget } from './rightsBudget';

// 恒久登録 index を stable member cursor で走査。購入 index に holder を書き込まない。
const PAGE =
  'local t=redis.call("TYPE",KEYS[1]); if type(t)=="table" then t=t.ok end; ' +
  'if t~="none" and t~="zset" then return {"__storage__"} end; ' +
  'local start=0; if ARGV[1]~="" then local rank=redis.call("ZREVRANK",KEYS[1],ARGV[1]); if not rank then return {"__cursor__"} end; start=rank+1 end; ' +
  'return redis.call("ZREVRANGE",KEYS[1],start,start+7); ';

// 1 ページの権利照合全体の期限。商品ごとの RPC 期限にも共有する (第 7 回レビュー B13)。
const HOLDERS_PAGE_DEADLINE_MS = 15_000;

type HeldLicenseItem = LicenseRights & {
  resourceId: string;
  productKind: 'license';
  title: string;
  contentRevision: 1;
  contentKind: 'text';
  license: LicenseDefinition;
  state: 'ready' | 'provided-ended';
};

export async function listHeldLicenses(address: Address, cursor: string | null) {
  if (!licenseNftEnabled()) return { ok: false as const, reason: 'not_found' as const };
  if (cursor !== null && !isHostedId(cursor)) return { ok: false as const, reason: 'invalid_cursor' as const };
  const deadline = Date.now() + HOLDERS_PAGE_DEADLINE_MS;
  const result = await kvEval<string[]>(PAGE, [LICENSE_REGISTRATION_INDEX], [cursor ?? '']);
  if (!result.ok || !Array.isArray(result.value)) return { ok: false as const, reason: 'storage_unavailable' as const };
  if (result.value[0] === '__cursor__') return { ok: false as const, reason: 'invalid_cursor' as const };
  if (result.value.some((id) => !isHostedId(id))) return { ok: false as const, reason: 'storage_unavailable' as const };
  const items: HeldLicenseItem[] = [];
  let last = cursor;
  // 期限到達は RPC 障害と区別し、確認済みの holder と「未処理商品の直前」の cursor を部分ページとして返す
  // (未処理商品は飛ばさず、続きの呼び出しが同じ商品から前進する・第 7 回レビュー B13 follow-up)。
  // 1 件も処理できていなければ同じ cursor の再試行でも前進しないので、従来どおり unknown (503) にする。
  const partialPage = () => last !== cursor
    ? { ok: true as const, page: { items, nextCursor: last } }
    : { ok: false as const, reason: 'license_rights_unknown' as const };
  // 権利照合 (RPC) は verify/delivery と同じ型の同時実行枠を通す (第 7 回レビュー B9)。枠は resolver が最初の
  // RPC の直前に 1 request 1 枠で取り、ページ全体で持つ (各商品は直列なので同時 RPC は枠数を超えない)。
  const page = pageScopedLicenseRightsAdmission({ acquire: acquireLicenseRightsBudget, release: releaseLicenseRightsBudget });
  try {
    for (const id of result.value) {
      // 多商品の遅い RPC が request 寿命を使い切らないよう、未処理 member の手前で返す。
      if (Date.now() >= deadline) return partialPage();
      const product = await getHostedProduct(id);
      if (product === 'storage') return { ok: false as const, reason: 'storage_unavailable' as const };
      // index/key と商品 ID の破損を、別商品の保有権利として投影しない。
      if (product && product.id !== id) return { ok: false as const, reason: 'storage_unavailable' as const };
      if (product?.productKind === 'license' && product.license?.transferable && product.registration?.status === 'registered') {
        const rights = await resolveLicenseRights({ address, productId: id, definition: product.license, ownership: null, deadline, admission: page.admission });
        if (rights.entitled === null) {
          // 商品の途中で期限を越えた (共有期限で RPC が拒否された) なら部分ページ。それ以外の RPC 不明 (枠不足・
          // 枠の KV 障害を含む) で holder をページから消したまま cursor を進める波及は断つ。
          return Date.now() >= deadline ? partialPage() : { ok: false as const, reason: 'license_rights_unknown' as const };
        }
        if (rights.entitled) items.push({ resourceId: id, productKind: 'license' as const, title: product.title, contentRevision: 1,
          contentKind: 'text' as const, license: product.license, ...rights,
          state: product.contentAvailable ? 'ready' as const : 'provided-ended' as const });
      }
      last = id;
    }
    return { ok: true as const, page: { items, nextCursor: result.value.length === 8 ? last : null } };
  } finally {
    await page.close();
  }
}
