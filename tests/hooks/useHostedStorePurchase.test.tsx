import type { ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import {
  QueryClient,
  QueryClientProvider,
} from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Address, Hex } from 'viem';

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

function renderPurchase() {
  return renderHook(
    () =>
      useHostedStorePurchase({
        resourceId: RESOURCE_ID,
        merchant: MERCHANT,
        priceJpyc: PRICE_JPYC,
        sessionAddress: PAYER,
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
  vi.restoreAllMocks();
  account.address = PAYER;
  account.chainId = 80002;
  signTypedData.mockReset();
  signTypedData.mockResolvedValue(SIGNATURE);
});

describe('useHostedStorePurchase quote fence', () => {
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
