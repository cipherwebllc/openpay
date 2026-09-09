import { NextResponse } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Hex } from 'viem';
import { createLicenseDefinition } from '@/lib/license/definition';
import type { LicenseRights, LicenseRightsChain } from '@/lib/license/rights';
import type { HostedProduct } from '@/lib/x402/hostedStore';
import type {
  StorePurchaseGrant,
  StorePurchaseOwnership,
} from '@/lib/x402/storePaymentSnapshot';

const h = vi.hoisted(() => ({
  enabled: true,
  licenseEnabled: true,
  session: vi.fn(),
  ipLimit: vi.fn(),
  addressLimit: vi.fn(),
  own: vi.fn(),
  product: vi.fn(),
  content: vi.fn(),
  rights: vi.fn(),
  proof: vi.fn(),
  calls: [] as string[],
}));
vi.mock('@/lib/env', () => ({
  env: {
    get enableCreatorStore() { return h.enabled; },
    get enableLicenseNft() { return h.licenseEnabled; },
  },
}));
// _shared と license/config は実物を使い、private headers と可視性も固定する。
vi.mock('@/app/api/auth/siwe/_session', () => ({ requireSession: h.session }));
vi.mock('@/lib/net/ipHash', () => ({
  clientIp: () => '192.0.2.1',
  hashIp: () => 'hashed-ip',
}));
vi.mock('@/lib/relay/relayGuards', () => ({
  checkIpRateLimit: h.ipLimit,
  checkReadRateLimit: h.addressLimit,
}));
vi.mock('@/lib/x402/hostedStore', () => ({
  getHostedProduct: h.product,
  getHostedContent: h.content,
  isHostedId: (id: string) => /^h_[0-9a-f]{32}$/.test(id),
}));
vi.mock('@/lib/x402/storeEntitlement', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/x402/storeEntitlement')>();
  return { ...actual, readStoreOwnership: h.own };
});
vi.mock('@/lib/x402/purchaseIntent', () => ({
  purchaseLibraryKey: vi.fn(),
  purchaseOwnershipKey: vi.fn(),
  parsePurchaseOwnership: vi.fn(),
}));
vi.mock('@/lib/license/rights', () => ({ resolveLicenseRights: h.rights }));
vi.mock('@/lib/license/jobs', () => ({ readLicenseProof: h.proof }));
vi.mock('@/lib/license/rpc', () => ({ licenseRpc: vi.fn() }));

import { GET } from '@/app/api/store/content/[resourceId]/route';

const ADDRESS = '0x1111111111111111111111111111111111111111';
const ID = `h_${'a'.repeat(32)}`;
const OTHER_ID = `h_${'b'.repeat(32)}`;
const SALT: Hex = `0x${'b'.repeat(64)}`;
const OLD_SALT: Hex = `0x${'c'.repeat(64)}`;
const TX: Hex = `0x${'ab'.repeat(32)}`;
const OLD_TX: Hex = `0x${'cd'.repeat(32)}`;
const definition = createLicenseDefinition(ID, {
  transferable: true,
  supply: 10,
  termsUrl: 'https://seller.example/terms',
  termsVersion: '1',
}, 80002, '0x3333333333333333333333333333333333333333');
const grant: StorePurchaseGrant = {
  intentSalt: SALT,
  contentRevision: 3,
  contentRef: `x402:hosted:${ID}:content:3`,
  metadata: {
    owner: ADDRESS,
    payTo: ADDRESS,
    title: 'Purchased prompt',
    priceJpyc: '300',
    contentKind: 'text',
    label: 'prompt',
  },
  chainId: 80002,
  nonce: SALT,
  purchasedAt: 1_700_000_000_000,
  txHash: TX,
};
const oldGrant: StorePurchaseGrant = {
  ...grant,
  intentSalt: OLD_SALT,
  nonce: OLD_SALT,
  contentRevision: 1,
  contentRef: `x402:hosted:${ID}:content:1`,
  metadata: { ...grant.metadata, title: 'Older purchased prompt' },
  purchasedAt: 1_699_999_999_000,
  txHash: OLD_TX,
};
function ownership(grants = [oldGrant, grant]): StorePurchaseOwnership {
  return {
    version: 1,
    policy: 'all-purchased-revisions',
    payer: ADDRESS,
    resourceId: ID,
    firstPurchasedAt: grants[0].purchasedAt,
    updatedAt: grants.at(-1)!.purchasedAt,
    grants,
    latestGrant: grants.at(-1)!,
  };
}
const product: HostedProduct = {
  ...grant.metadata,
  id: ID,
  title: 'Current product title',
  contentRevision: 99,
  contentAvailable: true,
  saleActive: true,
  createdAt: 1_600_000_000_000,
};
const licenseProduct: HostedProduct = {
  ...product,
  productKind: 'license',
  license: definition,
  title: 'Current license title',
};
const licenseGrant: StorePurchaseGrant = {
  ...oldGrant,
  contentRef: definition.contentRef,
  metadata: {
    ...oldGrant.metadata,
    title: 'Purchased license title',
    productKind: 'license',
    license: definition,
  },
};
const holderRights: LicenseRights = {
  entitled: true,
  basis: 'holder',
  nft: { status: 'minted', mintTxHash: TX },
  observedBlock: '100',
};

