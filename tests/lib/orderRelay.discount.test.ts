import { describe, it, expect } from 'vitest';
import { parseStoredOrder, serializeOrder, type StoredOrder } from '@/lib/orderRelay';

// 受注の店舗の値引き (plans/discount-common.md PR3)。KV は untrusted なので read 時も検証する。
const base: StoredOrder = {
  orderId: 'A1',
  items: [{ name: '牛丼', qty: 1, price: '500' }],
  table: null,
  amount: '450000000000000000000',
  txHash: `0x${'a'.repeat(64)}`,
  chainId: 137,
  from: '',
  ts: 1,
  fulfilled: false,
};

describe('StoredOrder.discount', () => {
  it('正の整数 (minor units) だけを保持し、状態更新の往復でも消えない', () => {
    const raw = serializeOrder({ ...base, discount: '50000000000000000000' });
    const parsed = parseStoredOrder(raw);
    expect(parsed?.discount).toBe('50000000000000000000');
    expect(parseStoredOrder(serializeOrder({ ...parsed!, fulfilled: true }))?.discount).toBe('50000000000000000000');
  });
  it.each(['0', '-1', '1.5', 'abc', 5])('不正 (%j) は落とす', (discount) => {
    const parsed = parseStoredOrder(JSON.stringify({ ...base, discount }));
    expect(parsed).not.toBeNull();
    expect(parsed && 'discount' in parsed).toBe(false);
  });
});
