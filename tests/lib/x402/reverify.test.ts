import { describe, expect, it, vi } from 'vitest';
import {
  probeForReverify,
  selectReverifyBatch,
  sendReverifyAlert,
  transitionVerification,
  utcHourRunId,
} from '@/lib/x402/reverify';

const lookupPublic = async () => [{ address: '93.184.216.34' }];
const openpayAccepts = [
  { scheme: 'exact', extra: { openpay: { mode: 'forwarder-split' } } },
];

function response(status: number, body = ''): typeof fetch {
  return (async () => new Response(body, { status })) as typeof fetch;
}

describe('probeForReverify', () => {
  it('402 OpenPay v1/v2 を成功、完全に読めた foreign 402 を確定違反に分類', async () => {
    const v1 = response(402, JSON.stringify({ accepts: openpayAccepts }));
    expect(
      await probeForReverify('https://x.test/paid', {
        fetchImpl: v1,
        lookup: lookupPublic,
      }),
    ).toBe('ok_402_openpay');

    const header = Buffer.from(
      JSON.stringify({ accepts: openpayAccepts }),
      'utf8',
    ).toString('base64');
    const v2 = (async () =>
      new Response('', {
        status: 402,
        headers: { 'payment-required': header },
      })) as typeof fetch;
    expect(
      await probeForReverify('https://x.test/paid', {
        fetchImpl: v2,
        lookup: lookupPublic,
      }),
    ).toBe('ok_402_openpay');

    const foreign = response(
      402,
      JSON.stringify({ accepts: [{ scheme: 'exact', network: 'base' }] }),
    );
    expect(
      await probeForReverify('https://x.test/paid', {
        fetchImpl: foreign,
        lookup: lookupPublic,
      }),
    ).toBe('violation_foreign_402');
  });

  it('dual-rail 402 (v2 ヘッダ=USDC のみ + v1 body=JPYC) は成功 — v2 だけで foreign にしない', async () => {
    // dual-rail 出品の正常形: PAYMENT-REQUIRED は USDC accept のみ (extra.openpay なし)、
    // v1 JSON body には JPYC (forwarder-split) が載る。v2 単独判定だと 3 巡で hidden になり
    // カタログ喪失 → 出品者ゲート 500 のデッドロック (2026-08-24 実害) — その回帰フェンス。
    const usdcOnlyHeader = Buffer.from(
      JSON.stringify({ accepts: [{ scheme: 'exact', network: 'eip155:8453' }] }),
      'utf8',
    ).toString('base64');
    const dual = (async () =>
      new Response(
        JSON.stringify({
          accepts: [...openpayAccepts, { scheme: 'exact', network: 'base' }],
        }),
        { status: 402, headers: { 'payment-required': usdcOnlyHeader } },
      )) as typeof fetch;
    expect(
      await probeForReverify('https://x.test/paid', {
        fetchImpl: dual,
        lookup: lookupPublic,
      }),
    ).toBe('ok_402_openpay');

    // v2 も v1 も OpenPay 方式でない → これは確定 foreign のまま。
    const bothForeign = (async () =>
      new Response(
        JSON.stringify({ accepts: [{ scheme: 'exact', network: 'base' }] }),
        { status: 402, headers: { 'payment-required': usdcOnlyHeader } },
      )) as typeof fetch;
    expect(
      await probeForReverify('https://x.test/paid', {
        fetchImpl: bothForeign,
        lookup: lookupPublic,
      }),
    ).toBe('violation_foreign_402');

    // v2 が foreign 風でも v1 body が読めない場合は transient (hidden へ進めない)。
    const headerOnlyNoBody = (async () =>
      new Response('', {
        status: 402,
        headers: { 'payment-required': usdcOnlyHeader },
      })) as typeof fetch;
    expect(
      await probeForReverify('https://x.test/paid', {
        fetchImpl: headerOnlyNoBody,
        lookup: lookupPublic,
      }),
    ).toBe('transient');
  });

  it.each([
    [200, 'violation_200_ungated'],
    [404, 'violation_gone'],
    [410, 'violation_gone'],
  ] as const)('status %i → %s', async (status, verdict) => {
    expect(
      await probeForReverify('https://x.test/paid', {
        fetchImpl: response(status, 'ordinary response'),
        lookup: lookupPublic,
      }),
    ).toBe(verdict);
  });

  it.each([301, 302, 307, 308, 401, 403, 429, 500, 503])(
    'status %i は transient (failures 非加算)',
    async (status) => {
      expect(
        await probeForReverify('https://x.test/paid', {
          fetchImpl: response(status),
          lookup: lookupPublic,
        }),
      ).toBe('transient');
    },
  );

  it('DNS/connect/timeout と 402 body failure は transient', async () => {
    expect(
      await probeForReverify('https://x.test/paid', {
        fetchImpl: response(200, 'ok'),
        lookup: async () => {
          throw new Error('NXDOMAIN');
        },
      }),
    ).toBe('transient');
    expect(
      await probeForReverify('https://x.test/paid', {
        fetchImpl: (async () => {
          throw new Error('ECONNRESET');
        }) as typeof fetch,
        lookup: lookupPublic,
      }),
    ).toBe('transient');
    expect(
      await probeForReverify('https://x.test/paid', {
        fetchImpl: response(402, 'x'.repeat(64 * 1024 + 1)),
        lookup: lookupPublic,
      }),
    ).toBe('transient');
  });

  it('Cloudflare challenge の 200 は ungated 違反にせず transient', async () => {
    const challenge = (async () =>
      new Response('<title>Just a moment...</title><script src="/cdn-cgi/challenge-platform"></script>', {
        status: 200,
        headers: { server: 'cloudflare' },
      })) as typeof fetch;
    expect(
      await probeForReverify('https://x.test/paid', {
        fetchImpl: challenge,
        lookup: lookupPublic,
      }),
    ).toBe('transient');
  });
});