function request(query = '', resourceId = ID) {
  return GET(new Request(`https://open-pay.jp/api/store/content/${resourceId}${query}`), {
    params: Promise.resolve({ resourceId }),
  });
}

// JSON のキー順も現行 serializer の wire contract として固定する。
async function expectHttp(response: Response, status: number, body: unknown) {
  expect(response.status).toBe(status);
  expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  expect(response.headers.get('Vary')).toBe('Cookie');
  expect(response.headers.get('Content-Type')).toBe('application/json');
  const text = await response.text();
  expect(text).toBe(JSON.stringify(body));
  expect(JSON.parse(text)).toEqual(body);
}
const denied = { ok: false, error: 'not_found' };
const storage = { ok: false, error: 'storage_unavailable' };
const unknown = { ok: false, error: 'license_rights_unknown' };
function purchaseBody(selected = grant, state = 'ready', kind = 'text', value = 'secret body') {
  return {
    ok: true,
    state,
    resourceId: ID,
    title: selected.metadata.title,
    contentRevision: selected.contentRevision,
    intentSalt: selected.intentSalt,
    purchasedAt: selected.purchasedAt,
    txHash: selected.txHash,
    ...(state === 'ready' ? { kind, value } : {}),
  };
}
function holderBody(state = 'ready', rights = holderRights) {
  return {
    ok: true,
    productKind: 'license',
    resourceId: ID,
    title: 'Current license title',
    contentRevision: 1,
    license: definition,
    ...rights,
    state,
    ...(state === 'ready' ? { kind: 'text', value: 'secret body' } : {}),
  };
}
function useLicensePurchase(grants = [licenseGrant]) {
  const own = ownership(grants);
  h.own.mockResolvedValue({ ok: true, ownership: own });
  h.product.mockResolvedValue(licenseProduct);
  return own;
}
function useHolder() {
  h.own.mockResolvedValue({ ok: true, ownership: null });
  h.product.mockResolvedValue(licenseProduct);
}

beforeEach(() => {
  vi.resetAllMocks();
  h.enabled = true;
  h.licenseEnabled = true;
  h.calls = [];
  h.session.mockResolvedValue({ ok: true, address: ADDRESS });
  h.ipLimit.mockResolvedValue(true);
  h.addressLimit.mockResolvedValue(true);
  h.own.mockImplementation(async () => {
    h.calls.push('own');
    return { ok: true, ownership: ownership() };
  });
  h.product.mockImplementation(async () => {
    h.calls.push('product');
    return product;
  });
  h.content.mockImplementation(async () => {
    h.calls.push('content');
    return { kind: 'text', value: 'secret body' };
  });
  h.rights.mockResolvedValue(holderRights);
  h.proof.mockResolvedValue({ status: 'minted', mintTxHash: TX });
});

