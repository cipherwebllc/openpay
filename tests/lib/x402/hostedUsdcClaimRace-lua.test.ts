// @vitest-environment node
// 第 10 回レビュー B2-1・B2-2 (Store の USDC 購入)。
// route (hostedUsdcPaidRoute)・intent の状態機械 (storeUsdcIntent)・rail の枠 (storeRailSelection)・署名の指紋
// (paymentRedelivery) は実物のまま、KV の Lua も本物を fake store の上で動かす。mock は境界だけ:
// facilitator (postFacilitator)・RPC (storeUsdcOnchain)・為替・商品の保存先・付帯処理 (push・集計・メトリクス)。
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAddress, type Address, type Hex } from 'viem';
import { closeRedisLuaEngine, createFakeRedisStore, runRedisLua, type FakeRedisStore } from '../../_helpers/redisLua';

const h = vi.hoisted(() => ({
  store: null as FakeRedisStore | null,
  // この request が settling への CAS を送る直前 (intent の read と rail の枠の確保の後) に 1 回ずつ走らせる、
  // 別の actor の書き込み。先頭から 1 つずつ使う。
  beforeSettlingCas: [] as (() => Promise<void>)[],
  postFacilitator: vi.fn(),
  authorizationUsed: false as boolean | 'unavailable',
  expiredUnused: false,
}));

vi.mock('server-only', () => ({}));
vi.mock('next/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next/server')>();
  return { ...actual, after: vi.fn((task: () => void) => task()) };
});
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@/lib/net/ipHash', () => ({ clientIp: () => '127.0.0.1', hashIpBucket: () => 'ip-hash' }));
vi.mock('@/lib/metrics', () => ({ recordMetric: vi.fn(async () => undefined) }));
vi.mock('@/lib/push/notify', () => ({ notifyPaymentReceived: vi.fn(async () => undefined) }));
vi.mock('@/lib/x402/purchaseStats', () => ({ recordHostedPurchase: vi.fn(async () => undefined) }));
vi.mock('@/lib/x402/storeUsdcRateProvider', () => ({
  quoteStoreJpycInUsdc: vi.fn(async () => ({
    ok: true,
    quote: {
      rate: 150,
      rateScaled: '150000000',
      fetchedAt: 1_900_000_000_000,
      usdcQuoteAtomic: '2000000',
      fxQuoteExpiresAt: 1_900_000_000_000 + 180_000,
      rounding: 'ceil',
    },
  })),
}));
vi.mock('@/lib/x402/hostedStore', () => {
  const seller = '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359';
  const product = {
    kind: 'hosted',
    id: `h_${'1'.repeat(32)}`,
    owner: seller,
    payTo: seller,
    title: 'Base USDC product',
    priceJpyc: '300',
    contentKind: 'text',
    label: 'prompt',
    contentRevision: 2,
    saleActive: true,
    contentAvailable: true,
    usdcEnabled: true,
    createdAt: 1_900_000_000_000 - 10_000,
  };
  return {
    hostedContentKey: (id: string, revision: number) => `x402:hosted:${id}:content:${revision}`,
    getHostedProduct: vi.fn(async () => product),
    getHostedContent: vi.fn(async () => ({ kind: 'text', value: 'paid content' })),
    sellerDisclosureComplete: vi.fn(async () => true),
    hostedPurchaseMetadata: () => ({
      owner: product.owner,
      payTo: product.payTo,
      title: product.title,
      priceJpyc: product.priceJpyc,
      contentKind: product.contentKind,
      label: product.label,
    }),
  };
});
vi.mock('@/lib/x402/storeUsdcOnchain', () => ({
  STORE_USDC_ADDRESS: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  STORE_USDC_CHAIN_ID: 8453,
  verifyStoreUsdcOnchain: vi.fn(async () => ({ ok: true, state: 'confirmed', blockNumber: 100n })),
  storeUsdcAuthorizationExpiredUnused: vi.fn(async () => h.expiredUnused),
  readStoreUsdcAuthorizationState: vi.fn(async () => h.authorizationUsed),
  readStoreUsdcAnchorBlock: vi.fn(async () => 114n),
  findStoreUsdcAuthorizationTransactions: vi.fn(async () => []),
  storeUsdcBoundedClient: vi.fn(),
}));
vi.mock('@/lib/x402/vanillaGate', () => ({ postFacilitator: h.postFacilitator }));
vi.mock('@/lib/x402/config', () => ({
  x402Config: { vanillaFacilitator: { url: 'https://cdp.example', cdpAuth: { keyId: 'k', keySecret: 's' } } },
}));
vi.mock('@/lib/x402/cdpJwt', () => ({ generateCdpJwt: () => 'test-jwt' }));
vi.mock('@/lib/kv', () => ({
  kvGet: async (key: string) => {
    h.store!.purgeExpired();
    return { ok: true as const, value: h.store!.strings.get(key) ?? null };
  },
  kvEval: async (script: string, keys: string[], args: string[]) => {
    // CAS_INTENT (KEYS = intent・pending・nonce) で、次の値が settling のもの = claimStoreUsdcSettlement の CAS。
    if (
      keys.length === 3 &&
      keys[0]?.startsWith('store:usdc:intent:0x') &&
      typeof args[4] === 'string' &&
      args[4].includes('"state":"settling"')
    ) {
      const actor = h.beforeSettlingCas.shift();
      if (actor) await actor();
    }
    return { ok: true as const, value: await runRedisLua(script, keys, args, h.store!) };
  },
  kvSet: vi.fn(),
  kvSetNxGet: vi.fn(),
  kvIncr: vi.fn(),
}));

