// onramp / offramp 関連 i18n キーの存在と ja/en parity を fence するテスト。
// 片方のロケールだけにキーを足して silent regression するのを防ぐ。
import { describe, it, expect } from 'vitest';
import ja from '@/messages/ja.json';
import en from '@/messages/en.json';

const ONRAMP_KEYS = [
  'onrampCta',
  'onrampJaResidentsOnlyNote',
  'onrampJapaneseUserHint',
] as const;

const FORM_NAMESPACES = ['PaymentForm', 'TipForm', 'CheckoutForm'] as const;

const OFFRAMP_KEYS = [
  'heading',
  'subheading',
  'row',
  'hint',
  'jaResidentsOnlyNote',
  'japaneseUserHint',
] as const;

describe('i18n: smart account 互換性エラー (3 form 名前空間 × ja/en)', () => {
  // useSmartAccount の router が IncompatibleSmartAccountError を投げる時の
  // i18n key 2 種。HashPort などの MAv2 委任 EOA 対策で導入。
  const SA_KEYS = ['errorIncompatibleSmartAccount', 'errorMav2Disabled'] as const;
  for (const ns of FORM_NAMESPACES) {
    for (const key of SA_KEYS) {
      it(`ja.${ns}.${key} は非空文字列`, () => {
        const v = (ja[ns] as Record<string, unknown>)[key];
        expect(typeof v).toBe('string');
        expect(v).not.toBe('');
      });
      it(`en.${ns}.${key} は非空文字列`, () => {
        const v = (en[ns] as Record<string, unknown>)[key];
        expect(typeof v).toBe('string');
        expect(v).not.toBe('');
      });
    }
  }
});

describe('i18n: onramp keys (3 form 名前空間 × ja/en)', () => {
  for (const ns of FORM_NAMESPACES) {
    for (const key of ONRAMP_KEYS) {
      it(`ja.${ns}.${key} は非空文字列`, () => {
        const v = (ja[ns] as Record<string, unknown>)[key];
        expect(typeof v).toBe('string');
        expect(v).not.toBe('');
      });

      it(`en.${ns}.${key} は非空文字列`, () => {
        const v = (en[ns] as Record<string, unknown>)[key];
        expect(typeof v).toBe('string');
        expect(v).not.toBe('');
      });
    }

    it(`${ns}.onrampCta は {label} と {token} の placeholder を両方持つ`, () => {
      // i18n 引数 (label, token) を受ける形式が変わると runtime エラー。fence する。
      const jaText = (ja[ns] as Record<string, string>).onrampCta;
      const enText = (en[ns] as Record<string, string>).onrampCta;
      expect(jaText).toContain('{label}');
      expect(jaText).toContain('{token}');
      expect(enText).toContain('{label}');
      expect(enText).toContain('{token}');
    });
  }
});

describe('i18n: Home.offramp キー (ja/en parity)', () => {
  for (const key of OFFRAMP_KEYS) {
    it(`ja.Home.offramp.${key} は非空文字列`, () => {
      const v = (ja.Home.offramp as Record<string, unknown>)[key];
      expect(typeof v).toBe('string');
      expect(v).not.toBe('');
    });

    it(`en.Home.offramp.${key} は非空文字列`, () => {
      const v = (en.Home.offramp as Record<string, unknown>)[key];
      expect(typeof v).toBe('string');
      expect(v).not.toBe('');
    });
  }

  it('Home.offramp.row は {token} placeholder を持つ', () => {
    expect(ja.Home.offramp.row).toContain('{token}');
    expect(en.Home.offramp.row).toContain('{token}');
  });
});

describe('i18n: ja/en 構造 parity (onramp + offramp)', () => {
  it('全 form 名前空間で onramp キー集合が ja と en で一致', () => {
    for (const ns of FORM_NAMESPACES) {
      const jaKeys = ONRAMP_KEYS.filter(
        (k) => k in (ja[ns] as Record<string, unknown>),
      );
      const enKeys = ONRAMP_KEYS.filter(
        (k) => k in (en[ns] as Record<string, unknown>),
      );
      expect(jaKeys.sort()).toEqual(enKeys.sort());
    }
  });

  it('Home.offramp キー集合が ja と en で一致', () => {
    const jaKeys = OFFRAMP_KEYS.filter(
      (k) => k in (ja.Home.offramp as Record<string, unknown>),
    );
    const enKeys = OFFRAMP_KEYS.filter(
      (k) => k in (en.Home.offramp as Record<string, unknown>),
    );
    expect(jaKeys.sort()).toEqual(enKeys.sort());
  });
});