describe('store content HTTP characterization: entry and selection', () => {
  it('creator store OFF precedes authentication and invalid selectors', async () => {
    h.enabled = false;
    await expectHttp(await request('?revision=0'), 404, denied);
    expect(h.ipLimit).not.toHaveBeenCalled();
    expect(h.session).not.toHaveBeenCalled();
    expect(h.own).not.toHaveBeenCalled();
  });

  it.each([
    [401, 'unauthenticated'],
    [503, 'session_storage_unavailable'],
  ])('authentication failure %s precedes selector parsing', async (status, error) => {
    h.session.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ ok: false, error }, { status }),
    });
    await expectHttp(await request('?revision=0'), status, { ok: false, error });
    expect(h.own).not.toHaveBeenCalled();
  });

  it.each(['ip', 'address'])('%s rate limit keeps private 429 and Retry-After', async (scope) => {
    (scope === 'ip' ? h.ipLimit : h.addressLimit).mockResolvedValue(false);
    const response = await request();
    await expectHttp(response, 429, { ok: false, error: 'rate_limited' });
    expect(response.headers.get('Retry-After')).toBe('60');
    expect(h.own).not.toHaveBeenCalled();
  });

  it.each([
    'revision=', 'revision=0', 'revision=-1', 'revision=01',
    'revision=1.0', 'revision=1e0', 'revision=%201', 'revision=%2B1',
    'revision=9007199254740992', 'revision=1&revision=1', 'revision=1&revision=2',
    'intentSalt=', 'intentSalt=0x1234', `intentSalt=0x${'B'.repeat(64)}`,
    `intentSalt=0X${'b'.repeat(64)}`, `intentSalt=0x${'b'.repeat(63)}`,
    `intentSalt=0x${'b'.repeat(65)}`, `intentSalt=${SALT}&intentSalt=${SALT}`,
    `intentSalt=${SALT}&intentSalt=${OLD_SALT}`,
  ])('invalid/duplicate selector %s is exactly 400', async (query) => {
    await expectHttp(await request(`?${query}`), 400, { ok: false, error: 'invalid_selector' });
    expect(h.session).toHaveBeenCalledOnce();
    expect(h.own).not.toHaveBeenCalled();
    expect(h.product).not.toHaveBeenCalled();
  });

  it('non-owner with license NFT OFF is the same private 404', async () => {
    h.licenseEnabled = false;
    h.own.mockResolvedValue({ ok: true, ownership: null });
    await expectHttp(await request(), 404, denied);
    expect(h.product).not.toHaveBeenCalled();
  });

  it.each(['invalid', `h_${'A'.repeat(32)}`])('invalid resource ID %s is 404', async (id) => {
    h.own.mockResolvedValue({ ok: true, ownership: null });
    await expectHttp(await request('', id), 404, denied);
    expect(h.own).toHaveBeenCalledWith(ADDRESS, id);
    expect(h.product).not.toHaveBeenCalled();
  });

  it.each(['storage', 'corrupt'])('ownership %s is 503 before any product lookup', async (reason) => {
    h.own.mockResolvedValue({ ok: false, reason });
    await expectHttp(await request(), 503, storage);
    expect(h.product).not.toHaveBeenCalled();
    expect(h.rights).not.toHaveBeenCalled();
  });

  it.each([
    '?revision=99', '?revision=9007199254740991',
    `?intentSalt=0x${'d'.repeat(64)}`, `?revision=3&intentSalt=${OLD_SALT}`,
  ])('missing selected grant %s never falls back to latest or holder', async (query) => {
    await expectHttp(await request(query), 404, denied);
    expect(h.product).not.toHaveBeenCalled();
    expect(h.rights).not.toHaveBeenCalled();
  });

  it.each(['', '?ignored=value', '?revision=3', `?intentSalt=${SALT}`])('latest digital grant %s keeps all provenance', async (query) => {
    await expectHttp(await request(query), 200, purchaseBody());
    expect(h.calls).toEqual(['own', 'product', 'content']);
    expect(h.own).toHaveBeenCalledWith(ADDRESS, ID);
    expect(h.content).toHaveBeenCalledWith(ID, 3);
    expect(h.rights).not.toHaveBeenCalled();
    expect(h.ipLimit).toHaveBeenCalledWith('creator-store:content', 'hashed-ip', 60, 60);
    expect(h.addressLimit).toHaveBeenCalledWith(`creator-store:content:${ADDRESS}`, 60, 60);
  });

  it.each(['?revision=1', `?intentSalt=${OLD_SALT}`, `?revision=1&intentSalt=${OLD_SALT}`])('historical digital grant %s keeps the purchased title and transaction', async (query) => {
    await expectHttp(await request(query), 200, purchaseBody(oldGrant));
    expect(h.content).toHaveBeenCalledWith(ID, 1);
  });

  it('revision selects the latest repurchase of that revision', async () => {
    const repurchase = { ...oldGrant, intentSalt: `0x${'d'.repeat(64)}` as Hex, purchasedAt: grant.purchasedAt + 1 };
    h.own.mockResolvedValue({ ok: true, ownership: ownership([oldGrant, grant, repurchase]) });
    await expectHttp(await request('?revision=1'), 200, purchaseBody(repurchase));
  });
});

