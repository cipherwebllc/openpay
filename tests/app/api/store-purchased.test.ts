// @vitest-environment node
// 第 10 回レビュー H-K・Codex P2-2: 購入の画面が「このウォレットはこの商品を購入済みか」だけを確かめる route
// (GET /api/store/purchased/{id})。商品の本文を返す /api/store/content/{id} と rate limit の枠を分け、
// 購入の画面の読み取りがライブラリの商品の読み取り・購入の直後の読み戻しを 429 にしないことを固定する。
// _shared (認可と rate limit)・relayGuards (枠)・readStoreOwnership (購入の記録の読み取りと検証) は実物。
// mock は境界だけ: env・SIWE session・IP の hash・KV (memory)。商品・本文・権利の確認 (RPC) は content route
// だけが読むので、この route が触れないことを見るために観測する。
import { NextResponse } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createLicenseDefinition } from '@/lib/license/definition';
import type {
  StorePurchaseGrant,
  StorePurchaseOwnership,
} from '@/lib/x402/storePaymentSnapshot';

const h = vi.hoisted(() => ({
  enabled: true,
  licenseEnabled: true,
  session: vi.fn(),
  store: new Map<string, string>(),
  counters: new Map<string, number>(),
  gets: [] as string[],
  incrs: [] as string[],
  getFails: false,
  incrFails: false,
  product: vi.fn(),
  content: vi.fn(),
  rights: vi.fn(),
}));

vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      get enableCreatorStore() {
        return h.enabled;
      },
      get enableLicenseNft() {
        return h.licenseEnabled;
      },
    },
  };
});
vi.mock('@/lib/siweSession', () => ({ requireSession: h.session }));
vi.mock('@/lib/net/ipHash', () => ({
  clientIp: () => '192.0.2.1',
  hashIpBucket: () => 'hashed-ip',
}));
// KV の境界: GET と rate limit の INCR を memory で持つ。
vi.mock('@/lib/kv', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/kv')>()),
  isKvConfigured: () => true,
  kvGet: async (key: string) => {
    h.gets.push(key);
    if (h.getFails) return { ok: false, reason: 'network_error' };
    return { ok: true, value: h.store.get(key) ?? null };
  },
  kvIncr: async (key: string) => {
    h.incrs.push(key);
    if (h.incrFails) return { ok: false, reason: 'network_error' };
    const value = (h.counters.get(key) ?? 0) + 1;
    h.counters.set(key, value);
    return { ok: true, value };
  },
}));
vi.mock('@/lib/x402/hostedStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/x402/hostedStore')>()),
  getHostedProduct: h.product,
  getHostedContent: h.content,
}));
vi.mock('@/lib/license/rights', () => ({ resolveLicenseRights: h.rights }));
vi.mock('@/lib/license/rightsBudget', () => ({
  acquireLicenseRightsBudget: async () => 'lease',
  releaseLicenseRightsBudget: async () => undefined,
}));

import { GET } from '@/app/api/store/purchased/[resourceId]/route';
import { GET as getContent } from '@/app/api/store/content/[resourceId]/route';

const ADDRESS = '0x1111111111111111111111111111111111111111';
const OTHER_ADDRESS = '0x4444444444444444444444444444444444444444';
const SELLER = '0x2222222222222222222222222222222222222222';
const ID = `h_${'a'.repeat(32)}`;
const SALT = `0x${'b'.repeat(64)}` as const;
const OLD_SALT = `0x${'c'.repeat(64)}` as const;
const TX = `0x${'ab'.repeat(32)}` as const;

