// lib/url/billKeyQr.ts: お店の側が bill key を作り、画面の QR の URL に足す。
// 払う側が読む所 (lib/url/billKey.ts) と、受ける形 (lib/relay/billKeySalt.ts) に合うことを確かめる。

import { describe, it, expect, vi, afterEach } from 'vitest';
import { billKeySalt } from '@/lib/relay/billKeySalt';
import { readBillKeyParam } from '@/lib/url/billKey';
import { newBillKey, withBillKey } from '@/lib/url/billKeyQr';
import { buildCheckoutUrl, buildPayUrl, parseCheckoutParams, parsePayParams } from '@/lib/url';

const SHOP = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

afterEach(() => {
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});

describe('newBillKey', () => {
  it('64 bit の乱数 (crypto.getRandomValues に 8 byte) を、base64url の 11 字にする', () => {
    const random = vi.spyOn(globalThis.crypto, 'getRandomValues');
    const billKey = newBillKey();
    expect(billKey).toMatch(/^[A-Za-z0-9_-]{11}$/);
    expect(random).toHaveBeenCalledTimes(1);
    expect((random.mock.calls[0][0] as Uint8Array).byteLength).toBe(8);
  });

  it('乱数の byte をそのまま写す (+ / は - _ に・padding なし)', () => {
    const fill = (bytes: number[]) =>
      vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(<T extends ArrayBufferView | null>(array: T): T => {
        if (array) new Uint8Array(array.buffer, array.byteOffset, array.byteLength).set(bytes);
        return array;
      });
    fill(new Array(8).fill(0));
    expect(newBillKey()).toBe('AAAAAAAAAAA');
    vi.restoreAllMocks();
    // "foobarba" の 8 byte (tests/lib/billKeySalt.test.ts の golden vector の bill key)。
    fill([...Buffer.from('foobarba')]);
    expect(newBillKey()).toBe('Zm9vYmFyYmE');
    vi.restoreAllMocks();
    // 0xfb 0xff … は base64 で + と / を含む並び (base64url では - と _)。
    const bytes = [0xfb, 0xff, 0xbf, 0xfb, 0xff, 0xbf, 0xfb, 0xff];
    fill(bytes);
    const billKey = newBillKey();
    expect(billKey).toBe(Buffer.from(bytes).toString('base64url'));
    expect(billKey).toBe('-_-_-_-_-_8');
    expect(billKey).toMatch(/[-_]/);
    expect(billKey).not.toMatch(/[+/=]/);
  });

  it('11 字目は、余りの 2 bit が 0 の 16 通りの字だけ (8 byte = 64 bit を 11 字 = 66 bit に入れた余り)', () => {
    const last = new Set<string>();
    for (let byte = 0; byte < 256; byte += 1) {
      vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(<T extends ArrayBufferView | null>(array: T): T => {
        if (array) new Uint8Array(array.buffer, array.byteOffset, array.byteLength).fill(byte);
        return array;
      });
      const billKey = newBillKey();
      vi.restoreAllMocks();
      expect(billKey).toHaveLength(11);
      expect(billKeySalt(billKey)).not.toBeNull();
      // 作った 11 字を 8 byte に戻すと、元の乱数と同じ (乱数の 64 bit を落としていない)。
      expect([...Buffer.from(billKey, 'base64url')]).toEqual(new Array(8).fill(byte));
      last.add(billKey[10]);
    }
    expect([...last].sort()).toEqual([...'AEIMQUYcgkosw048'].sort());
  });

  it('呼ぶたびに違う値で、どれも払う側が受ける形 (billKeySalt が null を返さない)', () => {
    const keys = Array.from({ length: 200 }, () => newBillKey());
    expect(new Set(keys).size).toBe(200);
    for (const billKey of keys) {
      expect(billKey).toHaveLength(11);
      expect(billKeySalt(billKey)).toMatch(/^0x[0-9a-f]{64}$/);
    }
  });
});

describe('withBillKey', () => {
  const BK = 'Zm9vYmFyYmE';

  it('元の URL の末尾に &bk=<bill key> を足す。元の param は 1 字も変えない', () => {
    const pay = buildPayUrl('https://shop.test', {
      to: SHOP, token: 'jpyc', chain: 'polygon', gas: 'merchant', mode: 'gasless', amount: '1000', storeName: '神田 & Coffee',
    });
    expect(withBillKey(pay, BK)).toBe(`${pay}&bk=${BK}`);
    const checkout = buildCheckoutUrl('https://shop.test', {
      to: SHOP, token: 'jpyc', chain: 'polygon', gas: 'merchant', mode: 'gasless', items: [{ name: 'コーヒー', qty: 2, price: '500' }],
    });
    expect(withBillKey(checkout, BK)).toBe(`${checkout}&bk=${BK}`);
  });

  it('足した URL を払う側が開くと、readBillKeyParam が同じ bill key を読み、会計の中身 (parser の結果) は変わらない', () => {
    const pay = buildPayUrl('https://shop.test', {
      to: SHOP, token: 'jpyc', chain: 'polygon', gas: 'merchant', mode: 'gasless', amount: '1000', receiptNo: 'R-1',
    });
    const withKey = new URL(withBillKey(pay, BK));
    window.history.replaceState(null, '', `/ja/pay${withKey.search}`);
    expect(readBillKeyParam()).toBe(BK);
    expect(parsePayParams(withKey.searchParams)).toEqual(parsePayParams(new URL(pay).searchParams));

    const checkout = buildCheckoutUrl('https://shop.test', {
      to: SHOP, token: 'jpyc', chain: 'polygon', gas: 'merchant', mode: 'gasless', items: [{ name: 'コーヒー', qty: 2, price: '500' }],
    });
    const checkoutWithKey = new URL(withBillKey(checkout, BK));
    window.history.replaceState(null, '', `/ja/checkout${checkoutWithKey.search}`);
    expect(readBillKeyParam()).toBe(BK);
    expect(parseCheckoutParams(checkoutWithKey.searchParams)).toEqual(parseCheckoutParams(new URL(checkout).searchParams));
  });

  it('作った bill key は、URL に載せても形が変わらない (URL で読み替わる字を含まない)', () => {
    for (let i = 0; i < 50; i += 1) {
      const billKey = newBillKey();
      const url = new URL(withBillKey(`https://shop.test/pay?to=${SHOP}&token=jpyc&amount=1`, billKey));
      expect(url.searchParams.get('bk')).toBe(billKey);
    }
  });
});
