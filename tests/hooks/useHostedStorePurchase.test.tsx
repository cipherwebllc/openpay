import type { ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import {
  QueryClient,
  QueryClientProvider,
} from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  keccak256,
  stringToHex,
  type Address,
  type Hex,
} from 'viem';

const FORWARDER =
  '0x752B7AaD0089286EB7b553d84D05233d80c9FCB4' as Address;
const MERCHANT =
  '0x2222222222222222222222222222222222222222' as Address;
const FEE_RECEIVER =
  '0x3333333333333333333333333333333333333333' as Address;
const PAYER =
  '0x1111111111111111111111111111111111111111' as Address;
const JPYC =
  '0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29' as Address;
const INTENT_SALT = `0x${'ab'.repeat(32)}` as Hex;
const SIGNATURE = `0x${'cd'.repeat(65)}` as Hex;
const TX_HASH = `0x${'ef'.repeat(32)}` as Hex;
const RESOURCE_ID = 'h_fixture';
const TITLE = 'Fixture product';
const PRICE_JPYC = '1200';
const PRICE = 1_200n * 10n ** 18n;
const FEE = 12n * 10n ** 18n;
const USDC =
  '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address;
const USDC_INTENT_SALT = `0x${'34'.repeat(32)}` as Hex;
const USDC_SERVER_NONCE = keccak256(
  stringToHex(
    `openpay:creator-store-usdc-vanilla-v1:${USDC_INTENT_SALT}`,
  ),
);
const USDC_NOW = 1_800_000_000_000;

