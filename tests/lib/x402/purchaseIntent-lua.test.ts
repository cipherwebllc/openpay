// @vitest-environment node
import { createHash } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAddress, toHex } from 'viem';
import { createFakeRedisStore, runRedisLua, closeRedisLuaEngine, type FakeRedisStore } from '../../_helpers/redisLua';

const h = vi.hoisted(() => ({
  store: null as FakeRedisStore | null,
  revertAliasFix: false,
  calls: [] as { script: string; args: string[] }[],
  errors: [] as string[],
  // kvEval の応答の差し替え (kvEval の契約は Redis の値の形まで・script ごとの意味は呼出側が確かめる)。
  // run() を呼べば本物の Lua を実行した結果、呼ばなければ Lua を走らせずに返した値がそのまま ok:true で届く。
  reply: null as ((script: string, run: () => Promise<unknown>) => Promise<unknown>) | null,
}));
vi.mock('@/lib/env', () => ({ env: { enableCreatorStore: true, enableLicenseNft: true, networkEnv: 'testnet', licenseNftAmoy: '0x3333333333333333333333333333333333333333' } }));
vi.mock('@/lib/kv', () => ({
  kvGet: async (key: string) => ({ ok: true, value: h.store!.strings.get(key) ?? null }),
  kvSet: async (key: string, value: string, options?: { nx?: boolean; ttlSec?: number }) => {
    if (options?.nx && h.store!.strings.has(key)) return { ok: true, value: null };
    h.store!.strings.set(key, value);
    if (options?.ttlSec) h.store!.setTtl(key, options.ttlSec);
    return { ok: true, value: 'OK' };
  },
  kvEval: async (script: string, keys: string[], args: string[]) => {
    h.calls.push({ script, args });
    // 実際の finalizer が渡す Lua の1行だけを一時的に戻し、回帰検出能力も検証する。
    const variant = h.revertAliasFix
      ? script.replace('own.latestGrant = cjson.decode(ARGV[13])', 'own.latestGrant = grant')
      : script;
    try {
      const run = () => runRedisLua(variant, keys, args, h.store!);
      return { ok: true, value: h.reply ? await h.reply(script, run) : await run() };
    } catch (error) {
      // 実 kvEval と同じく Redis script error を storage failure に変換する。
      h.errors.push(String(error));
      return { ok: false, reason: 'network_error' };
    }
  },
}));
vi.mock('@/lib/chains', () => ({ chainObjectForId: () => ({}), transportForChain: () => ({}) }));
vi.mock('@/lib/x402/hostedStore', () => ({ hostedContentKey: (id: string, revision: number) => 'x402:hosted:' + id + ':content:' + revision }));
vi.mock('@/lib/x402/facilitatorSettle', () => ({ parseFacilitatorRequest: vi.fn() }));
vi.mock('@/lib/x402/paymentRedelivery', () => ({ paymentRedeliveryIdentity: vi.fn() }));

import { buildForwarderNonce } from '@/lib/relay/forwarderIntent';
import { createQuotedPurchaseIntent, claimSignedPurchaseIntent, claimPurchaseSettlement, finalizeHostedPurchase, purchaseIntentKey, purchaseLibraryKey, purchaseOwnershipKey, readSettledPurchaseAccess, type PurchaseAuthorizationClaim, type PurchaseOwnership } from '@/lib/x402/purchaseIntent';
import { createLicenseDefinition } from '@/lib/license/definition';
import { LICENSE_OBLIGATION_INDEX, licenseStockKey, licenseObligationKey, licenseReservationKey } from '@/lib/license/stock';
import { computeLicensePaymentKey } from '@/lib/license/paymentKey';
import { JPYC_V3_ASSET } from '@/lib/x402/types';

const ID = 'h_' + 'a'.repeat(32);
const MERCHANT = getAddress('0x1111111111111111111111111111111111111111');
const FORWARDER = getAddress('0x2222222222222222222222222222222222222222');
const CONTRACT = getAddress('0x3333333333333333333333333333333333333333');
const FEE = getAddress('0x4444444444444444444444444444444444444444');
const PAYER = getAddress('0x5555555555555555555555555555555555555555');
const NOW = 1_800_000_000_000;
const definition = createLicenseDefinition(ID, { supply: 2, transferable: false, termsUrl: 'https://seller.example/terms', termsVersion: 'v1' }, 80002, CONTRACT);

