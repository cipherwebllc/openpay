// 「接続中のウォレットから補充」: お店のウォレット (wagmi) から、ガス用ウォレットへガス代のトークンを送る。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import { renderWithIntl as render } from '../_helpers/i18n';

const w = vi.hoisted(() => ({
  account: { address: undefined as string | undefined, isConnected: false, chainId: undefined as number | undefined },
  balance: undefined as { value: bigint } | undefined,
  send: vi.fn(),
  switchChain: vi.fn(),
  reset: vi.fn(),
  txHash: undefined as string | undefined,
  isSending: false,
  sendError: null as Error | null,
  receipt: { isLoading: false, isSuccess: false, data: undefined as { status: 'success' | 'reverted' } | undefined },
  receiptArgs: [] as unknown[],
}));
vi.mock('wagmi', () => ({
  useAccount: () => w.account,
  useBalance: () => ({ data: w.balance }),
  useSwitchChain: () => ({ switchChain: w.switchChain, isPending: false }),
  useSendTransaction: () => ({
    sendTransaction: w.send,
    data: w.txHash,
    isPending: w.isSending,
    error: w.sendError,
    reset: w.reset,
  }),
  useWaitForTransactionReceipt: (args: unknown) => {
    w.receiptArgs.push(args);
    return w.receipt;
  },
}));

import { StoreGasWalletTopUp } from '@/components/StoreGasWalletTopUp';

const GAS = '0x0000000000000000000000000000000000000abc' as const;
const SHOP = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const TX = `0x${'ab'.repeat(32)}`;
const chainState = (id: number, name: string) => ({
  chainId: id,
  chain: { id, name } as never,
  active: true,
  balance: 0n,
  gasPrice: 1n,
  readFailed: false,
});
const AMOY = chainState(80002, 'Polygon Amoy');
const FUJI = chainState(43113, 'Avalanche Fuji');

function show(chains = [AMOY], onDone = vi.fn()) {
  render(<StoreGasWalletTopUp chains={chains} gasAddress={GAS} onDone={onDone} />);
  return onDone;
}

describe('StoreGasWalletTopUp', () => {
  beforeEach(() => {
    w.account = { address: SHOP, isConnected: true, chainId: 80002 };
    w.balance = { value: 10n ** 19n };
    w.send.mockReset();
    w.switchChain.mockReset();
    w.reset.mockReset();
    w.txHash = undefined;
    w.isSending = false;
    w.sendError = null;
    w.receipt = { isLoading: false, isSuccess: false, data: undefined };
    w.receiptArgs = [];
  });

  it('未接続なら、右上で接続するよう案内するだけ (送る欄は出さない)', () => {
    w.account = { address: undefined, isConnected: false, chainId: undefined };
    show();
    expect(screen.getByText(/右上の「接続」でお店のウォレットをつなぐと/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /を送る/ })).toBeNull();
  });

  it('既定額は目安の下限・ガス用ウォレットのアドレスへ、そのチェーンで送る', () => {
    show();
    expect(screen.getByRole('textbox', { name: '送る額 (POL)' })).toHaveValue('1');
    expect(screen.getByText(/目安 1〜2 POL・1 回 2 POL まで/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '1 POL を送る' }));
    expect(w.send).toHaveBeenCalledWith({ to: GAS, value: 10n ** 18n, chainId: 80002 });
  });

  it('1 回の上限 (目安の上限) を超える額・数字でない額は送らない', () => {
    show();
    const input = screen.getByRole('textbox', { name: '送る額 (POL)' });
    fireEvent.change(input, { target: { value: '2.5' } });
    expect(screen.getByRole('alert')).toHaveTextContent('1 回に送れるのは 2 POL までです');
    expect(screen.getByRole('button', { name: /を送る/ })).toBeDisabled();
    fireEvent.change(input, { target: { value: '1e3' } });
    expect(screen.getByRole('alert')).toHaveTextContent('送る額を数字で入れてください。');
    fireEvent.change(input, { target: { value: '0' } });
    expect(screen.getByRole('button', { name: /を送る/ })).toBeDisabled();
  });

  it('接続中のウォレットの残高が足りなければ送らない', () => {
    w.balance = { value: 10n ** 17n };
    show();
    expect(screen.getByRole('alert')).toHaveTextContent('接続中のウォレットの POL が足りません。');
    expect(screen.getByRole('button', { name: '1 POL を送る' })).toBeDisabled();
  });

  it('ウォレットのチェーンが違えば、切り替えボタンだけを出す', () => {
    w.account = { address: SHOP, isConnected: true, chainId: 1 };
    show();
    expect(screen.queryByRole('button', { name: /を送る/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'ウォレットを Polygon Amoy に切り替える' }));
    expect(w.switchChain).toHaveBeenCalledWith({ chainId: 80002 });
  });

  it('チェーンを選ぶと、そのチェーンの目安と通貨で送る', () => {
    w.account = { address: SHOP, isConnected: true, chainId: 43113 };
    show([AMOY, FUJI]);
    fireEvent.change(screen.getByRole('combobox', { name: '補充するチェーン' }), { target: { value: '43113' } });
    expect(screen.getByRole('textbox', { name: '送る額 (AVAX)' })).toHaveValue('0.05');
    fireEvent.click(screen.getByRole('button', { name: '0.05 AVAX を送る' }));
    expect(w.send).toHaveBeenCalledWith({ to: GAS, value: 5n * 10n ** 16n, chainId: 43113 });
  });

  it('確定したら残高を 1 回だけ読み直し、tx へのリンクを出す (確定待ちは送ったチェーンで見る)', () => {
    const onDone = vi.fn();
    const ui = () => <StoreGasWalletTopUp chains={[AMOY]} gasAddress={GAS} onDone={onDone} />;
    const r = render(ui());
    fireEvent.click(screen.getByRole('button', { name: '1 POL を送る' }));
    // ウォレットが tx を返し、確定待ち → 確定
    w.txHash = TX;
    w.receipt = { isLoading: true, isSuccess: false, data: undefined };
    r.rerender(ui());
    expect(screen.getByRole('status')).toHaveTextContent('送っています。確定を待っています…');
    expect(w.receiptArgs.at(-1)).toEqual({ hash: TX, chainId: 80002 });
    w.receipt = { isLoading: false, isSuccess: true, data: { status: 'success' } };
    r.rerender(ui());
    r.rerender(ui());
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status')).toHaveTextContent('補充しました。');
    expect(screen.getByRole('link', { name: '取引を見る' }).getAttribute('href')).toContain(TX);
  });

  it('ウォレットで断ったときは、失敗の表示を出さない', () => {
    const rejected = Object.assign(new Error('User rejected the request.'), { name: 'UserRejectedRequestError' });
    w.sendError = rejected;
    show();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
