import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      networkEnv: 'testnet',
      enableStoreGasWallet: true,
      feeReceiver: '0x428483FbA62eDCef1E3a100d3799F6d71759c560',
    },
  };
});
vi.mock('@/lib/relay/forwarderConfig', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/relay/forwarderConfig')>()),
  jpycForwarderFor: () => '0x752B7AaD0089286EB7b553d84D05233d80c9FCB4',
}));

import {
  STORE_DEVICE_SALE_SNAPSHOT_KEY,
  STORE_DEVICE_SALE_SNAPSHOT_MAX,
  readStoreDeviceSaleSnapshot,
  saveStoreDeviceSaleSnapshot,
} from '@/lib/storeDeviceSaleSnapshot';
import { buildCheckoutPath, parseCheckoutParams, type CheckoutParams } from '@/lib/url';

const SHOP = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const HS = 'AbCdEfGhIjKlMnOpQrStUv';
const id = (n: number) => `handoff-${String(n).padStart(14, '0')}`;
const checkout: CheckoutParams = {
  to: SHOP,
  token: 'jpyc',
  chain: 'polygon',
  gas: 'merchant',
  mode: 'gasless',
  items: [{ name: 'コーヒー', qty: 2, price: '500', taxRate: 8, taxCategory: 'taxable_8', memo: '氷なし' }],
  receiptNo: 'R-0012',
  storeName: 'OpenPay Cafe',
  discount: '20',
  submit: 'store',
};
const stored = () =>
  JSON.parse(window.sessionStorage.getItem(STORE_DEVICE_SALE_SNAPSHOT_KEY) ?? '[]') as {
    id: string;
    path: string;
    at: number;
  }[];

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false });
  vi.setSystemTime(new Date('2026-11-16T03:00:00Z'));
  window.sessionStorage.clear();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('お店の端末で送る の会計の写し (sessionStorage・受け渡しの id ごと)', () => {
  it('QR に載せるのと同じ path を、受け渡しの id で写す (お客様の画面と同じ parser で読める)', () => {
    saveStoreDeviceSaleSnapshot(HS, checkout);
    const path = readStoreDeviceSaleSnapshot(HS);
    expect(path).toBe(buildCheckoutPath({ ...checkout, handoffId: HS }));
    const parsed = parseCheckoutParams(new URLSearchParams(path!.slice(path!.indexOf('?') + 1)));
    expect(parsed.ok && parsed.params).toMatchObject({
      to: SHOP,
      items: checkout.items,
      receiptNo: 'R-0012',
      storeName: 'OpenPay Cafe',
      discount: '20',
      submit: 'store',
      handoffId: HS,
    });
  });

  it('写しに入るのは受け渡しの id・path・時刻だけ (読み取りトークン・鍵・署名の欄は無い)', () => {
    saveStoreDeviceSaleSnapshot(HS, checkout);
    expect(stored()).toHaveLength(1);
    expect(Object.keys(stored()[0]).sort()).toEqual(['at', 'id', 'path']);
    expect(stored()[0].path.startsWith('/checkout?')).toBe(true);
  });

  it('別の受け渡しの写しは別々に持つ・無い id は null', () => {
    saveStoreDeviceSaleSnapshot(id(1), checkout);
    saveStoreDeviceSaleSnapshot(id(2), { ...checkout, receiptNo: 'R-0013' });
    expect(readStoreDeviceSaleSnapshot(id(1))).toContain('R-0012');
    expect(readStoreDeviceSaleSnapshot(id(2))).toContain('R-0013');
    expect(readStoreDeviceSaleSnapshot(id(3))).toBeNull();
  });

  it(`上限は ${STORE_DEVICE_SALE_SNAPSHOT_MAX} 件: 超えたら古い写しから捨てる`, () => {
    for (let n = 1; n <= STORE_DEVICE_SALE_SNAPSHOT_MAX + 3; n += 1) {
      saveStoreDeviceSaleSnapshot(id(n), checkout);
      vi.advanceTimersByTime(1_000);
    }
    expect(stored()).toHaveLength(STORE_DEVICE_SALE_SNAPSHOT_MAX);
    expect(readStoreDeviceSaleSnapshot(id(3))).toBeNull();
    expect(readStoreDeviceSaleSnapshot(id(4))).not.toBeNull();
    expect(readStoreDeviceSaleSnapshot(id(STORE_DEVICE_SALE_SNAPSHOT_MAX + 3))).not.toBeNull();
  });

  it('60 分を過ぎた写しは、次に写すときに捨てる (59 分の写しは残す)', () => {
    saveStoreDeviceSaleSnapshot(id(1), checkout);
    vi.advanceTimersByTime(60_000);
    saveStoreDeviceSaleSnapshot(id(2), checkout);
    vi.advanceTimersByTime(59 * 60_000);
    saveStoreDeviceSaleSnapshot(id(3), checkout);
    expect(stored().map((s) => s.id)).toEqual([id(2), id(3)]);
  });

  it('次の保存が無くても、読むときに 60 分の期限が効く (直前は使う・ちょうど / 過ぎたら使わない = 掃除と同じ境界)', () => {
    const at = Date.now();
    saveStoreDeviceSaleSnapshot(HS, checkout);
    const path = buildCheckoutPath({ ...checkout, handoffId: HS });
    vi.setSystemTime(at + 60 * 60_000 - 1);
    expect(readStoreDeviceSaleSnapshot(HS)).toBe(path);
    vi.setSystemTime(at + 60 * 60_000);
    expect(readStoreDeviceSaleSnapshot(HS)).toBeNull();
    vi.setSystemTime(at + 60 * 60_000 + 1);
    expect(readStoreDeviceSaleSnapshot(HS)).toBeNull();
    // 読み取りは写しを消さない (保存の掃除は次の保存のとき)
    expect(stored().map((s) => s.id)).toEqual([HS]);
  });

  it('端末の時計が戻った (写しの時刻が今より先) ときは使わない・保存した時刻ちょうどは使う', () => {
    const at = Date.now();
    saveStoreDeviceSaleSnapshot(HS, checkout);
    expect(readStoreDeviceSaleSnapshot(HS)).toBe(buildCheckoutPath({ ...checkout, handoffId: HS }));
    vi.setSystemTime(at - 1);
    expect(readStoreDeviceSaleSnapshot(HS)).toBeNull();
    vi.setSystemTime(at - 10 * 60_000);
    expect(readStoreDeviceSaleSnapshot(HS)).toBeNull();
  });

  it('保存してある値が読めない形でも落ちない (写しなしとして読み、次の保存で置き換える)', () => {
    window.sessionStorage.setItem(STORE_DEVICE_SALE_SNAPSHOT_KEY, '{broken');
    expect(readStoreDeviceSaleSnapshot(HS)).toBeNull();
    saveStoreDeviceSaleSnapshot(HS, checkout);
    expect(readStoreDeviceSaleSnapshot(HS)).not.toBeNull();
    window.sessionStorage.setItem(STORE_DEVICE_SALE_SNAPSHOT_KEY, JSON.stringify({ id: HS }));
    expect(readStoreDeviceSaleSnapshot(HS)).toBeNull();
    window.sessionStorage.setItem(STORE_DEVICE_SALE_SNAPSHOT_KEY, JSON.stringify([{ id: HS, path: 1, at: 1 }, null]));
    expect(readStoreDeviceSaleSnapshot(HS)).toBeNull();
  });

  it('sessionStorage が使えない (保存・読み取りが throw する) 端末でも throw しない (写しなし)', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    expect(() => saveStoreDeviceSaleSnapshot(HS, checkout)).not.toThrow();
    expect(readStoreDeviceSaleSnapshot(HS)).toBeNull();
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    expect(() => saveStoreDeviceSaleSnapshot(HS, checkout)).not.toThrow();
    expect(readStoreDeviceSaleSnapshot(HS)).toBeNull();
  });
});
