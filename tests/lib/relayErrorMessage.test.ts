import { describe, it, expect } from 'vitest';
import { relayErrorKey } from '@/lib/relay/relayErrorMessage';
import {
  isFallbackSafeRelayError,
  isIntentStorageUnavailableError,
  RelayIpRateLimitedError,
  RelayResponseUnknownError,
} from '@/lib/relay/relayResponseError';
import ja from '@/messages/ja.json';
import en from '@/messages/en.json';

describe('relayErrorKey (relay error code → 顧客向け i18n キー)', () => {
  it('アクションのある code は専用キー', () => {
    expect(relayErrorKey(new Error('rate_limited'))).toBe('errorRelayRateLimited');
    expect(relayErrorKey(new Error('relay_not_configured'))).toBe('errorRelayNotConfigured');
    expect(relayErrorKey(new Error('insufficient_balance'))).toBe('errorRelayInsufficientBalance');
  });

  it('a1 関所の fee_required は専用キー (一過性でない・店主確認/通常モード誘導)', () => {
    expect(relayErrorKey(new Error('fee_required'))).toBe('errorRelayFeePaused');
  });

  // 第 10 回レビュー H-R: 復旧の枠を書けない端末で hook が送らずに止めた code (server の応答ではない)。
  it('intent_storage_unavailable は専用キー (時間をおいても直らない・generic の「時間をおいて再度」にしない)', () => {
    expect(relayErrorKey(new Error('intent_storage_unavailable'))).toBe('errorRelayStorageUnavailable');
  });

  it('専用キーの文言は 3 つのフォームの namespace にあり、どれも通常決済への切り替えを案内しない (user 裁定 Q7-1)', () => {
    for (const messages of [ja, en]) {
      for (const namespace of ['PaymentForm', 'CheckoutForm', 'TipForm'] as const) {
        expect(messages[namespace].errorRelayStorageUnavailable).toEqual(expect.any(String));
      }
    }
    expect(ja.CheckoutForm.errorRelayStorageUnavailable).toBe(ja.PaymentForm.errorRelayStorageUnavailable);
    expect(en.CheckoutForm.errorRelayStorageUnavailable).toBe(en.PaymentForm.errorRelayStorageUnavailable);
    // 通常決済も同じ保存に頼っていて同じ穴があるので、どのフォームも切り替えを案内しない (/pay・/checkout も汎用の赤い
    // エラー枠に出す)。語は支払いの画面の既存の文 (pendingStoreUnavailableBody) と同じ「支払い記録」。
    for (const namespace of ['PaymentForm', 'CheckoutForm', 'TipForm'] as const) {
      expect(ja[namespace].errorRelayStorageUnavailable).not.toMatch(/通常/);
      expect(en[namespace].errorRelayStorageUnavailable).not.toMatch(/standard/i);
      expect(ja[namespace].errorRelayStorageUnavailable).toMatch(/^この端末では支払い記録を保存できないため、/);
      expect(en[namespace].errorRelayStorageUnavailable).toMatch(/^We can't save a payment record on this device, /);
      expect(ja[namespace].errorRelayStorageUnavailable).toContain('別のブラウザでお試しください');
      expect(en[namespace].errorRelayStorageUnavailable).toContain('try another browser');
    }
    // どの文も「JPYC は動いていない」を伝える (署名の前か、署名の後・POST の前に止めている)。
    for (const text of [ja.PaymentForm, ja.CheckoutForm, ja.TipForm].map((m) => m.errorRelayStorageUnavailable)) {
      expect(text).toContain('JPYC は動いていません');
    }
    for (const text of [en.PaymentForm, en.CheckoutForm, en.TipForm].map((m) => m.errorRelayStorageUnavailable)) {
      expect(text).toContain("your JPYC didn't move");
    }
  });

  it('技術系/未知コードは generic に丸める', () => {
    for (const m of ['http_500', 'signature_invalid', 'unsupported_chain', 'reverted', '']) {
      expect(relayErrorKey(new Error(m))).toBe('errorRelayGeneric');
    }
  });
});

// 第 10 回レビュー H-R・user 裁定 Q7-1: /pay・/checkout の切り替えの banner から外す error の分類。送っていないので
// fallback-safe のまま (switchToStandard の二重払いの判定は変えない)。
describe('isIntentStorageUnavailableError (通常決済への切り替えを案内しない relay の error)', () => {
  it('hook が枠を書けずに止めた code だけが true で、fallback-safe のまま', () => {
    const error = new Error('intent_storage_unavailable');
    expect(isIntentStorageUnavailableError(error)).toBe(true);
    expect(isFallbackSafeRelayError(error)).toBe(true);
  });

  it('ほかの relay の error (切り替えを案内する) と error でない値は false', () => {
    for (const m of ['rate_limited', 'fee_required', 'relay_not_configured', 'insufficient_balance', 'boom', 'order_binding_storage_unavailable', '']) {
      expect(isIntentStorageUnavailableError(new Error(m))).toBe(false);
    }
    expect(isIntentStorageUnavailableError(new RelayResponseUnknownError())).toBe(false);
    expect(isIntentStorageUnavailableError(new RelayIpRateLimitedError(30))).toBe(false);
    expect(isIntentStorageUnavailableError('intent_storage_unavailable')).toBe(false);
    expect(isIntentStorageUnavailableError(null)).toBe(false);
  });
});
