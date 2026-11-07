// useUsageFeePayment の実コードを検証 (パネル経由のモックでなく実体)。wagmi (walletClient/account)・
// fetch・env のみ境界モックし、署名ペイロード構築 (実 jpycEip3009) と relay 応答処理 (success/pending/error)
// を実際に通す。

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { useEffect, type ReactNode } from 'react';

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

// 画面 (/billing) を離れた (unmount した) hook の試みは、署名の後でも POST も復旧の枠 (openpay:usage-fee-intent:v1) の保存もしない。
// 離れて開き直した画面 (新しい hook) で払い直した後で、古い署名の承認や止まっていた再送 (応答不明 / IP 制限の後) が動いても、
// 2 本目を送らず枠も触らない。POST を始めた後は取り消さない (useJpycEip3009Payment の #1041 と同じ形)。
// 否定の assert (POST が無い・枠が変わらない) は、時間を待つのでなく古い試みの mutation が終わってから見る。
describe('useUsageFeePayment — 画面を離れた後の試みは POST も枠の保存もしない (unmount)', () => {
  type RelayReply = 'ok' | 'pending' | 'network' | 'ip_rate_limited';
  // relay POST の応答を順に返す (尽きたら成功)。
  let relayReplies: RelayReply[] = [];
  // relay へ送った body と、POST の時点の枠の nonce (POST の前に保存しているか・上書きしたか)。
  let posts: string[] = [];
  let savedAtPost: (string | null)[] = [];
  let fetchSpy: MockInstance<typeof fetch>;
  // アプリと同じく 1 つの QueryClient を共有する (止まった mutation は QueryClient が online で再開する・app/providers.tsx)。
  let qc: QueryClient;

  const HELD = [
    ['応答不明 (fetch の失敗)', 'network'],
    ['IP 制限 (429)', 'ip_rate_limited'],
  ] as const;

  function relayResponse(reply: RelayReply): Response {
    if (reply === 'network') throw new TypeError('Failed to fetch');
    if (reply === 'pending') {
      return new Response(JSON.stringify({ ok: false, pending: true, txHash: TX_PEND }), { status: 202 });
    }
    if (reply === 'ip_rate_limited') {
      return new Response(JSON.stringify({ ok: false, error: 'ip_rate_limited' }), { status: 429 });
    }
    return new Response(JSON.stringify({ ok: true, txHash: TX_OK }), { status: 200 });
  }

  function savedNonce(): string | null {
    const raw = window.sessionStorage.getItem(USAGE_FEE_INTENT_KEY);
    return raw === null ? null : (JSON.parse(raw) as { nonce: string }).nonce;
  }

  function postedNonces(): string[] {
    return posts.map((body) => (JSON.parse(body) as { nonce: string }).nonce);
  }

  function recordPost(url: unknown, init: RequestInit | undefined): void {
    expect(url).toBe('/api/relay/jpyc');
    posts.push(init?.body as string);
    savedAtPost.push(savedNonce());
  }

  function shared({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  }

  function mountHook(w: (props: { children: ReactNode }) => ReactNode = shared) {
    return renderHook(() => useUsageFeePayment(deployment), { wrapper: w });
  }

  type View = ReturnType<typeof mountHook>;

  // 押す (OpenPayFeePanel の startPay と同じく mutateAsync の reject を握る)。返す promise は mutation が終わると結果か error になる。
  function press(view: View, value: bigint = FEE): Promise<unknown> {
    let attempt: Promise<unknown> = Promise.resolve();
    act(() => {
      attempt = view.result.current.mutateAsync({ value }).catch((error: unknown) => error);
    });
    return attempt;
  }

  // mutation の終わりを待つ (時間に頼らない)。
  async function finished(attempt: Promise<unknown>): Promise<unknown> {
    let outcome: unknown;
    await act(async () => {
      outcome = await attempt;
    });
    return outcome;
  }

  function messageOf(outcome: unknown): unknown {
    return outcome instanceof Error ? outcome.message : outcome;
  }

  beforeEach(() => {
    relayReplies = [];
    posts = [];
    savedAtPost = [];
    qc = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } });
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      recordPost(url, init);
      return relayResponse(relayReplies.shift() ?? 'ok');
    });
  });

  it('署名を待つ間に unmount → 開き直した hook で払い直して送信済み → 古い署名が返っても POST も枠の上書きもしない', async () => {
    let resolveOld: (signature: string) => void = () => undefined;
    h.signTypedData.mockImplementationOnce(() => new Promise<string>((resolve) => { resolveOld = resolve; }));
    const viewA = mountHook();
    const oldAttempt = press(viewA);
    await waitFor(() => expect(h.signTypedData).toHaveBeenCalledTimes(1));
    viewA.unmount();

    // 開き直した画面で払い直す (送信済み・未確定 = 枠が残る)。
    relayReplies = ['pending'];
    const viewB = mountHook();
    expect(await finished(press(viewB))).toEqual({ txHash: TX_PEND, success: false, pending: true });
    const freshNonce = postedNonces()[0];
    expect(savedNonce()).toBe(freshNonce);

    // 古い署名の画面でも承認した。
    resolveOld('0x' + 'cd'.repeat(65));
    const oldOutcome = await finished(oldAttempt);
    expect(h.signTypedData).toHaveBeenCalledTimes(2);
    expect(posts).toHaveLength(1);
    expect(savedAtPost).toEqual([freshNonce]);
    expect(savedNonce()).toBe(freshNonce);
    expect(messageOf(oldOutcome)).toBe('payment_cancelled');
    viewB.unmount();
  });

  it.each(HELD)(
    '%s の後の再送を押した同じ tick に unmount → 古い再送は POST も枠の消去もしない・開き直した hook が同じ payload を送る',
    async (_label, held) => {
      relayReplies = [held];
      const viewA = mountHook();
      await finished(press(viewA));
      expect(posts).toHaveLength(1);
      const heldNonce = postedNonces()[0];
      expect(savedNonce()).toBe(heldNonce);

      // 再送を押した (mutation は作ったが mutationFn はまだ) 直後に、同じ tick で画面を離れる。
      let retry: Promise<unknown> = Promise.resolve();
      act(() => {
        retry = viewA.result.current.mutateAsync({ value: FEE }).catch((error: unknown) => error);
        viewA.unmount();
      });
      const retryOutcome = await finished(retry);
      expect(posts).toHaveLength(1);
      expect(savedNonce()).toBe(heldNonce);
      expect(messageOf(retryOutcome)).toBe('payment_cancelled');

      // 開き直した画面: 枠から同じ payload を復元し、再署名せずに同じ payload を送る (保持の流れは今までどおり)。
      const viewB = mountHook();
      expect(await finished(press(viewB))).toEqual({ txHash: TX_OK, success: true, pending: false });
      expect(h.signTypedData).toHaveBeenCalledTimes(1);
      expect(posts).toHaveLength(2);
      expect(posts[1]).toBe(posts[0]);
      expect(savedNonce()).toBeNull();
      viewB.unmount();
    },
  );

  it.each(HELD)(
    '%s の後の再送が offline で止まっている間に unmount → 開き直した後で online に戻っても、止まっていた再送は POST も枠の消去もしない',
    async (_label, held) => {
      relayReplies = [held];
      const viewA = mountHook();
      await finished(press(viewA));
      const heldNonce = postedNonces()[0];

      onlineManager.setOnline(false);
      try {
        const retry = press(viewA);
        // offline なので mutationFn は始まらない (POST も無い)。
        expect(qc.getMutationCache().getAll().some((m) => m.state.isPaused)).toBe(true);
        expect(posts).toHaveLength(1);
        viewA.unmount();
        const viewB = mountHook();
        // online に戻ると、止まっていた A の再送が再開する → 画面を離れた hook の試みなので何もしない。
        act(() => {
          onlineManager.setOnline(true);
        });
        const retryOutcome = await finished(retry);
        expect(posts).toHaveLength(1);
        expect(savedNonce()).toBe(heldNonce);
        expect(messageOf(retryOutcome)).toBe('payment_cancelled');

        // 開き直した hook は枠から同じ payload を復元して送る (再署名しない)。
        expect(await finished(press(viewB))).toEqual({ txHash: TX_OK, success: true, pending: false });
        expect(h.signTypedData).toHaveBeenCalledTimes(1);
        expect(posts).toHaveLength(2);
        expect(posts[1]).toBe(posts[0]);
        viewB.unmount();
      } finally {
        onlineManager.setOnline(true);
      }
    },
  );

  it('offline で止まった新しい支払いが unmount の後に online で再開しても、署名を求めず POST も枠の保存もしない', async () => {
    const viewA = mountHook();
    onlineManager.setOnline(false);
    try {
      const attempt = press(viewA);
      expect(qc.getMutationCache().getAll().some((m) => m.state.isPaused)).toBe(true);
      viewA.unmount();
      const viewB = mountHook();
      act(() => {
        onlineManager.setOnline(true);
      });
      const outcome = await finished(attempt);
      expect(h.signTypedData).not.toHaveBeenCalled();
      expect(posts).toHaveLength(0);
      expect(savedNonce()).toBeNull();
      expect(messageOf(outcome)).toBe('payment_cancelled');
      viewB.unmount();
    } finally {
      onlineManager.setOnline(true);
    }
  });

  it.each([
    ['応答が失われた (fetch の失敗)', 'network', 'response-unknown'],
    ['202 pending', 'pending', { txHash: TX_PEND, success: false, pending: true }],
  ] as const)(
    'POST を始めた後の unmount は取り消さない: %s でも枠が残り、開き直した hook は再署名せず同じ payload を再 POST する',
    async (_label, outcome, expected) => {
      let finishPost: () => void = () => undefined;
      fetchSpy.mockImplementationOnce((url, init) => {
        recordPost(url, init);
        return new Promise<Response>((resolve, reject) => {
          finishPost = () => (outcome === 'network' ? reject(new TypeError('Failed to fetch')) : resolve(relayResponse('pending')));
        });
      });
      const viewA = mountHook();
      const attempt = press(viewA);
      await waitFor(() => expect(posts).toHaveLength(1));
      const nonce = postedNonces()[0];
      // POST の前に枠を保存している (送ったかもしれないものの復旧の枠)。
      expect(savedAtPost).toEqual([nonce]);
      viewA.unmount();
      // 送った後の応答の扱いは今までどおり (取り消さない・枠を消さない)。
      finishPost();
      expect(messageOf(await finished(attempt))).toEqual(expected);
      expect((fetchSpy.mock.calls[0][1] as RequestInit).signal).toBeUndefined();
      expect(savedNonce()).toBe(nonce);

      const viewB = mountHook();
      expect(await finished(press(viewB))).toEqual({ txHash: TX_OK, success: true, pending: false });
      expect(h.signTypedData).toHaveBeenCalledTimes(1);
      expect(posts).toHaveLength(2);
      expect(posts[1]).toBe(posts[0]);
      viewB.unmount();
    },
  );

  // StrictMode は renderHook の reactStrictMode で root に置く。wrapper の関数 component の中に <StrictMode> を置くと、
  // React 19.2 は初回の mount で effect を二度呼ばない (StrictMode の fiber が新しく置いた木の一番上でないため)。
  it('StrictMode の mount→unmount→mount の後に押した正当な 1 回目は止めない (署名 1 回・POST 1 回で成立)', async () => {
    const log: string[] = [];
    const view = renderHook(
      () => {
        // effect が二度呼ばれた (mount→unmount→mount を通った) ことを確かめる目印。
        useEffect(() => {
          log.push('mount');
          return () => {
            log.push('unmount');
          };
        }, []);
        return useUsageFeePayment(deployment);
      },
      { wrapper: shared, reactStrictMode: true },
    );
    expect(log).toEqual(['mount', 'unmount', 'mount']);
    expect(await finished(press(view))).toEqual({ txHash: TX_OK, success: true, pending: false });
    expect(h.signTypedData).toHaveBeenCalledTimes(1);
    expect(posts).toHaveLength(1);
    expect(savedNonce()).toBeNull();
    view.unmount();
  });
});