import { handleHostedUsdcPaidGet } from '@/lib/x402/hostedUsdcPaidRoute';
import {
  claimStoreUsdcSettlement,
  finalizeStoreUsdcPurchase,
  getStoreUsdcIntent,
  reconcileStoreUsdcIntent,
  recordStoreUsdcTransaction,
  storeUsdcAuthorizationHash,
  storeUsdcIntentKey,
  type StoreUsdcAuthorizationClaim,
} from '@/lib/x402/storeUsdcIntent';
import { paymentSignatureFingerprint } from '@/lib/x402/paymentRedelivery';

const NOW = 1_900_000_000_000;
const RESOURCE_ID = `h_${'1'.repeat(32)}`;
// EIP-55 の例の address。checksum の形と小文字の形が違う (全部が数字の address ではこの穴は見えない)。
const PAYER = getAddress('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed');
const SELLER = getAddress('0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359');
const TX_HASH = `0x${'44'.repeat(32)}` as Hex;
const SIGNATURE = `0x${'55'.repeat(64)}1b`;
const OTHER_SIGNATURE = `0x${'66'.repeat(64)}1c`;

type Quote = { intentSalt: Hex; nonce: Hex; validBefore: string };

function request(headers?: HeadersInit): Request {
  return new Request(
    `http://test.local/api/paid/hosted/${RESOURCE_ID}?payer=${PAYER}&rail=usdc`,
    { headers },
  );
}

async function quote(): Promise<Quote> {
  const response = await handleHostedUsdcPaidGet(request(), RESOURCE_ID, PAYER);
  expect(response.status).toBe(402);
  const body = await response.json();
  const openpay = body.accepts[0].extra.openpay;
  return {
    intentSalt: openpay.intentSalt,
    nonce: openpay.nonce,
    validBefore: openpay.authorizationValidBeforeMax,
  };
}

function header(
  quoted: Quote,
  overrides: { from?: string; to?: string; validBefore?: string; signature?: string } = {},
): string {
  return Buffer.from(
    JSON.stringify({
      x402Version: 1,
      scheme: 'exact',
      network: 'base',
      payload: {
        signature: overrides.signature ?? SIGNATURE,
        authorization: {
          from: overrides.from ?? PAYER,
          to: overrides.to ?? SELLER,
          value: '2000000',
          validAfter: '0',
          validBefore: overrides.validBefore ?? quoted.validBefore,
          nonce: quoted.nonce,
        },
      },
    }),
    'utf8',
  ).toString('base64');
}

function pay(paymentHeader: string) {
  return handleHostedUsdcPaidGet(request({ 'x-payment': paymentHeader }), RESOURCE_ID, PAYER);
}

function facilitatorCalls(path: '/verify' | '/settle'): number {
  return h.postFacilitator.mock.calls.filter(([called]) => called === path).length;
}

