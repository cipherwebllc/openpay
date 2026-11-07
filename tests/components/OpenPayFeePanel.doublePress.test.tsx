// /billing の支払い (OpenPayFeePanel の startPay → 実物の useUsageFeePayment) の二度押し。
// 同じ task の中でボタンを 2 回押す (click() を 2 回 = startPay を 2 回) と、ボタンの disabled (pay.isPending) を描いた再描画より
// 前なので 2 回とも startPay に届く。2 回目は署名・POST・mutation を作らず、画面の状態 (清算中の期間など) も変えない。
// wagmi・SIWE・インボイス・env・fetch だけを境界でモックする (hook は実物)。「2 本目が無い」は待ち時間でなく、MutationCache の
// どの mutation も終わった (pending でない) のを待ってから見る (作られた送金の mutation の数も数える)。
// 別ファイルなのは、OpenPayFeePanel.test.tsx が hook を vi.mock で差し替えているため。

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderWithIntl } from '../_helpers/i18n';

const JPYC = 10n ** 18n;
const TX_OK = `0x${'a'.repeat(64)}`;

const h = vi.hoisted(() => ({
  account: {
    isConnected: true,
    chainId: 80002 as number | undefined,
    address: '0x1111111111111111111111111111111111111111' as string | undefined,
  },
  signTypedData: vi.fn(async () => '0x' + 'ab'.repeat(65)),
  invoice: { data: undefined as unknown, isLoading: false, isError: false },
  switch: { switchChain: vi.fn(), error: null as Error | null, hold: false, release: () => {} },
}));

vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      feeReceiver: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      enableUsageFee: true,
      feeReceiverConfigured: true,
    },
  };
});
vi.mock('wagmi', async () => {
  const { useSwitchChainStub } = await import('../_helpers/switchChainStub');
  return {
    useAccount: () => h.account,
    useWalletClient: () => ({ data: { signTypedData: h.signTypedData } }),
    useSwitchChain: () => useSwitchChainStub(h.switch),
  };
});
vi.mock('@/hooks/useSiweSession', () => ({
  useSiweSession: () => ({
    isSignedIn: true,
    isSigningIn: false,
    mismatch: false,
    signIn: async () => undefined,
    signInError: null,
  }),
}));
vi.mock('@/hooks/useBillingInvoice', () => ({
  useBillingInvoice: () => h.invoice,
}));

import { OpenPayFeePanel } from '@/components/OpenPayFeePanel';

const invoiceData = (over?: Partial<Record<string, unknown>>) => ({
  feeCurrent: false,
  expiresAt: null,
  lastPaidPeriod: null,
  bypass: false,
  due: {
    period: '2026-07',
    count: 10,
    volumeWei: (10_000n * JPYC).toString(),
    rateBps: 100,
    feeWei: (100n * JPYC).toString(),
    free: false,
  },
  current: null,
  owed: [], // 既定は単一 due フロー (owed 一覧を出さない)
  ...over,
});

// 未払い行 (owed 一覧用)。feeWei = jpyc になるよう逆算 (1%)。
const owedLine = (period: string, jpyc: bigint) => ({
  period,
  count: 5,
  volumeWei: (jpyc * 100n * JPYC).toString(),
  rateBps: 100,
  feeWei: (jpyc * JPYC).toString(),
  free: false,
});

let qc: QueryClient;
let fetchSpy: MockInstance<typeof fetch>;

function renderPanel() {
  return renderWithIntl(
    <QueryClientProvider client={qc}>
      <OpenPayFeePanel />
    </QueryClientProvider>,
  );
}

function bodiesTo(path: string): Record<string, unknown>[] {
  return fetchSpy.mock.calls
    .filter(([url]) => url === path)
    .map(([, init]) => JSON.parse((init as RequestInit).body as string) as Record<string, unknown>);
}

// MutationCache のどの mutation も終わる (pending でない) まで待ち、作られた送金の mutation (変数に value を持つ・清算の
// mutation は数えない) の数を返す。
async function settledPayMutationCount(): Promise<number> {
  await waitFor(() =>
    expect(qc.getMutationCache().getAll().every((m) => m.state.status !== 'pending')).toBe(true),
  );
  return qc
    .getMutationCache()
    .getAll()
    .filter((m) => typeof (m.state.variables as { value?: unknown } | undefined)?.value === 'bigint').length;
}

const PAID = 'お支払いありがとうございます。';

