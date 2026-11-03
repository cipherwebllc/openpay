// 確認の署名 (lib/orderConfirmation.ts): お客様とお店が同じ文を組み立てられるよう、署名する文をバイトで固定する。

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Address, Hex } from 'viem';
import {
  extractConfirmationSignature,
  orderConfirmationMessage,
  recoverableSignature,
  rememberedOrderPayment,
  rememberOrderPayment,
  storeConfirmationSignature,
  storedConfirmationSignature,
  subscribeConfirmationSignatures,
} from '@/lib/orderConfirmation';

const SHOP = '0x52d4901142e2b5680027da5eb47c86cb02a3ca81' as Address;
const TX = `0x${'AB'.repeat(32)}`;
const SIG = `0x${'12'.repeat(65)}` as Hex;

afterEach(() => {
  window.sessionStorage.clear();
  vi.restoreAllMocks();
});

describe('orderConfirmationMessage', () => {
  it('言語によらず同じ文 (\\n 区切り・末尾に改行なし・shop は checksum・tx は小文字)', () => {
    expect(orderConfirmationMessage({ chain: 'polygon', shop: SHOP, txHash: TX })).toBe(
      'OpenPay order confirmation\nchain: polygon\nshop: 0x52d4901142e2B5680027da5EB47C86CB02a3cA81\n' +
        `tx: 0x${'ab'.repeat(32)}`,
    );
  });
});

describe('extractConfirmationSignature', () => {
  it('届いた文から 64 バイト以上の署名を取り出し、Tx Hash (32 バイト) とは取り違えない', () => {
    const text = `注文します。\nTx Hash: 0x${'cd'.repeat(32)}\nhttps://polygonscan.com/tx/0x${'cd'.repeat(32)}\n確認の署名: ${SIG}`;
    expect(extractConfirmationSignature(text)).toBe(SIG);
    expect(extractConfirmationSignature(`Tx Hash: 0x${'cd'.repeat(32)}`)).toBeNull();
    // 改行が消えて前の文字とつながっても取れる
    expect(extractConfirmationSignature(`確認の署名:${SIG}`)).toBe(SIG);
    // 奇数桁や 16 進の続きは署名にしない
    expect(extractConfirmationSignature(`0x${'1'.repeat(127)}`)).toBeNull();
    // 短縮形 (EIP-2098・64 バイト) も取る
    expect(extractConfirmationSignature(`sig 0x${'56'.repeat(64)}`)).toBe(`0x${'56'.repeat(64)}`);
  });

  it('コントラクトのウォレットの長い署名も取る', () => {
    const long = `0x${'34'.repeat(200)}`;
    expect(extractConfirmationSignature(`sig ${long}`)).toBe(long);
  });
});

describe('recoverableSignature', () => {
  it('短縮形 (64 バイト) は 65 バイトに広げ、それ以外はそのまま', async () => {
    const { generatePrivateKey, privateKeyToAccount } = await import('viem/accounts');
    const { parseSignature, recoverMessageAddress, serializeCompactSignature, signatureToCompactSignature } = await import('viem');
    const account = privateKeyToAccount(generatePrivateKey());
    const full = await account.signMessage({ message: 'x' });
    const compact = serializeCompactSignature(signatureToCompactSignature(parseSignature(full)));
    expect(compact.length).toBe(2 + 128);
    expect(await recoverMessageAddress({ message: 'x', signature: recoverableSignature(compact) })).toBe(account.address);
    expect(recoverableSignature(full)).toBe(full);
    expect(recoverableSignature(SIG)).toBe(SIG);
  });
});

describe('署名をこのタブに残す', () => {
  const at = (txHash: string, shop: Address = SHOP) => ({ chain: 'polygon' as const, shop, txHash });

  it('残した署名をチェーン・お店・Tx Hash で読み直せ、変わったことを知らせる', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeConfirmationSignatures(listener);
    storeConfirmationSignature(at(TX), SIG);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(storedConfirmationSignature(at(TX.toLowerCase()))).toBe(SIG);
    expect(
      window.sessionStorage.getItem(`openpay:order-confirmation:v2:polygon:${SHOP}:${TX.toLowerCase()}`),
    ).toBe(SIG);
    // 別のお店・別のチェーンの同じ Tx Hash には使わない
    expect(storedConfirmationSignature(at(TX, '0x1111111111111111111111111111111111111111'))).toBeNull();
    expect(storedConfirmationSignature({ chain: 'kaia', shop: SHOP, txHash: TX })).toBeNull();
    unsubscribe();
    storeConfirmationSignature(at(`0x${'ef'.repeat(32)}`), SIG);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('前のページで残した署名を sessionStorage から読み、壊れた値は使わない', () => {
    const other = `0x${'99'.repeat(32)}`;
    window.sessionStorage.setItem(`openpay:order-confirmation:v2:polygon:${SHOP}:${other}`, SIG);
    expect(storedConfirmationSignature(at(other))).toBe(SIG);
    const broken = `0x${'77'.repeat(32)}`;
    window.sessionStorage.setItem(`openpay:order-confirmation:v2:polygon:${SHOP}:${broken}`, 'not-a-signature');
    expect(storedConfirmationSignature(at(broken))).toBeNull();
  });

  it('sessionStorage が使えなくても、このページの間は覚える (送る機能を止めない)', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    const hash = `0x${'55'.repeat(32)}`;
    expect(() => storeConfirmationSignature(at(hash), SIG)).not.toThrow();
    expect(storedConfirmationSignature(at(hash))).toBe(SIG);
  });
});

describe('この会計をタブで払った記録', () => {
  const PAYER = '0x4444444444444444444444444444444444444444' as Address;
  const tx = `0x${'ab'.repeat(32)}`;

  it('同じ会計の鍵で読み直せ、1 日を過ぎた記録や別の会計の記録は使わない', () => {
    rememberOrderPayment('ctx-a', { txHash: tx, payer: PAYER, paidAt: 1_000 });
    expect(rememberedOrderPayment('ctx-a', 2_000)).toEqual({ txHash: tx, payer: PAYER, paidAt: 1_000 });
    expect(rememberedOrderPayment('ctx-b', 2_000)).toBeNull();
    expect(rememberedOrderPayment('ctx-a', 1_000 + 24 * 60 * 60 * 1000 + 1)).toBeNull();
    // 未来の時刻は壊れた記録として使わない
    expect(rememberedOrderPayment('ctx-a', 500)).toBeNull();
  });

  it('壊れた記録・形の合わない値は使わず、使えない環境でも例外を出さない', () => {
    window.sessionStorage.setItem('openpay:order-paid:v1:ctx-x', '{not json');
    expect(rememberedOrderPayment('ctx-x', 2_000)).toBeNull();
    window.sessionStorage.setItem('openpay:order-paid:v1:ctx-y', JSON.stringify({ txHash: '0x12', paidAt: 1_000 }));
    expect(rememberedOrderPayment('ctx-y', 2_000)).toBeNull();
    window.sessionStorage.setItem('openpay:order-paid:v1:ctx-z', JSON.stringify({ txHash: tx, payer: 'evil', paidAt: 1_000 }));
    expect(rememberedOrderPayment('ctx-z', 2_000)).toEqual({ txHash: tx, paidAt: 1_000 });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    expect(() => rememberOrderPayment('ctx-q', { txHash: tx, paidAt: 1 })).not.toThrow();
  });
});
