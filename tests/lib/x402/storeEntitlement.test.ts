import { beforeEach, describe, expect, it, vi } from 'vitest';

const PAYER = '0x1111111111111111111111111111111111111111';
const SCORE = 1_700_000_000_000;

const kvEval = vi.hoisted(() => vi.fn());
const kvGet = vi.hoisted(() => vi.fn());
const kvMget = vi.hoisted(() => vi.fn());

vi.mock('@/lib/kv', () => ({
  kvEval,
  kvGet,
  kvMget,
}));
vi.mock('@/lib/x402/hostedStore', () => ({
  isHostedId: (value: unknown) =>
    typeof value === 'string' && /^h_[0-9a-f]{32}$/.test(value),
}));
vi.mock('@/lib/x402/purchaseIntent', () => ({
  purchaseLibraryKey: (payer: string) =>
    `store:lib:${payer.toLowerCase()}`,
  purchaseOwnershipKey: (payer: string, resourceId: string) =>
    `store:own:${payer.toLowerCase()}:${resourceId}`,
  parsePurchaseOwnership: (raw: unknown) => {
    if (typeof raw !== 'string') return null;
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return null;
    }
  },
}));

import {
  listStoreLibraryPage,
  selectStorePurchaseGrant,
  STORE_LIBRARY_PAGE_SIZE,
} from '@/lib/x402/storeEntitlement';

function resource(suffix: number): string {
  return `h_${suffix.toString(16).padStart(32, '0')}`;
}

function ownership(resourceId: string): string {
  const grant = {
    intentSalt: `0x${'a'.repeat(64)}`,
    contentRevision: 2,
    metadata: {
      title: `Product ${resourceId.slice(-2)}`,
      priceJpyc: '300',
      contentKind: 'text',
      label: 'prompt',
    },
    purchasedAt: SCORE + 1,
  };
  return JSON.stringify({
    payer: PAYER,
    resourceId,
    firstPurchasedAt: SCORE,
    grants: [grant],
    latestGrant: grant,
  });
}

