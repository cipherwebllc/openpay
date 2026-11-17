// トップの下部の小さな案内 (スポンサー・広告掲載の募集 /sponsors への入口・2026-11-18 user 裁定の第 1 段)。
// 文は承認済み (Landing.sponsorsNote)・リンクの名前は募集ページの題・置き場所は締め (LandingTrust) の後。

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createTranslator } from 'next-intl';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import ja from '@/messages/ja.json';
import en from '@/messages/en.json';
import { LANDING_NOTE_CENTERED, LANDING_TEXT_LINK } from '@/components/LandingControls';
import { LandingSponsorsNote } from '@/components/LandingSponsorsNote';
import { SPONSORS } from '@/lib/sponsors';
import { textHolder } from '@/tests/helpers/phrased';

const localeRef = vi.hoisted(() => ({ value: 'ja' as 'ja' | 'en' }));
vi.mock('next-intl/server', async () => {
  const jaMessages = (await import('@/messages/ja.json')).default;
  const enMessages = (await import('@/messages/en.json')).default;
  return {
    getLocale: async () => localeRef.value,
    getTranslations: async (namespace: 'Landing') =>
      createTranslator({ locale: localeRef.value, messages: localeRef.value === 'en' ? enMessages : jaMessages, namespace }),
  };
});

describe('LandingSponsorsNote', () => {
  it('ja の文は承認済みの文', () => {
    expect(ja.Landing.sponsorsNote).toBe('OpenPay の開発・運営を支える協賛企業・広告掲載企業を募集しています。');
  });

  it.each([
    ['ja', ja],
    ['en', en],
  ] as const)('%s: 案内の文 (注の型) と、募集ページへの文字リンク (名前は募集ページの題・aria-label なし)', async (locale, messages) => {
    localeRef.value = locale;
    try {
      render(await LandingSponsorsNote());
      const note = textHolder(screen.getByText(messages.Landing.sponsorsNote));
      expect(note.textContent).toBe(messages.Landing.sponsorsNote);
      const have = new Set(note.className.split(/\s+/));
      expect(LANDING_NOTE_CENTERED.split(/\s+/).filter((token) => !have.has(token))).toEqual([]);
      const link = screen.getByRole('link', { name: SPONSORS[locale].title });
      expect(link).toHaveAttribute('href', `/${locale}/sponsors`);
      expect(link).not.toHaveAttribute('aria-label');
      expect(link.className).toBe(LANDING_TEXT_LINK.brand);
    } finally {
      localeRef.value = 'ja';
    }
  });

  it('トップでは締め (LandingTrust) の後に置く (トップの節の並びは変えない)', () => {
    const page = readFileSync(join(resolve(__dirname, '../..'), 'app/[locale]/page.tsx'), 'utf8');
    const trust = page.indexOf('<LandingTrust />');
    const note = page.indexOf('<LandingSponsorsNote />');
    expect(trust).toBeGreaterThan(0);
    expect(note).toBeGreaterThan(trust);
    expect(page.slice(note)).toMatch(/^<LandingSponsorsNote \/>\s*<\/AppShell>/);
  });
});