describe('store content HTTP characterization: purchased content', () => {
  it('digital access survives license NFT OFF and sale paused', async () => {
    h.licenseEnabled = false;
    h.product.mockResolvedValue({ ...product, saleActive: false });
    await expectHttp(await request(), 200, purchaseBody());
    expect(h.rights).not.toHaveBeenCalled();
  });

  it('URL content keeps the purchased kind and URL', async () => {
    const urlGrant = { ...grant, metadata: { ...grant.metadata, contentKind: 'url' as const } };
    h.own.mockResolvedValue({ ok: true, ownership: ownership([urlGrant]) });
    h.content.mockResolvedValue({ kind: 'url', value: 'https://seller.example/file.zip' });
    await expectHttp(await request(), 200, purchaseBody(urlGrant, 'ready', 'url', 'https://seller.example/file.zip'));
  });

  it('USDC digital purchase has exactly the legacy HTTP fields', async () => {
    const usdcGrant: StorePurchaseGrant = {
      ...grant,
      chainId: 8453,
      payment: {
        version: 1,
        rail: 'usdc',
        asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        assetSymbol: 'USDC',
        chainId: 8453,
        paidAtomic: '2000000',
        priceJpyc: '300',
        quote: { rateScaled: '150000000', rateFetchedAt: 1000, fxQuoteExpiresAt: 2000, rounding: 'ceil' },
      },
    };
    h.own.mockResolvedValue({ ok: true, ownership: ownership([usdcGrant]) });
    await expectHttp(await request(), 200, purchaseBody());
    expect(h.rights).not.toHaveBeenCalled();
  });

  it('missing product is the same 404 as non-ownership', async () => {
    h.product.mockResolvedValue(null);
    await expectHttp(await request(), 404, denied);
    expect(h.content).not.toHaveBeenCalled();
  });

  it.each(['grant', 'product'])('license-invisible %s is 404', async (hidden) => {
    h.licenseEnabled = false;
    if (hidden === 'grant') h.own.mockResolvedValue({ ok: true, ownership: ownership([licenseGrant]) });
    else h.product.mockResolvedValue(licenseProduct);
    await expectHttp(await request(), 404, denied);
    if (hidden === 'grant') expect(h.product).not.toHaveBeenCalled();
    expect(h.rights).not.toHaveBeenCalled();
    expect(h.content).not.toHaveBeenCalled();
  });

  it.each(['product', 'content'])('%s storage failure is 503', async (boundary) => {
    (boundary === 'product' ? h.product : h.content).mockResolvedValue('storage');
    await expectHttp(await request(), 503, storage);
  });

  it('purchase embedded-ID mismatch is 503, even if content is ended', async () => {
    h.product.mockResolvedValue({ ...product, id: OTHER_ID, contentAvailable: false });
    await expectHttp(await request(), 503, storage);
    expect(h.content).not.toHaveBeenCalled();
  });

  it.each(['unavailable', 'missing'])('%s content keeps complete provided-ended provenance', async (boundary) => {
    if (boundary === 'unavailable') h.product.mockResolvedValue({ ...product, contentAvailable: false });
    else h.content.mockResolvedValue(null);
    await expectHttp(await request('?revision=1'), 200, purchaseBody(oldGrant, 'provided-ended'));
    if (boundary === 'unavailable') expect(h.content).not.toHaveBeenCalled();
    else expect(h.content).toHaveBeenCalledWith(ID, 1);
  });

  it('purchased content kind mismatch is 503', async () => {
    h.content.mockResolvedValue({ kind: 'url', value: 'https://seller.example/file' });
    await expectHttp(await request(), 503, storage);
  });

  it.each(['purchase', 'holder'] as const)('license rights basis %s still serializes purchase provenance only', async (basis) => {
    const own = useLicensePurchase([licenseGrant, grant]);
    // 現在の商品定義でなく、選択 grant の定義と全 ownership を権利判定へ渡す。
    h.product.mockResolvedValue({ ...licenseProduct, license: { ...definition, termsVersion: 'current' } });
    h.rights.mockResolvedValue({ ...holderRights, basis });
    await expectHttp(await request('?revision=1'), 200, purchaseBody(licenseGrant));
    expect(h.rights).toHaveBeenCalledWith({ address: ADDRESS, productId: ID, definition, ownership: own });
  });

  it.each([
    { entitled: null, status: 503, body: unknown },
    { entitled: false, status: 404, body: denied },
  ])('license entitlement $entitled is checked before provided-ended', async ({ entitled, status, body }) => {
    useLicensePurchase();
    h.product.mockResolvedValue({ ...licenseProduct, contentAvailable: false });
    h.rights.mockResolvedValue({ ...holderRights, entitled });
    await expectHttp(await request(), status, body);
    expect(h.content).not.toHaveBeenCalled();
  });

  it('entitled license purchase keeps provided-ended purchase fields', async () => {
    useLicensePurchase();
    h.content.mockResolvedValue(null);
    await expectHttp(await request(), 200, purchaseBody(licenseGrant, 'provided-ended'));
  });
});

