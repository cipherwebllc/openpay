import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { getAddress } from 'viem';

const routeMocks = vi.hoisted(() => ({
  verify: vi.fn(),
  settle: vi.fn(),
}));

const verificationMocks = vi.hoisted(() => ({
  snapshot: {} as Record<string, { checkedAt: string; ok: boolean; sourceUrl: string }> | null,
  read: vi.fn(),
}));

vi.mock('@/lib/directory/verification', () => ({
  readDirectoryVerificationSnapshot: async () => {
    verificationMocks.read();
    return verificationMocks.snapshot;
  },
}));

vi.mock('@/app/api/facilitator/verify/route', () => ({
  POST: routeMocks.verify,
}));
vi.mock('@/app/api/facilitator/settle/route', () => ({
  POST: routeMocks.settle,
}));

const FORWARDER = getAddress('0x752b7aad0089286eb7b553d84d05233d80c9fcb4');
const FEE_RECEIVER = getAddress('0x428483d2bd5E9f0e9f8E9f8e9F8E9F8E9f8e9F8e');
const JPYC_AMOY = getAddress('0x00000000000000000000000000000000000Ca11a');
const SELLER = getAddress('0x1234567890123456789012345678901234567890');
const PAYER = getAddress('0xAbCAbCabcAbCAbcAbcAbCABcabcAbCABcaBCaBcA');
const TX_HASH = `0x${'cd'.repeat(32)}`;

type PaidRoute = { GET: (req: Request) => Promise<Response> };
type DetailRoute = {
  GET: (
    req: Request,
    ctx: { params: Promise<{ slug: string }> },
  ) => Promise<Response>;
};

function paymentPayload() {
  return {
    x402Version: 1,
    scheme: 'exact',
    network: 'eip155:80002',
    payload: {
      signature: `0x${'0'.repeat(63)}1${'0'.repeat(63)}21b`,
      authorization: {
        from: PAYER,
        validAfter: '0',
        validBefore: '9999999999',
        intentSalt: `0x${'22'.repeat(32)}`,
      },
    },
  };
}

function paymentHeader(): string {
  return Buffer.from(JSON.stringify(paymentPayload()), 'utf8').toString('base64');
}

function req(path: string, paid = false): Request {
  return new Request(`https://open-pay.jp${path}`, {
    headers: paid ? { 'X-PAYMENT': paymentHeader() } : undefined,
  });
}

async function load(
  directoryFlag = '1',
  facilitatorFlag = '1',
): Promise<{ list: PaidRoute; search: PaidRoute; detail: DetailRoute }> {
  vi.stubEnv('NEXT_PUBLIC_ENABLE_WEB3_DIRECTORY', directoryFlag);
  vi.stubEnv('NEXT_PUBLIC_ENABLE_X402_FACILITATOR', facilitatorFlag);
  vi.stubEnv('NEXT_PUBLIC_JPYC_FORWARDER_AMOY', FORWARDER);
  vi.stubEnv('NEXT_PUBLIC_FEE_RECEIVER_ADDRESS', FEE_RECEIVER);
  vi.stubEnv('NEXT_PUBLIC_ENABLE_USAGE_FEE', '');
  vi.stubEnv('NEXT_PUBLIC_JPYC_TESTNET_ADDRESS', JPYC_AMOY);
  vi.stubEnv('X402_FEE_BPS', '100');
  vi.stubEnv('X402_FEE_FLOOR_JPYC', '1');
  vi.stubEnv('X402_PAY_TO_ADDRESS', SELLER);
  vi.resetModules();
  return {
    list: (await import('@/app/api/paid/japan-web3-directory/route')) as PaidRoute,
    search: (await import(
      '@/app/api/paid/japan-web3-directory/search/route'
    )) as PaidRoute,
    detail: (await import(
      '@/app/api/paid/japan-web3-directory/[slug]/route'
    )) as DetailRoute,
  };
}

function detailCtx(slug: string) {
  return { params: Promise.resolve({ slug }) };
}

