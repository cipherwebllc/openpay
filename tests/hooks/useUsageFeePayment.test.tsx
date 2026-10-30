// useUsageFeePayment の実コードを検証 (パネル経由のモックでなく実体)。wagmi (walletClient/account)・
// fetch・env のみ境界モックし、署名ペイロード構築 (実 jpycEip3009) と relay 応答処理 (success/pending/error)
// を実際に通す。

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const h = vi.hoisted(() => ({
  account: { address: '0x1111111111111111111111111111111111111111', chainId: 80002 } as {
    address: string | undefined;
    chainId: number | undefined;
  },
  signTypedData: vi.fn(async () => '0x' + 'ab'.repeat(65)),
}));

vi.mock('wagmi', () => ({
  useWalletClient: () => ({ data: { signTypedData: h.signTypedData } }),
  useAccount: () => h.account,
}));
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: { ...actual.env, feeReceiver: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' },
  };
});

import { useUsageFeePayment } from '@/hooks/useUsageFeePayment';
import { resolveDeployment } from '@/lib/tokens';

const deployment = resolveDeployment('jpyc', 80002)!; // 実 Amoy JPYC deployment
const FEE = 100n * 10n ** 18n;
// relay の txHash は 0x + 64 桁の hex。hook はこの形のときだけ成功・revert として受ける。
const TX_OK = `0x${'a'.repeat(64)}`;
const TX_REV = `0x${'e'.repeat(64)}`;
const TX_PEND = `0x${'c'.repeat(64)}`;
// 形の崩れた txHash (どれも空でない文字列なので、旧 isTxHash は通していた)。
const MALFORMED_TX_HASHES = [
  ['非 hex', `0x${'g'.repeat(64)}`],
  ['63 桁', `0x${'a'.repeat(63)}`],
  ['0x なし', 'a'.repeat(64)],
] as const;
// 202 pending の txHash として受けない値 (旧実装の 202 分岐は txHash の形を見ずに返していた)。
const INVALID_PENDING_TX_HASHES: ReadonlyArray<readonly [string, unknown]> = [
  ...MALFORMED_TX_HASHES,
  ['空文字', ''],
  ['数値', 123],
  ['object', { hash: TX_PEND }],
  ['真偽値', true],
];
const USAGE_FEE_INTENT_KEY = 'openpay:usage-fee-intent:v1';

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

function mockFetch(resp: { status?: number; body: unknown }) {
  return vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(
      new Response(JSON.stringify(resp.body), { status: resp.status ?? 200 }),
    );
}

beforeEach(() => {
  h.account = { address: '0x1111111111111111111111111111111111111111', chainId: 80002 };
  h.signTypedData = vi.fn(async () => '0x' + 'ab'.repeat(65));
  vi.restoreAllMocks();
  // 応答不明 latch は sessionStorage に残るため、test 間で持ち越さない。
  window.sessionStorage.clear();
});