const grant: StorePurchaseGrant = {
  intentSalt: SALT,
  contentRevision: 3,
  contentRef: `x402:hosted:${ID}:content:3`,
  metadata: {
    owner: SELLER,
    payTo: SELLER,
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
  purchasedAt: 1_699_000_000_000,
};
const definition = createLicenseDefinition(
  ID,
  {
    transferable: true,
    supply: 10,
    termsUrl: 'https://seller.example/terms',
    termsVersion: '1',
  },
  80002,
  '0x3333333333333333333333333333333333333333',
);
const licenseGrant: StorePurchaseGrant = {
  ...oldGrant,
  contentRef: definition.contentRef,
  metadata: {
    ...oldGrant.metadata,
    title: 'Purchased license',
    priceJpyc: '1000',
    productKind: 'license',
    license: definition,
  },
};

function ownershipRecord(
  payer: string,
  grants: StorePurchaseGrant[],
): string {
  // 保存側 (lib/x402/purchase/parse.ts) と同じ選び方: 本文の revision が大きいもの・同じなら時刻が新しいもの。
  const latestGrant = grants.reduce((latest, candidate) =>
    candidate.contentRevision > latest.contentRevision ||
    (candidate.contentRevision === latest.contentRevision &&
      candidate.purchasedAt > latest.purchasedAt)
      ? candidate
      : latest,
  );
  const record: StorePurchaseOwnership = {
    version: 1,
    policy: 'all-purchased-revisions',
    payer: payer as `0x${string}`,
    resourceId: ID,
    firstPurchasedAt: Math.min(...grants.map((g) => g.purchasedAt)),
    updatedAt: Math.max(...grants.map((g) => g.purchasedAt)),
    grants,
    latestGrant,
  };
  return JSON.stringify(record);
}

function ownKey(payer: string): string {
  return `store:own:${payer.toLowerCase()}:${ID}`;
}

function request(path: string, resourceId = ID) {
  return [
    new Request(`https://open-pay.jp${path}`),
    { params: Promise.resolve({ resourceId }) },
  ] as const;
}

const purchased = (resourceId = ID) =>
  GET(...request(`/api/store/purchased/${resourceId}`, resourceId));
const content = () => getContent(...request(`/api/store/content/${ID}`));

async function expectJson(
  response: Response,
  status: number,
  body: unknown,
): Promise<string> {
  expect(response.status).toBe(status);
  expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  expect(response.headers.get('Vary')).toBe('Cookie');
  const text = await response.text();
  // 鍵の順も含めて、これ以外の項目が無いことを見る。
  expect(text).toBe(JSON.stringify(body));
  return text;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.enabled = true;
  h.licenseEnabled = true;
  h.store.clear();
  h.counters.clear();
  h.gets = [];
  h.incrs = [];
  h.getFails = false;
  h.incrFails = false;
  h.session.mockResolvedValue({ ok: true, address: ADDRESS });
  h.product.mockResolvedValue(null);
  h.content.mockResolvedValue({ kind: 'text', value: 'secret body' });
  h.rights.mockResolvedValue({
    entitled: true,
    basis: 'holder',
    nft: { status: 'minted' },
  });
});