beforeEach(() => {
  routeMocks.verify.mockReset();
  routeMocks.settle.mockReset();
  verificationMocks.snapshot = {};
  verificationMocks.read.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('paid Japan Web3 Directory APIs', () => {
  // 不正署名・改ざん payload の拒否は既存 harness の
  // tests/app/api/paid-first-party.test.ts と paid-v2.test.ts が同じ _shared 経路を検証済み。
  it('directory flag と facilitator flag のどちらかが OFF なら404', async () => {
    const directoryOff = await load('', '1');
    expect(
      (await directoryOff.list.GET(req('/api/paid/japan-web3-directory'))).status,
    ).toBe(404);

    const facilitatorOff = await load('1', '');
    expect(
      (
        await facilitatorOff.search.GET(
          req('/api/paid/japan-web3-directory/search'),
        )
      ).status,
    ).toBe(404);
    expect(routeMocks.verify).not.toHaveBeenCalled();
    expect(routeMocks.settle).not.toHaveBeenCalled();
  });

  it('未払いは一覧/検索=2 JPYC、詳細=1 JPYC の402 challengeを返す', async () => {
    const { list, search, detail } = await load();
    const listRes = await list.GET(req('/api/paid/japan-web3-directory'));
    const searchRes = await search.GET(
      req('/api/paid/japan-web3-directory/search?category=wallet'),
    );
    const detailRes = await detail.GET(
      req('/api/paid/japan-web3-directory/jpyc'),
      detailCtx('jpyc'),
    );
    expect([listRes.status, searchRes.status, detailRes.status]).toEqual([
      402, 402, 402,
    ]);
    expect(verificationMocks.read).not.toHaveBeenCalled();

    const listBody = (await listRes.json()) as {
      accepts: Array<{
        resource: string;
        maxAmountRequired: string;
        extra: { openpay: { merchantValue: string; feeValue: string } };
      }>;
    };
    expect(listBody.accepts[0]).toMatchObject({
      resource: 'https://open-pay.jp/api/paid/japan-web3-directory',
      maxAmountRequired: (3n * 10n ** 18n).toString(),
      extra: {
        openpay: {
          merchantValue: (2n * 10n ** 18n).toString(),
          feeValue: (1n * 10n ** 18n).toString(),
        },
      },
    });

    const detailBody = (await detailRes.json()) as {
      accepts: Array<{
        resource: string;
        extra: { openpay: { merchantValue: string } };
      }>;
    };
    expect(detailBody.accepts[0]).toMatchObject({
      resource: 'https://open-pay.jp/api/paid/japan-web3-directory/jpyc',
      extra: {
        openpay: { merchantValue: (1n * 10n ** 18n).toString() },
      },
    });
  });

  it('未存在 slug と draft slug は支払い処理の前に404にする', async () => {
    const { detail } = await load();
    for (const slug of ['not-found', 'directory-draft-fixture']) {
      const res = await detail.GET(
        req(`/api/paid/japan-web3-directory/${slug}`, true),
        detailCtx(slug),
      );
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ ok: false, error: 'not_found' });
    }
    expect(routeMocks.verify).not.toHaveBeenCalled();
    expect(routeMocks.settle).not.toHaveBeenCalled();
  });

  it('既存 payment harness の verify→settle 後に全件一覧を解錠する', async () => {
    routeMocks.verify.mockResolvedValue(
      NextResponse.json({ isValid: true, payer: PAYER }),
    );
    routeMocks.settle.mockResolvedValue(
      NextResponse.json({
        success: true,
        transaction: TX_HASH,
        network: 'eip155:80002',
        payer: PAYER,
      }),
    );
    const { list } = await load();
    const res = await list.GET(req('/api/paid/japan-web3-directory', true));
    expect(res.status).toBe(200);
    expect(res.headers.get('x-payment-response')).toBeTruthy();
    const body = (await res.json()) as {
      schemaVersion: string;
      items: Array<{
        slug: string;
        sourceUrl: string;
        attribution: string;
        sourceCheckedAt: string | null;
        sourceOk: boolean | null;
      }>;
      total: number;
    };
    expect(body.schemaVersion).toBe('1.0');
    expect(body.items).toHaveLength(body.total);
    expect(body.items.length).toBeGreaterThanOrEqual(15);
    expect(body.items.some((item) => item.slug === 'directory-draft-fixture')).toBe(
      false,
    );
    expect(
      body.items.every((item) => item.sourceUrl && item.attribution),
    ).toBe(true);
    expect(body.items.every((item) => item.sourceOk === null)).toBe(true);
    expect(routeMocks.verify).toHaveBeenCalledTimes(1);
    expect(routeMocks.settle).toHaveBeenCalledTimes(1);
  });

  it('KV snapshot 障害は verify/settle 前に未課金503', async () => {
    verificationMocks.snapshot = null;
    const { list } = await load();
    const res = await list.GET(req('/api/paid/japan-web3-directory', true));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: 'storage_unavailable' });
    expect(verificationMocks.read).toHaveBeenCalledTimes(1);
    expect(routeMocks.verify).not.toHaveBeenCalled();
    expect(routeMocks.settle).not.toHaveBeenCalled();
  });

  it('検索と詳細も支払い後に共通封筒を解錠する', async () => {
    routeMocks.verify.mockImplementation(async () =>
      NextResponse.json({ isValid: true, payer: PAYER }),
    );
    routeMocks.settle.mockImplementation(async () =>
      NextResponse.json({
        success: true,
        transaction: TX_HASH,
        network: 'eip155:80002',
        payer: PAYER,
      }),
    );
    const { search, detail } = await load();

    const searchRes = await search.GET(
      req('/api/paid/japan-web3-directory/search?keyword=MetaMask', true),
    );
    expect(searchRes.status).toBe(200);
    const searchBody = (await searchRes.json()) as {
      query: { keyword: string };
      items: Array<{ slug: string }>;
    };
    expect(searchBody.query.keyword).toBe('MetaMask');
    expect(searchBody.items.map((item) => item.slug)).toEqual(['metamask']);

    const detailRes = await detail.GET(
      req('/api/paid/japan-web3-directory/jpyc', true),
      detailCtx('jpyc'),
    );
    expect(detailRes.status).toBe(200);
    const detailBody = (await detailRes.json()) as {
      query: { slug: string };
      items: Array<{ slug: string; sourceUrl: string; attribution: string }>;
    };
    expect(detailBody.query).toEqual({ slug: 'jpyc' });
    expect(detailBody.items).toHaveLength(1);
    expect(detailBody.items[0]).toMatchObject({
      slug: 'jpyc',
      sourceUrl: expect.stringContaining('jpyc.co.jp'),
      attribution: 'JPYC株式会社',
    });
  });

  it('検索 query が不正なら支払い要求の前に400にする', async () => {
    const { search } = await load();
    const res = await search.GET(
      req('/api/paid/japan-web3-directory/search?status=unknown'),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: 'invalid_query' });
    expect(routeMocks.verify).not.toHaveBeenCalled();
    expect(routeMocks.settle).not.toHaveBeenCalled();
  });
});