const account = vi.hoisted(() => ({
  address: '0x1111111111111111111111111111111111111111' as
    | Address
    | undefined,
  chainId: 80002 as number | undefined,
}));
const licenseFlags = vi.hoisted(() => ({ enabled: false }));
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
    get enableLicenseNftUi() { return licenseFlags.enabled; },
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
  useHostedStorePurchase,
} from '@/hooks/useHostedStorePurchase';
import {
  HostedPurchaseWireError,
} from '@/lib/x402/hostedPurchaseWire';

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function paymentRequired(): Record<string, unknown> {
  return {
    x402Version: 1,
    accepts: [
      {
        scheme: 'exact',
        network: 'eip155:80002',
        maxAmountRequired: (PRICE + FEE).toString(),
        resource: `https://open-pay.jp/api/paid/hosted/${RESOURCE_ID}?payer=${PAYER}`,
        description: 'Fixture product',
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
            merchant: MERCHANT,
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

function usdcPaymentRequired(): Record<string, unknown> {
  const rateFetchedAt = USDC_NOW - 60_000;
  const fxQuoteExpiresAt = USDC_NOW + 120_000;
  return {
    x402Version: 1,
    accepts: [
      {
        scheme: 'exact',
        network: 'base',
        maxAmountRequired: '8000000',
        resource: `https://open-pay.jp/api/paid/hosted/${RESOURCE_ID}?payer=${PAYER}&rail=usdc`,
        description: TITLE,
        mimeType: 'application/json',
        payTo: MERCHANT,
        maxTimeoutSeconds: 180,
        asset: USDC,
        extra: {
          name: 'USD Coin',
          version: '2',
          decimals: 6,
          assetTransferMethod: 'eip3009',
          openpay: {
            rail: 'usdc',
            deploymentVersion: 'creator-store-usdc-vanilla-v1',
            intentSalt: USDC_INTENT_SALT,
            nonce: USDC_SERVER_NONCE,
            usdcQuoteAtomic: '8000000',
            priceJpyc: PRICE_JPYC,
            rateScaled: '150000000',
            rateFetchedAt,
            fxQuoteExpiresAt,
            rounding: 'ceil',
            authorizationValidBeforeMax: String(
              Math.floor(fxQuoteExpiresAt / 1_000),
            ),
          },
        },
      },
    ],
  };
}

function settledPaidBody(): Record<string, unknown> {
  return {
    ok: true,
    state: 'settled',
    resourceId: RESOURCE_ID,
    contentRevision: 1,
    title: 'Fixture product',
    kind: 'text',
    value: 'paid content',
    txHash: TX_HASH,
  };
}

function mutateChallenge(
  mutate: (accept: Record<string, unknown>) => void,
): Record<string, unknown> {
  const body = structuredClone(paymentRequired());
  mutate((body.accepts as Record<string, unknown>[])[0]);
  return body;
}

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        {children}
      </QueryClientProvider>
    );
  };
}

function renderPurchase(rail: 'jpyc' | 'usdc' = 'jpyc') {
  return renderHook(
    () =>
      useHostedStorePurchase({
        resourceId: RESOURCE_ID,
        title: TITLE,
        merchant: MERCHANT,
        priceJpyc: PRICE_JPYC,
        sessionAddress: PAYER,
        rail,
      }),
    { wrapper: createWrapper() },
  );
}

async function prepare(
  result: ReturnType<typeof renderPurchase>['result'],
) {
  await act(async () => {
    await result.current.prepare();
  });
  await waitFor(() => expect(result.current.phase).toBe('review'));
}

beforeEach(() => {
  licenseFlags.enabled = false;
  vi.restoreAllMocks();
  account.address = PAYER;
  account.chainId = 80002;
  signTypedData.mockReset();
  signTypedData.mockResolvedValue(SIGNATURE);
});

describe('useHostedStorePurchase quote fence', () => {
  it('USDC は ?rail=usdc の 402 を Base native USDC と server nonce へ束縛してから署名する', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(USDC_NOW);
    account.chainId = 8453;
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input, init) => {
        const url = String(input);
        if (url.startsWith('/api/paid/hosted/')) {
          return new Headers(init?.headers).has('X-PAYMENT')
            ? jsonResponse({ ok: true, state: 'pending' }, 202)
            : jsonResponse(usdcPaymentRequired(), 402);
        }
        if (
          url ===
          `/api/store/purchase/status?intentSalt=${encodeURIComponent(
            USDC_INTENT_SALT,
          )}&rail=usdc`
        ) {
          return jsonResponse(
            { ok: true, state: 'settled', txHash: TX_HASH },
            200,
          );
        }
        if (url.startsWith('/api/store/content/')) {
          return jsonResponse(
            {
              ok: true,
              state: 'ready',
              resourceId: RESOURCE_ID,
              intentSalt: USDC_INTENT_SALT,
              title: TITLE,
              contentRevision: 1,
              kind: 'text',
              value: 'paid with USDC',
            },
            200,
          );
        }
        throw new Error(`unexpected fetch: ${url}`);
      });
    const { result } = renderPurchase('usdc');

    await prepare(result);
    expect(result.current.quote).toMatchObject({
      rail: 'usdc',
      chainId: 8453,
      asset: USDC,
      merchant: MERCHANT,
      nonce: USDC_SERVER_NONCE,
      usdcQuoteAtomic: 8_000_000n,
      paidUsdc: '8',
      priceJpyc: PRICE_JPYC,
    });

    await act(async () => {
      await result.current.purchase();
    });
    await waitFor(() => expect(result.current.phase).toBe('ready'));

    expect(signTypedData).toHaveBeenCalledOnce();
    expect(signTypedData.mock.calls[0]?.[0]).toMatchObject({
      domain: {
        name: 'USD Coin',
        version: '2',
        chainId: 8453,
        verifyingContract: USDC,
      },
      primaryType: 'TransferWithAuthorization',
      message: {
        from: PAYER,
        to: MERCHANT,
        value: 8_000_000n,
        validAfter: 0n,
        nonce: USDC_SERVER_NONCE,
      },
    });
    const paidCall = fetchMock.mock.calls.find(([, init]) =>
      new Headers(init?.headers).has('X-PAYMENT'),
    );
    expect(paidCall?.[0]).toBe(
      `/api/paid/hosted/${RESOURCE_ID}?payer=${encodeURIComponent(PAYER)}&rail=usdc`,
    );
    expect(paidCall?.[1]?.method).toBe('GET');
    const header = new Headers(paidCall?.[1]?.headers).get('X-PAYMENT');
    const payload = JSON.parse(
      Buffer.from(header ?? '', 'base64').toString('utf8'),
    );
    expect(payload.payload.authorization.nonce).toBe(USDC_SERVER_NONCE);
    expect(payload.payload.authorization.value).toBe('8000000');
    expect(result.current.content?.value).toBe('paid with USDC');
  });

  it('prepare は validated quote を返すだけで、最終確認前に署名しない', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(paymentRequired(), 402),
    );
    const { result } = renderPurchase();
    let quote:
      | Awaited<ReturnType<typeof result.current.prepare>>
      | undefined;

    await act(async () => {
      quote = await result.current.prepare();
    });

    expect(result.current.phase).toBe('review');
    expect(quote).toMatchObject({
      merchantValue: PRICE,
      feeValue: FEE,
      totalValue: PRICE + FEE,
      merchantValueJpyc: '1200',
      feeValueJpyc: '12',
      totalValueJpyc: '1212',
      chainId: 80002,
      merchant: MERCHANT,
      forwarder: FORWARDER,
      intentSalt: INTENT_SALT,
    });
    expect(signTypedData).not.toHaveBeenCalled();
  });

  it('quote 後に wallet chainId が未取得なら wrong-chain 導線を有効にする', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(paymentRequired(), 402),
    );
    const rendered = renderPurchase();
    await prepare(rendered.result);

    account.chainId = undefined;
    rendered.rerender();

    expect(rendered.result.current.requiredChainId).toBe(80002);
    expect(rendered.result.current.isWrongChain).toBe(true);
    expect(signTypedData).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'commitVersion 不一致',
      expected: 'commit_version_mismatch',
      mutate: (accept: Record<string, unknown>) => {
        const openpay = (
          accept.extra as Record<string, Record<string, unknown>>
        ).openpay;
        openpay.commitVersion = `0x${'12'.repeat(32)}`;
      },
    },
    {
      label: '金額不一致',
      expected: 'amount_mismatch',
      mutate: (accept: Record<string, unknown>) => {
        accept.maxAmountRequired = (PRICE + FEE + 1n).toString();
      },
    },
    {
      label: 'asset 不一致',
      expected: 'asset_mismatch',
      mutate: (accept: Record<string, unknown>) => {
        accept.asset =
          '0x4444444444444444444444444444444444444444';
      },
    },
    {
      label: 'merchant 不一致',
      expected: 'merchant_mismatch',
      mutate: (accept: Record<string, unknown>) => {
        const openpay = (
          accept.extra as Record<string, Record<string, unknown>>
        ).openpay;
        openpay.merchant =
          '0x5555555555555555555555555555555555555555';
      },
    },
    {
      label: 'salt 欠落 402',
      expected: 'intent_salt_required',
      mutate: (accept: Record<string, unknown>) => {
        const openpay = (
          accept.extra as Record<string, Record<string, unknown>>
        ).openpay;
        delete openpay.intentSalt;
      },
    },
  ])('$label は purchase/sign 前に拒否する', async ({
    mutate,
    expected,
  }) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(mutateChallenge(mutate), 402),
    );
    const { result } = renderPurchase();
    let thrown: unknown;

    await act(async () => {
      try {
        await result.current.prepare();
      } catch (error) {
        thrown = error;
      }
    });

    expect(thrown).toBeInstanceOf(HostedPurchaseWireError);
    expect((thrown as HostedPurchaseWireError).code).toBe(expected);
    expect(result.current.phase).toBe('error');
    expect(signTypedData).not.toHaveBeenCalled();
  });
});