async function quotedInput(productKind: 'digital' | 'license', sequence: number) {
  const quoted = await createQuotedPurchaseIntent({
    resourceId: ID, contentRevision: 1,
    metadata: { ...(productKind === 'license' ? { productKind, license: definition } : {}), owner: MERCHANT, payTo: MERCHANT, title: 'Product', priceJpyc: '1000', contentKind: 'text', label: 'prompt' },
    payer: PAYER, token: JPYC_V3_ASSET.address, chainId: 80002, forwarder: FORWARDER,
    merchant: MERCHANT, merchantValue: 1000n * 10n ** 18n, feeReceiver: FEE, feeValue: 10n * 10n ** 18n,
    anchorBlock: 1n, now: NOW, intentSalt: toHex(BigInt(sequence), { size: 32 }),
  });
  if (!quoted.ok) throw new Error(quoted.reason);
  const i = quoted.intent;
  const nonce = buildForwarderNonce({ from: PAYER, merchant: MERCHANT, merchantValue: BigInt(i.merchantValue), feeReceiver: FEE, feeValue: BigInt(i.feeValue), validAfter: 0n, validBefore: BigInt(i.authorizationValidBeforeMax), intentSalt: i.intentSalt }, i.chainId, FORWARDER);
  const claim: PurchaseAuthorizationClaim = { payer: PAYER, token: i.token, chainId: i.chainId, forwarder: FORWARDER, commitVersion: i.commitVersion, merchant: MERCHANT, merchantValue: i.merchantValue, feeReceiver: FEE, feeValue: i.feeValue, validAfter: '0', validBefore: i.authorizationValidBeforeMax, nonce, signatureFingerprint: 'a'.repeat(64), resourceId: ID, contentRevision: 1, deploymentVersion: i.deploymentVersion, anchorBlock: '1' };
  return { intentSalt: i.intentSalt, claim, authorizationHash: createHash('sha256').update(JSON.stringify(claim)).digest('hex'), now: NOW + 1000 };
}

async function settling(productKind: 'digital' | 'license', sequence: number) {
  const input = await quotedInput(productKind, sequence);
  expect(await claimSignedPurchaseIntent(input)).toMatchObject({ ok: true, kind: 'claimed' });
  expect(await claimPurchaseSettlement(input)).toMatchObject({ ok: true, kind: 'claimed' });
  return input;
}

beforeEach(() => {
  h.store = createFakeRedisStore(NOW);
  h.store.strings.set(licenseStockKey(ID), JSON.stringify({ supply: 2, sold: 0, reserved: 0, gen: definition.definitionHash }));
  h.revertAliasFix = false;
  h.calls = [];
  h.errors = [];
  h.reply = null;
});
afterAll(closeRedisLuaEngine);

describe('FINALIZE_PURCHASE: Upstash cjson alias regression, actual Lua', () => {
  it.each(['digital', 'license'] as const)('%s: second purchase persists a separate latestGrant; reverting the fix fails', async (productKind) => {
    const first = await settling(productKind, 1);
    expect(await finalizeHostedPurchase({ intentSalt: first.intentSalt, txHash: toHex(101n, { size: 32 }), settledAt: NOW + 2000 })).toMatchObject({ ok: true, kind: 'finalized' });
    const ownershipKey = purchaseOwnershipKey(PAYER, ID);
    const firstRaw = h.store!.strings.get(ownershipKey)!;
    const firstOwn = JSON.parse(firstRaw) as PurchaseOwnership;
    expect(firstOwn.grants).toHaveLength(1);

    const second = await settling(productKind, 2);
    const input = { intentSalt: second.intentSalt, txHash: toHex(102n, { size: 32 }), settledAt: NOW + 3000 };
    h.revertAliasFix = true;
    expect(await finalizeHostedPurchase(input)).toEqual({ ok: false, reason: productKind === 'license' ? 'corrupt' : 'storage' });
    expect(h.calls.at(-1)!.script).toContain('own.latestGrant = cjson.decode(ARGV[13])');
    expect(h.store!.strings.get(ownershipKey)).toBe(firstRaw);
    if (productKind === 'digital') {
      expect(h.errors).toHaveLength(1);
      expect(h.errors[0]).toContain('Lua redis lib command arguments must be strings or integers');
    } else {
      expect(h.errors).toEqual([]);
      expect(JSON.parse(h.store!.strings.get(licenseStockKey(ID))!)).toMatchObject({ sold: 1, reserved: 1 });
    }

    h.revertAliasFix = false;
    const result = await finalizeHostedPurchase(input);
    expect(result).toMatchObject({ ok: true, kind: 'finalized' });
    const call = h.calls.filter(({ script }) => script.includes('own.latestGrant = cjson.decode(ARGV[13])')).at(-1)!;
    const newGrant = JSON.parse(call.args[12]!);
    expect(newGrant).toMatchObject({ intentSalt: second.intentSalt, txHash: input.txHash, purchasedAt: input.settledAt });
    const own = JSON.parse(h.store!.strings.get(ownershipKey)!) as PurchaseOwnership;
    expect(own.grants).toHaveLength(2);
    expect(own.grants).toEqual([firstOwn.grants[0], newGrant]);
    expect(own.latestGrant).toEqual(newGrant);
    expect(result).toMatchObject({ ownership: own });
    // 保存 JSON を Lua で encode→decode し、JS 側でも全フィールドが同じことを確認する。
    const roundTrip = await runRedisLua(`
      local own=cjson.decode(redis.call('GET',KEYS[1]))
      local decoded=cjson.decode(cjson.encode(own))
      return cjson.encode(decoded)
    `, [ownershipKey], [], h.store!);
    expect(JSON.parse(roundTrip as string)).toEqual(own);

    if (productKind === 'license') {
      expect(JSON.parse(h.store!.strings.get(licenseStockKey(ID))!)).toMatchObject({ sold: 2, reserved: 0 });
      const paymentKey = computeLicensePaymentKey({ paymentChainId: 80002n, paymentToken: second.claim.token, payer: PAYER, authorizationNonce: second.claim.nonce });
      const context = JSON.parse(call.args.at(-1)!);
      expect(JSON.parse(h.store!.strings.get(licenseObligationKey(paymentKey))!)).toEqual(context.obligation);
      expect(context.obligation).toMatchObject({ intentSalt: second.intentSalt, paymentKey, payment: second.claim, txHash: input.txHash, purchasedAt: input.settledAt, status: 'awaiting_finality' });
      expect(JSON.parse(h.store!.strings.get(licenseReservationKey(ID, second.intentSalt))!)).toMatchObject({ state: 'sold', paymentKey });
      expect(h.store!.zsets.get(LICENSE_OBLIGATION_INDEX)?.size).toBe(2);
    }
  });
});

