// 受け付けるチェーンが複数の注文リンク: 払う前にお客様がチェーンを選ぶ。選ぶと URL に chain を足して開き直す。
// このタブで前に払った記録が、どのチェーンにでもあれば先に出す (別のチェーンで二重に払わせない)。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import type { Address } from 'viem';

const replace = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace, push: vi.fn() }) }));
vi.mock('wagmi', () => ({
  useSignMessage: () => ({ signMessageAsync: vi.fn(), isPending: false }),
  useAccount: () => ({ address: undefined }),
  usePublicClient: () => undefined,
}));

import { renderWithIntl as render } from '../_helpers/i18n';
import { CheckoutChainPicker } from '@/components/checkout/CheckoutChainPicker';
import { chainForSlug } from '@/lib/chains';
import { rememberOrderPayment } from '@/lib/orderConfirmation';
import { orderPaymentContextKey } from '@/lib/orderPaidLookup';
import type { CheckoutParams } from '@/lib/url/checkout';

const params: CheckoutParams = {
  to: '0x52d4901142e2B5680027da5EB47C86CB02a3cA81' as Address,
  token: 'jpyc',
  chain: 'polygon',
  chains: ['polygon', 'kaia'],
  pickChain: true,
  gas: 'customer',
  items: [{ name: 'マグカップ', qty: 2, price: '1750' }],
  storeName: 'OpenPay 工房',
  ship: 'ask',
  contact: { kind: 'line', id: '@openpay' },
};

beforeEach(() => {
  window.history.replaceState({}, '', '/ja/checkout?to=0x52d4901142e2B5680027da5EB47C86CB02a3cA81&token=jpyc&chains=polygon%2Ckaia');
});
afterEach(() => {
  replace.mockReset();
  window.sessionStorage.clear();
});

describe('CheckoutChainPicker', () => {
  it('注文の内容と合計・送り先を出し、受け付けるチェーンから選ばせる', () => {
    render(<CheckoutChainPicker params={params} />);
    expect(screen.getByText('OpenPay 工房')).toBeInTheDocument();
    expect(screen.getByText('マグカップ')).toBeInTheDocument();
    expect(screen.getByText('3500 JPYC')).toBeInTheDocument();
    expect(screen.getByText(/お名前とお届け先をお店 \(LINE @openpay\) へ送ります/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'お支払いのチェーンを選んでください' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /^JPYC \(/ })).toHaveLength(2);
  });

  it('選ぶと、ほかのパラメーターはそのまま URL に chain を足して開き直す', () => {
    render(<CheckoutChainPicker params={params} />);
    fireEvent.click(screen.getByRole('button', { name: `JPYC (${chainForSlug('kaia').name})` }));
    expect(replace).toHaveBeenCalledTimes(1);
    const [url, options] = replace.mock.calls[0];
    const search = new URLSearchParams(String(url).replace(/^\?/, ''));
    expect(search.get('chain')).toBe('kaia');
    expect(search.get('chains')).toBe('polygon,kaia');
    expect(search.get('to')).toBe(params.to);
    expect(options).toEqual({ scroll: false });
  });

  it('このタブでどれかのチェーンで払った記録があれば、先に「注文を送る」を出し、チェーンを選ばせない', async () => {
    const tx = `0x${'ab'.repeat(32)}`;
    rememberOrderPayment(orderPaymentContextKey(params, 'kaia'), { txHash: tx, paidAt: Date.now() });
    render(<CheckoutChainPicker params={params} />);
    expect(await screen.findByText('このタブでのお支払いは済んでいます')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '注文を送る' })).toBeInTheDocument();
    expect(screen.queryAllByRole('button', { name: /^JPYC \(/ })).toHaveLength(0);
    // 何度でも使えるリンクは、新しい注文としてなら選べる
    fireEvent.click(screen.getByRole('button', { name: '新しい注文として払う' }));
    expect(screen.getAllByRole('button', { name: /^JPYC \(/ })).toHaveLength(2);
  });

  it('番号つきの注文を払った記録があれば、別の注文として払う道も出さない', async () => {
    const numbered: CheckoutParams = { ...params, orderId: 'A-001', ship: undefined };
    rememberOrderPayment(orderPaymentContextKey(numbered, 'polygon'), { txHash: `0x${'cd'.repeat(32)}`, paidAt: Date.now() });
    render(<CheckoutChainPicker params={numbered} />);
    expect(await screen.findByText('このタブでのお支払いは済んでいます')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '新しい注文として払う' })).toBeNull();
    expect(screen.queryAllByRole('button', { name: /^JPYC \(/ })).toHaveLength(0);
  });
});