beforeEach(() => {
  vi.restoreAllMocks();
  h.account = { isConnected: true, chainId: 80002, address: '0x1111111111111111111111111111111111111111' };
  h.signTypedData = vi.fn(async () => '0x' + 'ab'.repeat(65));
  h.invoice = { data: invoiceData(), isLoading: false, isError: false };
  h.switch.switchChain.mockReset();
  h.switch.error = null;
  h.switch.hold = false;
  h.switch.release = () => {};
  // 復旧の枠 (openpay:usage-fee-intent:v1) を test 間で持ち越さない。
  window.sessionStorage.clear();
  qc = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } });
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    if (url === '/api/relay/jpyc') {
      return new Response(JSON.stringify({ ok: true, txHash: TX_OK }), { status: 200 });
    }
    expect(url).toBe('/api/billing/settle');
    return new Response(JSON.stringify({ ok: true, expiresAt: 1 }), { status: 200 });
  });
});

describe('OpenPayFeePanel — 二度押しは 2 つ目の署名・送金にしない (実物の useUsageFeePayment)', () => {
  it('支払いボタンを同じ task で 2 回押す: 署名 1 回・POST 1 本・送金の mutation 1 つ・清算 1 回', async () => {
    renderPanel();
    const button = screen.getByRole('button', { name: /100 JPYC を支払う/ });
    act(() => {
      button.click();
      button.click();
    });
    await waitFor(() => expect(screen.getByText(PAID)).toBeInTheDocument());
    expect(await settledPayMutationCount()).toBe(1);
    expect(h.signTypedData).toHaveBeenCalledTimes(1);
    expect(bodiesTo('/api/relay/jpyc')).toHaveLength(1);
    expect(bodiesTo('/api/billing/settle')).toEqual([{ txHash: TX_OK, chainId: 80002, period: '2026-07' }]);
  });

  it('owed が複数: 同じ task で新しい月と古い月のボタンを押す → 新しい月だけ署名し、古い月の押下は清算中の期間の表示を書き換えない', async () => {
    h.invoice = {
      data: invoiceData({ owed: [owedLine('2026-07', 100n), owedLine('2026-05', 50n)] }),
      isLoading: false,
      isError: false,
    };
    let resolveSign: (signature: string) => void = () => undefined;
    h.signTypedData.mockImplementationOnce(() => new Promise<string>((resolve) => { resolveSign = resolve; }));
    renderPanel();
    const [newer, older] = screen.getAllByRole('listitem');
    act(() => {
      within(newer).getByRole('button', { name: /100 JPYC を支払う/ }).click();
      within(older).getByRole('button', { name: /50 JPYC を支払う/ }).click();
    });
    // 署名を待つ間: 「署名・送信中…」は 1 回目の期間 (2026-07) の行に出て、古い月の行は元の文言のまま (どちらも押せない)。
    await waitFor(() => expect(within(newer).getByRole('button')).toHaveTextContent('署名・送信中…'));
    expect(within(older).getByRole('button')).toHaveTextContent(/50 JPYC を支払う/);
    expect(within(newer).getByRole('button')).toBeDisabled();
    expect(within(older).getByRole('button')).toBeDisabled();
    expect(h.signTypedData).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveSign('0x' + 'cd'.repeat(65));
    });
    await waitFor(() => expect(screen.getByText(PAID)).toBeInTheDocument());
    expect(await settledPayMutationCount()).toBe(1);
    expect(h.signTypedData).toHaveBeenCalledTimes(1);
    const relayBodies = bodiesTo('/api/relay/jpyc');
    expect(relayBodies).toHaveLength(1);
    expect(relayBodies[0].value).toBe((100n * JPYC).toString());
    // 清算は 1 回目の期間 (古い月の押下で取り違えない)。
    expect(bodiesTo('/api/billing/settle')).toEqual([{ txHash: TX_OK, chainId: 80002, period: '2026-07' }]);
  });

  it('署名をウォレットで拒否した後の正当な次の押下は通る (印が外れる)', async () => {
    h.signTypedData.mockRejectedValueOnce(new Error('User rejected the request.'));
    renderPanel();
    act(() => {
      screen.getByRole('button', { name: /100 JPYC を支払う/ }).click();
    });
    await waitFor(() => expect(screen.getByText(/お支払いに失敗しました/)).toBeInTheDocument());
    expect(await settledPayMutationCount()).toBe(1);
    expect(bodiesTo('/api/relay/jpyc')).toHaveLength(0);

    act(() => {
      screen.getByRole('button', { name: /100 JPYC を支払う/ }).click();
    });
    await waitFor(() => expect(screen.getByText(PAID)).toBeInTheDocument());
    expect(await settledPayMutationCount()).toBe(2);
    expect(h.signTypedData).toHaveBeenCalledTimes(2);
    expect(bodiesTo('/api/relay/jpyc')).toHaveLength(1);
    expect(bodiesTo('/api/billing/settle')).toHaveLength(1);
  });
});
