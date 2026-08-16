// /guide/image-url content SOT (lib/imageGuide.ts) のフェンス:
// ja/en 構造 parity・全 leaf 非空・料率/チェーン名の混入禁止・metadata。

import { describe, it, expect } from 'vitest';
import { imageGuideContentFor, imageGuideMetadata } from '@/lib/imageGuide';

const LOCALES = ['ja', 'en'] as const;

function shape(value: unknown): unknown {
  if (Array.isArray(value)) {
    return { __array: value.length ? shape(value[0]) : 'empty', len: value.length };
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value).sort()) {
      out[k] = shape((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return typeof value;
}

function leaves(value: unknown, path: string, sink: [string, string][]): void {
  if (typeof value === 'string') {
    sink.push([path, value]);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => leaves(v, `${path}[${i}]`, sink));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) leaves(v, `${path}.${k}`, sink);
  }
}

describe('imageGuide content', () => {
  it('未知ロケールは ja へ・en は別内容', () => {
    expect(imageGuideContentFor('ja')).toBe(imageGuideContentFor('xx'));
    expect(imageGuideContentFor('en')).not.toBe(imageGuideContentFor('ja'));
  });

  it('ja / en が同一構造で全 leaf 非空', () => {
    expect(shape(imageGuideContentFor('en'))).toEqual(
      shape(imageGuideContentFor('ja')),
    );
    for (const locale of LOCALES) {
      const sink: [string, string][] = [];
      leaves(imageGuideContentFor(locale), locale, sink);
      for (const [path, text] of sink) {
        expect(text.trim().length, `${path} が空`).toBeGreaterThan(0);
      }
    }
  });

  it('料率・保存期間・チェーン名を含まない (このガイドはドリフトしない設計)', () => {
    const FORBIDDEN = /[0-9]+\s*(%|JPYC|時間|日間)|Polygon|Kaia|Avalanche|Base\b/;
    for (const locale of LOCALES) {
      const sink: [string, string][] = [];
      leaves(imageGuideContentFor(locale), locale, sink);
      for (const [path, text] of sink) {
        expect(FORBIDDEN.test(text), `${path} に可変情報: ${text}`).toBe(false);
      }
    }
  });

  it('metadata は canonical /guide/image-url と OG images を持つ', () => {
    for (const locale of LOCALES) {
      const m = imageGuideMetadata(locale);
      expect(m.alternates?.canonical).toContain('/guide/image-url');
      expect(m.openGraph?.images).toBeDefined();
    }
  });
});
