// @vitest-environment node
// 第 7 回レビュー B9: SIWE 認証済みの content / holders / library も verify・delivery と同じ型の
// RPC 同時実行枠 (本物の Lua) を通す。枠は key ごとに独立し、KV 障害は無制限の RPC 開始に変換しない。
import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { createFakeRedisStore, runRedisLua, closeRedisLuaEngine, type FakeRedisStore } from '../../_helpers/redisLua';
const h = vi.hoisted(() => ({ store: null as FakeRedisStore | null, failed: false, raw: undefined as unknown, warn: vi.fn() }));
// raw を入れると Lua を走らせずにその値を ok:true で返す (kvEval は Redis の値の形までしか確かめない)。
vi.mock('@/lib/kv', () => ({ kvEval: async (script: string, keys: string[], args: string[]) => h.failed ? { ok: false, reason: 'network_error' } : { ok: true, value: h.raw !== undefined ? h.raw : await runRedisLua(script, keys, args, h.store!) } }));
vi.mock('@/lib/logger', () => ({ logger: { warn: h.warn } }));
// 第 9 回レビュー B-02 の結合テスト用: content の権利照合 (storeContentAccess → 実物の resolveLicenseRights) を、
// 本物の Lua の枠のまま、RPC client と KV 読み出しだけ差し替えて走らせる。
const c = vi.hoisted(() => ({ product: vi.fn(), content: vi.fn(), own: vi.fn(), getBlock: vi.fn(), readContract: vi.fn() }));
vi.mock('@/lib/env', () => ({ env: { enableCreatorStore: true, enableLicenseNft: true } }));
vi.mock('@/lib/x402/hostedStore', () => ({ getHostedProduct: c.product, getHostedContent: c.content, isHostedId: (id: string) => /^h_[0-9a-f]{32}$/.test(id) }));
vi.mock('@/lib/x402/storeEntitlement', () => ({ readStoreOwnership: c.own, selectStorePurchaseGrant: vi.fn() }));
vi.mock('@/lib/license/jobs', () => ({ readLicenseProof: vi.fn(async () => ({ status: 'unknown' })) }));
vi.mock('@/lib/license/rpc', () => ({ licenseRpc: () => ({ getBlock: c.getBlock, readContract: c.readContract }) }));
import { acquireLicenseRightsBudget, releaseLicenseRightsBudget, LICENSE_RIGHTS_BUDGET_KEY, acquireLicenseResendRightsBudget, releaseLicenseResendRightsBudget, LICENSE_RESEND_RIGHTS_BUDGET_KEY } from '@/lib/license/rightsBudget';
import { acquireLicenseVerifyBudget } from '@/lib/license/verifyBudget';
import { createLicenseDefinition } from '@/lib/license/definition';
import { resolveStoreContentAccess } from '@/lib/x402/storeContentAccess';
beforeEach(() => { h.store = createFakeRedisStore(Date.now()); h.failed = false; h.raw = undefined; });
afterAll(closeRedisLuaEngine);
it('caps authenticated rights RPC at eight across instances on its own key and reclaims crashed leases', async () => {
  const base = h.store!.now();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(base);
  const claims = await Promise.all(Array.from({ length: 10 }, () => acquireLicenseRightsBudget()));
  expect(claims.filter(Boolean)).toHaveLength(8);
  expect(h.store!.zsets.get(LICENSE_RIGHTS_BUDGET_KEY)?.size).toBe(8);
  // verify / delivery の枠とは別 key (公開 API の枠を認証済み経路が食い潰さない)。
  expect(h.store!.keys()).not.toContain('store:license:verify:rpc');
  expect(h.store!.keys()).not.toContain('store:delivery:rpc');
  await releaseLicenseRightsBudget(claims[0]!); expect(await acquireLicenseRightsBudget()).not.toBeNull();
  clock.mockReturnValue(base + 60_001);
  expect(await acquireLicenseRightsBudget()).not.toBeNull(); expect(h.store!.zsets.get(LICENSE_RIGHTS_BUDGET_KEY)?.size).toBe(1);
  clock.mockRestore();
});
it('KV failure does not grant an unbounded RPC slot and release failure is safe', async () => {
  const token = await acquireLicenseRightsBudget();
  h.failed = true; expect(await acquireLicenseRightsBudget()).toBeNull();
  await expect(releaseLicenseRightsBudget(token!)).resolves.toBeUndefined();
});
// 2026-10-12 (Grok 再レビュー): 返却 (ZREM) の応答を捨てない。1 = 返した・0 = 枠に無い (60 秒 lease が返却より先に失効して
// 回収された)・KV 障害・想定外の応答のうち、1 以外は warn を残す。投げない (呼出側の権利の応答・配信へ波及させない)。
it('release warns unless the slot was actually returned, and never throws', async () => {
  const token = await acquireLicenseRightsBudget();
  await releaseLicenseRightsBudget(token!);
  expect(h.warn).not.toHaveBeenCalled();
  await expect(releaseLicenseRightsBudget(token!)).resolves.toBeUndefined();
  expect(h.warn).toHaveBeenLastCalledWith('license.rights_budget_release_failed', { outcome: 'not_held' });
  h.raw = 'OK'; await expect(releaseLicenseRightsBudget(token!)).resolves.toBeUndefined();
  expect(h.warn).toHaveBeenLastCalledWith('license.rights_budget_release_failed', { outcome: 'unexpected_reply' });
  h.raw = undefined; h.failed = true; await expect(releaseLicenseRightsBudget(token!)).resolves.toBeUndefined();
  expect(h.warn).toHaveBeenLastCalledWith('license.rights_budget_release_failed', { outcome: 'storage', reason: 'network_error' });
  expect(h.warn).toHaveBeenCalledTimes(3);
});

