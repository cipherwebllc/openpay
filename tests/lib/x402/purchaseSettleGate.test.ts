// creator-store v4 契約 A: 汎用 settle 入口の hosted intent gate。
// intent fixture は実 createQuotedPurchaseIntent の保存 JSON から作り、
// nonce / signatureFingerprint は gate と同じ実導出 (buildForwarderNonce /
// paymentSignatureFingerprint) を使う — 導出式の drift をテストでも検出する。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type { Address, Hex } from 'viem';

const h = vi.hoisted(() => ({
  kvConfigured: true,
  kvGet: vi.fn(),
  kvSet: vi.fn(),
  kvEval: vi.fn(),
  loggerWarn: vi.fn(),
}));

vi.mock('@/lib/kv', () => ({
  isKvConfigured: () => h.kvConfigured,
  kvGet: h.kvGet,
  kvSet: h.kvSet,
  kvEval: h.kvEval,
}));

vi.mock('@/lib/logger', () => ({
  logger: {
    warn: h.loggerWarn,
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('@/lib/chains', () => ({
  chainObjectForId: (chainId: number) => ({ id: chainId }),
  transportForChain: () => ({}),
}));

vi.mock('@/lib/x402/hostedStore', () => ({
  hostedContentKey: (resourceId: string, revision: number) =>
    `store:hosted:content:${resourceId}:${revision}`,
}));

vi.mock('@/lib/x402/facilitatorSettle', () => ({
  parseFacilitatorRequest: vi.fn(() => ({
    ok: false,
    reason: 'not used by settle-gate test',
  })),
}));

import {
  buildForwarderNonce,
  type ForwarderSettleParams,
} from '@/lib/relay/forwarderIntent';
import { paymentSignatureFingerprint } from '@/lib/x402/paymentRedelivery';
import {
  createQuotedPurchaseIntent,
  parsePurchaseIntent,
  purchaseIntentKey,
  type PurchaseAuthorizationClaim,
} from '@/lib/x402/purchaseIntent';
import {
  checkHostedIntentSettleAdmission,
  hostedSettleGateIntentKey,
} from '@/lib/x402/purchaseSettleGate';

const CHAIN_ID = 137;
const PAYER = '0x00000000000000000000000000000000000000a1' as Address;
const MERCHANT = '0x00000000000000000000000000000000000000b2' as Address;
const FEE_RECEIVER = '0x00000000000000000000000000000000000000c3' as Address;
const TOKEN = '0x00000000000000000000000000000000000000d4' as Address;
const FORWARDER = '0x00000000000000000000000000000000000000e5' as Address;
const SALT =
  '0x1111111111111111111111111111111111111111111111111111111111111111' as Hex;
const BASE_NOW = 1_753_800_000_000;
// 実 parse 可能な 65-byte 署名 (r,s 32byte + v=27)。
const SIGNATURE = (`0x${'11'.repeat(32)}${'22'.repeat(32)}1b`) as Hex;
const OTHER_SIGNATURE = (`0x${'33'.repeat(32)}${'44'.repeat(32)}1b`) as Hex;

function params(
  overrides: Partial<ForwarderSettleParams> = {},
): ForwarderSettleParams {
  return {
    from: PAYER,
    merchant: MERCHANT,
    merchantValue: 100n,
    feeReceiver: FEE_RECEIVER,
    feeValue: 2n,
    validAfter: 0n,
    validBefore: BigInt(Math.floor(BASE_NOW / 1000) + 600),
    intentSalt: SALT,
    ...overrides,
  };
}

let storedQuoted: Record<string, unknown> | null = null;

async function buildQuotedJson(): Promise<Record<string, unknown>> {
  if (storedQuoted) return storedQuoted;
  let captured: string | null = null;
  h.kvSet.mockImplementation(async (_key: string, value: string) => {
    captured = value;
    return { ok: true, value: 'OK' };
  });
  const quoted = await createQuotedPurchaseIntent({
    resourceId: 'h_gate',
    contentRevision: 1,
    metadata: {
      owner: MERCHANT,
      payTo: MERCHANT,
      title: 'Gate fixture',
      priceJpyc: '100',
      contentKind: 'url',
      label: 'download',
    },
    payer: PAYER,
    token: TOKEN,
    chainId: CHAIN_ID,
    forwarder: FORWARDER,
    merchant: MERCHANT,
    merchantValue: 100n,
    feeReceiver: FEE_RECEIVER,
    feeValue: 2n,
    anchorBlock: 10n,
    now: BASE_NOW,
    intentSalt: SALT,
  });
  expect(quoted.ok).toBe(true);
  expect(captured).not.toBeNull();
  storedQuoted = JSON.parse(captured!) as Record<string, unknown>;
  return storedQuoted;
}

function claimFor(
  signature: Hex,
  p: ForwarderSettleParams,
): PurchaseAuthorizationClaim {
  const fingerprint = paymentSignatureFingerprint(signature);
  expect(fingerprint).not.toBeNull();
  // 順序は purchaseIntent parseClaim の返却順と一致させる (authorizationHash が順序依存)。
  // アドレスは parseClaim が checksum 正規化してから hash するため、保存済み record の
  // checksum 形式をそのまま使う (小文字のまま hash すると authorizationHash 不一致で parse 不能)。
  return {
    payer: storedQuoted!.payerHint as Address,
    token: storedQuoted!.token as Address,
    chainId: CHAIN_ID,
    forwarder: storedQuoted!.forwarder as Address,
    commitVersion: (storedQuoted!.commitVersion as Hex),
    merchant: storedQuoted!.merchant as Address,
    merchantValue: p.merchantValue.toString(),
    feeReceiver: storedQuoted!.feeReceiver as Address,
    feeValue: p.feeValue.toString(),
    validAfter: p.validAfter.toString(),
    validBefore: p.validBefore.toString(),
    nonce: buildForwarderNonce(p, CHAIN_ID, FORWARDER).toLowerCase() as Hex,
    signatureFingerprint: fingerprint!,
    resourceId: 'h_gate',
    contentRevision: 1,
    deploymentVersion: (storedQuoted!.deploymentVersion as string),
    anchorBlock: '10',
  };
}

async function intentJson(
  state: 'quoted' | 'signed' | 'settling' | 'indeterminate' | 'settled',
  signature: Hex = SIGNATURE,
): Promise<string> {
  const quoted = await buildQuotedJson();
  if (state === 'quoted') return JSON.stringify(quoted);
  const claim = claimFor(signature, params());
  const claimed: Record<string, unknown> = {
    ...quoted,
    state,
    claim,
    authorizationHash: createHash('sha256')
      .update(JSON.stringify(claim))
      .digest('hex'),
    signedAt: BASE_NOW + 1_000,
  };
  if (state !== 'signed') {
    claimed.attemptId = 'ab'.repeat(32);
    claimed.attempt = 1;
    claimed.settlementStartedAt = BASE_NOW + 2_000;
    claimed.leaseUntil = BASE_NOW + 62_000;
  }
  if (state === 'indeterminate') claimed.indeterminateAt = BASE_NOW + 3_000;
  if (state === 'settled') {
    delete claimed.attemptId;
    delete claimed.attempt;
    delete claimed.settlementStartedAt;
    delete claimed.leaseUntil;
    claimed.txHash = `0x${'ef'.repeat(32)}`;
    claimed.settledAt = BASE_NOW + 3_000;
  }
  const raw = JSON.stringify(claimed);
  // fixture 自体が実 schema で parse 可能であることを固定 (壊れた fixture での偽 green を防ぐ)。
  expect(parsePurchaseIntent(raw)).not.toBeNull();
  return raw;
}

function kvReturns(value: string | null) {
  h.kvGet.mockImplementation(async (key: string) => {
    expect(key).toBe(purchaseIntentKey(SALT));
    return { ok: true, value };
  });
}

beforeEach(() => {
  h.kvConfigured = true;
  h.kvGet.mockReset();
  h.loggerWarn.mockReset();
});

describe('checkHostedIntentSettleAdmission', () => {
  it('gate の key 形式は purchaseIntentKey と一致する (依存を切った代償の drift フェンス)', () => {
    expect(hostedSettleGateIntentKey(SALT)).toBe(purchaseIntentKey(SALT));
  });


  it('store intent が存在しない salt は素通し (allow)', async () => {
    kvReturns(null);
    await expect(
      checkHostedIntentSettleAdmission({
        params: params(),
        chainId: CHAIN_ID,
        signature: SIGNATURE,
      }),
    ).resolves.toBe('allow');
  });

  it('KV 未構成環境は read せず allow (hosted intent は作成不能)', async () => {
    h.kvConfigured = false;
    await expect(
      checkHostedIntentSettleAdmission({
        params: params(),
        chainId: CHAIN_ID,
        signature: SIGNATURE,
      }),
    ).resolves.toBe('allow');
    expect(h.kvGet).not.toHaveBeenCalled();
  });

  it('settling + 完全一致 (params/nonce/署名) は allow', async () => {
    kvReturns(await intentJson('settling'));
    await expect(
      checkHostedIntentSettleAdmission({
        params: params(),
        chainId: CHAIN_ID,
        signature: SIGNATURE,
      }),
    ).resolves.toBe('allow');
  });

  it('settled + 完全一致の再送は allow (下流の冪等 cache に委ねる)', async () => {
    kvReturns(await intentJson('settled'));
    await expect(
      checkHostedIntentSettleAdmission({
        params: params(),
        chainId: CHAIN_ID,
        signature: SIGNATURE,
      }),
    ).resolves.toBe('allow');
  });

  it('settling でも別署名は denied (同一 intent への別署名 broadcast 封鎖)', async () => {
    kvReturns(await intentJson('settling'));
    await expect(
      checkHostedIntentSettleAdmission({
        params: params(),
        chainId: CHAIN_ID,
        signature: OTHER_SIGNATURE,
      }),
    ).resolves.toBe('denied');
  });

  it('settling でも params 改変 (nonce 不一致) は denied', async () => {
    kvReturns(await intentJson('settling'));
    await expect(
      checkHostedIntentSettleAdmission({
        params: params({ merchantValue: 101n }),
        chainId: CHAIN_ID,
        signature: SIGNATURE,
      }),
    ).resolves.toBe('denied');
  });

  it.each(['quoted', 'signed', 'indeterminate'] as const)(
    '%s 状態への直接 broadcast は一致していても denied',
    async (state) => {
      kvReturns(await intentJson(state));
      await expect(
        checkHostedIntentSettleAdmission({
          params: params(),
          chainId: CHAIN_ID,
          signature: SIGNATURE,
        }),
      ).resolves.toBe('denied');
    },
  );

  it('KV 構成済みの read 障害は storage (fail-open で迂回を通さない)', async () => {
    h.kvGet.mockResolvedValue({ ok: false });
    await expect(
      checkHostedIntentSettleAdmission({
        params: params(),
        chainId: CHAIN_ID,
        signature: SIGNATURE,
      }),
    ).resolves.toBe('storage');
  });

  it('hosted intent key の破損 record は storage (素通し禁止)', async () => {
    kvReturns('{"broken":true}');
    await expect(
      checkHostedIntentSettleAdmission({
        params: params(),
        chainId: CHAIN_ID,
        signature: SIGNATURE,
      }),
    ).resolves.toBe('storage');
  });
});
