import { describe, it, expect } from 'vitest';
import manifest from '@/app/manifest';

describe('app/manifest.ts (PWA manifest)', () => {
  const m = manifest();

  it('start_url と scope が "/" (i18n プレフィックスは middleware が付与)', () => {
    expect(m.start_url).toBe('/');
    expect(m.scope).toBe('/');
  });

  it('display=standalone (ホーム画面追加時に独立アプリ風)', () => {
    expect(m.display).toBe('standalone');
  });

  it('icons に SVG が 2 種 (any + maskable)', () => {
    expect(m.icons).toHaveLength(2);
    const purposes = m.icons!.map((i) => i.purpose);
    expect(purposes).toContain('any');
    expect(purposes).toContain('maskable');
    for (const icon of m.icons!) {
      expect(icon.type).toBe('image/svg+xml');
      expect(icon.src).toMatch(/^\/icon/);
    }
  });

  it('theme_color は brand 色 (Tailwind brand-dark に同期)', () => {
    expect(m.theme_color).toBe('#1e3a8a');
  });

  it('lang=ja (デフォルト locale)', () => {
    expect(m.lang).toBe('ja');
  });

  it('categories で finance アプリとして分類', () => {
    expect(m.categories).toContain('finance');
  });
});