describe('useUsageFeePayment (実コード)', () => {
  it('成功: FEE_RECEIVER 宛 transferWithAuthorization を署名し relay → {success, txHash}', async () => {
    const fetchSpy = mockFetch({ body: { ok: true, txHash: TX_OK } });
    const { result } = renderHook(() => useUsageFeePayment(deployment), { wrapper });
    const r = await result.current.mutateAsync({ value: FEE });
    expect(r).toEqual({ txHash: TX_OK, success: true, pending: false });
    expect(h.signTypedData).toHaveBeenCalledTimes(1);
    // relay へ送る payload を検査: to=FEE_RECEIVER・value・signature が乗る。
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('/api/relay/jpyc');
    const payload = JSON.parse((init as RequestInit).body as string);
    expect(payload.to).toBe('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
    expect(payload.value).toBe(FEE.toString());
    expect(payload.from).toBe(h.account.address);
    expect(typeof payload.signature).toBe('string');
    expect(payload.nonce).toMatch(/^0x[0-9a-f]{64}$/i);
  });

  it('202 pending → {pending:true, success:false} (再送禁止)', async () => {
    mockFetch({ status: 202, body: { pending: true, txHash: TX_PEND } });
    const { result } = renderHook(() => useUsageFeePayment(deployment), { wrapper });
    const r = await result.current.mutateAsync({ value: FEE });
    expect(r).toEqual({ txHash: TX_PEND, success: false, pending: true });
  });

  it('relay エラー (402 fee_required) → throw (error code を伝播)', async () => {
    mockFetch({ status: 402, body: { ok: false, error: 'fee_required' } });
    const { result } = renderHook(() => useUsageFeePayment(deployment), { wrapper });
    await expect(result.current.mutateAsync({ value: FEE })).rejects.toThrow('fee_required');
  });

  // A2 (2026-09-02 review): 応答不明 (network throw / 非 JSON 2xx / 非構造化 non-2xx) を
  // 通常 Error に倒すと、呼出側の再試行が **新しい nonce** で署名し直し、server の冪等キー
  // (chainId+from+nonce) が変わって二重課金になる。専用状態 + 同一 payload 再 POST で封じる。
  describe('応答不明 (response-unknown) の扱い', () => {
    it('fetch が throw (応答喪失) → RelayResponseUnknownError', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Failed to fetch'));
      const { result } = renderHook(() => useUsageFeePayment(deployment), { wrapper });
      await expect(result.current.mutateAsync({ value: FEE })).rejects.toMatchObject({
        name: 'RelayResponseUnknownError',
        message: 'response-unknown',
      });
    });

    it('非 JSON の 200 も成功にせず RelayResponseUnknownError', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('<html>gateway</html>', { status: 200 }),
      );
      const { result } = renderHook(() => useUsageFeePayment(deployment), { wrapper });
      await expect(result.current.mutateAsync({ value: FEE })).rejects.toMatchObject({
        name: 'RelayResponseUnknownError',
      });
    });

    it('応答不明の後の再試行は再署名せず同一 payload (同 nonce) を再 POST する', async () => {
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockRejectedValueOnce(new Error('Failed to fetch'))
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ ok: true, txHash: TX_OK }), { status: 200 }),
        );
      const { result } = renderHook(() => useUsageFeePayment(deployment), { wrapper });
      await expect(result.current.mutateAsync({ value: FEE })).rejects.toMatchObject({
        name: 'RelayResponseUnknownError',
      });
      expect(h.signTypedData).toHaveBeenCalledTimes(1);

      const r = await result.current.mutateAsync({ value: FEE });
      expect(r).toEqual({ txHash: TX_OK, success: true, pending: false });
      // 再署名していない = 新しい nonce を作っていない (server 冪等キーが変わらない)。
      expect(h.signTypedData).toHaveBeenCalledTimes(1);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      const first = (fetchSpy.mock.calls[0][1] as RequestInit).body as string;
      const second = (fetchSpy.mock.calls[1][1] as RequestInit).body as string;
      expect(second).toBe(first);
      expect(JSON.parse(second).nonce).toBe(JSON.parse(first).nonce);
    });

    it('構造化 4xx (fallback-safe) の後は latch を解除し新規署名で再試行できる', async () => {
      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ ok: false, error: 'fee_required' }), {
            status: 402,
          }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ ok: true, txHash: TX_OK }), { status: 200 }),
        );
      const { result } = renderHook(() => useUsageFeePayment(deployment), { wrapper });
      await expect(result.current.mutateAsync({ value: FEE })).rejects.toThrow('fee_required');
      const r = await result.current.mutateAsync({ value: FEE });
      expect(r.success).toBe(true);
      expect(h.signTypedData).toHaveBeenCalledTimes(2);
    });

    it('応答不明の間は別 amount の新規署名も出さない (二重課金防止)', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Failed to fetch'));
      const { result } = renderHook(() => useUsageFeePayment(deployment), { wrapper });
      await expect(result.current.mutateAsync({ value: FEE })).rejects.toMatchObject({
        name: 'RelayResponseUnknownError',
      });
      await expect(result.current.mutateAsync({ value: FEE * 2n })).rejects.toMatchObject({
        name: 'RelayResponseUnknownError',
      });
      expect(h.signTypedData).toHaveBeenCalledTimes(1);
    });
  });

  // A2 rescope (2026-09-03 adversarial review): sibling (useJpycEip3009Payment) との
  // 分岐差を潰す。429 ip_rate_limited / 200 reverted / latch の単調性 / chain-account 照合 /
  // reload 復元。
  describe('sibling (useJpycEip3009Payment) との分岐一致', () => {
    it('429 ip_rate_limited → RelayIpRateLimitedError・latch 維持で同一 nonce を再 POST', async () => {
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ ok: false, error: 'ip_rate_limited' }), {
            status: 429,
            headers: { 'retry-after': '30' },
          }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ ok: true, txHash: TX_OK }), { status: 200 }),
        );
      const { result } = renderHook(() => useUsageFeePayment(deployment), { wrapper });
      await expect(result.current.mutateAsync({ value: FEE })).rejects.toMatchObject({
        name: 'RelayIpRateLimitedError',
        message: 'ip_rate_limited',
        retryAfterSeconds: 30,
      });

      const r = await result.current.mutateAsync({ value: FEE });
      expect(r.success).toBe(true);
      // 再署名なし = 同一 nonce の再 POST (server 冪等キーが変わらない)。
      expect(h.signTypedData).toHaveBeenCalledTimes(1);
      const first = (fetchSpy.mock.calls[0][1] as RequestInit).body as string;
      const second = (fetchSpy.mock.calls[1][1] as RequestInit).body as string;
      expect(second).toBe(first);
    });

    it('200 {ok:false,reverted:true} → 確定失敗として latch 解除・再署名を許す', async () => {
      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ ok: false, reverted: true, txHash: TX_REV }),
            { status: 200 },
          ),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ ok: true, txHash: TX_OK }), { status: 200 }),
        );
      const { result } = renderHook(() => useUsageFeePayment(deployment), { wrapper });
      const reverted = await result.current.mutateAsync({ value: FEE });
      expect(reverted).toEqual({ txHash: TX_REV, success: false, pending: false });
      // revert = on-chain 終端 (送金未成立) なので latch を残さない。
      expect(window.sessionStorage.getItem('openpay:usage-fee-intent:v1')).toBeNull();

      const r = await result.current.mutateAsync({ value: FEE });
      expect(r.success).toBe(true);
      expect(h.signTypedData).toHaveBeenCalledTimes(2);
    });

    it('応答不明のあとの構造化 400 では latch を解除しない (単調 latch)', async () => {
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockRejectedValueOnce(new Error('Failed to fetch'))
        // Response の body は 1 度しか読めないため、呼出ごとに新しく作る。
        .mockImplementation(async () =>
          new Response(JSON.stringify({ ok: false, error: 'bad_request' }), {
            status: 400,
          }),
        );
      const { result } = renderHook(() => useUsageFeePayment(deployment), { wrapper });
      await expect(result.current.mutateAsync({ value: FEE })).rejects.toMatchObject({
        name: 'RelayResponseUnknownError',
      });
      await expect(result.current.mutateAsync({ value: FEE })).rejects.toThrow('bad_request');
      // 3 回目も再署名せず同一 payload を再 POST する (latch が外れていない証拠)。
      await expect(result.current.mutateAsync({ value: FEE })).rejects.toThrow('bad_request');
      expect(h.signTypedData).toHaveBeenCalledTimes(1);
      expect(fetchSpy).toHaveBeenCalledTimes(3);
      const bodies = fetchSpy.mock.calls.map(
        (c) => (c[1] as RequestInit).body as string,
      );
      expect(bodies[1]).toBe(bodies[0]);
      expect(bodies[2]).toBe(bodies[0]);
    });

    it('latch 中に chain を切り替えたら stale payload を再 POST しない (latch は維持)', async () => {
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockRejectedValue(new Error('Failed to fetch'));
      const { result, rerender } = renderHook(
        () => useUsageFeePayment(deployment),
        { wrapper },
      );
      await expect(result.current.mutateAsync({ value: FEE })).rejects.toMatchObject({
        name: 'RelayResponseUnknownError',
      });
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      h.account = { address: h.account.address, chainId: 137 };
      rerender();
      await expect(result.current.mutateAsync({ value: FEE })).rejects.toMatchObject({
        name: 'RelayResponseUnknownError',
      });
      // 別 chain の relay へ古い payload を投げず、再署名もしない。
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(h.signTypedData).toHaveBeenCalledTimes(1);
    });

    it('latch 中に account を切り替えても stale payload を再 POST しない', async () => {
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockRejectedValue(new Error('Failed to fetch'));
      const { result, rerender } = renderHook(
        () => useUsageFeePayment(deployment),
        { wrapper },
      );
      await expect(result.current.mutateAsync({ value: FEE })).rejects.toMatchObject({
        name: 'RelayResponseUnknownError',
      });

      h.account = {
        address: '0x2222222222222222222222222222222222222222',
        chainId: 80002,
      };
      rerender();
      await expect(result.current.mutateAsync({ value: FEE })).rejects.toMatchObject({
        name: 'RelayResponseUnknownError',
      });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(h.signTypedData).toHaveBeenCalledTimes(1);
    });

    it('reload (remount) 後も sessionStorage から latch を復元し同一 nonce を再 POST する', async () => {
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockRejectedValueOnce(new Error('Failed to fetch'))
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ ok: true, txHash: TX_OK }), { status: 200 }),
        );
      const first = renderHook(() => useUsageFeePayment(deployment), { wrapper });
      await expect(first.result.current.mutateAsync({ value: FEE })).rejects.toMatchObject(
        { name: 'RelayResponseUnknownError' },
      );
      expect(window.sessionStorage.getItem('openpay:usage-fee-intent:v1')).not.toBeNull();
      first.unmount();

      // reload 相当: memory latch を失った新しい mount。
      const second = renderHook(() => useUsageFeePayment(deployment), { wrapper });
      await waitFor(() =>
        expect(window.sessionStorage.getItem('openpay:usage-fee-intent:v1')).not.toBeNull(),
      );
      const r = await second.result.current.mutateAsync({ value: FEE });
      expect(r.success).toBe(true);
      // 再署名せず、保存済み payload (同一 nonce) をそのまま再 POST する。
      expect(h.signTypedData).toHaveBeenCalledTimes(1);
      const bodies = fetchSpy.mock.calls.map(
        (c) => (c[1] as RequestInit).body as string,
      );
      expect(JSON.parse(bodies[1]).nonce).toBe(JSON.parse(bodies[0]).nonce);
      expect(JSON.parse(bodies[1]).signature).toBe(JSON.parse(bodies[0]).signature);
      // 確定応答で保存も破棄する。
      expect(window.sessionStorage.getItem('openpay:usage-fee-intent:v1')).toBeNull();
    });
  });

  // full-review 2026-10-30 F-6 (PR-07): txHash は 0x + 64 桁の hex のときだけ確定応答として受ける。
  // 形の崩れた txHash は成功にも revert (latch 解除・再署名の許可) にもせず、応答不明 (曖昧 latch) に落とす。
  describe('txHash の形 (0x + 64 桁の hex だけを確定応答にする)', () => {
    it.each(MALFORMED_TX_HASHES)(
      '200 {ok:true} の txHash が %s → 成功にせず応答不明・latch を残して同一 nonce を再 POST',
      async (_label, badHash) => {
        const fetchSpy = vi
          .spyOn(globalThis, 'fetch')
          .mockResolvedValueOnce(
            new Response(JSON.stringify({ ok: true, txHash: badHash }), { status: 200 }),
          )
          .mockResolvedValueOnce(
            new Response(JSON.stringify({ ok: true, txHash: TX_OK }), { status: 200 }),
          );
        const { result } = renderHook(() => useUsageFeePayment(deployment), { wrapper });
        await expect(result.current.mutateAsync({ value: FEE })).rejects.toMatchObject({
          name: 'RelayResponseUnknownError',
        });
        expect(window.sessionStorage.getItem('openpay:usage-fee-intent:v1')).not.toBeNull();

        const r = await result.current.mutateAsync({ value: FEE });
        expect(r).toEqual({ txHash: TX_OK, success: true, pending: false });
        expect(h.signTypedData).toHaveBeenCalledTimes(1);
        const bodies = fetchSpy.mock.calls.map((c) => (c[1] as RequestInit).body as string);
        expect(bodies[1]).toBe(bodies[0]);
      },
    );

    it.each(MALFORMED_TX_HASHES)(
      '200 {ok:false,reverted:true} の txHash が %s → 確定失敗にせず応答不明・再署名を許さない',
      async (_label, badHash) => {
        const fetchSpy = vi
          .spyOn(globalThis, 'fetch')
          .mockResolvedValueOnce(
            new Response(
              JSON.stringify({ ok: false, reverted: true, txHash: badHash }),
              { status: 200 },
            ),
          )
          .mockResolvedValueOnce(
            new Response(JSON.stringify({ ok: true, txHash: TX_OK }), { status: 200 }),
          );
        const { result } = renderHook(() => useUsageFeePayment(deployment), { wrapper });
        await expect(result.current.mutateAsync({ value: FEE })).rejects.toMatchObject({
          name: 'RelayResponseUnknownError',
        });
        expect(window.sessionStorage.getItem('openpay:usage-fee-intent:v1')).not.toBeNull();

        const r = await result.current.mutateAsync({ value: FEE });
        expect(r).toEqual({ txHash: TX_OK, success: true, pending: false });
        expect(h.signTypedData).toHaveBeenCalledTimes(1);
        const bodies = fetchSpy.mock.calls.map((c) => (c[1] as RequestInit).body as string);
        expect(bodies[1]).toBe(bodies[0]);
      },
    );

    it('大文字を含む 0x + 64 桁の hex は従来どおり成功', async () => {
      const mixedCase = `0x${'aB'.repeat(32)}`;
      mockFetch({ body: { ok: true, txHash: mixedCase } });
      const { result } = renderHook(() => useUsageFeePayment(deployment), { wrapper });
      const r = await result.current.mutateAsync({ value: FEE });
      expect(r).toEqual({ txHash: mixedCase, success: true, pending: false });
      expect(window.sessionStorage.getItem('openpay:usage-fee-intent:v1')).toBeNull();
    });

    // 202 pending も useJpycEip3009Payment と同じく txHash が無し・null・64 桁 hex のときだけ pending の結果にする。
    it.each([
      ['txHash: null', { ok: false, pending: true, txHash: null }],
      ['txHash なし', { ok: false, pending: true }],
    ])('202 pending の %s → 従来どおり pending (txHash は null)・latch を残す', async (_label, body) => {
      mockFetch({ status: 202, body });
      const { result } = renderHook(() => useUsageFeePayment(deployment), { wrapper });
      const r = await result.current.mutateAsync({ value: FEE });
      expect(r).toEqual({ txHash: null, success: false, pending: true });
      expect(window.sessionStorage.getItem(USAGE_FEE_INTENT_KEY)).not.toBeNull();
    });

    it.each(INVALID_PENDING_TX_HASHES)(
      '202 pending の txHash が %s → pending の結果にせず応答不明・同一 nonce を再 POST',
      async (_label, badHash) => {
        const fetchSpy = vi
          .spyOn(globalThis, 'fetch')
          .mockResolvedValueOnce(
            new Response(
              JSON.stringify({ ok: false, pending: true, txHash: badHash }),
              { status: 202 },
            ),
          )
          .mockResolvedValueOnce(
            new Response(JSON.stringify({ ok: false, pending: true, txHash: TX_PEND }), {
              status: 202,
            }),
          );
        const { result } = renderHook(() => useUsageFeePayment(deployment), { wrapper });
        await expect(result.current.mutateAsync({ value: FEE })).rejects.toMatchObject({
          name: 'RelayResponseUnknownError',
        });
        expect(window.sessionStorage.getItem(USAGE_FEE_INTENT_KEY)).not.toBeNull();

        const r = await result.current.mutateAsync({ value: FEE });
        expect(r).toEqual({ txHash: TX_PEND, success: false, pending: true });
        expect(h.signTypedData).toHaveBeenCalledTimes(1);
        const bodies = fetchSpy.mock.calls.map((c) => (c[1] as RequestInit).body as string);
        expect(bodies[1]).toBe(bodies[0]);
      },
    );

    // この PR が保証するのは「形の崩れた txHash で latch を外さない・再署名しない」まで。broadcast 済みの
    // 利用料の再 POST は、server が authorization 使用済みを見て hash なしの 202 pending を返す
    // (lib/relay/jpycRelay.ts の 5.5)。この hook には status / receipt の照会が無いので pending のまま残る (既存の限界)。
    it('200 {ok:true} の崩れた txHash → 応答不明 → 再 POST は hash なしの 202 pending → pending のまま再署名しない', async () => {
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ ok: true, txHash: MALFORMED_TX_HASHES[0][1] }), {
            status: 200,
          }),
        )
        .mockImplementation(async () =>
          new Response(JSON.stringify({ ok: false, pending: true, txHash: null }), {
            status: 202,
          }),
        );
      const { result } = renderHook(() => useUsageFeePayment(deployment), { wrapper });
      await expect(result.current.mutateAsync({ value: FEE })).rejects.toMatchObject({
        name: 'RelayResponseUnknownError',
      });

      const second = await result.current.mutateAsync({ value: FEE });
      expect(second).toEqual({ txHash: null, success: false, pending: true });
      const third = await result.current.mutateAsync({ value: FEE });
      expect(third).toEqual({ txHash: null, success: false, pending: true });
      expect(window.sessionStorage.getItem(USAGE_FEE_INTENT_KEY)).not.toBeNull();
      expect(h.signTypedData).toHaveBeenCalledTimes(1);
      const bodies = fetchSpy.mock.calls.map((c) => (c[1] as RequestInit).body as string);
      expect(bodies).toHaveLength(3);
      expect(new Set(bodies).size).toBe(1);
    });
  });

  it('ウォレット未接続 → throw (署名・relay しない)', async () => {
    h.account = { address: undefined, chainId: undefined };
    const fetchSpy = mockFetch({ body: { ok: true, txHash: '0x' } });
    const { result } = renderHook(() => useUsageFeePayment(deployment), { wrapper });
    await expect(result.current.mutateAsync({ value: FEE })).rejects.toThrow('wallet_not_connected');
    expect(h.signTypedData).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