describe('useHostedStorePurchase settlement and read-back', () => {
  it('status が解決しない場合は D2 の timeout state へ移り、新 quote/reset を封鎖する', async () => {
    vi.useFakeTimers();
    try {
      const statusHold = new Promise<Response>(() => undefined);
      vi.spyOn(globalThis, 'fetch').mockImplementation(
        async (input, init) => {
          const url = String(input);
          if (url.startsWith('/api/store/purchase/status')) {
            return statusHold;
          }
          return new Headers(init?.headers).has('X-PAYMENT')
            ? jsonResponse({ ok: true, state: 'pending' }, 202)
            : jsonResponse(paymentRequired(), 402);
        },
      );
      const { result } = renderPurchase();
      await act(async () => {
        await result.current.prepare();
      });
      await act(async () => {
        await result.current.purchase();
      });
      expect(result.current.phase).toBe('indeterminate');

      await act(async () => {
        await vi.advanceTimersByTimeAsync(90_000);
      });
      expect(result.current.phase).toBe('indeterminate-exhausted');
      expect(result.current.paymentStatus).toBe('unknown');
      expect(result.current.accessStatus).toBe('needs-support');
      expect(result.current.needsSupportReason).toBe(
        'payment-status-timeout',
      );
      expect(result.current.canRetrySignedPayment).toBe(true);

      act(() => result.current.reset());
      expect(result.current.phase).toBe('indeterminate-exhausted');
      expect(signTypedData).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('202 は status を自動 pollingし、settled後の own content 200 でのみ ready', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input, init) => {
        const url = String(input);
        if (url.startsWith('/api/paid/hosted/')) {
          return new Headers(init?.headers).has('X-PAYMENT')
            ? jsonResponse({ ok: true, state: 'pending' }, 202)
            : jsonResponse(paymentRequired(), 402);
        }
        if (url.startsWith('/api/store/purchase/status')) {
          return jsonResponse(
            { ok: true, state: 'settled', txHash: TX_HASH },
            200,
          );
        }
        if (url.startsWith('/api/store/content/')) {
          return jsonResponse(
            {
              ok: true,
              state: 'ready',
              resourceId: RESOURCE_ID,
              intentSalt: INTENT_SALT,
              title: 'Fixture product',
              contentRevision: 1,
              kind: 'text',
              value: 'paid content',
            },
            200,
          );
        }
        throw new Error(`unexpected fetch: ${url}`);
      });
    const { result } = renderPurchase();
    await prepare(result);

    await act(async () => {
      await result.current.purchase();
    });

    await waitFor(() => expect(result.current.phase).toBe('ready'));
    expect(result.current.paymentStatus).toBe('confirmed');
    expect(result.current.accessStatus).toBe('ready');
    expect(result.current.content?.value).toBe('paid content');
    expect(result.current.txHash).toBe(TX_HASH);
    expect(signTypedData).toHaveBeenCalledTimes(1);
    expect(
      fetchMock.mock.calls.some(([url]) =>
        String(url).startsWith('/api/store/purchase/status'),
      ),
    ).toBe(true);
    expect(
      fetchMock.mock.calls.some(([url]) =>
        String(url) ===
        `/api/store/content/${RESOURCE_ID}?intentSalt=${encodeURIComponent(
          INTENT_SALT,
        )}`,
      ),
    ).toBe(true);
  });

  it('payment 200 後も own read-back が404なら購入完了にせず provisioning', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (input, init) => {
        const url = String(input);
        if (url.startsWith('/api/paid/hosted/')) {
          return new Headers(init?.headers).has('X-PAYMENT')
            ? jsonResponse(settledPaidBody(), 200)
            : jsonResponse(paymentRequired(), 402);
        }
        if (url.startsWith('/api/store/content/')) {
          return jsonResponse({ ok: false, error: 'not_found' }, 404);
        }
        throw new Error(`unexpected fetch: ${url}`);
      },
    );
    const { result } = renderPurchase();
    await prepare(result);

    await act(async () => {
      await result.current.purchase();
    });

    await waitFor(() =>
      expect(result.current.paymentStatus).toBe('confirmed'),
    );
    await waitFor(() =>
      expect(result.current.accessStatus).toBe('provisioning'),
    );
    expect(result.current.phase).toBe('provisioning');
    expect(result.current.content).toBeNull();
  });

  it('503 purchase_provisioning は決済成立として own read-backを継続する', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (input, init) => {
        const url = String(input);
        if (url.startsWith('/api/paid/hosted/')) {
          return new Headers(init?.headers).has('X-PAYMENT')
            ? jsonResponse(
                { ok: false, error: 'purchase_provisioning' },
                503,
              )
            : jsonResponse(paymentRequired(), 402);
        }
        if (url.startsWith('/api/store/purchase/status')) {
          return jsonResponse(
            { ok: true, state: 'settled', txHash: TX_HASH },
            200,
          );
        }
        if (url.startsWith('/api/store/content/')) {
          return jsonResponse({ ok: false, error: 'not_found' }, 404);
        }
        throw new Error(`unexpected fetch: ${url}`);
      },
    );
    const { result } = renderPurchase();
    await prepare(result);

    await act(async () => {
      await result.current.purchase();
    });

    await waitFor(() =>
      expect(result.current.phase).toBe('provisioning'),
    );
    expect(result.current.paymentStatus).toBe('confirmed');
    expect(result.current.accessStatus).toBe('provisioning');
    expect(signTypedData).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([url]) =>
          String(url).startsWith('/api/store/purchase/status'),
        ),
      ).toBe(true),
    );
    // status 応答の state 反映は非同期 — 呼出直後の即時 assert は full suite の
    // 実行順で flake する (2026-07-30 実測) ため、txHash 自体を waitFor する。
    await waitFor(() => expect(result.current.txHash).toBe(TX_HASH));
  });

  it('提供終了 read-back は payment confirmed / needs-support に分ける', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (input, init) => {
        const url = String(input);
        if (url.startsWith('/api/paid/hosted/')) {
          return new Headers(init?.headers).has('X-PAYMENT')
            ? jsonResponse(settledPaidBody(), 200)
            : jsonResponse(paymentRequired(), 402);
        }
        if (url.startsWith('/api/store/content/')) {
          return jsonResponse(
            {
              ok: true,
              state: 'provided-ended',
              resourceId: RESOURCE_ID,
              intentSalt: INTENT_SALT,
              title: 'Fixture product',
              contentRevision: 1,
            },
            200,
          );
        }
        throw new Error(`unexpected fetch: ${url}`);
      },
    );
    const { result } = renderPurchase();
    await prepare(result);

    await act(async () => {
      await result.current.purchase();
    });

    await waitFor(() =>
      expect(result.current.phase).toBe('needs-support'),
    );
    expect(result.current.paymentStatus).toBe('confirmed');
    expect(result.current.accessStatus).toBe('needs-support');
    expect(result.current.needsSupportReason).toBe('provided-ended');
  });

  it('過去購入の own 200 を今回 intent の引き渡し完了として扱わない', async () => {
    const oldIntentSalt = `0x${'12'.repeat(32)}` as Hex;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (input, init) => {
        const url = String(input);
        if (url.startsWith('/api/paid/hosted/')) {
          return new Headers(init?.headers).has('X-PAYMENT')
            ? jsonResponse(
                { ok: false, error: 'purchase_provisioning' },
                503,
              )
            : jsonResponse(paymentRequired(), 402);
        }
        if (url.startsWith('/api/store/purchase/status')) {
          return jsonResponse(
            { ok: true, state: 'settled', txHash: TX_HASH },
            200,
          );
        }
        if (url.startsWith('/api/store/content/')) {
          return jsonResponse(
            {
              ok: true,
              state: 'ready',
              resourceId: RESOURCE_ID,
              intentSalt: oldIntentSalt,
              title: 'Old purchase',
              contentRevision: 1,
              kind: 'text',
              value: 'old content',
            },
            200,
          );
        }
        throw new Error(`unexpected fetch: ${url}`);
      },
    );
    const { result } = renderPurchase();
    await prepare(result);

    await act(async () => {
      await result.current.purchase();
    });

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([url]) =>
          String(url).startsWith('/api/store/content/'),
        ),
      ).toBe(true);
    });
    expect(result.current.phase).toBe('provisioning');
    expect(result.current.content).toBeNull();
    expect(result.current.accessStatus).toBe('provisioning');
  });

  it('409 purchase_intent_failed は支払い未実行の terminal state', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (input, init) => {
        const headers = new Headers(init?.headers);
        return headers.has('X-PAYMENT')
          ? jsonResponse(
              { ok: false, error: 'purchase_intent_failed' },
              409,
            )
          : jsonResponse(paymentRequired(), 402);
      },
    );
    const { result } = renderPurchase();
    await prepare(result);

    await act(async () => {
      await result.current.purchase();
    });

    expect(result.current.phase).toBe('failed-prebroadcast');
    expect(result.current.paymentStatus).toBe('not-executed');
    expect(result.current.accessStatus).toBe('none');
  });

  it.each([
    { status: 409, error: 'authorization_expired' },
    { status: 404, error: 'purchase_intent_not_found' },
  ])(
    '$status $error は永久 pending にせず支払い未実行へ収束する',
    async ({ status, error }) => {
      vi.spyOn(globalThis, 'fetch').mockImplementation(
        async (_input, init) =>
          new Headers(init?.headers).has('X-PAYMENT')
            ? jsonResponse({ ok: false, error }, status)
            : jsonResponse(paymentRequired(), 402),
      );
      const { result } = renderPurchase();
      await prepare(result);

      await act(async () => {
        await result.current.purchase();
      });

      expect(result.current.phase).toBe('failed-prebroadcast');
      expect(result.current.paymentStatus).toBe('not-executed');
      expect(result.current.canRetrySignedPayment).toBe(false);
    },
  );

  it('署名送信後の壊れた HTTP 200 は決済成立とせず status 確認へ倒す', async () => {
    const statusHold = new Promise<Response>(() => undefined);
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (input, init) => {
        const url = String(input);
        if (url.startsWith('/api/store/purchase/status')) {
          return statusHold;
        }
        const headers = new Headers(init?.headers);
        return headers.has('X-PAYMENT')
          ? jsonResponse({ ok: true, state: 'unexpected' }, 200)
          : jsonResponse(paymentRequired(), 402);
      },
    );
    const { result } = renderPurchase();
    await prepare(result);

    await act(async () => {
      await result.current.purchase();
    });

    expect(result.current.phase).toBe('indeterminate');
    expect(result.current.paymentStatus).toBe('unknown');
    expect(result.current.content).toBeNull();
    expect(signTypedData).toHaveBeenCalledTimes(1);
  });

  it('通信断後の retry は同じ署名headerのGETだけを再送し、新署名しない', async () => {
    let paidAttempts = 0;
    const statusHold = new Promise<Response>(() => undefined);
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input, init) => {
        const url = String(input);
        if (url.startsWith('/api/store/purchase/status')) {
          return statusHold;
        }
        const headers = new Headers(init?.headers);
        if (!headers.has('X-PAYMENT')) {
          return jsonResponse(paymentRequired(), 402);
        }
        paidAttempts += 1;
        if (paidAttempts === 1) throw new TypeError('network lost');
        return jsonResponse({ ok: true, state: 'pending' }, 202);
      });
    const { result } = renderPurchase();
    await prepare(result);

    await act(async () => {
      await result.current.purchase();
    });
    expect(result.current.phase).toBe('indeterminate');

    await act(async () => {
      await result.current.retry();
    });

    const paidCalls = fetchMock.mock.calls.filter(([, init]) =>
      new Headers(init?.headers).has('X-PAYMENT'),
    );
    expect(paidCalls).toHaveLength(2);
    expect(
      new Headers(paidCalls[0][1]?.headers).get('X-PAYMENT'),
    ).toBe(new Headers(paidCalls[1][1]?.headers).get('X-PAYMENT'));
    expect(paidCalls[0][1]?.method).toBe('GET');
    expect(paidCalls[1][1]?.method).toBe('GET');
    expect(signTypedData).toHaveBeenCalledTimes(1);
    expect(result.current.phase).toBe('indeterminate');
  });
});