describe('GET /api/store/purchased/{id}', () => {
  it('Store が OFF なら、認可と KV より先に private の 404', async () => {
    h.enabled = false;
    await expectJson(await purchased(), 404, { ok: false, error: 'not_found' });
    expect(h.session).not.toHaveBeenCalled();
    expect(h.incrs).toEqual([]);
    expect(h.gets).toEqual([]);
  });

  it('未ログインは今ある 401 の形 (private headers つき)・購入の記録を読まない', async () => {
    h.session.mockResolvedValue({
      ok: false,
      response: NextResponse.json(
        { ok: false, error: 'unauthenticated' },
        { status: 401 },
      ),
    });
    await expectJson(await purchased(), 401, {
      ok: false,
      error: 'unauthenticated',
    });
    expect(h.gets).toEqual([]);
  });

  it('購入の記録があれば purchased: true と最新の購入日時だけを返す (本文・intentSalt・txHash は返さない)', async () => {
    h.store.set(ownKey(ADDRESS), ownershipRecord(ADDRESS, [oldGrant, grant]));
    const text = await expectJson(await purchased(), 200, {
      ok: true,
      purchased: true,
      purchasedAt: grant.purchasedAt,
    });
    for (const secret of ['secret body', SALT.slice(2), OLD_SALT.slice(2), TX.slice(2), 'Purchased prompt']) {
      expect(text).not.toContain(secret);
    }
    // KV の読み取りは購入の記録の key 1 つだけ (session は SIWE の境界の mock)。商品・本文・権利の確認は読まない。
    expect(h.gets).toEqual([ownKey(ADDRESS)]);
    expect(h.product).not.toHaveBeenCalled();
    expect(h.content).not.toHaveBeenCalled();
    expect(h.rights).not.toHaveBeenCalled();
  });

  it('新しい revision を買った後で古い revision の購入を済ませたときも、purchasedAt は一番新しい購入の時刻 (latestGrant の時刻ではない)', async () => {
    // revision 1 の見積もりを持ったまま別のタブで revision 2 を買い、その後で revision 1 の支払いを済ませた記録。
    // 保存側の latestGrant は revision の大きい revision 2 (古い時刻) になる。
    const newerRevisionFirst: StorePurchaseGrant = {
      ...grant,
      intentSalt: `0x${'d'.repeat(64)}`,
      nonce: `0x${'d'.repeat(64)}`,
      contentRevision: 2,
      contentRef: `x402:hosted:${ID}:content:2`,
      purchasedAt: 1_700_000_000_000,
    };
    const olderRevisionLater: StorePurchaseGrant = {
      ...oldGrant,
      purchasedAt: 1_700_000_500_000,
    };
    h.store.set(
      ownKey(ADDRESS),
      ownershipRecord(ADDRESS, [newerRevisionFirst, olderRevisionLater]),
    );
    await expectJson(await purchased(), 200, {
      ok: true,
      purchased: true,
      purchasedAt: olderRevisionLater.purchasedAt,
    });
  });

  it('同じ revision を 2 回買ったときは、新しい方の時刻', async () => {
    const again: StorePurchaseGrant = {
      ...grant,
      intentSalt: `0x${'e'.repeat(64)}`,
      nonce: `0x${'e'.repeat(64)}`,
      purchasedAt: grant.purchasedAt + 60_000,
    };
    h.store.set(ownKey(ADDRESS), ownershipRecord(ADDRESS, [grant, again]));
    await expectJson(await purchased(), 200, {
      ok: true,
      purchased: true,
      purchasedAt: again.purchasedAt,
    });
  });

  it('購入が 1 つなら、その時刻', async () => {
    h.store.set(ownKey(ADDRESS), ownershipRecord(ADDRESS, [oldGrant]));
    await expectJson(await purchased(), 200, {
      ok: true,
      purchased: true,
      purchasedAt: oldGrant.purchasedAt,
    });
  });

  it('購入の記録が無ければ purchased: false', async () => {
    await expectJson(await purchased(), 200, { ok: true, purchased: false });
    expect(h.gets).toEqual([ownKey(ADDRESS)]);
  });

  it('別のウォレットの購入の記録は見えない (読むのは session のウォレットの key だけ)', async () => {
    h.store.set(ownKey(OTHER_ADDRESS), ownershipRecord(OTHER_ADDRESS, [grant]));
    await expectJson(await purchased(), 200, { ok: true, purchased: false });
    expect(h.gets).toEqual([ownKey(ADDRESS)]);
  });

  it('購入せずに譲渡で license を持つだけのウォレットは purchased: false (content API は本文を返す相手でも)・権利の確認の RPC を呼ばない', async () => {
    // content API は、購入の記録が無くても譲渡可の license を持つウォレットへ 200 (holder) を返す。
    h.product.mockResolvedValue({
      id: ID,
      productKind: 'license',
      license: definition,
      owner: SELLER,
      payTo: SELLER,
      title: 'Current license',
      priceJpyc: '1000',
      contentKind: 'text',
      label: 'prompt',
      contentRevision: 1,
      contentAvailable: true,
      saleActive: true,
      createdAt: 1,
    });
    const holder = await content();
    expect(holder.status).toBe(200);
    expect(await holder.json()).toMatchObject({ ok: true, basis: 'holder' });
    vi.clearAllMocks();

    await expectJson(await purchased(), 200, { ok: true, purchased: false });
    expect(h.rights).not.toHaveBeenCalled();
    expect(h.product).not.toHaveBeenCalled();
  });

  it('購入した license は、譲った後も purchased: true (購入の記録は残る・権利の確認の RPC は呼ばない)', async () => {
    h.store.set(ownKey(ADDRESS), ownershipRecord(ADDRESS, [licenseGrant]));
    h.rights.mockResolvedValue({
      entitled: false,
      basis: 'holder',
      nft: { status: 'minted' },
    });
    await expectJson(await purchased(), 200, {
      ok: true,
      purchased: true,
      purchasedAt: licenseGrant.purchasedAt,
    });
    expect(h.rights).not.toHaveBeenCalled();
  });

  it('license の機能が OFF の環境では、license の購入の記録は purchased: false (content API の 404 と同じ)', async () => {
    h.licenseEnabled = false;
    h.store.set(ownKey(ADDRESS), ownershipRecord(ADDRESS, [licenseGrant]));
    await expectJson(await purchased(), 200, { ok: true, purchased: false });
  });

  it('購入の記録を読めない (storage 障害・壊れた記録) ときは 503 (画面は確認を出さずに進む)', async () => {
    h.getFails = true;
    await expectJson(await purchased(), 503, {
      ok: false,
      error: 'storage_unavailable',
    });
    h.getFails = false;
    h.store.set(ownKey(ADDRESS), '{"broken":true}');
    await expectJson(await purchased(), 503, {
      ok: false,
      error: 'storage_unavailable',
    });
  });

  it('Store の商品の id でないものは purchased: false (KV を読まない)', async () => {
    await expectJson(await purchased('not-a-product'), 200, {
      ok: true,
      purchased: false,
    });
    expect(h.gets).toEqual([]);
  });

  describe('rate limit は content と別の枠', () => {
    it('IP と session のウォレットの枠は creator-store:purchased の名前 (content の枠の key に触れない)', async () => {
      await purchased();
      expect(h.incrs).toHaveLength(2);
      expect(h.incrs[0]).toBe('iprl:v1:creator-store:purchased:hashed-ip');
      expect(h.incrs[1]).toMatch(
        new RegExp(`^rl:read:creator-store:purchased:${ADDRESS}:\\d+$`),
      );
      expect(h.incrs.some((key) => key.includes('creator-store:content'))).toBe(false);
    });

    it('この route を 60 回呼んでも、content の読み取りは 429 にならない', async () => {
      for (let index = 0; index < 60; index += 1) {
        expect((await purchased()).status).toBe(200);
      }
      // 購入の記録が無いウォレットなので content は 404 (枠の内側まで届いている = 429 ではない)。
      expect((await content()).status).toBe(404);
    });

    it('content の枠を使い切った後も、この route は 200 を返す', async () => {
      for (let index = 0; index < 60; index += 1) {
        expect((await content()).status).toBe(404);
      }
      expect((await content()).status).toBe(429);
      await expectJson(await purchased(), 200, { ok: true, purchased: false });
    });

    it('自分の枠 (60 回 / 60 秒) を超えたら 429 (Retry-After つき・購入の記録を読まない)', async () => {
      for (let index = 0; index < 60; index += 1) {
        expect((await purchased()).status).toBe(200);
      }
      h.gets = [];
      const limited = await purchased();
      await expectJson(limited, 429, { ok: false, error: 'rate_limited' });
      expect(limited.headers.get('Retry-After')).toBe('60');
      expect(h.gets).toEqual([]);
    });

    it('rate limit の storage 障害では止めない (fail-open・Store の他の route と同じ)', async () => {
      h.incrFails = true;
      h.store.set(ownKey(ADDRESS), ownershipRecord(ADDRESS, [grant]));
      await expectJson(await purchased(), 200, {
        ok: true,
        purchased: true,
        purchasedAt: grant.purchasedAt,
      });
    });
  });
});
