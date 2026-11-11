import { describe, it, expect } from 'vitest';
import { relayErrorKey } from '@/lib/relay/relayErrorMessage';
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

  it('専用キーの文言は 3 つのフォームの namespace にあり、通常決済へ切り替えられないチップでは切り替えを案内しない', () => {
    for (const messages of [ja, en]) {
      for (const namespace of ['PaymentForm', 'CheckoutForm', 'TipForm'] as const) {
        expect(messages[namespace].errorRelayStorageUnavailable).toEqual(expect.any(String));
      }
    }
    // /pay・/checkout は RelayFallbackBanner (通常決済への切り替えボタン) の中に出る。
    expect(ja.PaymentForm.errorRelayStorageUnavailable).toContain('通常決済');
    expect(ja.CheckoutForm.errorRelayStorageUnavailable).toBe(ja.PaymentForm.errorRelayStorageUnavailable);
    expect(en.PaymentForm.errorRelayStorageUnavailable).toMatch(/standard payment/);
    expect(en.CheckoutForm.errorRelayStorageUnavailable).toBe(en.PaymentForm.errorRelayStorageUnavailable);
    // /tip は赤いエラー枠に出るだけで、JPYC の通常決済へ切り替える入口が無い。
    expect(ja.TipForm.errorRelayStorageUnavailable).not.toMatch(/通常/);
    expect(en.TipForm.errorRelayStorageUnavailable).not.toMatch(/standard/i);
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
