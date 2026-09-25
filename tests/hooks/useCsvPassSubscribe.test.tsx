// useCsvPassSubscribe (汎用 useJpycEntitlementPay の thin wrapper) の config smoke test。
// engine 本体 (耐久化/resume/terminal 区別/状態機械) は useProSubscribe.test が共有 hook 経由で
// 担保済。ここでは CSV パス wrapper 固有の config — pending localStorage key と endpoint — が
// 正しく差し替わっていることを resume 経路で実証する (Pro と非共有である回帰防止)。

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const WALLET = '0x000000000000000000000000000000000000aBcD';
const CSVPASS_PENDING_KEY = 'openpay:csvpass:pendingTx';
const CSVPASS_SIG_KEY = `${CSVPASS_PENDING_KEY}:sig`;
const PRO_PENDING_KEY = 'openpay:pro:pendingTx';
const TX = ('0x' + 'a'.repeat(64)) as `0x${string}`;
const FEE_RECEIVER = '0x4284e651C3D8c9A439FedE00d2600032d5DB0Be7';
const DEPLOYMENT_ADDRESS = '0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29';

type SignTypedDataArgs = {
  primaryType: string;
  domain: {
    name?: string;
    version?: string;
    chainId?: number;
    verifyingContract?: string;
  };
  message: {
    from?: string;
    to?: string;
    value?: bigint;
    validAfter?: bigint;
    validBefore?: bigint;
    nonce?: string;
  };
};

// wagmi: 接続 wallet を返し、送金系は idle (resume パスのみを駆動)。useWalletClient は
// signGaslessAuthorization wrapper が呼ぶ (gasless 経路のテストでは signTypedData を返す)。
const accountHold = vi.hoisted(() => ({
  address: '0x000000000000000000000000000000000000aBcD',
  chainId: 137,
}));
const signTypedDataMock = vi.fn(async (_typed: SignTypedDataArgs) => SIGNATURE);
const writeContractMock = vi.fn();
vi.mock('wagmi', () => ({
  useAccount: () => ({ address: accountHold.address, chainId: accountHold.chainId }),
  useWriteContract: () => ({
    data: undefined,
    isPending: false,
    error: null,
    reset: vi.fn(),
    writeContract: writeContractMock,
  }),
  useWaitForTransactionReceipt: () => ({
    data: undefined,
    isSuccess: false,
    isError: false,
    error: null,
  }),
  useWalletClient: () => ({
    data: { signTypedData: signTypedDataMock },
  }),
}));

// env: ガスレス可否 (enableJpycEip3009 + feeReceiverConfigured) を ON にして gasless 経路を走らせる。
// 137 (Polygon) は EIP3009_RELAY_CHAINS に含まれる。
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      enableJpycEip3009: true,
      feeReceiverConfigured: true,
      feeReceiver: '0x4284e651C3D8c9A439FedE00d2600032d5DB0Be7',
    },
  };
});

const SIGNATURE = ('0x' + 'b'.repeat(130)) as `0x${string}`;

import { useCsvPassSubscribe } from '@/hooks/useCsvPassSubscribe';
import { csvPassPriceWei } from '@/lib/csvPassConstants';
import { isRelayIpRateLimitedError } from '@/lib/relay/relayResponseError';

const deployment = { address: DEPLOYMENT_ADDRESS } as never;

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  vi.restoreAllMocks();
  signTypedDataMock.mockClear();
  signTypedDataMock.mockResolvedValue(SIGNATURE);
  writeContractMock.mockClear();
  accountHold.address = WALLET;
  accountHold.chainId = 137;
  window.localStorage.clear();
});

describe('useCsvPassSubscribe (wrapper config)', () => {
  it('csvpass の pending key で resume し /api/csv-pass/subscribe を叩く', async () => {
    window.localStorage.setItem(
      CSVPASS_PENDING_KEY,
      JSON.stringify({ txHash: TX, chainId: 137, wallet: WALLET }),
    );
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ ok: true, wallet: WALLET, expiresAt: 1_800_000_000_000 }),
        { status: 200 },
      ),
    );

    const { result } = renderHook(() => useCsvPassSubscribe(deployment), {
      wrapper,
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    // CSV パス専用エンドポイントを叩く (Pro と非共有)。
    expect(fetchSpy.mock.calls[0][0]).toBe('/api/csv-pass/subscribe');
    const body = JSON.parse(
      (fetchSpy.mock.calls[0][1] as RequestInit).body as string,
    );
    expect(body).toEqual({ txHash: TX, chainId: 137 });
    // 付与確定で csvpass の耐久記録は消える。
    expect(window.localStorage.getItem(CSVPASS_PENDING_KEY)).toBeNull();
  });

  it('Pro の pending key (openpay:pro:pendingTx) は claim しない (key 非共有)', async () => {
    // Pro 用 key だけがある状態では csvpass wrapper は resume しない。
    window.localStorage.setItem(
      PRO_PENDING_KEY,
      JSON.stringify({ txHash: TX, chainId: 137, wallet: WALLET }),
    );
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    renderHook(() => useCsvPassSubscribe(deployment), { wrapper });
    await new Promise((r) => setTimeout(r, 30));
    expect(fetchSpy).not.toHaveBeenCalled();
    // Pro 用 key はそのまま残す (csvpass は触らない)。
    expect(window.localStorage.getItem(PRO_PENDING_KEY)).not.toBeNull();
  });
});

