import type { ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import {
  QueryClient,
  QueryClientProvider,
} from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Address, Hex } from 'viem';
import {
  CONTENT_READBACK_CASES,
  PHASE_STATUS_TABLE,
  PURCHASE_STATUS_CASES,
  TABLE_INTENT_SALT,
  TABLE_RESOURCE_ID,
  TABLE_TX_HASH,
} from '../_helpers/hostedPurchaseResponseTables';

// R15b (parser / phase 対応表の抽出) の前後で hook の観測挙動が変わらないことを固定する。
// 旧コード (抽出前) でもそのまま走るよう、hook の公開 API だけを経由して検査する。

const FORWARDER =
  '0x752B7AaD0089286EB7b553d84D05233d80c9FCB4' as Address;
const MERCHANT =
  '0x2222222222222222222222222222222222222222' as Address;
const FEE_RECEIVER =
  '0x3333333333333333333333333333333333333333' as Address;
const PAYER =
  '0x1111111111111111111111111111111111111111' as Address;
const OTHER =
  '0x4444444444444444444444444444444444444444' as Address;
// 大文字小文字の差だけで scope が切り替わらないことを見るため、英字を含む checksum address。
const MIXED_MERCHANT =
  '0xABcdEFABcdEFabcdEfAbCdefabcdeFABcDEFabCD' as Address;
const MIXED_PAYER =
  '0xfeDcbaFEdcBaFEDcbAfedcBAfeDCBAFeDCBafEdc' as Address;
const JPYC =
  '0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29' as Address;
const SIGNATURE = `0x${'cd'.repeat(65)}` as Hex;
const RESOURCE_ID = TABLE_RESOURCE_ID;
const INTENT_SALT = TABLE_INTENT_SALT;
const TX_HASH = TABLE_TX_HASH;
const TITLE = 'Fixture product';
const PRICE_JPYC = '1200';
const PRICE = 1_200n * 10n ** 18n;
const FEE = 12n * 10n ** 18n;

const account = vi.hoisted(() => ({
  address: '0x1111111111111111111111111111111111111111' as
    | Address
    | undefined,
  chainId: 80002 as number | undefined,
}));
const signTypedData = vi.hoisted(() => vi.fn());

vi.mock('wagmi', () => ({
  useAccount: () => ({
    address: account.address,
    chainId: account.chainId,
  }),
  useWalletClient: () => ({
    data: {
      signTypedData,
    },
  }),
}));

vi.mock('@/lib/env', () => ({
  env: {
    networkEnv: 'testnet',
    enableLicenseNftUi: false,
    feeReceiver:
      '0x3333333333333333333333333333333333333333',
    feeReceiverConfigured: true,
  },
}));

vi.mock('@/lib/relay/forwarderConfig', () => ({
  configuredJpycForwarderFor: () =>
    '0x752B7AaD0089286EB7b553d84D05233d80c9FCB4',
}));

import { FORWARDER_COMMIT_VERSION } from '@/lib/relay/forwarderIntent';
import {
  HostedStorePurchaseError,
  useHostedStorePurchase,
} from '@/hooks/useHostedStorePurchase';

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function paymentRequired(
  resourceId = RESOURCE_ID,
  merchant: Address = MERCHANT,
  payer: Address = PAYER,
): Record<string, unknown> {
  return {
    x402Version: 1,
    accepts: [
      {
        scheme: 'exact',
        network: 'eip155:80002',
        maxAmountRequired: (PRICE + FEE).toString(),
        resource: `https://open-pay.jp/api/paid/hosted/${resourceId}?payer=${payer}`,
        description: TITLE,
        mimeType: 'application/json',
        payTo: FORWARDER,
        maxTimeoutSeconds: 600,
        asset: JPYC,
        extra: {
          name: 'JPY Coin',
          version: '1',
          decimals: 18,
          assetTransferMethod: 'eip3009',
          openpay: {
            mode: 'forwarder-split',
            forwarder: FORWARDER,
            merchant,
            merchantValue: PRICE.toString(),
            feeReceiver: FEE_RECEIVER,
            feeValue: FEE.toString(),
            commitVersion: FORWARDER_COMMIT_VERSION,
            intentSalt: INTENT_SALT,
            authorizationValidBeforeMax: '2000000000',
          },
        },
      },
    ],
    error: 'payment_required',
  };
}