// 保存される claim (checksum の形)。署名の指紋は実物の関数で作る。
function canonicalClaim(quoted: Quote, signature = SIGNATURE): StoreUsdcAuthorizationClaim {
  return {
    payer: PAYER,
    to: SELLER,
    value: '2000000',
    validAfter: '0',
    validBefore: quoted.validBefore,
    nonce: quoted.nonce,
    signatureFingerprint: paymentSignatureFingerprint(signature)!,
  };
}

async function stored(quoted: Quote) {
  const intent = await getStoreUsdcIntent(quoted.intentSalt);
  if (!intent || intent === 'storage' || intent === 'corrupt') throw new Error(`intent: ${String(intent)}`);
  return intent;
}

// reconcile (cron・status route) が signed の intent を見て、未使用なので再試行時刻だけを書き直す。
function rescheduleByReconcile(quoted: Quote, now: number) {
  return async () => {
    h.authorizationUsed = false;
    expect(await reconcileStoreUsdcIntent(quoted.intentSalt, { now })).toEqual({ ok: true, state: 'pending' });
  };
}

function flipFirstLetterCase(address: Address): string {
  const index = [...address].findIndex((char, position) => position >= 2 && /[a-fA-F]/.test(char));
  const char = address[index]!;
  const flipped = char === char.toUpperCase() ? char.toLowerCase() : char.toUpperCase();
  return address.slice(0, index) + flipped + address.slice(index + 1);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(Date, 'now').mockReturnValue(NOW + 5_000);
  h.store = createFakeRedisStore(NOW + 5_000);
  h.beforeSettlingCas = [];
  h.authorizationUsed = false;
  h.expiredUnused = false;
  h.postFacilitator.mockImplementation(async (path: string) =>
    path === '/verify'
      ? { isValid: true, payer: PAYER }
      : { success: true, transaction: TX_HASH, network: 'base', payer: PAYER },
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  // 用意した別の actor は全部走った (= その test は settling への CAS の直前まで本当に進んだ)。
  expect(h.beforeSettlingCas).toHaveLength(0);
});

afterAll(closeRedisLuaEngine);

describe('B2-1: USDC の claim は from / to の大文字小文字に関係なく同じ hash になる', () => {
  it('前提: この test の address は checksum の形と小文字の形が違う', () => {
    expect(PAYER).not.toBe(PAYER.toLowerCase());
    expect(SELLER).not.toBe(SELLER.toLowerCase());
  });

  it.each([
    ['from も to も checksum', PAYER, SELLER],
    ['from も to も小文字', PAYER.toLowerCase(), SELLER.toLowerCase()],
    ['from だけ小文字', PAYER.toLowerCase(), SELLER],
    ['to だけ小文字', PAYER, SELLER.toLowerCase()],
  ])('%s: verify の後に 409 にならず、同じ claim で確定する', async (_label, from, to) => {
    const quoted = await quote();
    const response = await pay(header(quoted, { from, to }));
    expect(await response.json()).toMatchObject({ ok: true, state: 'settled', value: 'paid content', txHash: TX_HASH });
    expect(response.status).toBe(200);
    expect(facilitatorCalls('/verify')).toBe(1);
    expect(facilitatorCalls('/settle')).toBe(1);
    // 保存された claim と hash は、送られた形に関係なく checksum の形の 1 通り。
    const intent = await stored(quoted);
    expect(intent).toMatchObject({
      state: 'settled',
      claim: canonicalClaim(quoted),
      authorizationHash: storeUsdcAuthorizationHash(canonicalClaim(quoted)),
    });
    // facilitator へ送る署名ヘッダーの中身は書き換えない (client が送った形のまま)。
    const settleBody = h.postFacilitator.mock.calls.find(([path]) => path === '/settle')![1];
    expect(settleBody.paymentPayload.payload.authorization).toMatchObject({ from, to });
  });

  // 全部大文字でも EIP-55 として正しい address (例: 0x52908400098527886E0F7030069857D2E4169EE7) は isAddress を通る。
  // ここの PAYER / SELLER は全部大文字にすると checksum と合わない (= checksum が壊れた形の 1 つ) ので拒まれる。
  it.each([
    ['from', 'checksum が壊れた形', (): Record<string, string> => ({ from: flipFirstLetterCase(PAYER) })],
    ['to', 'checksum が壊れた形', (): Record<string, string> => ({ to: flipFirstLetterCase(SELLER) })],
    ['from', 'checksum と合わない全部大文字の形', (): Record<string, string> => ({ from: `0x${PAYER.slice(2).toUpperCase()}` })],
    ['to', 'checksum と合わない全部大文字の形', (): Record<string, string> => ({ to: `0x${SELLER.slice(2).toUpperCase()}` })],
  ])('%s が%sの address は今までどおり verify の前に 409 invalid_payment_payload', async (_field, _kind, overrides) => {
    const quoted = await quote();
    const response = await pay(header(quoted, overrides()));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ ok: false, error: 'invalid_payment_payload' });
    expect(h.postFacilitator).not.toHaveBeenCalled();
    expect(await stored(quoted)).toMatchObject({ state: 'quoted' });
  });

  it('確定した後の再送は、小文字の形でも同じ署名として「確定済み」を返し、別の署名は今までどおり 409', async () => {
    const quoted = await quote();
    expect((await pay(header(quoted))).status).toBe(200);
    const again = await pay(header(quoted, { from: PAYER.toLowerCase(), to: SELLER.toLowerCase() }));
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: 'purchase_already_settled', state: 'settled', txHash: TX_HASH });
    const forged = await pay(header(quoted, { from: PAYER.toLowerCase(), signature: OTHER_SIGNATURE }));
    expect(forged.status).toBe(409);
    expect(await forged.json()).toEqual({ ok: false, error: 'authorization_conflict' });
    expect(facilitatorCalls('/settle')).toBe(1);
  });
});

