import { describe, it, expect } from 'vitest';
import { relayErrorKey } from '@/lib/relay/relayErrorMessage';

describe('relayErrorKey (relay error code → 顧客向け i18n キー)', () => {
  it('アクションのある code は専用キー', () => {
    expect(relayErrorKey(new Error('rate_limited'))).toBe('errorRelayRateLimited');
    expect(relayErrorKey(new Error('relay_not_configured'))).toBe('errorRelayNotConfigured');
    expect(relayErrorKey(new Error('insufficient_balance'))).toBe('errorRelayInsufficientBalance');
  });

  it('a1 関所の fee_required は専用キー (一過性でない・店主確認/通常モード誘導)', () => {
    expect(relayErrorKey(new Error('fee_required'))).toBe('errorRelayFeePaused');
  });

  it('技術系/未知コードは generic に丸める', () => {
    for (const m of ['http_500', 'signature_invalid', 'unsupported_chain', 'reverted', '']) {
      expect(relayErrorKey(new Error(m))).toBe('errorRelayGeneric');
    }
  });
});