function settledPaidBody(resourceId = RESOURCE_ID): Record<string, unknown> {
  return {
    ok: true,
    state: 'settled',
    resourceId,
    contentRevision: 1,
    title: TITLE,
    kind: 'text',
    value: 'paid content',
    txHash: TX_HASH,
  };
}

function readyContentBody(): Record<string, unknown> {
  return {
    ok: true,
    state: 'ready',
    resourceId: RESOURCE_ID,
    intentSalt: INTENT_SALT,
    title: TITLE,
    contentRevision: 1,
    kind: 'text',
    value: 'paid content',
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type Handler = () => Response | Promise<Response>;
type Routes = {
  quote?: Handler;
  paid?: Handler;
  status?: Handler;
  content?: Handler;
};

const HOLD: Handler = () => new Promise<Response>(() => undefined);

function routeFetch(routes: Routes) {
  return vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.startsWith('/api/paid/hosted/')) {
        if (new Headers(init?.headers).has('X-PAYMENT')) {
          return (routes.paid ?? HOLD)();
        }
        return (routes.quote ?? (() => jsonResponse(paymentRequired(), 402)))();
      }
      if (url.startsWith('/api/store/purchase/status')) {
        return (routes.status ?? HOLD)();
      }
      if (url.startsWith('/api/store/content/')) {
        return (routes.content ?? HOLD)();
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
}

type HookProps = Parameters<typeof useHostedStorePurchase>[0];

function baseProps(overrides: Partial<HookProps> = {}): HookProps {
  return {
    resourceId: RESOURCE_ID,
    title: TITLE,
    merchant: MERCHANT,
    priceJpyc: PRICE_JPYC,
    sessionAddress: PAYER,
    rail: 'jpyc',
    ...overrides,
  };
}

function renderPurchase(initial: HookProps = baseProps()) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        {children}
      </QueryClientProvider>
    );
  }
  const rendered = renderHook(
    (props: HookProps) => useHostedStorePurchase(props),
    { initialProps: initial, wrapper: Wrapper },
  );
  return { ...rendered, queryClient };
}

type Rendered = ReturnType<typeof renderPurchase>;

async function prepareToReview(rendered: Rendered) {
  await act(async () => {
    await rendered.result.current.prepare();
  });
  expect(rendered.result.current.phase).toBe('review');
}

/** 非同期の state 反映を数 tick 待つ (応答を処理済みにしてから「変化しない」ことを見る)。 */
async function settle(ms = 30) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

function calledWith(
  fetchMock: ReturnType<typeof routeFetch>,
  prefix: string,
): boolean {
  return fetchMock.mock.calls.some(([url]) =>
    String(url).startsWith(prefix),
  );
}

function switchWallet(rendered: Rendered, props: HookProps, to: Address) {
  account.address = to;
  rendered.rerender({ ...props, sessionAddress: to });
}

