// 注文の送り先 (lib/shopContact.ts): 形が決まった LINE 公式アカウントとメールだけを受け、任意の URL や
// mailto: への差し込みを作らせない。

import { describe, expect, it } from 'vitest';
import {
  formatShopContact,
  lineMessageUrl,
  mailtoUrl,
  parseShopContact,
  sameShopContact,
  shopContactFromInput,
  shopContactLabel,
} from '@/lib/shopContact';

describe('shopContactFromInput', () => {
  it('LINE は @ を省いても付け、小文字にそろえる', () => {
    expect(shopContactFromInput('line', ' OpenPay ')).toEqual({ kind: 'line', id: '@openpay' });
    expect(shopContactFromInput('line', '@123abcde')).toEqual({ kind: 'line', id: '@123abcde' });
  });

  it('空は送り先なし・形の合わない値は invalid', () => {
    expect(shopContactFromInput('line', '  ')).toBeNull();
    expect(shopContactFromInput('mail', '')).toBeNull();
    for (const bad of ['@a', '@shop name', '@ショップ', `@${'a'.repeat(21)}`, 'https://line.me/x']) {
      expect(shopContactFromInput('line', bad)).toBe('invalid');
    }
    for (const bad of ['shop', 'shop@', 'a b@example.com', 'a@example.com?cc=x', 'a@example.com#x', 'a%40b@example.com', 'あ@example.com', `${'a'.repeat(120)}@example.com`]) {
      expect(shopContactFromInput('mail', bad)).toBe('invalid');
    }
    expect(shopContactFromInput('mail', 'shop+order@example.co.jp')).toEqual({ kind: 'mail', address: 'shop+order@example.co.jp' });
  });
});

describe('parseShopContact / formatShopContact', () => {
  it('line: と mail: だけを読み、書いた形に戻せる', () => {
    for (const contact of [{ kind: 'line', id: '@openpay' }, { kind: 'mail', address: 'shop@example.com' }] as const) {
      expect(parseShopContact(formatShopContact(contact))).toEqual(contact);
    }
  });

  it('知らない種類・形の合わない値・大文字の LINE ID は送り先なし (表示だけの値なので会計は止めない)', () => {
    for (const raw of [null, '', 'tel:0312345678', 'url:https://evil.example', 'javascript:alert(1)', 'line:@Shop', 'line:shop', 'mail:a@b', 'mail:a@example.com?bcc=x']) {
      expect(parseShopContact(raw)).toBeNull();
    }
  });

  it('同じ送り先かを比べる', () => {
    expect(sameShopContact(null, undefined)).toBe(true);
    expect(sameShopContact({ kind: 'line', id: '@a1' }, { kind: 'line', id: '@a1' })).toBe(true);
    expect(sameShopContact({ kind: 'line', id: '@a1' }, null)).toBe(false);
    expect(sameShopContact({ kind: 'mail', address: 'a@example.com' }, { kind: 'mail', address: 'b@example.com' })).toBe(false);
  });
});

describe('送り先を開く URL', () => {
  it('LINE は oaMessage に ID と文を URL エンコードして入れる', () => {
    expect(lineMessageUrl('@openpay', '注文します。\nTx Hash: 0x1')).toBe(
      `https://line.me/R/oaMessage/%40openpay/?${encodeURIComponent('注文します。\nTx Hash: 0x1')}`,
    );
  });

  it('メールは件名と本文を入れ、改行は CRLF にする', () => {
    expect(mailtoUrl('shop@example.com', '注文', 'a\nb')).toBe('mailto:shop@example.com?subject=%E6%B3%A8%E6%96%87&body=a%0D%0Ab');
  });

  it('お客様に見せる送り先', () => {
    expect(shopContactLabel({ kind: 'line', id: '@openpay' })).toBe('LINE @openpay');
    expect(shopContactLabel({ kind: 'mail', address: 'shop@example.com' })).toBe('shop@example.com');
  });
});
