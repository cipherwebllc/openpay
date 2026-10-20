// 「Arc の売上を受け取る」の画面 (components/arcPayout/ArcPayoutPanel.tsx + hooks/useArcPayout.ts)。
// 押せない理由の出し分け・全額の表示・二度押し・Circle の応答が分からないときに引き出し直させない・
// 受け取りの取引の再送 (失効まで・引き出し元のアカウントだけ)・署名をログに出さないこと、を固定する。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Hex } from 'viem';
import { renderWithIntl } from '../_helpers/i18n';
import messages from '../../messages/ja.json';

const A = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';
const B = '0x1111111111111111111111111111111111111111';
const SECRET_SIG = `0x${'5e'.repeat(65)}` as Hex;
const SECRET_ATT = `0x${'a7'.repeat(200)}` as Hex;
const TX = `0x${'ab'.repeat(32)}` as Hex;

const s = vi.hoisted(() => ({
  address: undefined as string | undefined,
  code: { arc: undefined as string | undefined, base: undefined as string | undefined },
  gas: 117_000_000_000_000_000n,
  balance: { status: 'ok', available: 30_500n, pending: 0n } as unknown,
  fee: 3_500n as bigint | Error,
  request: vi.fn(),
  mint: vi.fn(),
  switchChainAsync: vi.fn(),
}));

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: s.address }),
  usePublicClient: ({ chainId }: { chainId: number }) => ({
    getCode: async () => (chainId === 5042 || chainId === 5042002 ? s.code.arc : s.code.base),
    getBalance: async () => s.gas,
  }),
  useWalletClient: () => ({ data: { account: s.address } }),
  useSwitchChain: () => ({ switchChainAsync: s.switchChainAsync }),
}));
vi.mock('@/components/ConnectButton', () => ({ ConnectButton: () => <button type="button">connect-stub</button> }));
vi.mock('@/lib/crossChain/arcPayout', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/crossChain/arcPayout')>();
  return {
    ...actual,
    readArcPayoutBalance: async () => s.balance,
    fetchArcPayoutFee: async () => {
      if (s.fee instanceof Error) throw s.fee;
      return s.fee;
    },
    requestArcPayout: s.request,
    sendArcPayoutMint: s.mint,
  };
});

import { ArcPayoutPanel } from '@/components/arcPayout/ArcPayoutPanel';
import { ArcPayoutError } from '@/lib/crossChain/arcPayout';
import { GatewayTransferRejectedError } from '@/lib/crossChain/gateway';

const t = messages.ArcPayout;
const pending = { depositor: A, attestation: SECRET_ATT, signature: SECRET_SIG, expiresAtBlock: 9_999n, value: 27_000n };

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = renderWithIntl(
    <QueryClientProvider client={qc}>
      <ArcPayoutPanel />
    </QueryClientProvider>,
  );
  return {
    ...view,
    rerenderPanel: () => view.rerender(
      <QueryClientProvider client={qc}>
        <ArcPayoutPanel />
      </QueryClientProvider>,
    ),
  };
}

const withdrawButton = () => screen.getByRole('button', { name: t.withdraw });

beforeEach(() => {
  s.address = A;
  s.code = { arc: undefined, base: undefined };
  s.gas = 117_000_000_000_000_000n;
  s.balance = { status: 'ok', available: 30_500n, pending: 0n };
  s.fee = 3_500n;
  s.request.mockReset().mockResolvedValue(pending);
  s.mint.mockReset().mockResolvedValue(TX);
  s.switchChainAsync.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe('ArcPayoutPanel の表示', () => {
  it('未接続なら受取アドレスのウォレットをつなぐよう案内する', () => {
    s.address = undefined;
    renderPanel();
    expect(screen.getByText(t.connectPrompt)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'connect-stub' })).toBeInTheDocument();
  });

  it('残高・精算待ち・手数料・受け取る額 (残高 − 手数料) を出し、押せる', async () => {
    renderPanel();
    expect(await screen.findByText('0.027 USDC')).toBeInTheDocument();
    expect(screen.getByText('0.0305 USDC')).toBeInTheDocument();
    expect(screen.getByText('0.0035 USDC')).toBeInTheDocument();
    await waitFor(() => expect(withdrawButton()).toBeEnabled());
  });

  it.each([
    ['Arc でコントラクト', () => { s.code.arc = '0x6000'; }, t.contractWallet],
    ['Base でコントラクト', () => { s.code.base = '0x6000'; }, t.contractWallet],
    ['残高 0', () => { s.balance = { status: 'ok', available: 0n, pending: 5n }; }, t.nothingToWithdraw],
    ['残高が手数料ちょうど', () => { s.balance = { status: 'ok', available: 3_500n, pending: 0n }; }, t.errorBelowFee.replace('{fee}', '0.0035')],
    ['ガス代用の Arc の USDC が 0', () => { s.gas = 0n; }, t.noGas],
    ['残高を読めない', () => { s.balance = { status: 'error', error: 'x' }; }, t.errorLoad],
    ['手数料を読めない', () => { s.fee = new Error('estimate down'); }, t.errorFee],
  ])('%s なら理由を出して押せない', async (_label, setup, message) => {
    setup();
    renderPanel();
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(withdrawButton()).toBeDisabled();
  });

  it('7702 の委任 (0xef0100…) は通常のアドレスとして扱う', async () => {
    s.code.arc = `0xef0100${'22'.repeat(20)}`;
    renderPanel();
    await waitFor(() => expect(withdrawButton()).toBeEnabled());
  });
});