beforeEach(() => {
  vi.restoreAllMocks();
  account.address = PAYER;
  account.chainId = 80002;
  signTypedData.mockReset();
  signTypedData.mockResolvedValue(SIGNATURE);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('R15b pin: phase → paymentStatus / accessStatus (hook 経由で全 phase)', () => {
  type Reach = (rendered: Rendered) => Promise<void>;
  const reach: Record<string, { routes: Routes; go: Reach; fakeTimers?: true }> = {
    idle: { routes: {}, go: async () => undefined },
    'loading-quote': {
      routes: { quote: HOLD },
      go: async (rendered) => {
        act(() => {
          void rendered.result.current.prepare();
        });
      },
    },
    review: { routes: {}, go: prepareToReview },
    signing: {
      routes: {},
      go: async (rendered) => {
        await prepareToReview(rendered);
        signTypedData.mockImplementation(
          () => new Promise(() => undefined),
        );
        act(() => {
          void rendered.result.current.purchase();
        });
      },
    },
    submitting: {
      routes: { paid: HOLD },
      go: async (rendered) => {
        await prepareToReview(rendered);
        await act(async () => {
          void rendered.result.current.purchase();
        });
      },
    },
    indeterminate: {
      routes: { paid: () => jsonResponse({ ok: true, state: 'pending' }, 202) },
      go: async (rendered) => {
        await prepareToReview(rendered);
        await act(async () => {
          await rendered.result.current.purchase();
        });
      },
    },
    'indeterminate-exhausted': {
      fakeTimers: true,
      routes: { paid: () => jsonResponse({ ok: true, state: 'pending' }, 202) },
      go: async (rendered) => {
        await act(async () => {
          await rendered.result.current.prepare();
        });
        await act(async () => {
          await rendered.result.current.purchase();
        });
        await act(async () => {
          await vi.advanceTimersByTimeAsync(90_000);
        });
      },
    },
    provisioning: {
      routes: {
        paid: () => jsonResponse(settledPaidBody(), 200),
        content: () => jsonResponse({ ok: false, error: 'not_found' }, 404),
      },
      go: async (rendered) => {
        await prepareToReview(rendered);
        await act(async () => {
          await rendered.result.current.purchase();
        });
      },
    },
    ready: {
      routes: {
        paid: () => jsonResponse(settledPaidBody(), 200),
        content: () => jsonResponse(readyContentBody(), 200),
      },
      go: async (rendered) => {
        await prepareToReview(rendered);
        await act(async () => {
          await rendered.result.current.purchase();
        });
        await waitFor(() => expect(rendered.result.current.phase).toBe('ready'));
      },
    },
    'needs-support': {
      routes: {
        paid: () => jsonResponse(settledPaidBody(), 200),
        content: () =>
          jsonResponse({ ...readyContentBody(), state: 'provided-ended' }, 200),
      },
      go: async (rendered) => {
        await prepareToReview(rendered);
        await act(async () => {
          await rendered.result.current.purchase();
        });
        await waitFor(() =>
          expect(rendered.result.current.phase).toBe('needs-support'),
        );
      },
    },
    'failed-prebroadcast': {
      routes: {
        paid: () =>
          jsonResponse({ ok: false, error: 'purchase_intent_failed' }, 409),
      },
      go: async (rendered) => {
        await prepareToReview(rendered);
        await act(async () => {
          await rendered.result.current.purchase();
        });
      },
    },
    error: {
      routes: { quote: () => jsonResponse({ error: 'boom' }, 500) },
      go: async (rendered) => {
        await act(async () => {
          await rendered.result.current.prepare().catch(() => undefined);
        });
      },
    },
  };

  const busy = new Set(['loading-quote', 'signing', 'submitting']);
  const retryable = new Set(['indeterminate', 'indeterminate-exhausted']);

  it.each(PHASE_STATUS_TABLE)(
    '%s → payment=%s / access=%s',
    async (phase, paymentStatus, accessStatus) => {
      const step = reach[phase];
      if (step.fakeTimers) vi.useFakeTimers();
      routeFetch(step.routes);
      const rendered = renderPurchase();
      await step.go(rendered);
      const current = rendered.result.current;
      expect(current.phase).toBe(phase);
      expect(current.paymentStatus).toBe(paymentStatus);
      expect(current.accessStatus).toBe(accessStatus);
      expect(current.isBusy).toBe(busy.has(phase));
      expect(current.canRetrySignedPayment).toBe(retryable.has(phase));
    },
  );

  it('表は hook の phase union 12 種をすべて網羅する', () => {
    expect(PHASE_STATUS_TABLE.map(([phase]) => phase).sort()).toEqual(
      Object.keys(reach).sort(),
    );
    expect(PHASE_STATUS_TABLE).toHaveLength(12);
  });
});

describe('R15b pin: status 応答 parser (hook 経由)', () => {
  it.each(PURCHASE_STATUS_CASES)('$label', async ({ body, expected }) => {
    const fetchMock = routeFetch({
      paid: () => jsonResponse({ ok: true, state: 'pending' }, 202),
      status: () => jsonResponse(body, 200),
      content: () => jsonResponse({ ok: false, error: 'not_found' }, 404),
    });
    const rendered = renderPurchase();
    await prepareToReview(rendered);
    await act(async () => {
      await rendered.result.current.purchase();
    });
    await waitFor(() =>
      expect(calledWith(fetchMock, '/api/store/purchase/status')).toBe(true),
    );

    if (expected?.state === 'settled') {
      await waitFor(() =>
        expect(rendered.result.current.phase).toBe('provisioning'),
      );
      expect(rendered.result.current.txHash).toBe(expected.txHash);
      expect(rendered.result.current.paymentStatus).toBe('confirmed');
      return;
    }
    if (expected?.state === 'failed') {
      await waitFor(() =>
        expect(rendered.result.current.phase).toBe('failed-prebroadcast'),
      );
      expect(rendered.result.current.error?.message).toBe(
        'purchase_intent_failed',
      );
      return;
    }
    // pending / 不正応答はどちらも確認中のまま (不正応答を成立・未実行へ倒さない)。
    await settle();
    expect(rendered.result.current.phase).toBe('indeterminate');
    expect(rendered.result.current.txHash).toBeNull();
    expect(rendered.result.current.paymentStatus).toBe('unknown');
  });

  it('status route の HTTP error は確認中のまま据え置く', async () => {
    const fetchMock = routeFetch({
      paid: () => jsonResponse({ ok: true, state: 'pending' }, 202),
      status: () => jsonResponse({ error: 'rate_limited' }, 429),
    });
    const rendered = renderPurchase();
    await prepareToReview(rendered);
    await act(async () => {
      await rendered.result.current.purchase();
    });
    await waitFor(() =>
      expect(calledWith(fetchMock, '/api/store/purchase/status')).toBe(true),
    );
    await settle();
    expect(rendered.result.current.phase).toBe('indeterminate');
  });
});

describe('R15b pin: own content read-back parser (hook 経由)', () => {
  it.each(CONTENT_READBACK_CASES)('$label', async ({ body, expected }) => {
    const fetchMock = routeFetch({
      paid: () => jsonResponse(settledPaidBody(), 200),
      status: () =>
        jsonResponse({ ok: true, state: 'settled', txHash: TX_HASH }, 200),
      content: () => jsonResponse(body, 200),
    });
    const rendered = renderPurchase();
    await prepareToReview(rendered);
    await act(async () => {
      await rendered.result.current.purchase();
    });
    await waitFor(() =>
      expect(calledWith(fetchMock, '/api/store/content/')).toBe(true),
    );

    if (expected?.state === 'ready') {
      await waitFor(() => expect(rendered.result.current.phase).toBe('ready'));
      expect(rendered.result.current.content).toEqual(expected);
      expect(rendered.result.current.needsSupportReason).toBeNull();
      return;
    }
    if (expected?.state === 'provided-ended') {
      await waitFor(() =>
        expect(rendered.result.current.phase).toBe('needs-support'),
      );
      expect(rendered.result.current.content).toBeNull();
      expect(rendered.result.current.needsSupportReason).toBe('provided-ended');
      return;
    }
    await settle();
    expect(rendered.result.current.phase).toBe('provisioning');
    expect(rendered.result.current.content).toBeNull();
    expect(rendered.result.current.error).toBeNull();
  });
});

describe('R15b pin: session / product scope と古い完了の扱い', () => {
  it('初回 mount は既存の store cache を消さず、wallet 切替で store cache を全消去する', async () => {
    routeFetch({});
    const queryClient = new QueryClient();
    queryClient.setQueryData(['store', 'library', PAYER], ['kept']);
    queryClient.setQueryData(['other', 'x'], 'untouched');
    function Wrapper({ children }: { children: ReactNode }) {
      return (
        <QueryClientProvider client={queryClient}>
          {children}
        </QueryClientProvider>
      );
    }
    const props = baseProps();
    const rendered = renderHook(
      (p: HookProps) => useHostedStorePurchase(p),
      { initialProps: props, wrapper: Wrapper },
    );
    expect(queryClient.getQueryData(['store', 'library', PAYER])).toEqual([
      'kept',
    ]);

    account.address = OTHER;
    rendered.rerender({ ...props, sessionAddress: OTHER });
    expect(queryClient.getQueryData(['store', 'library', PAYER])).toBeUndefined();
    expect(queryClient.getQueryData(['other', 'x'])).toBe('untouched');
  });

  it('address / merchant の大文字小文字だけの変化では scope を切り替えない', async () => {
    routeFetch({
      quote: () =>
        jsonResponse(
          paymentRequired(RESOURCE_ID, MIXED_MERCHANT, MIXED_PAYER),
          402,
        ),
    });
    account.address = MIXED_PAYER;
    const props = baseProps({
      merchant: MIXED_MERCHANT,
      sessionAddress: MIXED_PAYER,
    });
    const rendered = renderPurchase(props);
    await prepareToReview(rendered);

    account.address = MIXED_PAYER.toLowerCase() as Address;
    rendered.rerender({
      ...props,
      sessionAddress: MIXED_PAYER.toLowerCase() as Address,
      merchant: MIXED_MERCHANT.toLowerCase() as Address,
    });
    expect(rendered.result.current.phase).toBe('review');
    expect(rendered.result.current.quote).toMatchObject({
      merchant: MIXED_MERCHANT,
    });
  });

  it.each([
    ['resourceId', { resourceId: 'h_other' }],
    ['title', { title: 'Other title' }],
    ['merchant', { merchant: OTHER }],
    ['priceJpyc', { priceJpyc: '1300' }],
    ['rail', { rail: 'usdc' as const }],
  ])('product scope (%s) が変わると review を破棄して idle に戻す', async (_label, change) => {
    routeFetch({});
    const props = baseProps();
    const rendered = renderPurchase(props);
    await prepareToReview(rendered);

    rendered.rerender({ ...props, ...change });
    expect(rendered.result.current.phase).toBe('idle');
    expect(rendered.result.current.quote).toBeNull();
    expect(rendered.result.current.error).toBeNull();
  });

  it('quote 取得中に wallet が切り替わると、遅れて届いた 402 を review に出さず wallet_changed', async () => {
    const quote = deferred<Response>();
    routeFetch({ quote: () => quote.promise });
    const props = baseProps();
    const rendered = renderPurchase(props);
    let pending!: Promise<unknown>;
    act(() => {
      pending = rendered.result.current.prepare();
    });
    expect(rendered.result.current.phase).toBe('loading-quote');

    switchWallet(rendered, props, OTHER);
    expect(rendered.result.current.phase).toBe('idle');

    let thrown: unknown;
    await act(async () => {
      quote.resolve(jsonResponse(paymentRequired(), 402));
      thrown = await pending.catch((error: unknown) => error);
    });
    expect(thrown).toBeInstanceOf(HostedStorePurchaseError);
    expect((thrown as HostedStorePurchaseError).code).toBe('wallet_changed');
    expect(rendered.result.current.phase).toBe('error');
    expect(rendered.result.current.quote).toBeNull();
    expect(signTypedData).not.toHaveBeenCalled();
  });

  it('署名済み request の送信中に wallet が切り替わると、遅れて届いた 200 settled を無視する', async () => {
    const paid = deferred<Response>();
    const fetchMock = routeFetch({ paid: () => paid.promise });
    const props = baseProps();
    const rendered = renderPurchase(props);
    await prepareToReview(rendered);
    let pending!: Promise<void>;
    await act(async () => {
      pending = rendered.result.current.purchase();
    });
    expect(rendered.result.current.phase).toBe('submitting');

    switchWallet(rendered, props, OTHER);
    expect(rendered.result.current.phase).toBe('idle');

    await act(async () => {
      paid.resolve(jsonResponse(settledPaidBody(), 200));
      await pending;
    });
    await settle();
    expect(rendered.result.current.phase).toBe('idle');
    expect(rendered.result.current.txHash).toBeNull();
    expect(rendered.result.current.content).toBeNull();
    expect(rendered.result.current.error).toBeNull();
    expect(rendered.result.current.canRetrySignedPayment).toBe(false);
    expect(calledWith(fetchMock, '/api/store/')).toBe(false);
  });

  it('署名済み request の送信中に wallet が切り替わると、遅れて届いた通信断も無視する', async () => {
    const paid = deferred<Response>();
    routeFetch({ paid: () => paid.promise });
    const props = baseProps();
    const rendered = renderPurchase(props);
    await prepareToReview(rendered);
    let pending!: Promise<void>;
    await act(async () => {
      pending = rendered.result.current.purchase();
    });

    switchWallet(rendered, props, OTHER);
    await act(async () => {
      paid.reject(new TypeError('network lost'));
      await pending;
    });
    expect(rendered.result.current.phase).toBe('idle');
    expect(rendered.result.current.error).toBeNull();
  });

  it('status 確認中に wallet が切り替わると、遅れて届いた settled を反映しない', async () => {
    const status = deferred<Response>();
    const fetchMock = routeFetch({
      paid: () => jsonResponse({ ok: true, state: 'pending' }, 202),
      status: () => status.promise,
    });
    const props = baseProps();
    const rendered = renderPurchase(props);
    await prepareToReview(rendered);
    await act(async () => {
      await rendered.result.current.purchase();
    });
    await waitFor(() =>
      expect(calledWith(fetchMock, '/api/store/purchase/status')).toBe(true),
    );

    switchWallet(rendered, props, OTHER);
    expect(rendered.result.current.phase).toBe('idle');
    await act(async () => {
      status.resolve(
        jsonResponse({ ok: true, state: 'settled', txHash: TX_HASH }, 200),
      );
    });
    await settle();
    expect(rendered.result.current.phase).toBe('idle');
    expect(rendered.result.current.txHash).toBeNull();
  });

  it('own read-back 中に wallet が切り替わると、遅れて届いた content を表示しない', async () => {
    const content = deferred<Response>();
    const fetchMock = routeFetch({
      paid: () => jsonResponse(settledPaidBody(), 200),
      status: HOLD,
      content: () => content.promise,
    });
    const props = baseProps();
    const rendered = renderPurchase(props);
    await prepareToReview(rendered);
    await act(async () => {
      await rendered.result.current.purchase();
    });
    await waitFor(() =>
      expect(calledWith(fetchMock, '/api/store/content/')).toBe(true),
    );

    switchWallet(rendered, props, OTHER);
    await act(async () => {
      content.resolve(jsonResponse(readyContentBody(), 200));
    });
    await settle();
    expect(rendered.result.current.phase).toBe('idle');
    expect(rendered.result.current.content).toBeNull();
    expect(rendered.result.current.accessStatus).toBe('none');
  });

  it('送信中/確認中の reset は署名済み request を保持したまま拒否し、wallet 切替だけが破棄する', async () => {
    routeFetch({
      paid: () => jsonResponse({ ok: true, state: 'pending' }, 202),
    });
    const props = baseProps();
    const rendered = renderPurchase(props);
    await prepareToReview(rendered);
    await act(async () => {
      await rendered.result.current.purchase();
    });
    act(() => rendered.result.current.reset());
    expect(rendered.result.current.phase).toBe('indeterminate');
    expect(rendered.result.current.canRetrySignedPayment).toBe(true);

    switchWallet(rendered, props, OTHER);
    expect(rendered.result.current.phase).toBe('idle');
    expect(rendered.result.current.canRetrySignedPayment).toBe(false);
    await expect(rendered.result.current.retry()).rejects.toMatchObject({
      code: 'signed_payment_unavailable',
    });
  });

  // 以下 2 件は「現状挙動の固定」。product scope の切替は wallet 切替と違い、
  // 進行中の request の完了を捨てない (UI 側は quote 取得中の rail 切替を disabled にしている)。
  // 抽出 PR では変えない — 挙動変更は別 PR (掟 12/15) で扱う。
  it('[現状固定] quote 取得中の product scope 切替では、遅れて届いた旧 quote が review に出る', async () => {
    const quote = deferred<Response>();
    routeFetch({ quote: () => quote.promise });
    const props = baseProps();
    const rendered = renderPurchase(props);
    let pending!: Promise<unknown>;
    act(() => {
      pending = rendered.result.current.prepare();
    });
    rendered.rerender({ ...props, priceJpyc: '1300' });
    expect(rendered.result.current.phase).toBe('idle');

    await act(async () => {
      quote.resolve(jsonResponse(paymentRequired(), 402));
      await pending;
    });
    expect(rendered.result.current.phase).toBe('review');
    expect(rendered.result.current.quote).toMatchObject({
      merchantValueJpyc: '1200',
    });
  });

  it('[現状固定] 送信中の product scope 切替では、遅れて届いた旧商品の 200 settled で provisioning になる', async () => {
    const paid = deferred<Response>();
    routeFetch({ paid: () => paid.promise });
    const props = baseProps();
    const rendered = renderPurchase(props);
    await prepareToReview(rendered);
    let pending!: Promise<void>;
    await act(async () => {
      pending = rendered.result.current.purchase();
    });
    rendered.rerender({ ...props, resourceId: 'h_other' });
    expect(rendered.result.current.phase).toBe('idle');

    await act(async () => {
      paid.resolve(jsonResponse(settledPaidBody(RESOURCE_ID), 200));
      await pending;
    });
    expect(rendered.result.current.phase).toBe('provisioning');
    expect(rendered.result.current.quote).toBeNull();
    expect(rendered.result.current.txHash).toBe(TX_HASH);
    expect(rendered.result.current.canRetrySignedPayment).toBe(false);
  });
});