describe('store content HTTP characterization: incoming holder', () => {
  beforeEach(useHolder);

  it.each(['', '?revision=1'])('selector %s returns holder fields without purchase provenance', async (query) => {
    await expectHttp(await request(query), 200, holderBody());
    expect(h.rights).toHaveBeenCalledWith({ address: ADDRESS, productId: ID, definition, ownership: null });
    expect(h.content).toHaveBeenCalledWith(ID, 1);
  });

  it('omitted optional rights fields remain omitted', async () => {
    const rights: LicenseRights = { entitled: true, basis: 'holder', nft: { status: 'minted' } };
    h.rights.mockResolvedValue(rights);
    await expectHttp(await request(), 200, holderBody('ready', rights));
  });

  it('sale paused and missing registration do not deny a holder', async () => {
    h.product.mockResolvedValue({ ...licenseProduct, saleActive: false });
    await expectHttp(await request(), 200, holderBody());
  });

  it.each(['?revision=2', `?intentSalt=${SALT}`, `?revision=1&intentSalt=${SALT}`])('selector %s is 404 before product/rights lookup', async (query) => {
    await expectHttp(await request(query), 404, denied);
    expect(h.product).not.toHaveBeenCalled();
    expect(h.rights).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'missing product', value: null },
    { name: 'digital product', value: product },
    { name: 'missing definition', value: { ...licenseProduct, license: undefined } },
    { name: 'nontransferable product', value: { ...licenseProduct, license: { ...definition, transferable: false } } },
    { name: 'embedded-ID mismatch', value: { ...licenseProduct, id: OTHER_ID } },
  ])('$name is 404 without resolving rights', async ({ value }) => {
    h.product.mockResolvedValue(value);
    await expectHttp(await request(), 404, denied);
    expect(h.rights).not.toHaveBeenCalled();
    expect(h.content).not.toHaveBeenCalled();
  });

  it.each(['product', 'content'])('holder %s storage failure is 503', async (boundary) => {
    (boundary === 'product' ? h.product : h.content).mockResolvedValue('storage');
    await expectHttp(await request(), 503, storage);
    if (boundary === 'product') expect(h.rights).not.toHaveBeenCalled();
  });

  it.each([
    { entitled: null, status: 503, body: unknown },
    { entitled: false, status: 404, body: denied },
  ])('holder entitlement $entitled precedes provided-ended', async ({ entitled, status, body }) => {
    h.product.mockResolvedValue({ ...licenseProduct, contentAvailable: false });
    h.rights.mockResolvedValue({ ...holderRights, entitled });
    await expectHttp(await request(), status, body);
    expect(h.content).not.toHaveBeenCalled();
  });

  it.each(['unavailable', 'missing'])('%s holder content keeps provided-ended rights fields', async (boundary) => {
    if (boundary === 'unavailable') h.product.mockResolvedValue({ ...licenseProduct, contentAvailable: false });
    else h.content.mockResolvedValue(null);
    await expectHttp(await request('?revision=1'), 200, holderBody('provided-ended'));
    if (boundary === 'unavailable') expect(h.content).not.toHaveBeenCalled();
    else expect(h.content).toHaveBeenCalledWith(ID, 1);
  });

  it('holder content must be text even if product contentKind is url', async () => {
    h.product.mockResolvedValue({ ...licenseProduct, contentKind: 'url' });
    h.content.mockResolvedValue({ kind: 'url', value: 'https://seller.example/file' });
    await expectHttp(await request(), 503, storage);
  });
});