// plans/hosted-redelivery-secret.md の PR-0。確定済みの購入への再送に server が本文を返さずに返す 409 を、
// error code の名前ではなく形 (409・state settled・正規の txHash・resourceId 一致) で確定として扱う。
// あわせて、exhausted の後の retry の時計と、exhausted の後の低頻度の status 確認を固定する。
describe('useHostedStorePurchase: 確定済みの 409・retry の時計・exhausted の後の確認', () => {
  const HOLD = () => new Promise<Response>(() => undefined);
  const UPPER_TX_HASH = `0x${'EF'.repeat(32)}` as Hex;

  type Respond = () => Response | Promise<Response>;

  function settled409Body(
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      ok: false,
      error: 'purchase_redelivery_expired',
      state: 'settled',
      resourceId: RESOURCE_ID,
      txHash: TX_HASH,
      network: 'eip155:80002',
      library: '/store/library',
      contentApi: `/api/store/content/${RESOURCE_ID}`,
      message: 'This purchase is already settled.',
      messageJa: 'この購入は確定済みです。',
      ...overrides,
    };
  }

  function withoutKey(
    body: Record<string, unknown>,
    key: string,
  ): Record<string, unknown> {
    const copy = { ...body };
    delete copy[key];
    return copy;
  }

  function readyContent(
    intentSalt: Hex = INTENT_SALT,
    value = 'paid content',
  ): Record<string, unknown> {
    return {
      ok: true,
      state: 'ready',
      resourceId: RESOURCE_ID,
      intentSalt,
      title: TITLE,
      contentRevision: 1,
      kind: 'text',
      value,
    };
  }

  function statusBody(state: 'pending' | 'settled' | 'failed') {
    return state === 'settled'
      ? { ok: true, state, txHash: TX_HASH }
      : { ok: true, state };
  }

  /** 署名ヘッダー付きの GET・status・content を、呼ぶたびに今の handler で応答する。 */
  function mockRoutes(routes: {
    quote?: Respond;
    paid: () => Respond;
    status?: () => Respond;
    content?: Respond;
  }) {
    return vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input, init) => {
        const url = String(input);
        if (url.startsWith('/api/paid/hosted/')) {
          if (new Headers(init?.headers).has('X-PAYMENT')) {
            return routes.paid()();
          }
          return (routes.quote ?? (() => jsonResponse(paymentRequired(), 402)))();
        }
        if (url.startsWith('/api/store/purchase/status')) {
          return (routes.status?.() ?? HOLD)();
        }
        if (url.startsWith('/api/store/content/')) {
          return (routes.content ?? HOLD)();
        }
        throw new Error(`unexpected fetch: ${url}`);
      });
  }

  function countCalls(
    fetchMock: ReturnType<typeof mockRoutes>,
    match: (url: string, init?: RequestInit) => boolean,
  ): number {
    return fetchMock.mock.calls.filter(([url, init]) =>
      match(String(url), init),
    ).length;
  }

  const paidCalls = (fetchMock: ReturnType<typeof mockRoutes>) =>
    countCalls(fetchMock, (_url, init) =>
      new Headers(init?.headers).has('X-PAYMENT'),
    );
  const statusCalls = (fetchMock: ReturnType<typeof mockRoutes>) =>
    countCalls(fetchMock, (url) =>
      url.startsWith('/api/store/purchase/status'),
    );
  const contentCalls = (fetchMock: ReturnType<typeof mockRoutes>) =>
    countCalls(fetchMock, (url) => url.startsWith('/api/store/content/'));

  /**
   * 時計を小刻みに進める。一度に大きく進めると、区間の終わりに発火した polling の応答 (fetch の解決 →
   * react-query の通知 → React の更新) が区間の中で処理されきらないため、実時間に近い刻みで進める。
   */
  async function advance(ms: number, step = 250) {
    for (let elapsed = 0; elapsed < ms; elapsed += step) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(Math.min(step, ms - elapsed));
      });
    }
  }

  /** fake timers の下で review → 署名 → 202 → 90 秒で exhausted まで進める。 */
  async function reachExhausted(
    result: ReturnType<typeof renderPurchase>['result'],
  ) {
    await act(async () => {
      await result.current.prepare();
    });
    await act(async () => {
      await result.current.purchase();
    });
    expect(result.current.phase).toBe('indeterminate');
    await advance(90_000);
    expect(result.current.phase).toBe('indeterminate-exhausted');
  }

  describe('409 の判定', () => {
    it.each([
      ['今の code (purchase_redelivery_expired)', settled409Body()],
      [
        'code を改名しても (purchase_already_settled)',
        settled409Body({ error: 'purchase_already_settled' }),
      ],
      ['error code なし', withoutKey(settled409Body(), 'error')],
      ['大文字 hex の txHash', settled409Body({ txHash: UPPER_TX_HASH })],
    ])(
      '409 + settled + 正規の txHash + resourceId 一致 (%s) は確定として own content へ進む',
      async (_label, body) => {
        const fetchMock = mockRoutes({
          paid: () => () => jsonResponse(body, 409),
          content: () => jsonResponse(readyContent(), 200),
        });
        const { result } = renderPurchase();
        await prepare(result);

        await act(async () => {
          await result.current.purchase();
        });

        await waitFor(() => expect(result.current.phase).toBe('ready'));
        expect(result.current.paymentStatus).toBe('confirmed');
        expect(result.current.txHash).toBe(body.txHash);
        expect(result.current.content?.value).toBe('paid content');
        expect(signTypedData).toHaveBeenCalledOnce();
        expect(paidCalls(fetchMock)).toBe(1);
      },
    );

    it.each([
      ['state 欠落', 409, withoutKey(settled409Body(), 'state')],
      ["state が 'pending'", 409, settled409Body({ state: 'pending' })],
      ['txHash 欠落', 409, withoutKey(settled409Body(), 'txHash')],
      [
        'txHash が短い',
        409,
        settled409Body({ txHash: `0x${'ef'.repeat(31)}` }),
      ],
      [
        'txHash が非 hex',
        409,
        settled409Body({ txHash: `0x${'zz'.repeat(32)}` }),
      ],
      ['txHash が 0x なし', 409, settled409Body({ txHash: 'ef'.repeat(32) })],
      ['resourceId 欠落', 409, withoutKey(settled409Body(), 'resourceId')],
      ['resourceId が別商品', 409, settled409Body({ resourceId: 'h_other' })],
      ['HTTP が 409 でない (500)', 500, settled409Body()],
      ['HTTP が 409 でない (410)', 410, settled409Body()],
    ])(
      '%s なら確定にせず、status の確認へ倒す',
      async (_label, status, body) => {
        const fetchMock = mockRoutes({
          paid: () => () => jsonResponse(body, status),
        });
        const { result } = renderPurchase();
        await prepare(result);

        await act(async () => {
          await result.current.purchase();
        });

        expect(result.current.phase).toBe('indeterminate');
        expect(result.current.paymentStatus).toBe('unknown');
        expect(result.current.txHash).toBeNull();
        expect(contentCalls(fetchMock)).toBe(0);
        expect(signTypedData).toHaveBeenCalledOnce();
      },
    );

    it('USDC でも 409 settled は確定として own content へ進む', async () => {
      vi.spyOn(Date, 'now').mockReturnValue(USDC_NOW);
      account.chainId = 8453;
      const fetchMock = mockRoutes({
        quote: () => jsonResponse(usdcPaymentRequired(), 402),
        paid: () => () =>
          jsonResponse(settled409Body({ network: 'eip155:8453' }), 409),
        content: () =>
          jsonResponse(readyContent(USDC_INTENT_SALT, 'paid with USDC'), 200),
      });
      const { result } = renderPurchase('usdc');
      await prepare(result);

      await act(async () => {
        await result.current.purchase();
      });

      await waitFor(() => expect(result.current.phase).toBe('ready'));
      expect(result.current.txHash).toBe(TX_HASH);
      expect(result.current.content?.value).toBe('paid with USDC');
      expect(signTypedData).toHaveBeenCalledOnce();
      expect(
        fetchMock.mock.calls.some(
          ([url]) =>
            String(url) ===
            `/api/store/content/${RESOURCE_ID}?intentSalt=${encodeURIComponent(
              USDC_INTENT_SALT,
            )}`,
        ),
      ).toBe(true);
    });
  });

  describe('exhausted の後の retry', () => {
    it('retry が 409 settled を受けたら、確定として own content へ進む', async () => {
      vi.useFakeTimers();
      try {
        let paid: Respond = () =>
          jsonResponse({ ok: true, state: 'pending' }, 202);
        const fetchMock = mockRoutes({
          paid: () => paid,
          status: () => () => jsonResponse(statusBody('pending'), 200),
          content: () => jsonResponse(readyContent(), 200),
        });
        const { result } = renderPurchase();
        await reachExhausted(result);

        paid = () => jsonResponse(settled409Body(), 409);
        await act(async () => {
          await result.current.retry();
        });
        expect(result.current.phase).toBe('provisioning');
        expect(result.current.txHash).toBe(TX_HASH);

        await advance(1_000);
        expect(result.current.phase).toBe('ready');
        expect(result.current.content?.value).toBe('paid content');
        expect(signTypedData).toHaveBeenCalledOnce();
        expect(paidCalls(fetchMock)).toBe(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it.each([
      ['202', () => jsonResponse({ ok: true, state: 'pending' }, 202)],
      [
        '503 (想定外の応答)',
        () => jsonResponse({ ok: false, error: 'storage_unavailable' }, 503),
      ],
      [
        '409 (settled でない)',
        () => jsonResponse({ ok: false, error: 'purchase_intent_conflict' }, 409),
      ],
    ] as const)(
      'retry が %s を受けても、すぐに exhausted へ戻らず 90 秒の確認を取り直し、status の settled を拾う',
      async (_label, respond) => {
        vi.useFakeTimers();
        try {
          let paid: Respond = () =>
            jsonResponse({ ok: true, state: 'pending' }, 202);
          let statusState: 'pending' | 'settled' = 'pending';
          mockRoutes({
            paid: () => paid,
            status: () => () => jsonResponse(statusBody(statusState), 200),
            content: () => jsonResponse(readyContent(), 200),
          });
          const { result } = renderPurchase();
          await reachExhausted(result);

          paid = respond;
          await act(async () => {
            await result.current.retry();
          });
          expect(result.current.phase).toBe('indeterminate');

          await advance(1_000);
          expect(result.current.phase).toBe('indeterminate');
          await advance(80_000);
          expect(result.current.phase).toBe('indeterminate');

          // 3 秒おきの確認の 1 回分 (+ 応答の処理) で拾う。retry から 90 秒より前に収まる。
          statusState = 'settled';
          await advance(3_500);
          expect(result.current.phase).not.toBe('indeterminate');
          await advance(2_000);
          expect(result.current.phase).toBe('ready');
          expect(result.current.txHash).toBe(TX_HASH);
          expect(signTypedData).toHaveBeenCalledOnce();
        } finally {
          vi.useRealTimers();
        }
      },
    );
  });

  describe('exhausted の後の低頻度の status 確認', () => {
    it('30 秒おきに確かめ続け、確定したら own content へ進む', async () => {
      vi.useFakeTimers();
      try {
        let statusState: 'pending' | 'settled' = 'pending';
        const fetchMock = mockRoutes({
          paid: () => () => jsonResponse({ ok: true, state: 'pending' }, 202),
          status: () => () => jsonResponse(statusBody(statusState), 200),
          content: () => jsonResponse(readyContent(), 200),
        });
        const { result } = renderPurchase();
        await reachExhausted(result);
        expect(result.current.isAutoCheckingPayment).toBe(true);
        expect(result.current.needsSupportReason).toBe(
          'payment-status-timeout',
        );

        // 3 秒おきの確認は止まり、低頻度 (30 秒おき) に切り替わる。
        const atExhausted = statusCalls(fetchMock);
        await advance(29_000);
        expect(statusCalls(fetchMock)).toBe(atExhausted);
        await advance(2_000);
        expect(statusCalls(fetchMock)).toBe(atExhausted + 1);
        expect(result.current.phase).toBe('indeterminate-exhausted');

        statusState = 'settled';
        await advance(30_000);
        expect(result.current.phase).not.toBe('indeterminate-exhausted');
        await advance(2_000);
        expect(result.current.phase).toBe('ready');
        expect(result.current.paymentStatus).toBe('confirmed');
        expect(result.current.txHash).toBe(TX_HASH);
        expect(result.current.needsSupportReason).toBeNull();
        expect(result.current.content?.value).toBe('paid content');
        expect(signTypedData).toHaveBeenCalledOnce();
        expect(paidCalls(fetchMock)).toBe(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('低頻度の確認で failed なら、支払い未実行へ収束する', async () => {
      vi.useFakeTimers();
      try {
        let statusState: 'pending' | 'failed' = 'pending';
        mockRoutes({
          paid: () => () => jsonResponse({ ok: true, state: 'pending' }, 202),
          status: () => () => jsonResponse(statusBody(statusState), 200),
        });
        const { result } = renderPurchase();
        await reachExhausted(result);

        statusState = 'failed';
        await advance(31_000);
        expect(result.current.phase).toBe('failed-prebroadcast');
        expect(result.current.paymentStatus).toBe('not-executed');
        expect(result.current.error?.message).toBe('purchase_intent_failed');
      } finally {
        vi.useRealTimers();
      }
    });

    it('上限 (15 分) を越えたら確認を止め、retry でだけ取り直す', async () => {
      vi.useFakeTimers();
      try {
        let statusState: 'pending' | 'settled' = 'pending';
        const fetchMock = mockRoutes({
          paid: () => () => jsonResponse({ ok: true, state: 'pending' }, 202),
          status: () => () => jsonResponse(statusBody(statusState), 200),
          content: () => jsonResponse(readyContent(), 200),
        });
        const { result } = renderPurchase();
        await reachExhausted(result);
        const atExhausted = statusCalls(fetchMock);

        await advance(15 * 60_000 - 1_000);
        expect(result.current.isAutoCheckingPayment).toBe(true);
        await advance(1_000);
        expect(result.current.isAutoCheckingPayment).toBe(false);
        expect(result.current.phase).toBe('indeterminate-exhausted');
        expect(result.current.canRetrySignedPayment).toBe(true);
        const atLimit = statusCalls(fetchMock);
        expect(atLimit - atExhausted).toBeLessThanOrEqual(31);

        // 止めた後は、確定していても自分からは確かめない。
        statusState = 'settled';
        await advance(10 * 60_000);
        expect(statusCalls(fetchMock)).toBe(atLimit);
        expect(result.current.phase).toBe('indeterminate-exhausted');

        // retry (同じ署名の再送) で確認を取り直す。
        await act(async () => {
          await result.current.retry();
        });
        expect(result.current.phase).toBe('indeterminate');
        expect(result.current.isAutoCheckingPayment).toBe(true);
        await advance(5_000);
        expect(result.current.phase).toBe('ready');
        expect(signTypedData).toHaveBeenCalledOnce();
      } finally {
        vi.useRealTimers();
      }
    });

    it('低頻度の確認中に SIWE が切れたら idle に戻り、確認を止める', async () => {
      vi.useFakeTimers();
      try {
        let statusState: 'pending' | 'settled' = 'pending';
        const fetchMock = mockRoutes({
          paid: () => () => jsonResponse({ ok: true, state: 'pending' }, 202),
          status: () => () => jsonResponse(statusBody(statusState), 200),
          content: () => jsonResponse(readyContent(), 200),
        });
        const rendered = renderHook(
          ({ sessionAddress }: { sessionAddress: Address | null }) =>
            useHostedStorePurchase({
              resourceId: RESOURCE_ID,
              title: TITLE,
              merchant: MERCHANT,
              priceJpyc: PRICE_JPYC,
              sessionAddress,
            }),
          {
            initialProps: { sessionAddress: PAYER as Address | null },
            wrapper: createWrapper(),
          },
        );
        await reachExhausted(rendered.result);

        rendered.rerender({ sessionAddress: null });
        expect(rendered.result.current.phase).toBe('idle');
        expect(rendered.result.current.isAutoCheckingPayment).toBe(false);
        expect(rendered.result.current.canRetrySignedPayment).toBe(false);
        const atExpiry = statusCalls(fetchMock);

        statusState = 'settled';
        await advance(5 * 60_000);
        expect(statusCalls(fetchMock)).toBe(atExpiry);
        expect(rendered.result.current.phase).toBe('idle');
        expect(rendered.result.current.txHash).toBeNull();
        expect(contentCalls(fetchMock)).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});


describe('license errors preserve server code', () => {
  it.each([
    ['sold_out', 409], ['reservation_quota', 409], ['recipient_unsupported', 409], ['license_registration_pending', 409], ['license_simulation_unavailable', 503],
  ])('%s は署名前に保持し、署名しない', async (code, status) => {
    licenseFlags.enabled = true;
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ ok: false, error: code }, status));
    const { result } = renderPurchase();
    await act(async () => { await expect(result.current.prepare()).rejects.toMatchObject({ code }); });
    expect(result.current.error).toMatchObject({ code });
    expect(result.current.phase).toBe('error');
    expect(signTypedData).not.toHaveBeenCalled();
  });
  it.each([
    ['sold_out', 409], ['reservation_quota', 409], ['recipient_unsupported', 409],
    ['license_registration_pending', 409], ['license_simulation_unavailable', 503],
  ])('%s は署名送信後も未実行で停止する', async (code, status) => {
    licenseFlags.enabled = true;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) =>
      new Headers(init?.headers).has('X-PAYMENT') ? jsonResponse({ ok: false, error: code }, Number(status)) : jsonResponse(paymentRequired(), 402));
    const { result } = renderPurchase();
    await prepare(result);
    await act(async () => { await result.current.purchase(); });
    expect(result.current.phase).toBe('failed-prebroadcast');
    expect(result.current.error?.message).toBe(code);
    expect(result.current.paymentStatus).toBe('not-executed');
    expect(fetchMock.mock.calls.every(([url]) => !String(url).includes('/purchase/status'))).toBe(true);
  });

  it.each(['operator', 'third_party'] as const)('server sellerRole=%s は表示専用で、quote・署名・X-PAYMENT に入れない', async (sellerRole) => {
    licenseFlags.enabled = true;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) =>
      new Headers(init?.headers).has('X-PAYMENT')
        ? jsonResponse({ ok: false, error: 'sold_out' }, 409)
        : jsonResponse({ ...paymentRequired(), sellerRole }, 402));
    const { result } = renderPurchase();
    await prepare(result);
    expect(result.current.sellerRole).toBe(sellerRole);
    expect(result.current.quote).not.toHaveProperty('sellerRole');
    await act(async () => { await result.current.purchase(); });
    expect(JSON.stringify(signTypedData.mock.calls, (_key, value) => typeof value === 'bigint' ? value.toString() : value)).not.toContain('sellerRole');
    const header = fetchMock.mock.calls.map(([, init]) => new Headers(init?.headers).get('X-PAYMENT')).find(Boolean)!;
    expect(atob(header)).not.toContain('sellerRole');
    act(() => result.current.reset());
    expect(result.current.sellerRole).toBeUndefined();
  });

  it.each([[false, 409], [true, 500]])('flag=%s・HTTP=%s はライセンスエラーへ誤分類しない', async (enabled, status) => {
    licenseFlags.enabled = Boolean(enabled);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ error: 'sold_out' }, Number(status)));
    const { result } = renderPurchase();
    await act(async () => { await expect(result.current.prepare()).rejects.toMatchObject({ code: 'quote_expected_402' }); });
    expect(signTypedData).not.toHaveBeenCalled();
  });
});