// kvEval は Redis の値の形 (整数・文字列・nil・配列) までしか確かめない。script が返さない形を成功と読まないことを固定する。
// script は本文の断片で見分ける (lib/x402/purchase/* は facade 経由でしか import しない)。
const isClaimSigned = (script: string) => script.includes('decoded.claim.signatureFingerprint == ARGV[18]');
const isFinalize = (script: string) => script.includes('own.latestGrant = cjson.decode(ARGV[13])');
const isLibraryScore = (script: string) => script.trim() === "return redis.call('ZSCORE', KEYS[1], ARGV[1])";
describe('unexpected kvEval replies, actual Lua', () => {
  it('CLAIM_SIGNED_INTENT: a nil reply is not claimed; the intent stays quoted and a retry claims it', async () => {
    const input = await quotedInput('digital', 3);
    h.reply = async (script, run) => isClaimSigned(script) ? null : run();
    expect(await claimSignedPurchaseIntent(input)).toEqual({ ok: false, reason: 'storage' });
    expect(JSON.parse(h.store!.strings.get(purchaseIntentKey(input.intentSalt))!)).toMatchObject({ state: 'quoted' });
    h.reply = null;
    expect(await claimSignedPurchaseIntent(input)).toMatchObject({ ok: true, kind: 'claimed' });
  });

  it('FINALIZE_PURCHASE: a replayed finalize (2) arriving in another shape is not a first finalization', async () => {
    const first = await settling('digital', 4);
    const input = { intentSalt: first.intentSalt, txHash: toHex(104n, { size: 32 }), settledAt: NOW + 2000 };
    expect(await finalizeHostedPurchase(input)).toMatchObject({ ok: true, kind: 'finalized' });
    h.reply = async (script, run) => {
      const value = await run();
      return isFinalize(script) ? String(value) : value;
    };
    expect(await finalizeHostedPurchase(input)).toEqual({ ok: false, reason: 'storage' });
    h.reply = null;
    expect(await finalizeHostedPurchase(input)).toMatchObject({ ok: true, kind: 'idempotent' });
  });

  // ZSCORE の応答は score の文字列か nil だけ。library の欠落 (nil) が [score] / [[score]] で届くと Number() の暗黙の変換で
  // 通ってしまい、配信が既存の修復を飛ばす → 文字列でなければ storage。
  it.each([['[score]', (score: string) => [score]], ['[[score]]', (score: string) => [[score]]]])(
    'READ_LIBRARY_SCORE: a missing library entry arriving as %s is storage, not a settled access', async (_name, wrap) => {
      const first = await settling('digital', 5);
      const input = { intentSalt: first.intentSalt, txHash: toHex(105n, { size: 32 }), settledAt: NOW + 2000 };
      expect(await finalizeHostedPurchase(input)).toMatchObject({ ok: true, kind: 'finalized' });
      const library = h.store!.zsets.get(purchaseLibraryKey(PAYER))!;
      const score = String(library.get(ID));
      library.delete(ID);
      h.reply = async (script, run) => isLibraryScore(script) ? wrap(score) : run();
      expect(await readSettledPurchaseAccess(input.intentSalt)).toEqual({ ok: false, reason: 'storage' });
      h.reply = null;
      expect(await readSettledPurchaseAccess(input.intentSalt)).toEqual({ ok: false, reason: 'corrupt' });
    },
  );
});
