import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import { renderWithIntl as render } from '../_helpers/i18n';

const hold = vi.hoisted(() => ({
  status: { phase: 'idle' } as Record<string, unknown>,
  pay: vi.fn(),
  balance: { balance: 10n ** 22n, insufficientBalance: false, wrongChain: false } as Record<string, unknown>,
  history: [] as unknown[][],
  connected: true,
}));
vi.mock('wagmi', () => ({
  useAccount: () => ({ address: hold.connected ? '0x0000000000000000000000000000000000000def' : undefined, isConnected: hold.connected }),
  useSwitchChain: () => ({ switchChain: vi.fn(), isPending: false }),
}));
vi.mock('@/components/ConnectButton', () => ({ ConnectButton: () => <div>connect</div> }));
vi.mock('@/components/PayerReceiptCompletion', () => ({
  PayerReceiptCompletion: ({ candidateIds }: { candidateIds: unknown[] }) => <div>receipt:{String(candidateIds[0])}</div>,
}));
vi.mock('@/hooks/useStoreDevicePayment', () => ({
  useStoreDevicePayment: () => ({ status: hold.status, pay: hold.pay, reset: vi.fn() }),
}));
vi.mock('@/hooks/useErc20BalanceAndChain', () => ({ useErc20BalanceAndChain: () => hold.balance }));
vi.mock('@/hooks/usePaymentHistory', () => ({
  usePaymentHistory: (...args: unknown[]) => {
    hold.history.push(args);
  },
}));

import { StoreDeviceCheckoutForm } from '@/components/StoreDeviceCheckoutForm';
import type { CheckoutParams } from '@/lib/url';

const params: CheckoutParams = {
  to: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  token: 'jpyc',
  chain: 'polygon',
  gas: 'customer',
  mode: 'gasless',
  items: [{ name: 'カフェラテ', qty: 2, price: '550' }],
  storeName: 'OpenPay Cafe',
  submit: 'store',
  handoffId: 'AbCdEfGhIjKlMnOpQrStUv',
};

describe('StoreDeviceCheckoutForm', () => {
  beforeEach(() => {
    hold.status = { phase: 'idle' };
    hold.pay.mockReset();
    hold.balance = { balance: 10n ** 22n, insufficientBalance: false, wrongChain: false };
    hold.history.length = 0;
    hold.connected = true;
  });

  it('明細・お支払い額・利用料 0 円 (仕組み上 1 wei) の説明を出し、支払いで署名を求める', () => {
    render(<StoreDeviceCheckoutForm params={params} />);
    expect(screen.getByText('OpenPay Cafe')).toBeTruthy();
    expect(screen.getByText('カフェラテ')).toBeTruthy();
    expect(screen.getByText(/OpenPay 利用料は 0 円です/)).toBeTruthy();
    expect(screen.getByText(/1 wei = 0.000000000000000001 JPYC/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /1100 JPYC を支払う|1,100 JPYC を支払う/ }));
    expect(hold.pay).toHaveBeenCalledWith({ merchant: params.to, bill: 1100n * 10n ** 18n });
  });

  it('残高が請求額 + 1 wei に足りなければ押せず、通常の決済を案内する', () => {
    hold.balance = { balance: 1100n * 10n ** 18n, insufficientBalance: true, wrongChain: false };
    render(<StoreDeviceCheckoutForm params={params} />);
    expect(screen.getByRole('alert')).toHaveTextContent(/1 wei が必要です/);
    expect(screen.getByRole('button', { name: /を支払う/ })).toBeDisabled();
  });

  it('送信待ちは残り時間を出し、押せない', () => {
    hold.status = { phase: 'waiting', validBefore: Math.floor(Date.now() / 1000) + 100 };
    render(<StoreDeviceCheckoutForm params={params} />);
    expect(screen.getByRole('status')).toHaveTextContent(/お店の端末が送信しています/);
    expect(screen.getByRole('button', { name: /を支払う/ })).toBeDisabled();
  });

  it('完了: 支払いボタンを消し、控えを出す', () => {
    hold.status = { phase: 'success', txHash: `0x${'ab'.repeat(32)}` };
    render(<StoreDeviceCheckoutForm params={params} />);
    expect(screen.getByText('お支払いが完了しました')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /を支払う/ })).toBeNull();
    expect(screen.getByText(`receipt:0x${'ab'.repeat(32)}`)).toBeTruthy();
  });

  it('期限切れ (未使用を確認済み) は「お支払いは行われていません」・理由つきのエラーも出す', () => {
    hold.status = { phase: 'expired' };
    const { unmount } = render(<StoreDeviceCheckoutForm params={params} />);
    expect(screen.getByRole('alert')).toHaveTextContent(/お支払いは行われていません/);
    unmount();
    hold.status = { phase: 'error', reason: 'session_taken' };
    render(<StoreDeviceCheckoutForm params={params} />);
    expect(screen.getByRole('alert')).toHaveTextContent(/すでに別のお支払いが進んでいます/);
  });

  it('履歴と控えには、店の受取 = 請求額・利用料欄 = 1 wei・お客様はガスなしで渡す', () => {
    hold.status = { phase: 'success', txHash: `0x${'ab'.repeat(32)}` };
    render(<StoreDeviceCheckoutForm params={params} />);
    const [ctx, gasless] = hold.history.at(-1) as [Record<string, unknown>, Record<string, unknown>];
    expect(ctx).toMatchObject({
      merchantAmount: 1100n * 10n ** 18n,
      feeAmount: 1n,
      saleAmount: 1100n * 10n ** 18n,
      payMode: 'gasless',
      receiptMerchantName: 'OpenPay Cafe',
    });
    expect(gasless).toMatchObject({
      data: { txHash: `0x${'ab'.repeat(32)}`, success: true },
      variables: { merchantAmount: 1100n * 10n ** 18n, feeAmount: 1n, saleAmount: 1100n * 10n ** 18n },
    });
  });
});
