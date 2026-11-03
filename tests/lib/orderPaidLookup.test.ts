// この会計をこのタブで払った記録を、リンクが受け付ける全部のチェーンで探す (別のチェーンを選んで二重に払わせない)。

import { afterEach, describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import { rememberOrderPayment } from '@/lib/orderConfirmation';
import { findRememberedOrderPayment, orderPaymentContextKey } from '@/lib/orderPaidLookup';
import type { CheckoutParams } from '@/lib/url/checkout';

const params: CheckoutParams = {
  to: '0x52d4901142e2B5680027da5EB47C86CB02a3cA81' as Address,
  token: 'jpyc',
  chain: 'polygon',
  chains: ['polygon', 'kaia'],
  gas: 'customer',
  items: [{ name: 'マグカップ', qty: 1, price: '3500' }],
  ship: 'ask',
};
const TX = `0x${'ab'.repeat(32)}`;

afterEach(() => window.sessionStorage.clear());

describe('findRememberedOrderPayment', () => {
  it('Polygon で払った記録は、Kaia を選んだ画面からも見つかる', () => {
    rememberOrderPayment(orderPaymentContextKey(params, 'polygon'), { txHash: TX, paidAt: 1_000 });
    expect(findRememberedOrderPayment({ ...params, chain: 'kaia' }, 2_000)).toEqual({
      chain: 'polygon',
      payment: { txHash: TX, paidAt: 1_000 },
    });
  });

  it('チェーンごとに鍵が違い、明細の違う会計の記録は使わない', () => {
    expect(orderPaymentContextKey(params, 'polygon')).not.toBe(orderPaymentContextKey(params, 'kaia'));
    rememberOrderPayment(orderPaymentContextKey(params, 'kaia'), { txHash: TX, paidAt: 1_000 });
    const other = { ...params, items: [{ name: 'マグカップ', qty: 2, price: '3500' }] };
    expect(findRememberedOrderPayment(other, 2_000)).toBeNull();
  });

  it('1 つのチェーンのリンクは今のチェーンだけを見る', () => {
    rememberOrderPayment(orderPaymentContextKey(params, 'kaia'), { txHash: TX, paidAt: 1_000 });
    const single = { ...params, chains: undefined };
    expect(findRememberedOrderPayment(single, 2_000)).toBeNull();
    expect(findRememberedOrderPayment({ ...single, chain: 'kaia' }, 2_000)).toMatchObject({ chain: 'kaia' });
  });
});
