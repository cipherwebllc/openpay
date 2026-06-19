// 受注閲覧トークンの純ロジック (lib/orderToken) を実コードで検証。KV キー / トークン形式判定。

import { describe, it, expect } from 'vitest';
import {
  orderTokenKey,
  orderTokenRevKey,
  isOrderTokenLike,
  ORDER_TOKEN_BYTES,
} from '@/lib/orderToken';

// base64url(32 bytes) = 43 文字の有効トークン例。
const VALID = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNO-_';

describe('orderToken: KV キー', () => {
  it('orderTokenKey は受取アドレスを小文字化', () => {
    expect(orderTokenKey('0xABCdef0000000000000000000000000000000000')).toBe(
      'order:optoken:0xabcdef0000000000000000000000000000000000',
    );
  });
  it('orderTokenRevKey はトークンをそのままキーに含める (lookup 用)', () => {
    expect(orderTokenRevKey(VALID)).toBe(`order:optoken:rev:${VALID}`);
  });
});

describe('orderToken: isOrderTokenLike (KV ルックアップ前の形式ゲート)', () => {
  it('base64url 43 文字のみ true', () => {
    expect(VALID.length).toBe(43); // 前提確認
    expect(isOrderTokenLike(VALID)).toBe(true);
  });
  it('長さ違い / 不正文字 / 非文字列は false', () => {
    expect(isOrderTokenLike(VALID.slice(0, 42))).toBe(false); // 短い
    expect(isOrderTokenLike(VALID + 'x')).toBe(false); // 長い
    expect(isOrderTokenLike('!'.repeat(43))).toBe(false); // base64url 外の文字
    expect(isOrderTokenLike('あ'.repeat(43))).toBe(false);
    expect(isOrderTokenLike('')).toBe(false);
    expect(isOrderTokenLike(undefined)).toBe(false);
    expect(isOrderTokenLike(null)).toBe(false);
    expect(isOrderTokenLike(123)).toBe(false);
  });
  it('ORDER_TOKEN_BYTES は 32 (256-bit)', () => {
    expect(ORDER_TOKEN_BYTES).toBe(32);
  });
});
