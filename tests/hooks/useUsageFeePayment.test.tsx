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
});

describe('useUsageFeePayment (実コード)', () => {
  it('成功: FEE_RECEIVER 宛 transferWithAuthorization を署名し relay → {success, txHash}', async () => {
    const fetchSpy = mockFetch({ body: { ok: true, txHash: '0xdeadbeef' } });
    const { result } = renderHook(() => useUsageFeePayment(deployment), { wrapper });
    const r = await result.current.mutateAsync({ value: FEE });
    expect(r).toEqual({ txHash: '0xdeadbeef', success: true, pending: false });
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
    mockFetch({ status: 202, body: { pending: true, txHash: '0xpend' } });
    const { result } = renderHook(() => useUsageFeePayment(deployment), { wrapper });
    const r = await result.current.mutateAsync({ value: FEE });
    expect(r).toEqual({ txHash: '0xpend', success: false, pending: true });
  });

  it('relay エラー (402 fee_required) → throw (error code を伝播)', async () => {
    mockFetch({ status: 402, body: { ok: false, error: 'fee_required' } });
    const { result } = renderHook(() => useUsageFeePayment(deployment), { wrapper });
    await expect(result.current.mutateAsync({ value: FEE })).rejects.toThrow('fee_required');
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