describe('ArcPayoutPanel の引き出し', () => {
  it('二度押ししても依頼は 1 回。署名 → 受け取りの取引 → 完了と取引のリンク', async () => {
    let release!: () => void;
    s.request.mockImplementation(() => new Promise((resolve) => { release = () => resolve(pending); }));
    renderPanel();
    await waitFor(() => expect(withdrawButton()).toBeEnabled());
    fireEvent.click(withdrawButton());
    fireEvent.click(withdrawButton());
    await act(async () => release());
    expect(await screen.findByText(t.done.replace('{amount}', '0.027'), { exact: false })).toBeInTheDocument();
    expect(s.request).toHaveBeenCalledTimes(1);
    expect(s.mint).toHaveBeenCalledTimes(1);
    expect(s.mint.mock.calls[0]![0]).toBe(pending);
    expect(screen.getByRole('link', { name: t.viewTx })).toHaveAttribute('href', expect.stringContaining(TX));
  });

  it('Circle が拒否した (確定) ら理由を出す。残高はそのままなので、もう一度押せる', async () => {
    s.request.mockRejectedValue(new GatewayTransferRejectedError(400, 'maxFee too low'));
    renderPanel();
    await waitFor(() => expect(withdrawButton()).toBeEnabled());
    fireEvent.click(withdrawButton());
    expect(await screen.findByText(t.errorCircleRejected.replace('{status}', '400'))).toBeInTheDocument();
    await waitFor(() => expect(withdrawButton()).toBeEnabled());
  });

  it.each([
    ['5xx', () => new GatewayTransferRejectedError(503, 'busy')],
    ['依頼中の通信の失敗', () => new TypeError('Failed to fetch')],
  ])('Circle の応答が分からない (%s) ときは 10 分間引き出し直させない', async (_label, error) => {
    s.request.mockImplementation(async (_from: string, deps: { onStep?: (step: string) => void }) => {
      deps.onStep?.('requesting');
      throw error();
    });
    renderPanel();
    await waitFor(() => expect(withdrawButton()).toBeEnabled());
    fireEvent.click(withdrawButton());
    expect(await screen.findByText(t.errorCircleUnknown)).toBeInTheDocument();
    await waitFor(() => expect(withdrawButton()).toBeDisabled());
    fireEvent.click(withdrawButton());
    expect(s.request).toHaveBeenCalledTimes(1);
  });

  it('受け取りの取引に失敗したら、新しく署名させずに同じ attestation で再送できる', async () => {
    s.mint.mockRejectedValueOnce(new Error('user rejected the request')).mockResolvedValueOnce(TX);
    renderPanel();
    await waitFor(() => expect(withdrawButton()).toBeEnabled());
    fireEvent.click(withdrawButton());
    expect(await screen.findByText(t.errorMintNotSent)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: t.retryMint }));
    expect(await screen.findByText(t.done.replace('{amount}', '0.027'), { exact: false })).toBeInTheDocument();
    expect(s.request).toHaveBeenCalledTimes(1);
    expect(s.mint).toHaveBeenCalledTimes(2);
    expect(s.mint.mock.calls[1]![0]).toBe(pending);
  });

  it('失効した attestation は再送させない (残高に戻るのを待つ)', async () => {
    s.mint.mockRejectedValue(new ArcPayoutError('attestation_expired'));
    renderPanel();
    await waitFor(() => expect(withdrawButton()).toBeEnabled());
    fireEvent.click(withdrawButton());
    expect(await screen.findByText(t.errorExpired)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: t.retryMint })).not.toBeInTheDocument();
  });

  it('再送できるのは引き出し元のアカウントだけ。別のアカウントでは元に戻すよう案内し、戻せば再送できる', async () => {
    s.mint.mockRejectedValueOnce(new Error('user rejected the request')).mockResolvedValueOnce(TX);
    const view = renderPanel();
    await waitFor(() => expect(withdrawButton()).toBeEnabled());
    fireEvent.click(withdrawButton());
    expect(await screen.findByText(t.errorMintNotSent, { exact: false })).toBeInTheDocument();

    s.address = B;
    view.rerenderPanel();
    expect(await screen.findByText(t.switchBack.replace('{address}', '0x52d4…cA81'), { exact: false })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: t.retryMint })).not.toBeInTheDocument();
    expect(withdrawButton()).toBeDisabled();

    s.address = A;
    view.rerenderPanel();
    fireEvent.click(await screen.findByRole('button', { name: t.retryMint }));
    expect(await screen.findByText(t.done.replace('{amount}', '0.027'), { exact: false })).toBeInTheDocument();
    expect(s.mint.mock.calls[1]![0]).toBe(pending);
  });

  it('署名・attestation を console に出さない', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) => vi.spyOn(console, level));
    s.mint.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(TX);
    renderPanel();
    await waitFor(() => expect(withdrawButton()).toBeEnabled());
    fireEvent.click(withdrawButton());
    fireEvent.click(await screen.findByRole('button', { name: t.retryMint }));
    await screen.findByText(t.done.replace('{amount}', '0.027'), { exact: false });
    const logged = spies.flatMap((spy) => spy.mock.calls.flat().map((arg) => String(arg))).join('\n');
    expect(logged).not.toContain(SECRET_SIG.slice(2, 40));
    expect(logged).not.toContain(SECRET_ATT.slice(2, 40));
  });
});
