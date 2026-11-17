import { describe, it, expect } from 'vitest';
import { relayErrorKey } from '@/lib/relay/relayErrorMessage';
import {
  isFallbackSafeRelayError,
  isIntentStorageUnavailableError,
  isOrderBindingStorageUnavailableError,
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

  it('技術系/未知コードは generic に丸める (signature_mismatch はウォレットの種類の問題と言い切れないので generic のまま)', () => {
    for (const m of ['http_500', 'signature_mismatch', 'unsupported_chain', 'reverted', '']) {
      expect(relayErrorKey(new Error(m))).toBe('errorRelayGeneric');
    }
  });

  // 7702 でない contract の口座 (ERC-4337 のスマートアカウント・マイナウォレット) の署名は、JPYC の EIP-3009 (ecrecover だけ) で
  // server が送り元を復元できず signature_invalid になる。時間をおいても直らないので「一時的」の generic にしない。
  it('signature_invalid は対応していないウォレットの専用キー (fallback-safe のまま = 通常決済へ切り替えられる)', () => {
    const error = new Error('signature_invalid');
    expect(relayErrorKey(error)).toBe('errorRelayUnsupportedWallet');
    expect(isFallbackSafeRelayError(error)).toBe(true);
    expect(isIntentStorageUnavailableError(error)).toBe(false);
    expect(isOrderBindingStorageUnavailableError(error)).toBe(false);
  });

  it('対応していないウォレットの文言は 3 つのフォームの namespace に ja / en であり、「一時的」「時間をおいて」と言わない', () => {
    expect(ja.PaymentForm.errorRelayUnsupportedWallet).toBe('このウォレットは、ガス代不要の支払いに対応していません。');
    expect(ja.CheckoutForm.errorRelayUnsupportedWallet).toBe('このウォレットは、ガス代不要の支払いに対応していません。');
    expect(ja.TipForm.errorRelayUnsupportedWallet).toBe('このウォレットは、ガス代不要の送金に対応していません。');
    expect(en.PaymentForm.errorRelayUnsupportedWallet).toBe("This wallet doesn't support payment with no gas fee.");
    expect(en.CheckoutForm.errorRelayUnsupportedWallet).toBe("This wallet doesn't support payment with no gas fee.");
    expect(en.TipForm.errorRelayUnsupportedWallet).toBe("This wallet doesn't support transfers with no gas fee.");
    for (const messages of [ja, en]) {
      for (const namespace of ['PaymentForm', 'CheckoutForm', 'TipForm'] as const) {
        expect(messages[namespace].errorRelayUnsupportedWallet).not.toMatch(/一時的|時間をおいて|temporarily|try again later/i);
      }
    }
    // /pay・/checkout の banner の題は、この文と同じ中身 (banner は題・本文・切り替えのボタンだけを出す)。
    expect(ja.PaymentForm.errorRelayUnsupportedWallet).toBe(`${ja.RelayFallback.unsupportedTitle}。`);
    expect(en.PaymentForm.errorRelayUnsupportedWallet).toBe(`${en.RelayFallback.unsupportedTitle}.`);
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

// 第 10 回レビュー H-R・user 裁定 Q8 = A: /checkout の切り替えの banner と汎用の文から外す、束縛した注文の error の分類。
// 送っていないので fallback-safe のまま (switchToStandard の二重払いの判定は変えない)。
describe('isOrderBindingStorageUnavailableError (束縛した注文の slot を保存できずに止めた error)', () => {
  it('束縛した注文の slot を書けずに止めた code だけが true で、fallback-safe のまま', () => {
    const error = new Error('order_binding_storage_unavailable');
    expect(isOrderBindingStorageUnavailableError(error)).toBe(true);
    expect(isFallbackSafeRelayError(error)).toBe(true);
  });

  it('ほかの relay の error (文脈が変わって止めた order_binding_mismatch を含む) と error でない値は false', () => {
    for (const m of ['rate_limited', 'fee_required', 'relay_not_configured', 'insufficient_balance', 'boom', 'intent_storage_unavailable', 'order_binding_mismatch', '']) {
      expect(isOrderBindingStorageUnavailableError(new Error(m))).toBe(false);
    }
    expect(isOrderBindingStorageUnavailableError(new RelayResponseUnknownError())).toBe(false);
    expect(isOrderBindingStorageUnavailableError(new RelayIpRateLimitedError(30))).toBe(false);
    expect(isOrderBindingStorageUnavailableError('order_binding_storage_unavailable')).toBe(false);
    expect(isOrderBindingStorageUnavailableError(null)).toBe(false);
  });
});