function flatIndex(resourceIds: string[]): string[] {
  return resourceIds.flatMap((resourceId) => [
    resourceId,
    String(SCORE),
  ]);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('store library stable cursor', () => {
  it('score/member 降順で page 境界を固定し、次 page は cursor を exclusive にする', async () => {
    const descendingSameScore = Array.from(
      { length: STORE_LIBRARY_PAGE_SIZE + 1 },
      (_, index) => resource(STORE_LIBRARY_PAGE_SIZE - index),
    );
    kvEval
      .mockResolvedValueOnce({
        ok: true,
        value: flatIndex(descendingSameScore),
      })
      .mockResolvedValueOnce({
        ok: true,
        value: flatIndex([descendingSameScore.at(-1)!]),
      });
    kvMget
      .mockResolvedValueOnce({
        ok: true,
        value: descendingSameScore
          .slice(0, STORE_LIBRARY_PAGE_SIZE)
          .map(ownership),
      })
      .mockResolvedValueOnce({
        ok: true,
        value: [ownership(descendingSameScore.at(-1)!)],
      });

    const first = await listStoreLibraryPage({
      payer: PAYER,
      cursor: null,
    });

    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('expected page');
    expect(first.page.items.map((item) => item.resourceId)).toEqual(
      descendingSameScore.slice(0, STORE_LIBRARY_PAGE_SIZE),
    );
    expect(first.page.items[0]?.revisions).toEqual([
      expect.objectContaining({
        contentRevision: 2,
        purchasedAt: SCORE + 1,
      }),
    ]);
    expect(first.page.nextCursor).not.toBeNull();
    const decoded = JSON.parse(
      Buffer.from(first.page.nextCursor!, 'base64url').toString('utf8'),
    ) as unknown;
    expect(decoded).toEqual({
      score: SCORE,
      member: descendingSameScore[STORE_LIBRARY_PAGE_SIZE - 1],
    });
    const script = kvEval.mock.calls[0]?.[0] as string;
    expect(script).toContain('ZREVRANK');
    expect(script).toContain('ZREVRANGE');

    const second = await listStoreLibraryPage({
      payer: PAYER,
      cursor: first.page.nextCursor,
    });

    expect(second).toEqual({
      ok: true,
      page: {
        items: [
          expect.objectContaining({
            resourceId: descendingSameScore.at(-1),
          }),
        ],
        nextCursor: null,
      },
    });
    expect(kvEval.mock.calls[1]?.[2]).toEqual([
      '1',
      String(SCORE),
      descendingSameScore[STORE_LIBRARY_PAGE_SIZE - 1],
      'none',
      'zset',
      'table',
      '__storage__',
      '1',
      '__cursor__',
      String(STORE_LIBRARY_PAGE_SIZE + 1),
    ]);
  });

  it('cursor の形式不正と index 上で消えた tuple を区別して拒否する', async () => {
    const malformed = await listStoreLibraryPage({
      payer: PAYER,
      cursor: 'not+base64url',
    });
    expect(malformed).toEqual({
      ok: false,
      reason: 'invalid_cursor',
    });
    expect(kvEval).not.toHaveBeenCalled();

    const validCursor = Buffer.from(
      JSON.stringify({ score: SCORE, member: resource(1) }),
      'utf8',
    ).toString('base64url');
    kvEval.mockResolvedValueOnce({
      ok: true,
      value: ['__cursor__'],
    });

    await expect(
      listStoreLibraryPage({ payer: PAYER, cursor: validCursor }),
    ).resolves.toEqual({
      ok: false,
      reason: 'invalid_cursor',
    });
  });

  it('index score と ownership.firstPurchasedAt の不一致は欠落扱いにせず corrupt', async () => {
    kvEval.mockResolvedValueOnce({
      ok: true,
      value: [resource(1), String(SCORE)],
    });
    kvMget.mockResolvedValueOnce({
      ok: true,
      value: [
        JSON.stringify({
          ...JSON.parse(ownership(resource(1))),
          firstPurchasedAt: SCORE + 1,
        }),
      ],
    });

    await expect(
      listStoreLibraryPage({ payer: PAYER, cursor: null }),
    ).resolves.toEqual({ ok: false, reason: 'corrupt' });
  });

  it('全購入 revision の安全な metadata を返し、同 revision の再購入は最新表示へまとめる', async () => {
    const resourceId = resource(1);
    const firstRevision = {
      intentSalt: `0x${'b'.repeat(64)}`,
      contentRevision: 1,
      metadata: {
        title: 'First revision',
        priceJpyc: '100',
        contentKind: 'text',
        label: 'prompt',
      },
      purchasedAt: SCORE,
    };
    const olderThirdRevision = {
      intentSalt: `0x${'c'.repeat(64)}`,
      contentRevision: 3,
      metadata: {
        title: 'Third revision old purchase',
        priceJpyc: '250',
        contentKind: 'url',
        label: 'download',
      },
      purchasedAt: SCORE + 1,
    };
    const latestThirdRevision = {
      ...olderThirdRevision,
      intentSalt: `0x${'d'.repeat(64)}`,
      metadata: {
        ...olderThirdRevision.metadata,
        title: 'Third revision latest purchase',
        priceJpyc: '300',
      },
      purchasedAt: SCORE + 2,
    };
    kvEval.mockResolvedValueOnce({
      ok: true,
      value: [resourceId, String(SCORE)],
    });
    kvMget.mockResolvedValueOnce({
      ok: true,
      value: [
        JSON.stringify({
          payer: PAYER,
          resourceId,
          firstPurchasedAt: SCORE,
          grants: [
            firstRevision,
            olderThirdRevision,
            latestThirdRevision,
          ],
          latestGrant: latestThirdRevision,
        }),
      ],
    });

    const result = await listStoreLibraryPage({
      payer: PAYER,
      cursor: null,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected page');
    expect(result.page.items[0]?.revisions).toEqual([
      {
        contentRevision: 3,
        title: 'Third revision latest purchase',
        priceJpyc: '300',
        contentKind: 'url',
        label: 'download',
        purchasedAt: SCORE + 2,
      },
      {
        contentRevision: 1,
        title: 'First revision',
        priceJpyc: '100',
        contentKind: 'text',
        label: 'prompt',
        purchasedAt: SCORE,
      },
    ]);
    expect(result.page.items[0]?.revisions[0]).not.toHaveProperty(
      'intentSalt',
    );
  });

  it('USDC payment snapshot を item/revision に伝播し、旧 grant には既定値を足さない', async () => {
    const resourceId = resource(1);
    const base = JSON.parse(ownership(resourceId)) as {
      grants: Array<Record<string, unknown>>;
      latestGrant: Record<string, unknown>;
    };
    const payment = {
      version: 1,
      rail: 'usdc',
      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      assetSymbol: 'USDC',
      chainId: 8453,
      paidAtomic: '2000000',
      priceJpyc: '300',
      quote: {
        rateScaled: '150000000',
        rateFetchedAt: SCORE - 180_000,
        fxQuoteExpiresAt: SCORE - 1,
        rounding: 'ceil',
      },
    };
    base.grants[0] = { ...base.grants[0], payment };
    base.latestGrant = { ...base.latestGrant, payment };
    kvEval.mockResolvedValueOnce({
      ok: true,
      value: [resourceId, String(SCORE)],
    });
    kvMget.mockResolvedValueOnce({
      ok: true,
      value: [JSON.stringify(base)],
    });

    const result = await listStoreLibraryPage({ payer: PAYER, cursor: null });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected page');
    expect(result.page.items[0]?.payment).toEqual(payment);
    expect(result.page.items[0]?.revisions[0]?.payment).toEqual(payment);

    const legacyResource = resource(2);
    kvEval.mockResolvedValueOnce({
      ok: true,
      value: [legacyResource, String(SCORE)],
    });
    kvMget.mockResolvedValueOnce({
      ok: true,
      value: [ownership(legacyResource)],
    });
    const legacy = await listStoreLibraryPage({ payer: PAYER, cursor: null });
    expect(legacy.ok).toBe(true);
    if (!legacy.ok) throw new Error('expected page');
    expect(legacy.page.items[0]).not.toHaveProperty('payment');
    expect(legacy.page.items[0]?.revisions[0]).not.toHaveProperty('payment');
  });
});

describe('store ownership revision selection', () => {
  const olderSalt = `0x${'b'.repeat(64)}`;
  const latestSameRevisionSalt = `0x${'c'.repeat(64)}`;
  const latestSalt = `0x${'d'.repeat(64)}`;
  const grants = [
    {
      intentSalt: olderSalt,
      contentRevision: 1,
      purchasedAt: SCORE,
    },
    {
      intentSalt: latestSameRevisionSalt,
      contentRevision: 1,
      purchasedAt: SCORE + 1,
    },
    {
      intentSalt: latestSalt,
      contentRevision: 2,
      purchasedAt: SCORE + 2,
    },
  ];
  const parsedOwnership = {
    grants,
    latestGrant: grants[2],
  } as Parameters<typeof selectStorePurchaseGrant>[0];

  it('intentSalt は exact grant、revision は同 revision の最新 grant を選ぶ', () => {
    expect(
      selectStorePurchaseGrant(parsedOwnership, {
        revision: null,
        intentSalt: olderSalt,
      }),
    ).toBe(grants[0]);
    expect(
      selectStorePurchaseGrant(parsedOwnership, {
        revision: 1,
        intentSalt: null,
      }),
    ).toBe(grants[1]);
    expect(
      selectStorePurchaseGrant(parsedOwnership, {
        revision: null,
        intentSalt: null,
      }),
    ).toBe(grants[2]);
  });

  it('intentSalt と revision の不一致・未保有 selector は null', () => {
    expect(
      selectStorePurchaseGrant(parsedOwnership, {
        revision: 2,
        intentSalt: olderSalt,
      }),
    ).toBeNull();
    expect(
      selectStorePurchaseGrant(parsedOwnership, {
        revision: 99,
        intentSalt: null,
      }),
    ).toBeNull();
    expect(
      selectStorePurchaseGrant(parsedOwnership, {
        revision: null,
        intentSalt: `0x${'e'.repeat(64)}`,
      }),
    ).toBeNull();
  });
});
