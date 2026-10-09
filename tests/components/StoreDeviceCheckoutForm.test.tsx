import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import { renderWithIntl as render } from '../_helpers/i18n';

const hold = vi.hoisted(() => ({
  status: { phase: 'idle' } as Record<string, unknown>,
  pay: vi.fn(),
  checkNow: vi.fn(),
  acknowledge: vi.fn(),
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
  useStoreDevicePayment: () => ({
    status: hold.status,
    pay: hold.pay,
    checkNow: hold.checkNow,
    acknowledge: hold.acknowledge,
  }),
}));
vi.mock('@/hooks/useErc20BalanceAndChain', () => ({ useErc20BalanceAndChain: () => hold.balance }));
vi.mock('@/hooks/usePaymentHistory', () => ({
  usePaymentHistory: (...args: unknown[]) => {
    hold.history.push(args);
  },
}));

import { StoreDeviceCheckoutForm } from '@/components/StoreDeviceCheckoutForm';
import type { CheckoutParams } from '@/lib/url';

const INTENT = {
  v: 3,
  forwarder: '0x752B7AaD0089286EB7b553d84D05233d80c9FCB4',
  feeReceiver: '0x428483FbA62eDCef1E3a100d3799F6d71759c560',
  handoffId: 'AbCdEfGhIjKlMnOpQrStUv',
  chainId: 80002,
  from: '0x0000000000000000000000000000000000000aaa',
  merchant: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  merchantValue: (1100n * 10n ** 18n).toString(),
  intentSalt: `0x${'11'.repeat(32)}`,
  validBefore: Math.floor(Date.now() / 1000) + 100,
  nonce: `0x${'22'.repeat(32)}`,
  snapshot: { storeName: 'OpenPay Cafe', items: [{ name: 'カフェラテ', qty: 2, price: '550' }] },
};

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
    hold.acknowledge.mockReset();
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
    expect(hold.pay).toHaveBeenCalledWith(
      expect.objectContaining({
        merchant: params.to,
        bill: 1100n * 10n ** 18n,
        snapshot: expect.objectContaining({ storeName: 'OpenPay Cafe', items: params.items }),
      }),
    );
  });

  it('レジの値引き: 小計 → 値引き を出し、署名する請求額は値引き後 (1100 − 100 = 1000)・控え用に値引きも固定', () => {
    render(<StoreDeviceCheckoutForm params={{ ...params, discount: '100' }} />);
    expect(screen.getByText('値引き')).toBeTruthy();
    expect(screen.getByText(/−100/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /1000 JPYC を支払う|1,000 JPYC を支払う/ }));
    expect(hold.pay).toHaveBeenCalledWith(
      expect.objectContaining({
        bill: 1000n * 10n ** 18n,
        snapshot: expect.objectContaining({ items: params.items, discount: '100' }),
      }),
    );
  });

  it('残高が請求額 + 1 wei に足りなければ押せず、通常の決済を案内する', () => {
    hold.balance = { balance: 1100n * 10n ** 18n, insufficientBalance: true, wrongChain: false };
    render(<StoreDeviceCheckoutForm params={params} />);
    expect(screen.getByRole('alert')).toHaveTextContent(/1 wei が必要です/);
    expect(screen.getByRole('button', { name: /を支払う/ })).toBeDisabled();
  });

  it('送信待ちは状態だけを読み上げ (秒数は読み上げ領域の外)、押せない', () => {
    hold.status = { phase: 'waiting', intent: INTENT, otherCheckout: false, txHint: null, confirming: false, autoStopped: false };
    render(<StoreDeviceCheckoutForm params={params} />);
    expect(screen.getByRole('status')).toHaveTextContent('お店の端末の送信と確認を待っています…');
    expect(screen.getByRole('status')).not.toHaveTextContent(/秒/);
    expect(screen.getByText(/署名の期限まで残り約/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /を支払う/ })).toBeDisabled();
  });

  it('別の会計の未解決の支払いを確認中なら、その旨を出して押せない', () => {
    hold.status = { phase: 'waiting', intent: { ...INTENT, handoffId: 'ZZZZZZZZZZZZZZZZZZZZZZ' }, otherCheckout: true, txHint: null, confirming: false, autoStopped: false };
    render(<StoreDeviceCheckoutForm params={params} />);
    expect(screen.getByRole('status')).toHaveTextContent(/前のお支払いの結果を確認しています/);
    expect(screen.getByText(/前のお支払い: OpenPay Cafe/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /を支払う/ })).toBeDisabled();
  });

  it('枠が埋まっている (session_taken) ときは押せない', () => {
    hold.status = { phase: 'error', reason: 'session_taken', blocking: true };
    render(<StoreDeviceCheckoutForm params={params} />);
    expect(screen.getByRole('button', { name: /を支払う/ })).toBeDisabled();
  });

  it('完了: 支払いボタンを消し、控えを出す', () => {
    hold.status = { phase: 'success', txHash: `0x${'ab'.repeat(32)}`, intent: INTENT };
    render(<StoreDeviceCheckoutForm params={params} />);
    expect(screen.getByText('お支払いが完了しました')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /を支払う/ })).toBeNull();
    expect(screen.getByText(`receipt:0x${'ab'.repeat(32)}`)).toBeTruthy();
  });

  it('期限切れ (未使用を確認済み) は「お支払いは行われていません」・理由つきのエラーも出す', () => {
    hold.status = { phase: 'expired', intent: INTENT };
    const { unmount } = render(<StoreDeviceCheckoutForm params={params} />);
    expect(screen.getByRole('alert')).toHaveTextContent(/お支払いは行われていません/);
    unmount();
    hold.status = { phase: 'error', reason: 'session_taken', blocking: true };
    render(<StoreDeviceCheckoutForm params={params} />);
    expect(screen.getByRole('alert')).toHaveTextContent(/すでに別のお支払いが進んでいます/);
  });

  it('履歴と控えは署名した時点の値で作る (店の受取 = 請求額・利用料欄 = 1 wei・ガスは店舗負担)', () => {
    hold.status = { phase: 'success', txHash: `0x${'ab'.repeat(32)}`, intent: INTENT };
    // 署名後に URL やウォレットが変わっても、記録は署名時点の値のまま
    render(<StoreDeviceCheckoutForm params={{ ...params, storeName: 'Changed', items: [{ name: 'x', qty: 9, price: '1' }] }} />);
    const [ctx, gasless] = hold.history.at(-1) as [Record<string, unknown>, Record<string, unknown>];
    expect(ctx).toMatchObject({
      merchantAmount: 1100n * 10n ** 18n,
      feeAmount: 1n,
      saleAmount: 1100n * 10n ** 18n,
      payMode: 'gasless',
      gasMode: 'merchant',
      customer: INTENT.from,
      receiptMerchantName: 'OpenPay Cafe',
      productName: 'カフェラテ',
    });
    expect(gasless).toMatchObject({
      data: { txHash: `0x${'ab'.repeat(32)}`, success: true },
      variables: { merchantAmount: 1100n * 10n ** 18n, feeAmount: 1n, saleAmount: 1100n * 10n ** 18n },
    });
  });

  it('描き直しても履歴に渡すデータは同じもの (同じ支払いを二重に記録しない)', () => {
    hold.status = { phase: 'success', txHash: `0x${'ab'.repeat(32)}`, intent: INTENT };
    const { rerender } = render(<StoreDeviceCheckoutForm params={params} />);
    const first = (hold.history.at(-1) as unknown[])[1] as { data: unknown };
    rerender(<StoreDeviceCheckoutForm params={params} />);
    const second = (hold.history.at(-1) as unknown[])[1] as { data: unknown };
    expect(second).toBe(first);
  });

  it('確認中は「いま確認する」と取引/ウォレットを見るリンクを出し、確定待ちの文言も出せる', () => {
    hold.status = { phase: 'waiting', intent: INTENT, otherCheckout: false, txHint: `0x${'ab'.repeat(32)}`, confirming: true, autoStopped: true };
    render(<StoreDeviceCheckoutForm params={params} />);
    expect(screen.getByRole('status')).toHaveTextContent(/確定を待っています/);
    expect(screen.getByText(/自動の確認を止めました/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'いま確認する' }));
    expect(hold.checkNow).toHaveBeenCalled();
    expect(screen.getByRole('link', { name: '取引を見る' })).toBeTruthy();
  });

  it('確認中は残高不足でも「通常の決済を頼んで」を出さない (元の署名が成立しうるため)', () => {
    hold.status = { phase: 'waiting', intent: INTENT, otherCheckout: false, txHint: null, confirming: false, autoStopped: false };
    hold.balance = { balance: 0n, insufficientBalance: true, wrongChain: false };
    render(<StoreDeviceCheckoutForm params={params} />);
    expect(screen.queryByText(/通常の決済を頼んでください/)).toBeNull();
  });

  it('結果を確かめられない (used_unresolved) はウォレットでの確認を案内し、支払い済み・未払いを言わない', () => {
    hold.status = { phase: 'used_unresolved', intent: INTENT, otherCheckout: false };
    render(<StoreDeviceCheckoutForm params={params} />);
    expect(screen.getByRole('alert')).toHaveTextContent(/こちらでは確かめられませんでした/);
    expect(screen.queryByText('お支払いが完了しました')).toBeNull();
    expect(screen.queryByText(/お支払いは行われていません/)).toBeNull();
    // 確かめるまで新しい支払いは始めさせない (支払いボタンを出さない)
    expect(screen.queryByRole('button', { name: /を支払う/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'ウォレットで確かめました' }));
    expect(hold.acknowledge).toHaveBeenCalled();
  });

  it('「確かめました」で記録を消せなかったら、成立していないことを確かめてから店員に伝えるよう案内する (通常の決済を無条件に勧めない)', () => {
    hold.status = { phase: 'used_unresolved', intent: INTENT, otherCheckout: false, ackFailed: true };
    render(<StoreDeviceCheckoutForm params={params} />);
    expect(screen.getByRole('alert')).toHaveTextContent(/この端末の記録を消せなかったため/);
    expect(screen.getByRole('alert')).toHaveTextContent(/成立していないことを確かめてから/);
    expect(screen.queryByText(/通常の決済を頼んでください/)).toBeNull();
  });

  it('前の会計の結果不明は、前の会計の店名・金額を添えて案内する', () => {
    hold.status = {
      phase: 'used_unresolved',
      intent: { ...INTENT, snapshot: { storeName: 'Prev Shop', items: [] } },
      otherCheckout: true,
    };
    render(<StoreDeviceCheckoutForm params={params} />);
    expect(screen.getByRole('alert')).toHaveTextContent(/前のお支払い: Prev Shop/);
    expect(screen.queryByRole('button', { name: /を支払う/ })).toBeNull();
  });

  it('前の会計の結論は前の会計の店名・金額で出し、この会計は払える', () => {
    hold.status = { phase: 'previous', outcome: 'success', intent: { ...INTENT, snapshot: { storeName: 'Prev Shop', items: [] } }, txHash: `0x${'ab'.repeat(32)}` };
    render(<StoreDeviceCheckoutForm params={params} />);
    expect(screen.getByRole('status')).toHaveTextContent(/前のお支払い（Prev Shop/);
    expect(screen.queryByText('お支払いが完了しました')).toBeNull();
    expect(screen.getByRole('button', { name: /を支払う/ })).not.toBeDisabled();
  });
});