describe('verification transitions', () => {
  it('確定違反だけを3回加算して hidden、transient は維持、成功で復帰', () => {
    const url = 'https://x.test/paid';
    let state = transitionVerification(
      null,
      'violation_200_ungated',
      '2026-07-14T00:00:00.000Z',
      '2026071400',
      url,
    );
    expect(state).toMatchObject({ verification: { failures: 1 }, hidden: false });

    state = transitionVerification(
      state,
      'transient',
      '2026-07-14T01:00:00.000Z',
      '2026071401',
      url,
    );
    expect(state).toMatchObject({ verification: { failures: 1 }, hidden: false });

    state = transitionVerification(
      state,
      'violation_gone',
      '2026-07-14T02:00:00.000Z',
      '2026071402',
      url,
    );
    state = transitionVerification(
      state,
      'violation_foreign_402',
      '2026-07-14T03:00:00.000Z',
      '2026071403',
      url,
    );
    expect(state).toMatchObject({
      verification: { failures: 3 },
      hidden: true,
      hiddenTransition: 'hidden',
    });

    state = transitionVerification(
      state,
      'ok_402_openpay',
      '2026-07-14T04:00:00.000Z',
      '2026071404',
      url,
    );
    expect(state).toMatchObject({
      verification: {
        failures: 0,
        lastOkAt: '2026-07-14T04:00:00.000Z',
      },
      hidden: false,
      hiddenTransition: 'restored',
    });
  });

  it('probedUrl 変更は旧 failures/hidden を引き継がない', () => {
    const changed = transitionVerification(
      {
        hidden: true,
        verification: {
          failures: 5,
          lastCheckedAt: 'old',
          lastRunId: 'old',
          probedUrl: 'https://old.test/paid',
        },
      },
      'violation_gone',
      '2026-07-14T00:00:00.000Z',
      '2026071400',
      'https://new.test/paid',
    );
    expect(changed).toMatchObject({ verification: { failures: 1 }, hidden: false });
  });
});

describe('cursor / alert helpers', () => {
  it('catalog + first-party を巡回し、1回25件を上限に wrap する', () => {
    const external = Array.from({ length: 30 }, (_, i) => `r${i}`);
    const firstParty = ['/a', '/b'];
    const first = selectReverifyBatch(external, firstParty, { offset: 0 });
    expect(first.targets).toHaveLength(25);
    expect(first.nextOffset).toBe(25);
    const second = selectReverifyBatch(external, firstParty, {
      offset: first.nextOffset,
    });
    expect(second.targets).toHaveLength(25);
    expect(second.targets.slice(0, 7)).toEqual([
      { kind: 'external', id: 'r25' },
      { kind: 'external', id: 'r26' },
      { kind: 'external', id: 'r27' },
      { kind: 'external', id: 'r28' },
      { kind: 'external', id: 'r29' },
      { kind: 'first-party', path: '/a' },
      { kind: 'first-party', path: '/b' },
    ]);
    expect(utcHourRunId(new Date('2026-07-14T09:34:56.000Z'))).toBe('2026071409');
  });

  it('webhook failure を throw せず隔離し、互換 payload は text/content の両方を送る', async () => {
    await expect(
      sendReverifyAlert(
        'https://hooks.test/alert',
        'alert',
        vi.fn().mockRejectedValue(new Error('down')) as typeof fetch,
      ),
    ).resolves.toBe(false);

    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    await expect(
      sendReverifyAlert(
        'https://hooks.test/alert',
        'alert',
        fetchMock as typeof fetch,
      ),
    ).resolves.toBe(true);
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({ text: 'alert', content: 'alert' });
  });
});