describe('store content HTTP characterization with real license rights and injected chain/proof', () => {
  let chain: LicenseRightsChain;

  beforeEach(async () => {
    useLicensePurchase();
    chain = {
      block: vi.fn(async () => 100n),
      balance: vi.fn(async () => 0n),
      consumed: vi.fn<LicenseRightsChain['consumed']>(async () => ({ id: BigInt(definition.tokenId), to: ADDRESS })),
    };
    const actual = await vi.importActual<typeof import('@/lib/license/rights')>('@/lib/license/rights');
    h.rights.mockImplementation((input: Parameters<typeof actual.resolveLicenseRights>[0]) =>
      actual.resolveLicenseRights({ ...input, chain }));
  });

  it('nontransferable purchase survives burn and proof storage failure without RPC', async () => {
    const nontransferable = { ...licenseGrant, metadata: { ...licenseGrant.metadata, license: { ...definition, transferable: false } } };
    useLicensePurchase([nontransferable]);
    h.proof.mockRejectedValue(new Error('proof unavailable'));
    await expectHttp(await request(), 200, purchaseBody(nontransferable));
    expect(h.proof).toHaveBeenCalledOnce();
    expect(chain.block).not.toHaveBeenCalled();
  });

  it('transferable pre-mint unconsumed purchase remains entitled despite minted proof', async () => {
    vi.mocked(chain.consumed).mockResolvedValue({ id: 0n, to: '0x0000000000000000000000000000000000000000' });
    await expectHttp(await request(), 200, purchaseBody(licenseGrant));
  });

  it('current holder with ownership keeps purchase HTTP provenance', async () => {
    vi.mocked(chain.balance).mockResolvedValue(1n);
    await expectHttp(await request(), 200, purchaseBody(licenseGrant));
    expect(chain.consumed).not.toHaveBeenCalled();
  });

  it.each(['transferred away', 'burned'])('consumed purchase with zero balance (%s) is 404', async () => {
    await expectHttp(await request(), 404, denied);
    expect(chain.consumed).toHaveBeenCalledOnce();
    expect(h.content).not.toHaveBeenCalled();
  });

  it('incoming holder without ownership receives revision 1 and observed rights', async () => {
    useHolder();
    vi.mocked(chain.balance).mockResolvedValue(1n);
    await expectHttp(await request('?revision=1'), 200, holderBody('ready', {
      entitled: true, basis: 'holder', nft: { status: 'minted' }, observedBlock: '100',
    }));
    expect(h.proof).not.toHaveBeenCalled();
    expect(chain.consumed).not.toHaveBeenCalled();
  });

  it('incoming nonholder without ownership is 404', async () => {
    useHolder();
    await expectHttp(await request(), 404, denied);
  });

  it('an unconsumed second grant retains access after a consumed first grant', async () => {
    const repurchase = { ...licenseGrant, nonce: SALT, intentSalt: SALT, purchasedAt: grant.purchasedAt };
    useLicensePurchase([licenseGrant, repurchase]);
    vi.mocked(chain.consumed)
      .mockResolvedValueOnce({ id: BigInt(definition.tokenId), to: ADDRESS })
      .mockResolvedValueOnce({ id: 0n, to: '0x0000000000000000000000000000000000000000' });
    await expectHttp(await request(`?intentSalt=${OLD_SALT}`), 200, purchaseBody(licenseGrant));
    expect(chain.consumed).toHaveBeenCalledTimes(2);
  });

  it('grant-limit overflow is unknown after 40 consumed grants', async () => {
    const grants = Array.from({ length: 41 }, (_, index) => ({
      ...licenseGrant,
      nonce: `0x${index.toString(16).padStart(64, '0')}` as Hex,
      intentSalt: `0x${index.toString(16).padStart(64, '0')}` as Hex,
      purchasedAt: licenseGrant.purchasedAt + index,
    }));
    useLicensePurchase(grants);
    await expectHttp(await request(), 503, unknown);
    expect(chain.consumed).toHaveBeenCalledTimes(40);
  });

  it.each(['block', 'balance', 'consumed'] as const)('RPC %s failure remains unknown', async (boundary) => {
    vi.mocked(chain[boundary]).mockRejectedValue(new Error('RPC unavailable'));
    await expectHttp(await request(), 503, unknown);
    expect(h.content).not.toHaveBeenCalled();
  });
});