// ガスレス購入経路 (W2-3): start() = 署名 → /api/csv-pass/relay POST → savePending → subscribe。
// env mock で enableJpycEip3009/feeReceiverConfigured を ON にしてあるので gasless=true で start が走る。
describe('useCsvPassSubscribe ガスレス購入 (relay 経路)', () => {
  function relayThenSubscribe(
    relay: { status: number; body: Record<string, unknown> },
  ) {
    return vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (url: RequestInfo | URL) => {
        const u = String(url);
        if (u === '/api/csv-pass/relay') {
          return new Response(JSON.stringify(relay.body), { status: relay.status });
        }
        // subscribe は成功で返す (付与確定)。
        return new Response(
          JSON.stringify({ ok: true, wallet: WALLET, expiresAt: 1_800_000_000_000 }),
          { status: 200 },
        );
      });
  }

  it('gasless=true を返し、start() で 署名 → relay POST → savePending → subscribe 成功', async () => {
    const fetchSpy = relayThenSubscribe({
      status: 200,
      body: { ok: true, txHash: TX },
    });
    const { result } = renderHook(() => useCsvPassSubscribe(deployment), {
      wrapper,
    });
    expect(result.current.gasless).toBe(true);

    await act(async () => {
      result.current.start();
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    // 署名された (wallet client の signTypedData を呼んだ)。
    expect(signTypedDataMock).toHaveBeenCalledTimes(1);
    // 1 回目は relay へ to を含まない payload (server が FEE_RECEIVER を構成)。
    expect(fetchSpy.mock.calls[0][0]).toBe('/api/csv-pass/relay');
    const relayBody = JSON.parse(
      (fetchSpy.mock.calls[0][1] as RequestInit).body as string,
    );
    expect(relayBody.to).toBeUndefined();
    expect(relayBody.from.toLowerCase()).toBe(WALLET.toLowerCase());
    expect(relayBody.signature).toBe(SIGNATURE);
    expect(relayBody.value).toBe((100n * 10n ** 18n).toString());
    // 2 回目は subscribe へ relay の txHash を渡す。
    expect(fetchSpy.mock.calls[1][0]).toBe('/api/csv-pass/subscribe');
    const subBody = JSON.parse(
      (fetchSpy.mock.calls[1][1] as RequestInit).body as string,
    );
    expect(subBody).toEqual({ txHash: TX, chainId: 137 });
    // 付与確定で耐久記録は消える。
    expect(window.localStorage.getItem(CSVPASS_PENDING_KEY)).toBeNull();
    expect(window.localStorage.getItem(CSVPASS_SIG_KEY)).toBeNull();
  });

  it('wallet に渡す EIP-3009 typed-data が client↔server 契約と一致する', async () => {
    relayThenSubscribe({
      status: 202,
      body: { ok: false, pending: true },
    });
    const { result } = renderHook(() => useCsvPassSubscribe(deployment), {
      wrapper,
    });

    await act(async () => {
      result.current.start();
    });
    await waitFor(() => expect(signTypedDataMock).toHaveBeenCalledTimes(1));

    const typed = signTypedDataMock.mock.calls[0][0];
    expect(typed.primaryType).toBe('TransferWithAuthorization');
    expect(typed.domain).toMatchObject({
      name: 'JPY Coin',
      version: '1',
      chainId: 137,
      verifyingContract: DEPLOYMENT_ADDRESS,
    });
    expect(typed.message).toMatchObject({
      from: WALLET,
      to: FEE_RECEIVER,
      value: csvPassPriceWei,
      validAfter: 0n,
    });
    expect(typeof typed.message.validBefore).toBe('bigint');
    expect(typed.message.nonce).toMatch(/^0x[0-9a-fA-F]{64}$/);
  });

  it('relay 202 pending(txHash あり) → savePending → subscribe (broadcast 後扱い)', async () => {
    const fetchSpy = relayThenSubscribe({
      status: 202,
      body: { ok: false, pending: true, txHash: TX },
    });
    const { result } = renderHook(() => useCsvPassSubscribe(deployment), {
      wrapper,
    });
    await act(async () => {
      result.current.start();
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchSpy.mock.calls[1][0]).toBe('/api/csv-pass/subscribe');
    expect(window.localStorage.getItem(CSVPASS_SIG_KEY)).toBeNull();
  });

  it('relay reverted → savePending しない (耐久記録なし) + pay-error', async () => {
    relayThenSubscribe({
      status: 200,
      body: { ok: false, reverted: true, txHash: TX },
    });
    const { result } = renderHook(() => useCsvPassSubscribe(deployment), {
      wrapper,
    });
    await act(async () => {
      result.current.start();
    });
    await waitFor(() => expect(result.current.isPayError).toBe(true));
    // 何も送金されていないので耐久記録なし (subscribe は走らない)。
    expect(window.localStorage.getItem(CSVPASS_PENDING_KEY)).toBeNull();
    expect(window.localStorage.getItem(CSVPASS_SIG_KEY)).toBeNull();
  });

  it('relay_not_configured → gaslessUnavailable フラグを立て pay-error', async () => {
    relayThenSubscribe({
      status: 503,
      body: { ok: false, error: 'relay_not_configured' },
    });
    const { result } = renderHook(() => useCsvPassSubscribe(deployment), {
      wrapper,
    });
    await act(async () => {
      result.current.start();
    });
    await waitFor(() => expect(result.current.isPayError).toBe(true));
    expect(result.current.gaslessUnavailable).toBe(true);
    expect(window.localStorage.getItem(CSVPASS_SIG_KEY)).toBeNull();
  });

  it('pending(txHash 無し) → retryRelay が **同一 payload を再 POST** する (再署名しない)', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (url: RequestInfo | URL) => {
        const u = String(url);
        if (u === '/api/csv-pass/relay') {
          // hash 無しの pending (broadcast 不確定)。
          return new Response(JSON.stringify({ ok: false, pending: true }), {
            status: 202,
          });
        }
        return new Response(
          JSON.stringify({ ok: true, wallet: WALLET, expiresAt: 1 }),
          { status: 200 },
        );
      });
    const { result } = renderHook(() => useCsvPassSubscribe(deployment), {
      wrapper,
    });
    await act(async () => {
      result.current.start();
    });
    await waitFor(() => expect(result.current.isPayError).toBe(true));
    expect(result.current.canRetryRelay).toBe(true);
    expect(signTypedDataMock).toHaveBeenCalledTimes(1); // 署名は 1 回のみ
    const firstRelayBody = (fetchSpy.mock.calls[0][1] as RequestInit).body;

    await act(async () => {
      result.current.retryRelay();
    });
    // 2 回目の relay POST。再署名なし (signTypedData は依然 1 回)。
    await waitFor(() =>
      expect(
        fetchSpy.mock.calls.filter((c) => c[0] === '/api/csv-pass/relay').length,
      ).toBe(2),
    );
    expect(signTypedDataMock).toHaveBeenCalledTimes(1);
    // 同一 payload (同 nonce/signature) を再送信している。
    const secondRelayCall = fetchSpy.mock.calls.find(
      (c, i) => c[0] === '/api/csv-pass/relay' && i > 0,
    )!;
    expect((secondRelayCall[1] as RequestInit).body).toEqual(firstRelayBody);
  });

  it('429 ip_rate_limited → payload 保持 + 同一 payload 再 POST のみ（再署名なし）', async () => {
    let allowRelaySuccess = false;
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (url: RequestInfo | URL) => {
        const u = String(url);
        if (u === '/api/csv-pass/relay') {
          if (!allowRelaySuccess) {
            return new Response(
              JSON.stringify({ ok: false, error: 'ip_rate_limited' }),
              { status: 429, headers: { 'retry-after': '30' } },
            );
          }
          return new Response(JSON.stringify({ ok: true, txHash: TX }), {
            status: 200,
          });
        }
        return new Response(
          JSON.stringify({ ok: true, wallet: WALLET, expiresAt: 1 }),
          { status: 200 },
        );
      });
    const { result } = renderHook(() => useCsvPassSubscribe(deployment), {
      wrapper,
    });

    await act(async () => {
      result.current.start();
    });
    await waitFor(() => expect(result.current.isPayError).toBe(true));
    expect(result.current.canRetryRelay).toBe(true);
    expect(isRelayIpRateLimitedError(result.current.error)).toBe(true);
    if (!isRelayIpRateLimitedError(result.current.error)) {
      throw new Error('expected RelayIpRateLimitedError');
    }
    expect(result.current.error.retryAfterSeconds).toBe(30);
    expect(window.localStorage.getItem(CSVPASS_SIG_KEY)).not.toBeNull();
    expect(signTypedDataMock).toHaveBeenCalledTimes(1);
    const beforeRetryBodies = fetchSpy.mock.calls
      .filter((c) => c[0] === '/api/csv-pass/relay')
      .map((c) => (c[1] as RequestInit).body);
    expect(beforeRetryBodies.length).toBeGreaterThan(0);

    allowRelaySuccess = true;
    await act(async () => {
      result.current.retryRelay();
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const relayBodies = fetchSpy.mock.calls
      .filter((c) => c[0] === '/api/csv-pass/relay')
      .map((c) => (c[1] as RequestInit).body);
    expect(relayBodies.every((body) => body === relayBodies[0])).toBe(true);
    expect(signTypedDataMock).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem(CSVPASS_SIG_KEY)).toBeNull();
  });

  it('pending(txHash 無し) を localStorage から remount resume し同一 payload を再 POST', async () => {
    let relayCalls = 0;
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (url: RequestInfo | URL) => {
        const u = String(url);
        if (u === '/api/csv-pass/relay') {
          relayCalls += 1;
          if (relayCalls === 1) {
            return new Response(JSON.stringify({ ok: false, pending: true }), {
              status: 202,
            });
          }
          return new Response(JSON.stringify({ ok: true, txHash: TX }), {
            status: 200,
          });
        }
        return new Response(
          JSON.stringify({ ok: true, wallet: WALLET, expiresAt: 1 }),
          { status: 200 },
        );
      });
    const first = renderHook(() => useCsvPassSubscribe(deployment), { wrapper });
    await act(async () => {
      first.result.current.start();
    });
    await waitFor(() => expect(first.result.current.canRetryRelay).toBe(true));
    const stored = window.localStorage.getItem(CSVPASS_SIG_KEY);
    expect(stored).not.toBeNull();
    const firstRelayBody = (fetchSpy.mock.calls[0][1] as RequestInit).body;
    first.unmount();

    const second = renderHook(() => useCsvPassSubscribe(deployment), { wrapper });
    await waitFor(() => expect(second.result.current.isSuccess).toBe(true));
    const relayBodies = fetchSpy.mock.calls
      .filter((c) => c[0] === '/api/csv-pass/relay')
      .map((c) => (c[1] as RequestInit).body);
    expect(relayBodies).toEqual([firstRelayBody, firstRelayBody]);
    expect(signTypedDataMock).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem(CSVPASS_SIG_KEY)).toBeNull();
  });

  it('別 wallet の pending sig は再利用せず storage から破棄する', async () => {
    relayThenSubscribe({ status: 202, body: { ok: false, pending: true } });
    const first = renderHook(() => useCsvPassSubscribe(deployment), { wrapper });
    await act(async () => {
      first.result.current.start();
    });
    await waitFor(() => expect(first.result.current.canRetryRelay).toBe(true));
    first.unmount();

    vi.restoreAllMocks();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    accountHold.address = '0x000000000000000000000000000000000000bEEF';
    renderHook(() => useCsvPassSubscribe(deployment), { wrapper });
    await waitFor(() =>
      expect(window.localStorage.getItem(CSVPASS_SIG_KEY)).toBeNull(),
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // --- Codex code review P1/P2 の回帰防止 ---

  it('fetch 例外 (ネットワーク断) でも payload を保持し retryRelay 可能 (再署名しない・Codex P1)', async () => {
    // 1 回目はネットワーク断 (サーバに届いたか不明)、2 回目以降は成功。
    let relayCalls = 0;
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (url: RequestInfo | URL) => {
        const u = String(url);
        if (u === '/api/csv-pass/relay') {
          relayCalls += 1;
          if (relayCalls === 1) throw new TypeError('network error');
          return new Response(JSON.stringify({ ok: true, txHash: TX }), {
            status: 200,
          });
        }
        return new Response(
          JSON.stringify({ ok: true, wallet: WALLET, expiresAt: 1 }),
          { status: 200 },
        );
      });
    const { result } = renderHook(() => useCsvPassSubscribe(deployment), {
      wrapper,
    });
    await act(async () => {
      result.current.start();
    });
    await waitFor(() => expect(result.current.isPayError).toBe(true));
    // 届いた可能性を否定できない → payload 保持 → retryRelay が再試行経路。
    expect(result.current.canRetryRelay).toBe(true);
    expect(window.localStorage.getItem(CSVPASS_SIG_KEY)).not.toBeNull();

    await act(async () => {
      result.current.retryRelay();
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    // 署名は 1 回のみ (同一 payload の再 POST で解決した)。
    expect(signTypedDataMock).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls.filter((c) => c[0] === '/api/csv-pass/relay').length).toBe(2);
    expect(window.localStorage.getItem(CSVPASS_SIG_KEY)).toBeNull();
  });

  // B-R5 (S1): preflight_unavailable は「この POST が何もしていない」ことしか示さない。以前の POST が
  // broadcast 済みでありうる再 POST では payload を破棄せず、ガスあり fallback も出さない。
  it.each([
    ['fetch 例外', 'throw'],
    ['202 pending(hash 無し)', 'pending'],
  ] as const)(
    '%s 後の再 POST が 503 preflight_unavailable → payload 保持・再試行可能・fallback を出さない',
    async (_label, first) => {
      let relayCalls = 0;
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockImplementation(async (url: RequestInfo | URL) => {
          const u = String(url);
          if (u === '/api/csv-pass/relay') {
            relayCalls += 1;
            if (relayCalls === 1) {
              if (first === 'throw') throw new TypeError('network error');
              return new Response(JSON.stringify({ ok: false, pending: true }), {
                status: 202,
              });
            }
            if (relayCalls === 2) {
              return new Response(
                JSON.stringify({ ok: false, error: 'preflight_unavailable' }),
                { status: 503 },
              );
            }
            return new Response(JSON.stringify({ ok: true, txHash: TX }), {
              status: 200,
            });
          }
          return new Response(
            JSON.stringify({ ok: true, wallet: WALLET, expiresAt: 1 }),
            { status: 200 },
          );
        });
      const { result } = renderHook(() => useCsvPassSubscribe(deployment), {
        wrapper,
      });
      await act(async () => {
        result.current.start();
      });
      await waitFor(() => expect(result.current.canRetryRelay).toBe(true));

      await act(async () => {
        result.current.retryRelay();
      });
      await waitFor(() => expect(relayCalls).toBe(2));
      await waitFor(() => expect(result.current.isPayError).toBe(true));
      // payload 保持 (localStorage も) + 再試行可能 + ガスあり fallback を出さない。
      expect(result.current.error?.message).toBe('preflight_unavailable');
      expect(result.current.canRetryRelay).toBe(true);
      expect(result.current.gaslessUnavailable).toBe(false);
      expect(window.localStorage.getItem(CSVPASS_SIG_KEY)).not.toBeNull();
      // 未解決 payload がある間はガスあり送金も始まらない。
      await act(async () => {
        result.current.startGasPaid();
      });
      expect(result.current.isPaying).toBe(false);

      // RPC 復旧後の再試行は同一 payload の再 POST で解決する (再署名なし)。
      await act(async () => {
        result.current.retryRelay();
      });
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      const relayBodies = fetchSpy.mock.calls
        .filter((c) => c[0] === '/api/csv-pass/relay')
        .map((c) => (c[1] as RequestInit).body);
      expect(relayBodies).toHaveLength(3);
      expect(relayBodies.every((body) => body === relayBodies[0])).toBe(true);
      expect(signTypedDataMock).toHaveBeenCalledTimes(1);
      expect(window.localStorage.getItem(CSVPASS_SIG_KEY)).toBeNull();
    },
  );

  it('初回 POST の 503 preflight_unavailable は未 broadcast が確定 → payload 破棄 + ガスあり fallback', async () => {
    relayThenSubscribe({
      status: 503,
      body: { ok: false, error: 'preflight_unavailable' },
    });
    const { result } = renderHook(() => useCsvPassSubscribe(deployment), {
      wrapper,
    });
    await act(async () => {
      result.current.start();
    });
    await waitFor(() => expect(result.current.gaslessUnavailable).toBe(true));
    expect(result.current.isPayError).toBe(true);
    expect(result.current.canRetryRelay).toBe(false);
    expect(window.localStorage.getItem(CSVPASS_SIG_KEY)).toBeNull();
  });

  // B-R5b: 例外 2 コード以外の 5xx は、応答形式や以前の POST の結果によらず保持する。
  it.each(
    (['pending', 'throw', 'rate-limited'] as const).flatMap((firstResponse) =>
      ([
        [500, '<html>Internal Server Error</html>'],
        [502, '<html>Bad Gateway</html>'],
        [503, '<html>Service Unavailable</html>'],
        [504, '<html>Gateway Timeout</html>'],
        [500, JSON.stringify({ ok: false, error: 'internal_error' })],
        [503, 'null'],
        ...[
          'relay_not_configured',
          'csvpass_misconfigured',
          'gas_ceiling_required',
          'kv_required',
          'session_storage_unavailable',
          'future_admission_error',
        ].map((error) => [503, JSON.stringify({ ok: false, error })] as const),
      ] as const).map(([status, body]) => [firstResponse, status, body] as const),
    ),
  )(
    '%s 後の再 POST の %s %s → 確認中・同一 payload の再試行のみ (remount 後も保持)',
    async (firstResponse, status, body) => {
      let relayCalls = 0;
      let recovered = false;
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        if (String(url) === '/api/csv-pass/relay') {
          relayCalls += 1;
          if (relayCalls === 1) {
            if (firstResponse === 'throw') throw new TypeError('network error');
            if (firstResponse === 'rate-limited') {
              return new Response(JSON.stringify({ error: 'ip_rate_limited' }), {
                status: 429,
              });
            }
            return new Response(JSON.stringify({ ok: false, pending: true }), {
              status: 202,
            });
          }
          return recovered
            ? new Response(JSON.stringify({ ok: true, txHash: TX }), { status: 200 })
            : new Response(body, { status });
        }
        return new Response(JSON.stringify({ ok: true, wallet: WALLET, expiresAt: 1 }));
      });
      const first = renderHook(() => useCsvPassSubscribe(deployment), { wrapper });
      await act(async () => first.result.current.start());
      await waitFor(() => expect(first.result.current.canRetryRelay).toBe(true));
      const originalBody = (fetchSpy.mock.calls[0][1] as RequestInit).body as string;
      const stored = window.localStorage.getItem(CSVPASS_SIG_KEY);
      expect(JSON.parse(stored!)).toEqual({ payload: JSON.parse(originalBody), wallet: WALLET });

      await act(async () => first.result.current.retryRelay());
      await waitFor(() => expect(first.result.current.isPayError).toBe(true));
      expect(first.result.current.canRetryRelay).toBe(true);
      expect(first.result.current.isRelayUncertain).toBe(true);
      expect(first.result.current.gaslessUnavailable).toBe(false);
      expect(window.localStorage.getItem(CSVPASS_SIG_KEY)).toBe(stored);
      expect(window.localStorage.getItem(CSVPASS_PENDING_KEY)).toBeNull();
      expect(fetchSpy.mock.calls.every(([url]) => url === '/api/csv-pass/relay')).toBe(true);

      await act(async () => first.result.current.startGasPaid());
      expect(writeContractMock).not.toHaveBeenCalled();
      expect(first.result.current.isPayError).toBe(true);
      // 通常 CTA を直接呼んでも再署名せず、同じ authorization を再 POST する。
      await act(async () => first.result.current.start());
      await waitFor(() => expect(first.result.current.isRelayUncertain).toBe(true));
      first.unmount();

      const second = renderHook(() => useCsvPassSubscribe(deployment), { wrapper });
      await waitFor(() => expect(second.result.current.isRelayUncertain).toBe(true));
      expect(second.result.current.canRetryRelay).toBe(true);
      expect(second.result.current.gaslessUnavailable).toBe(false);
      expect(window.localStorage.getItem(CSVPASS_SIG_KEY)).toBe(stored);

      recovered = true;
      await act(async () => second.result.current.retryRelay());
      await waitFor(() => expect(second.result.current.isSuccess).toBe(true));
      const relayBodies = fetchSpy.mock.calls
        .filter(([url]) => url === '/api/csv-pass/relay')
        .map(([, init]) => init?.body);
      expect(relayBodies).toEqual(Array(5).fill(originalBody));
      expect(signTypedDataMock).toHaveBeenCalledTimes(1);
      expect(writeContractMock).not.toHaveBeenCalled();
      expect(second.result.current.canRetryRelay).toBe(false);
      expect(second.result.current.isRelayUncertain).toBe(false);
      expect(fetchSpy.mock.calls.at(-1)).toEqual([
        '/api/csv-pass/subscribe',
        expect.objectContaining({ body: JSON.stringify({ txHash: TX, chainId: 137 }) }),
      ]);
      expect(window.localStorage.getItem(CSVPASS_SIG_KEY)).toBeNull();
      expect(window.localStorage.getItem(CSVPASS_PENDING_KEY)).toBeNull();
    },
  );

  it.each([500, 502, 503, 504])('初回 POST の非 JSON %s は従来どおり payload を破棄する', async (status) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('<html>Server Error</html>', { status }));
    const { result } = renderHook(() => useCsvPassSubscribe(deployment), { wrapper });
    await act(async () => result.current.start());
    await waitFor(() => expect(result.current.isPayError).toBe(true));
    expect(result.current.canRetryRelay).toBe(false);
    expect(result.current.isRelayUncertain).toBe(false);
    expect(result.current.gaslessUnavailable).toBe(status === 503);
    expect(window.localStorage.getItem(CSVPASS_SIG_KEY)).toBeNull();
    expect(window.localStorage.getItem(CSVPASS_PENDING_KEY)).toBeNull();
  });

  it.each([null, [], 42, 'error', true].map((body) => [body] as const))('object でない JSON 本文 %j でも mining に取り残さない', async (body) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
    const { result } = renderHook(() => useCsvPassSubscribe(deployment), { wrapper });
    await act(async () => result.current.start());
    await waitFor(() => expect(result.current.isPayError).toBe(true));
    expect(result.current.isPaying).toBe(false);
    expect(result.current.isSuccess).toBe(false);
    expect(result.current.canRetryRelay).toBe(false);
    expect(window.localStorage.getItem(CSVPASS_SIG_KEY)).toBeNull();
  });

  it('再 POST の JSON 502 relay_error は payload を破棄し、新しい署名で再購入できる', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, pending: true }), { status: 202 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, error: 'relay_error' }), { status: 502 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, txHash: TX }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, wallet: WALLET, expiresAt: 1 }), { status: 200 }));
    const { result } = renderHook(() => useCsvPassSubscribe(deployment), { wrapper });
    await act(async () => result.current.start());
    await waitFor(() => expect(result.current.canRetryRelay).toBe(true));

    await act(async () => result.current.retryRelay());
    await waitFor(() => expect(result.current.isPayError).toBe(true));
    expect(result.current.canRetryRelay).toBe(false);
    expect(result.current.isRelayUncertain).toBe(false);
    expect(result.current.gaslessUnavailable).toBe(false);
    expect(window.localStorage.getItem(CSVPASS_SIG_KEY)).toBeNull();
    expect(fetchSpy.mock.calls[1][1]?.body).toBe(fetchSpy.mock.calls[0][1]?.body);
    expect(signTypedDataMock).toHaveBeenCalledTimes(1);

    await act(async () => result.current.start());
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(signTypedDataMock).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[2][1]?.body).not.toBe(fetchSpy.mock.calls[0][1]?.body);
    expect(writeContractMock).not.toHaveBeenCalled();
  });

  it('未解決 payload がある間は start() でも再署名せず同一 payload を再 POST (構造的強制・Codex P1)', async () => {
    let relayCalls = 0;
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (url: RequestInfo | URL) => {
        const u = String(url);
        if (u === '/api/csv-pass/relay') {
          relayCalls += 1;
          if (relayCalls === 1) {
            // hash 無し pending → payload が未解決のまま残る。
            return new Response(JSON.stringify({ ok: false, pending: true }), {
              status: 202,
            });
          }
          return new Response(JSON.stringify({ ok: true, txHash: TX }), {
            status: 200,
          });
        }
        return new Response(
          JSON.stringify({ ok: true, wallet: WALLET, expiresAt: 1 }),
          { status: 200 },
        );
      });
    const { result } = renderHook(() => useCsvPassSubscribe(deployment), {
      wrapper,
    });
    await act(async () => {
      result.current.start();
    });
    await waitFor(() => expect(result.current.canRetryRelay).toBe(true));

    // 通常の購入 CTA (start) をもう一度押されても再署名しない (engine ガード)。
    await act(async () => {
      result.current.start();
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(signTypedDataMock).toHaveBeenCalledTimes(1); // 再署名ゼロ
    const relayBodies = fetchSpy.mock.calls
      .filter((c) => c[0] === '/api/csv-pass/relay')
      .map((c) => (c[1] as RequestInit).body);
    expect(relayBodies.length).toBe(2);
    expect(relayBodies[1]).toEqual(relayBodies[0]); // 同一 payload
  });

  it('未解決 payload がある間は startGasPaid も開始しない (二重支払い防止・Codex P1)', async () => {
    relayThenSubscribe({ status: 202, body: { ok: false, pending: true } });
    const { result } = renderHook(() => useCsvPassSubscribe(deployment), {
      wrapper,
    });
    await act(async () => {
      result.current.start();
    });
    await waitFor(() => expect(result.current.canRetryRelay).toBe(true));

    await act(async () => {
      result.current.startGasPaid();
    });
    // ガスあり送金 (writeContract) は呼ばれず、phase も pay-error のまま。
    expect(result.current.isPayError).toBe(true);
    expect(result.current.canRetryRelay).toBe(true);
  });

  it('確定的な事前拒否 (4xx) は payload を破棄 → 通常 CTA から再署名できる (無限リプレイ防止・Codex P2)', async () => {
    // 1 回目は 400 rejected (署名不一致等・サーバは submit 前に拒否)、2 回目は成功。
    let relayCalls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (url: RequestInfo | URL) => {
        const u = String(url);
        if (u === '/api/csv-pass/relay') {
          relayCalls += 1;
          if (relayCalls === 1) {
            return new Response(
              JSON.stringify({ ok: false, error: 'insufficient_value' }),
              { status: 400 },
            );
          }
          return new Response(JSON.stringify({ ok: true, txHash: TX }), {
            status: 200,
          });
        }
        return new Response(
          JSON.stringify({ ok: true, wallet: WALLET, expiresAt: 1 }),
          { status: 200 },
        );
      },
    );
    const { result } = renderHook(() => useCsvPassSubscribe(deployment), {
      wrapper,
    });
    await act(async () => {
      result.current.start();
    });
    await waitFor(() => expect(result.current.isPayError).toBe(true));
    // 事前拒否 = broadcast されていない → payload は破棄され、リプレイ経路は出ない。
    expect(result.current.canRetryRelay).toBe(false);
    expect(window.localStorage.getItem(CSVPASS_SIG_KEY)).toBeNull();

    // 通常 CTA (start) から **新しい署名** でやり直せる (閉じ込めない)。
    await act(async () => {
      result.current.start();
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(signTypedDataMock).toHaveBeenCalledTimes(2); // 再署名された
  });

  it('pending 保持中の再試行が 503 daily_budget_exceeded → payload 破棄 + fallback (startGasPaid) が機能する (Codex P3)', async () => {
    // 1 回目 202 pending(hash 無し) → 2 回目 (retryRelay) 503。
    let relayCalls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (url: RequestInfo | URL) => {
        const u = String(url);
        if (u === '/api/csv-pass/relay') {
          relayCalls += 1;
          if (relayCalls === 1) {
            return new Response(JSON.stringify({ ok: false, pending: true }), {
              status: 202,
            });
          }
          return new Response(
            JSON.stringify({ ok: false, error: 'daily_budget_exceeded' }),
            { status: 503 },
          );
        }
        return new Response(
          JSON.stringify({ ok: true, wallet: WALLET, expiresAt: 1 }),
          { status: 200 },
        );
      },
    );
    const { result } = renderHook(() => useCsvPassSubscribe(deployment), {
      wrapper,
    });
    await act(async () => {
      result.current.start();
    });
    await waitFor(() => expect(result.current.canRetryRelay).toBe(true));

    await act(async () => {
      result.current.retryRelay();
    });
    // daily_budget_exceeded は idem claim 後の拒否 → payload 破棄 + gaslessUnavailable。
    await waitFor(() => expect(result.current.gaslessUnavailable).toBe(true));
    expect(result.current.canRetryRelay).toBe(false);
    expect(result.current.isRelayUncertain).toBe(false);
    expect(window.localStorage.getItem(CSVPASS_SIG_KEY)).toBeNull();

    // fallback ボタン (startGasPaid) が無反応にならず送金を開始できる。
    await act(async () => {
      result.current.startGasPaid();
    });
    expect(result.current.isPaying).toBe(true);
  });

  it('startGasPaid は gaslessUnavailable をリセットしない (fallback 中の表示矛盾防止・Codex P2)', async () => {
    relayThenSubscribe({
      status: 503,
      body: { ok: false, error: 'relay_not_configured' },
    });
    const { result } = renderHook(() => useCsvPassSubscribe(deployment), {
      wrapper,
    });
    await act(async () => {
      result.current.start();
    });
    await waitFor(() => expect(result.current.gaslessUnavailable).toBe(true));

    await act(async () => {
      result.current.startGasPaid();
    });
    // fallback 送金を開始しても「ガスレス不可」表示は維持される (ガス負担表示が偽らない)。
    expect(result.current.gaslessUnavailable).toBe(true);
  });
});
