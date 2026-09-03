import { describe, expect, it, vi } from 'vitest';
import {
  probeForReverify,
  probeForReverifyDetailed,
  REVERIFY_AUTH_HIDE_THRESHOLD,
  REVERIFY_IDENTIFYING_USER_AGENT,
  REVERIFY_IDENTITY_HEADER,
  REVERIFY_USER_AGENTS,
  reverifyUserAgent,
  selectReverifyBatch,
  sendReverifyAlert,
  transitionVerification,
  utcHourRunId,
  type ReverifyAuthClass,
  type ReverifyVerdict,
  type VerificationState,
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

  // B6: probedUrl が変われば連続違反カウンタ (failures) は仕切り直すが、**hidden は残す**。
  // owner が別 URL へ PATCH → 元 URL へ PATCH し直すだけで自動 hidden を解除できてはならない。
  it('probedUrl 変更は failures を仕切り直すが hidden は引き継ぐ', () => {
    const hiddenAtOtherUrl: VerificationState = {
      hidden: true,
      verification: {
        failures: 5,
        lastCheckedAt: 'old',
        lastRunId: 'old',
        probedUrl: 'https://old.test/paid',
      },
    };
    const changed = transitionVerification(
      hiddenAtOtherUrl,
      'violation_gone',
      '2026-07-14T00:00:00.000Z',
      '2026071400',
      'https://new.test/paid',
    );
    expect(changed).toMatchObject({
      verification: { failures: 1 },
      hidden: true,
      hiddenTransition: null,
    });

    // transient でも解除されない (「成功していない」以上の意味はないため)。
    expect(
      transitionVerification(
        hiddenAtOtherUrl,
        'transient',
        '2026-07-14T00:00:00.000Z',
        '2026071400',
        'https://new.test/paid',
      ),
    ).toMatchObject({ hidden: true, hiddenTransition: null });

    // 復帰は「新 URL で ok_402_openpay を観測する」正規経路のみ。
    expect(
      transitionVerification(
        hiddenAtOtherUrl,
        'ok_402_openpay',
        '2026-07-14T00:00:00.000Z',
        '2026071400',
        'https://new.test/paid',
      ),
    ).toMatchObject({ hidden: false, hiddenTransition: 'restored' });
  });
});

