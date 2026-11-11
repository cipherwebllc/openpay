import { beforeEach, describe, expect, it, vi } from 'vitest';
import { canonicalOrder, orderBindSalt, orderDigest } from '@/lib/orderBind';
import {
  orderDeliveryKey,
  resolveOrderDelivery,
  saveOrderDelivery,
  saveOrderDeliveryVerified,
  type OrderDelivery,
} from '@/lib/orderDelivery';

// 第 10 回レビュー H-R (Codex の MUST・SHOULD): 束縛した注文を送る前 (初回の POST・IP 制限の後の再送) に、自分の slot を
// 書いて読み戻す。saveOrderDelivery は setItem が投げなければ true を返すので、書き込みを黙って捨てる storage では slot なしで
// 送れていた。ほかの呼び出し (確定後の更新・terminal) が使う saveOrderDelivery の戻り値の意味は変えない。
// 差し替えるのは Storage の境界だけ。

const order = canonicalOrder({ chainId: 80002, tokenAddress: '0x0000000000000000000000000000000000000abc', merchant: '0x1111111111111111111111111111111111111111', handle: 'alice', orderId: 'id', items: [{ name: 'Tea', qty: 1, price: '100' }], statusToken: 's'.repeat(43) });
const secret = `0x${'12'.repeat(32)}` as const;
const record: OrderDelivery = {
  version: 1, order, bind: { v: 1, secret, validAfter: '0', validBefore: '1800000000' },
  intent: { chainId: 80002, from: '0x2222222222222222222222222222222222222222', merchant: order.merchant, merchantValue: '100000000000000000000', feeValue: '0', nonce: orderBindSalt(orderDigest(order), secret), validBefore: '1800000000', routeKind: 'free', issuedAt: 1700000000000 },
  forwarder: null, state: 'signed',
};
const key = orderDeliveryKey(record);

function accessDenied(): never {
  throw new DOMException('Access is denied for this document.', 'SecurityError');
}

// 書き込みの後の最初の読み戻しだけを投げさせる (saveOrderDelivery の書く前の読みは通る)。
function failReadBackOnce(): void {
  const realSet = Storage.prototype.setItem;
  const realGet = Storage.prototype.getItem;
  let wrote = false;
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, k: string, value: string) {
    if (k === key) wrote = true;
    realSet.call(this, k, value);
  });
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, k: string) {
    if (k === key && wrote) {
      wrote = false;
      return accessDenied();
    }
    return realGet.call(this, k);
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
  sessionStorage.clear();
});

describe('saveOrderDeliveryVerified (束縛した注文を送る前の slot の保存と読み戻し)', () => {
  it('書けて読み戻せる端末では true で、saveOrderDelivery と同じ中身を slot に残す', () => {
    expect(saveOrderDeliveryVerified(record)).toBe(true);
    expect(JSON.parse(sessionStorage.getItem(key)!)).toEqual(record);
  });

  // Codex の再現 (MUST): 書き込みを黙って捨てる storage。saveOrderDelivery は今までどおり true (意味は変えない)。
  it('書き込みを黙って捨てる端末では false (saveOrderDelivery は今までどおり true のまま)', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => undefined);
    expect(saveOrderDelivery(record)).toBe(true);
    expect(saveOrderDeliveryVerified(record)).toBe(false);
    vi.restoreAllMocks();
    expect(sessionStorage.getItem(key)).toBeNull();
  });

  it('書き込みが投げる端末・slot を読めない端末では false (throw しない)', () => {
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(accessDenied);
    expect(saveOrderDeliveryVerified(record)).toBe(false);
    write.mockRestore();
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(accessDenied);
    expect(saveOrderDeliveryVerified(record)).toBe(false);
  });

  it('読み戻した記録が同じ authorization でも state が違う (書いた signed が読めない) ときは false', () => {
    // 同じ authorization の正しい形の notify-pending (parseRecord を通る) が返る端末。state の照合だけが false にする。
    const resolved = resolveOrderDelivery(record, `0x${'ab'.repeat(32)}`);
    const realGet = Storage.prototype.getItem;
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, k: string) {
      const raw = realGet.call(this, k);
      return k === key && raw ? JSON.stringify(resolved) : raw;
    });
    expect(saveOrderDeliveryVerified(record)).toBe(false);
  });

  // Codex の再現 (SHOULD): 書けたが読み戻しが投げた記録 (まだ送っていない) が slot に残ると、読めるようになった後に
  // 開き直した画面が「送信済みかもしれない」として塞ぐ。書く前の slot が空か同じ authorization だったので、消してよい。
  it('書けたが読み戻しが投げた → false で、この試みの slot を片づける', () => {
    failReadBackOnce();
    expect(saveOrderDeliveryVerified(record)).toBe(false);
    vi.restoreAllMocks();
    expect(sessionStorage.getItem(key)).toBeNull();
  });

  it('同じ authorization の記録が先にあった (IP 制限の後の再送) ときも、読み戻せなければ片づける', () => {
    expect(saveOrderDelivery(record)).toBe(true);
    failReadBackOnce();
    expect(saveOrderDeliveryVerified(record)).toBe(false);
    vi.restoreAllMocks();
    expect(sessionStorage.getItem(key)).toBeNull();
  });

  it('同じ slot に別の authorization の記録があったときは書かず、その記録も消さない', () => {
    const other: OrderDelivery = { ...record, intent: { ...record.intent, merchantValue: '200000000000000000000' } };
    expect(saveOrderDelivery(other)).toBe(true);
    expect(saveOrderDeliveryVerified(record)).toBe(false);
    expect(JSON.parse(sessionStorage.getItem(key)!)).toEqual(other);
  });

  it('片づけ (removeItem) が投げても false を返すだけ (throw しない)', () => {
    failReadBackOnce();
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(accessDenied);
    expect(saveOrderDeliveryVerified(record)).toBe(false);
  });
});
