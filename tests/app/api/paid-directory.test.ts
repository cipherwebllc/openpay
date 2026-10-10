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

// 再配信 (settled / pending → 復旧) はコアが KV の再配信レコードから content を呼ぶ経路。
// 既定は「レコード無し」(missing) で、従来どおり verify → settle へ進む。
const redeliveryMocks = vi.hoisted(() => ({
  lookup: vi.fn(),
  promote: vi.fn(),
  resolveStatus: vi.fn(),
  statusRateLimit: vi.fn(),
}));
vi.mock('@/lib/x402/paymentRedelivery', async (original) => ({
  ...(await original<typeof import('@/lib/x402/paymentRedelivery')>()),
  lookupPaymentRedelivery: redeliveryMocks.lookup,
  claimPaymentRedelivery: async () => ({ kind: 'unavailable' }),
  promotePaymentRedelivery: redeliveryMocks.promote,
}));
vi.mock('@/lib/x402/facilitatorStatus', () => ({
  resolveFacilitatorPaymentStatus: redeliveryMocks.resolveStatus,
}));
vi.mock('@/lib/x402/facilitatorStatusRateLimit', () => ({
  checkFacilitatorStatusRateLimit: redeliveryMocks.statusRateLimit,
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
  redeliveryMocks.lookup.mockReset().mockResolvedValue({ kind: 'missing' });
  redeliveryMocks.promote.mockReset().mockResolvedValue({ kind: 'unavailable' });
  redeliveryMocks.resolveStatus.mockReset();
  redeliveryMocks.statusRateLimit.mockReset().mockResolvedValue(true);
});

afterEach(() => {
  vi.doUnmock('@/lib/directory/data');
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

  // 第 7 回レビュー E1: 中身の無い・壊れた支払い header の連打で KV (verification snapshot) を読ませない。
  // 先読みは「コアが verify まで進める header」のときだけ。応答は従来どおりの 402 invalid_payment_payload。
  it.each([
    ['X-PAYMENT', 'x'],
    ['PAYMENT-SIGNATURE', 'x'],
    ['X-PAYMENT', Buffer.from(JSON.stringify({ x402Version: 1 }), 'utf8').toString('base64')],
  ])('壊れた支払い header (%s: %s) は KV を読まずに 402 invalid_payment_payload', async (name, value) => {
    const { list, search, detail } = await load();
    const headers = { [name]: value };
    const responses = [
      await list.GET(new Request('https://open-pay.jp/api/paid/japan-web3-directory', { headers })),
      await search.GET(new Request('https://open-pay.jp/api/paid/japan-web3-directory/search?category=wallet', { headers })),
      await detail.GET(new Request('https://open-pay.jp/api/paid/japan-web3-directory/jpyc', { headers }), { params: Promise.resolve({ slug: 'jpyc' }) }),
    ];
    for (const res of responses) {
      expect(res.status).toBe(402);
      expect(await res.json()).toMatchObject({ error: 'invalid_payment_payload' });
    }
    expect(verificationMocks.read).not.toHaveBeenCalled();
    expect(routeMocks.verify).not.toHaveBeenCalled();
  });

  // Codex P2: 支払いの識別子は取れるが、コアが v2PayloadToV1Body で拒否する v2 header (v1 の payload を
  // PAYMENT-SIGNATURE に載せる・accepted の必須項目が欠けた v2) でも KV を読まない。応答は従来どおり。
  it.each([
    ['v1 の payload を PAYMENT-SIGNATURE に載せる', paymentHeader()],
    [
      'accepted の必須項目が欠けた v2',
      Buffer.from(
        JSON.stringify({
          x402Version: 2,
          accepted: { network: 'eip155:80002' },
          payload: paymentPayload().payload,
        }),
        'utf8',
      ).toString('base64'),
    ],
  ])('verify まで進めない v2 header (%s) は KV を読まずに 402 invalid_payment_payload', async (_label, value) => {
    const { list, search, detail } = await load();
    const headers = { 'PAYMENT-SIGNATURE': value };
    const responses = [
      await list.GET(new Request('https://open-pay.jp/api/paid/japan-web3-directory', { headers })),
      await search.GET(new Request('https://open-pay.jp/api/paid/japan-web3-directory/search?category=wallet', { headers })),
      await detail.GET(new Request('https://open-pay.jp/api/paid/japan-web3-directory/jpyc', { headers }), { params: Promise.resolve({ slug: 'jpyc' }) }),
    ];
    for (const res of responses) {
      expect(res.status).toBe(402);
      expect(await res.json()).toMatchObject({ error: 'invalid_payment_payload' });
    }
    // コアは v2 の構造検査より先に再配信 lookup を行う (再配信レコードが無いから 402 で終わり、snapshot は読まない)。
    expect(redeliveryMocks.lookup).toHaveBeenCalledTimes(3);
    expect(verificationMocks.read).not.toHaveBeenCalled();
    expect(routeMocks.verify).not.toHaveBeenCalled();
  });

  // Codex P2 (再レビュー): 先読みしない header でも、コアが同じ identity・credential の再配信レコードから
  // content を呼ぶ (settled 再配信・pending からの復旧) ときは実コンテンツを返す。snapshot はそのとき 1 回だけ読む。
  describe('支払い済みの再配信は先読みしない header でも実コンテンツを返す', () => {
    const settlement = {
      success: true,
      transaction: TX_HASH,
      network: 'eip155:80002',
      payer: PAYER,
    };
    const paymentResponse = (res: Response): unknown =>
      JSON.parse(Buffer.from(res.headers.get('x-payment-response') ?? '', 'base64').toString('utf8'));

    it.each([
      ['v1 の payload を PAYMENT-SIGNATURE に載せる', { 'PAYMENT-SIGNATURE': paymentHeader() }],
      ['空の PAYMENT-SIGNATURE と正常な X-PAYMENT の併存', { 'PAYMENT-SIGNATURE': '', 'X-PAYMENT': paymentHeader() }],
    ])('settled レコードがあれば %s の再送でも 200 の実コンテンツ', async (_label, headers) => {
      redeliveryMocks.lookup.mockResolvedValue({ kind: 'match', record: { state: 'settled', settlement } });
      const { paymentRedeliveryIdentity } = await import('@/lib/x402/paymentRedelivery');
      const { list, search, detail } = await load();

      const listRes = await list.GET(new Request('https://open-pay.jp/api/paid/japan-web3-directory', { headers }));
      expect(listRes.status).toBe(200);
      const listBody = (await listRes.json()) as { schemaVersion: string; items: unknown[]; total: number };
      expect(listBody.schemaVersion).toBe('1.0');
      expect(listBody.items).toHaveLength(listBody.total);
      expect(listBody.total).toBeGreaterThanOrEqual(15);
      expect(paymentResponse(listRes)).toEqual(settlement);
      expect(redeliveryMocks.lookup).toHaveBeenCalledWith(
        paymentRedeliveryIdentity(paymentPayload()),
        { scope: 'first-party', resource: 'https://open-pay.jp/api/paid/japan-web3-directory' },
      );
      expect(verificationMocks.read).toHaveBeenCalledTimes(1);

      verificationMocks.read.mockClear();
      const searchRes = await search.GET(
        new Request('https://open-pay.jp/api/paid/japan-web3-directory/search?keyword=MetaMask', { headers }),
      );
      expect(searchRes.status).toBe(200);
      expect((await searchRes.json()) as { items: Array<{ slug: string }> }).toMatchObject({
        query: { keyword: 'MetaMask' },
        items: [{ slug: 'metamask' }],
      });
      expect(paymentResponse(searchRes)).toEqual(settlement);
      expect(verificationMocks.read).toHaveBeenCalledTimes(1);

      verificationMocks.read.mockClear();
      const detailRes = await detail.GET(
        new Request('https://open-pay.jp/api/paid/japan-web3-directory/jpyc', { headers }),
        detailCtx('jpyc'),
      );
      expect(detailRes.status).toBe(200);
      expect(await detailRes.json()).toMatchObject({ query: { slug: 'jpyc' }, items: [{ slug: 'jpyc' }] });
      expect(paymentResponse(detailRes)).toEqual(settlement);
      expect(verificationMocks.read).toHaveBeenCalledTimes(1);

      expect(routeMocks.verify).not.toHaveBeenCalled();
      expect(routeMocks.settle).not.toHaveBeenCalled();
    });

    it('pending レコードが on-chain settled へ復旧したときも 200 の実コンテンツ', async () => {
      redeliveryMocks.lookup.mockResolvedValue({
        kind: 'match',
        record: { state: 'pending', facilitatorBody: { paymentPayload: paymentPayload() } },
      });
      redeliveryMocks.resolveStatus.mockResolvedValue({
        ok: true,
        state: 'settled',
        txHash: TX_HASH,
        chainId: 80002,
        payer: PAYER,
      });
      redeliveryMocks.promote.mockResolvedValue({ kind: 'promoted', record: { state: 'settled', settlement } });
      const { list } = await load();
      const res = await list.GET(
        new Request('https://open-pay.jp/api/paid/japan-web3-directory', {
          headers: { 'PAYMENT-SIGNATURE': paymentHeader() },
        }),
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ schemaVersion: '1.0' });
      expect(paymentResponse(res)).toEqual(settlement);
      expect(redeliveryMocks.promote).toHaveBeenCalledTimes(1);
      expect(verificationMocks.read).toHaveBeenCalledTimes(1);
      expect(routeMocks.verify).not.toHaveBeenCalled();
      expect(routeMocks.settle).not.toHaveBeenCalled();
    });

    it('再配信時に snapshot が読めなければ 503 storage_unavailable (課金は成立済み・settle は走らない)', async () => {
      redeliveryMocks.lookup.mockResolvedValue({ kind: 'match', record: { state: 'settled', settlement } });
      verificationMocks.snapshot = null;
      const { list } = await load();
      const res = await list.GET(
        new Request('https://open-pay.jp/api/paid/japan-web3-directory', {
          headers: { 'PAYMENT-SIGNATURE': paymentHeader() },
        }),
      );
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ ok: false, error: 'storage_unavailable' });
      expect(verificationMocks.read).toHaveBeenCalledTimes(1);
      expect(routeMocks.verify).not.toHaveBeenCalled();
      expect(routeMocks.settle).not.toHaveBeenCalled();
    });
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

  // E16 (user 裁定 R7): 内部の審査段階 (draft 等) を指定した検索は必ず空 → 支払い要求の前に 400。
  it.each(['draft', 'review', 'rejected', 'archived'])(
    'E16: status=%s の検索は支払い要求の前に400にする',
    async (status) => {
      const { search } = await load();
      const res = await search.GET(
        req(`/api/paid/japan-web3-directory/search?status=${status}`),
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ ok: false, error: 'invalid_query' });
      expect(routeMocks.verify).not.toHaveBeenCalled();
      expect(routeMocks.settle).not.toHaveBeenCalled();
    },
  );

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


it('E2: the JPYC full export also returns all 51 published rows, excluding drafts', async () => {
  const { DIRECTORY_ENTRIES } = await vi.importActual<typeof import('@/lib/directory/data')>('@/lib/directory/data');
  const source = DIRECTORY_ENTRIES.find((entry) => entry.status === 'published')!;
  vi.doMock('@/lib/directory/data', () => ({
    DIRECTORY_ENTRIES: [
      ...Array.from({ length: 51 }, (_, i) => ({ ...source, slug: `published-${i}` })),
      { ...source, slug: 'hidden-draft', status: 'draft' },
    ],
  }));
  routeMocks.verify.mockResolvedValue(NextResponse.json({ isValid: true, payer: PAYER }));
  routeMocks.settle.mockResolvedValue(NextResponse.json({ success: true, transaction: TX_HASH, network: 'eip155:80002', payer: PAYER }));
  const { list } = await load();
  const response = await list.GET(req('/api/paid/japan-web3-directory', true));
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.total).toBe(51);
  expect(body.items.map((item: { slug: string }) => item.slug)).toEqual(
    Array.from({ length: 51 }, (_, i) => `published-${i}`),
  );
});