// 第 9 回レビュー B-02: 公開の有料 route の再送 (署名ヘッダーをオンチェーンの calldata から組み立てて匿名で送れる) は、
// 認証済み経路とも verify とも別の鍵の枠を使う。匿名の再送が枠を使い切っても、正規の利用者の権利照合は 503 にならない。
const HOLDER = '0x1111111111111111111111111111111111111111';
const ID = `h_${'a'.repeat(32)}`;
const definition = createLicenseDefinition(ID, { transferable: true, supply: 10, termsUrl: 'https://seller.example/terms', termsVersion: '1' }, 80002, '0x3333333333333333333333333333333333333333');
/** app/api/store/content と同じ admission で、譲渡可能な license の holder の本文を読む。 */
function readContentAsHolder() {
  return resolveStoreContentAccess({
    address: HOLDER, resourceId: ID, selector: { revision: null, intentSalt: null },
    admission: { acquire: acquireLicenseRightsBudget, release: releaseLicenseRightsBudget },
  });
}

it('resend rights budget caps anonymous resends at eight on its own key', async () => {
  const claims = await Promise.all(Array.from({ length: 10 }, () => acquireLicenseResendRightsBudget()));
  expect(claims.filter(Boolean)).toHaveLength(8);
  expect(h.store!.zsets.get(LICENSE_RESEND_RIGHTS_BUDGET_KEY)?.size).toBe(8);
  expect(LICENSE_RESEND_RIGHTS_BUDGET_KEY).toBe('store:license:rights:resend:rpc');
  expect(h.store!.keys()).toEqual([LICENSE_RESEND_RIGHTS_BUDGET_KEY]);
  await releaseLicenseResendRightsBudget(claims.find(Boolean)!);
  expect(h.warn).not.toHaveBeenCalled();
  expect(await acquireLicenseResendRightsBudget()).not.toBeNull();
  await releaseLicenseResendRightsBudget('not-held');
  expect(h.warn).toHaveBeenLastCalledWith('license.resend_rights_budget_release_failed', { outcome: 'not_held' });
  h.failed = true; expect(await acquireLicenseResendRightsBudget()).toBeNull();
});

it('exhausting the resend budget leaves the authenticated content path and verify able to read rights', async () => {
  c.product.mockResolvedValue({ id: ID, owner: HOLDER, payTo: HOLDER, title: 'License', priceJpyc: '300', contentKind: 'text', productKind: 'license', license: definition, contentAvailable: true, saleActive: true });
  c.content.mockResolvedValue({ kind: 'text', value: 'licensed body' });
  c.own.mockResolvedValue({ ok: true, ownership: null });
  c.getBlock.mockReset().mockResolvedValue({ number: 100n });
  c.readContract.mockReset().mockImplementation(async ({ functionName }: { functionName: string }) => functionName === 'balanceOf' ? 1n : undefined);
  // 匿名の再送が再送用の 8 枠を使い切った状態。
  const resend = await Promise.all(Array.from({ length: 8 }, () => acquireLicenseResendRightsBudget()));
  expect(resend.every(Boolean)).toBe(true);
  expect(await acquireLicenseResendRightsBudget()).toBeNull();

  // 認証済みの content 経路は、自分の枠で RPC (block・balanceOf) を読み、本文まで届く。枠は返されて空に戻る。
  expect(await readContentAsHolder()).toMatchObject({ kind: 'ready', source: 'holder', rights: { entitled: true, basis: 'holder' } });
  expect(c.getBlock).toHaveBeenCalledTimes(1);
  expect(c.readContract).toHaveBeenCalledWith(expect.objectContaining({ functionName: 'balanceOf' }));
  expect(h.store!.zsets.get(LICENSE_RIGHTS_BUDGET_KEY)?.size ?? 0).toBe(0);
  // verify (公開 API) の枠も残る。
  expect(await acquireLicenseVerifyBudget()).not.toBeNull();
  // 再送用の枠は 8 枠のまま (認証済み経路は再送の枠に触れない)。
  expect(h.store!.zsets.get(LICENSE_RESEND_RIGHTS_BUDGET_KEY)?.size).toBe(8);

  // 逆向き: 認証済み経路が自分の 8 枠を使い切っても、再送の枠は解放されれば取れる (互いに食い潰さない)。
  for (const token of resend) await releaseLicenseResendRightsBudget(token!);
  const authenticated = await Promise.all(Array.from({ length: 8 }, () => acquireLicenseRightsBudget()));
  expect(authenticated.every(Boolean)).toBe(true);
  expect(await readContentAsHolder()).toEqual({ kind: 'rights_unknown' });
  expect(await acquireLicenseResendRightsBudget()).not.toBeNull();
});