// B8: 200 を誰にでも返しつつ、この UA にだけ 403/302 を返す cloaking 出品は verdict が
// 常に transient になり永久掲載されていた。契約とは別軸の authFailures で締め出しを数える。
describe('cloaking (auth block) detection', () => {
  function state(
    authFailures: number,
    probedUrl = 'https://x.test/paid',
  ): VerificationState {
    return {
      hidden: false,
      verification: {
        failures: 0,
        authFailures,
        lastCheckedAt: 'old',
        lastRunId: 'old',
        probedUrl,
      },
    };
  }

  function step(
    previous: VerificationState,
    verdict: ReverifyVerdict,
    authClass: ReverifyAuthClass,
  ) {
    return transitionVerification(
      previous,
      verdict,
      '2026-07-14T00:00:00.000Z',
      '2026071400',
      'https://x.test/paid',
      authClass,
    );
  }

  it('probe が 401/403/別 origin redirect を block、200/402 を clear に分類する', async () => {
    const cases: Array<[number, Record<string, string>, ReverifyAuthClass]> = [
      [403, {}, 'block'],
      [401, {}, 'block'],
      [302, { location: 'https://elsewhere.test/blocked' }, 'block'],
      [302, { location: '/login' }, 'neutral'],
      [301, {}, 'neutral'],
      [429, {}, 'neutral'],
      [503, {}, 'neutral'],
      [404, {}, 'neutral'],
    ];
    for (const [status, headers, authClass] of cases) {
      const probe = await probeForReverifyDetailed('https://x.test/paid', {
        fetchImpl: (async () => new Response('', { status, headers })) as typeof fetch,
        lookup: lookupPublic,
      });
      expect([status, probe.authClass]).toEqual([status, authClass]);
    }

    // 素の 200 / 402 に到達できた = 締め出されていない。
    expect(
      await probeForReverifyDetailed('https://x.test/paid', {
        fetchImpl: response(200, 'ordinary response'),
        lookup: lookupPublic,
      }),
    ).toEqual({ verdict: 'violation_200_ungated', authClass: 'clear' });
    expect(
      await probeForReverifyDetailed('https://x.test/paid', {
        fetchImpl: response(402, JSON.stringify({ accepts: openpayAccepts })),
        lookup: lookupPublic,
      }),
    ).toEqual({ verdict: 'ok_402_openpay', authClass: 'clear' });
  });

  it('403 が 6 連続で hidden になる', () => {
    let current = state(0);
    for (let i = 1; i < REVERIFY_AUTH_HIDE_THRESHOLD; i += 1) {
      const next = step(current, 'transient', 'block');
      expect(next).toMatchObject({
        verification: { authFailures: i, failures: 0 },
        hidden: false,
      });
      current = { hidden: next.hidden, verification: next.verification };
    }
    const hiddenNow = step(current, 'transient', 'block');
    expect(hiddenNow).toMatchObject({
      verification: { authFailures: REVERIFY_AUTH_HIDE_THRESHOLD },
      hidden: true,
      hiddenTransition: 'hidden',
    });
  });

  it('403 が 5 連続でも、素の 402 が 1 回入れば counter は 0 に戻る', () => {
    const almost = state(REVERIFY_AUTH_HIDE_THRESHOLD - 1);
    const cleared = step(almost, 'ok_402_openpay', 'clear');
    expect(cleared.hidden).toBe(false);
    expect(cleared.verification.authFailures).toBeUndefined();

    // リセット後に改めて 403 が来ても 1 からやり直し。
    expect(
      step(
        { hidden: cleared.hidden, verification: cleared.verification },
        'transient',
        'block',
      ),
    ).toMatchObject({ verification: { authFailures: 1 }, hidden: false });
  });

  it('5xx は authFailures を加算も減算もしない', () => {
    const partial = state(3);
    const after = step(partial, 'transient', 'neutral');
    expect(after).toMatchObject({
      verification: { authFailures: 3 },
      hidden: false,
    });
  });

  // N-2: 身元ヘッダを毎回付けると cloaker は UA ではなくヘッダで選別すれば足り、UA 交代が
  // 無意味になる。ヘッダは identifying UA の回だけ・ブラウザ UA の回は素の probe にする。
  it('UA を 1 時間ごとに交代させ、身元ヘッダは identifying UA の回だけ付ける', async () => {
    const hour = 3_600_000;
    const seen = new Set(
      Array.from({ length: REVERIFY_USER_AGENTS.length }, (_, i) =>
        reverifyUserAgent(i * hour),
      ),
    );
    expect(seen.size).toBe(REVERIFY_USER_AGENTS.length);
    expect(REVERIFY_USER_AGENTS.length).toBeGreaterThan(1);
    // 同一バケット内は同じ UA (1 run 内で揺れない)。
    expect(reverifyUserAgent(hour + 1)).toBe(reverifyUserAgent(hour + hour - 1));
    expect(reverifyUserAgent(0)).toBe(REVERIFY_IDENTIFYING_USER_AGENT);
    expect(reverifyUserAgent(hour)).not.toBe(REVERIFY_IDENTIFYING_USER_AGENT);

    async function headersAt(probeAtMs: number) {
      const fetchImpl = vi.fn(async () => new Response('', { status: 503 }));
      await probeForReverify('https://x.test/paid', {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        lookup: lookupPublic,
        probeAtMs,
      });
      const [, init] = fetchImpl.mock.calls[0] as unknown as [
        string,
        { headers: Record<string, string> },
      ];
      return init.headers;
    }

    // identifying バケット: UA も身元ヘッダも名乗る (正直な運用者が allow-list できる)。
    const identifying = await headersAt(0);
    expect(identifying['user-agent']).toBe(REVERIFY_IDENTIFYING_USER_AGENT);
    expect(identifying[REVERIFY_IDENTITY_HEADER]).toBe('1');

    // ブラウザ UA バケット: 身元ヘッダを付けない (ヘッダで選別する cloaker に見えない)。
    const browserLike = await headersAt(hour);
    expect(browserLike['user-agent']).toBe(reverifyUserAgent(hour));
    expect(browserLike[REVERIFY_IDENTITY_HEADER]).toBeUndefined();
  });

  // N-3: 別ホストへの転送だけを block にする。apex→www / http→https の 301 まで block にすると、
  // 正当な出品が 6 時間で hidden になり、hidden は monotone なので dual-rail の USDC 購入が
  // 404 になる (lib/x402/dualRailRelay.ts の resolveTarget)。
  // ⚠️ この分類は fetchSsrfSafe の redirect:'manual' に依存する — undici が 3xx を追跡せず
  //    そのまま返すからこそ Location を読める。追跡モードに変えると本判定は死ぬ。
  it.each([
    ['https://www.x.test/paid', 'neutral'],
    ['https://x.test/paid', 'neutral'],
    ['/login', 'neutral'],
    ['https://elsewhere.test/blocked', 'block'],
    ['https://x.test.evil.example/paid', 'block'],
  ] as const)('301 Location %s → authClass %s', async (location, authClass) => {
    // 登録 URL は apex の http。www 付与・https 昇格・相対はいずれも正当な正規化。
    const probe = await probeForReverifyDetailed('http://x.test/paid', {
      fetchImpl: (async () =>
        new Response('', { status: 301, headers: { location } })) as typeof fetch,
      lookup: lookupPublic,
    });
    expect(probe).toEqual({ verdict: 'transient', authClass });
  });

  it('www 付きで登録された URL の apex への 301 も neutral', async () => {
    const probe = await probeForReverifyDetailed('https://www.x.test/paid', {
      fetchImpl: (async () =>
        new Response('', {
          status: 308,
          headers: { location: 'https://x.test/paid' },
        })) as typeof fetch,
      lookup: lookupPublic,
    });
    expect(probe.authClass).toBe('neutral');
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