describe('B2-2: settling への CAS が reconcile と重なっても、同じ署名ならやり直す', () => {
  it('reconcile が再試行時刻を書いた直後でも、読み直して settling を取り、settle は 1 回だけ', async () => {
    const quoted = await quote();
    h.beforeSettlingCas.push(rescheduleByReconcile(quoted, NOW + 5_001));
    const response = await pay(header(quoted));
    expect(await response.json()).toMatchObject({ ok: true, state: 'settled', txHash: TX_HASH });
    expect(response.status).toBe(200);
    expect(h.beforeSettlingCas).toHaveLength(0);
    expect(facilitatorCalls('/settle')).toBe(1);
    expect(await stored(quoted)).toMatchObject({ state: 'settled', txHash: TX_HASH });
  });

  it('やり直しは 3 回まで: 3 回続けて負けても 4 回目で取り、settle は 1 回だけ', async () => {
    const quoted = await quote();
    h.beforeSettlingCas.push(
      rescheduleByReconcile(quoted, NOW + 5_001),
      rescheduleByReconcile(quoted, NOW + 5_002),
      rescheduleByReconcile(quoted, NOW + 5_003),
    );
    const response = await pay(header(quoted));
    expect(response.status).toBe(200);
    expect(h.beforeSettlingCas).toHaveLength(0);
    expect(facilitatorCalls('/settle')).toBe(1);
  });

  it('4 回続けて負けたら今までどおり 409 purchase_rail_conflict で、settle は呼ばない。同じヘッダーの再送は通る', async () => {
    const quoted = await quote();
    h.beforeSettlingCas.push(
      rescheduleByReconcile(quoted, NOW + 5_001),
      rescheduleByReconcile(quoted, NOW + 5_002),
      rescheduleByReconcile(quoted, NOW + 5_003),
      rescheduleByReconcile(quoted, NOW + 5_004),
    );
    const response = await pay(header(quoted));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ ok: false, error: 'purchase_rail_conflict' });
    expect(h.beforeSettlingCas).toHaveLength(0);
    expect(facilitatorCalls('/settle')).toBe(0);
    expect(await stored(quoted)).toMatchObject({ state: 'signed' });

    const retried = await pay(header(quoted));
    expect(retried.status).toBe(200);
    expect(facilitatorCalls('/verify')).toBe(1);
    expect(facilitatorCalls('/settle')).toBe(1);
  });

  it('同じ署名の別の request が先に settling を取っていたら 202 pending で、この request は settle を呼ばない', async () => {
    const quoted = await quote();
    let otherAttemptId = '';
    h.beforeSettlingCas.push(async () => {
      const other = await claimStoreUsdcSettlement({ intentSalt: quoted.intentSalt });
      if (!other.ok || other.kind !== 'claimed') throw new Error('other request did not claim');
      otherAttemptId = other.intent.attemptId;
    });
    const response = await pay(header(quoted));
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ ok: true, state: 'pending' });
    expect(facilitatorCalls('/settle')).toBe(0);
    // settling を持っているのは先に取った方のまま (この request は attempt を上書きしない)。
    expect(await stored(quoted)).toMatchObject({ state: 'settling', attemptId: otherAttemptId });
  });

  it('その間に別の request が確定まで進めていたら、今ある「確定済み」の 409 を返し、settle を呼ばない', async () => {
    const quoted = await quote();
    h.beforeSettlingCas.push(async () => {
      const other = await claimStoreUsdcSettlement({ intentSalt: quoted.intentSalt });
      if (!other.ok || other.kind !== 'claimed') throw new Error('other request did not claim');
      expect(await recordStoreUsdcTransaction({
        intentSalt: quoted.intentSalt, attemptId: other.intent.attemptId, txHash: TX_HASH,
      })).toBe('updated');
      expect(await finalizeStoreUsdcPurchase({ intentSalt: quoted.intentSalt, txHash: TX_HASH }))
        .toMatchObject({ ok: true, kind: 'finalized' });
    });
    const response = await pay(header(quoted));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      ok: false, error: 'purchase_already_settled', state: 'settled', txHash: TX_HASH, resourceId: RESOURCE_ID,
    });
    expect(facilitatorCalls('/settle')).toBe(0);
  });

  it('reconcile が「署名は使用済み」と見て indeterminate にしていたら 202 pending で、settle を呼ばない', async () => {
    const quoted = await quote();
    h.beforeSettlingCas.push(async () => {
      h.authorizationUsed = true;
      expect(await reconcileStoreUsdcIntent(quoted.intentSalt, { now: NOW + 5_001 }))
        .toEqual({ ok: true, state: 'pending' });
    });
    const response = await pay(header(quoted));
    expect(response.status).toBe(202);
    expect(facilitatorCalls('/settle')).toBe(0);
    expect(await stored(quoted)).toMatchObject({ state: 'indeterminate' });
  });

  it('reconcile が期限切れの未使用として失敗にしていたら、今までどおり 409 purchase_rail_conflict で、settle を呼ばない', async () => {
    const quoted = await quote();
    h.beforeSettlingCas.push(async () => {
      h.authorizationUsed = false;
      h.expiredUnused = true;
      expect(await reconcileStoreUsdcIntent(quoted.intentSalt, { now: Number(quoted.validBefore) * 1_000 }))
        .toEqual({ ok: true, state: 'failed' });
    });
    const response = await pay(header(quoted));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ ok: false, error: 'purchase_rail_conflict' });
    expect(facilitatorCalls('/settle')).toBe(0);
    expect(await stored(quoted)).toMatchObject({ state: 'failed_prebroadcast' });
  });

  it('読み直した intent が別の署名のものなら、今までどおり 409 purchase_rail_conflict で、settle を呼ばず intent も書き換えない', async () => {
    const quoted = await quote();
    let replaced = '';
    h.beforeSettlingCas.push(async () => {
      // 公開の関数からはこの状態にならない (signed の後に claim を書き換える経路は無い) ので、KV を直接書き換える。
      // やり直しの回でこれを拒むのは rail の枠の Lua (CLAIM_RAIL: 取得済みの枠と authorizationHash が違えば conflict)。
      const key = storeUsdcIntentKey(quoted.intentSalt);
      const current = JSON.parse(h.store!.strings.get(key)!);
      const claim = canonicalClaim(quoted, OTHER_SIGNATURE);
      replaced = JSON.stringify({ ...current, claim, authorizationHash: storeUsdcAuthorizationHash(claim) });
      h.store!.strings.set(key, replaced);
    });
    const response = await pay(header(quoted));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ ok: false, error: 'purchase_rail_conflict' });
    expect(facilitatorCalls('/settle')).toBe(0);
    expect(h.store!.strings.get(storeUsdcIntentKey(quoted.intentSalt))).toBe(replaced);
  });
});
