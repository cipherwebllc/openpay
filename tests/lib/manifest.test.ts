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

  it('icons に PNG が 2 種 (any + maskable)', () => {
    expect(m.icons).toHaveLength(2);
    const purposes = m.icons!.map((i) => i.purpose);
    expect(purposes).toContain('any');
    expect(purposes).toContain('maskable');
    for (const icon of m.icons!) {
      expect(icon.type).toBe('image/png');
      expect(icon.src).toMatch(/^\/icon-.*\.png$/);
      expect(icon.sizes).toBe('512x512');
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

  it('display_override は standalone 第一希望 + minimal-ui フォールバック', () => {
    expect(m.display_override).toEqual(['standalone', 'minimal-ui']);
  });

  it('screenshots に narrow/wide の PNG (Android リッチインストール UI 用)', () => {
    expect(m.screenshots).toHaveLength(2);
    const byForm = new Map(m.screenshots!.map((s) => [s.form_factor, s]));
    const narrow = byForm.get('narrow');
    const wide = byForm.get('wide');
    expect(narrow).toBeDefined();
    expect(wide).toBeDefined();
    for (const s of [narrow!, wide!]) {
      expect(s.type).toBe('image/png');
      expect(s.src).toMatch(/^\/screenshot-.*\.png$/);
      // sizes は public/ の実 PNG と一致させる (撮影時に検証済みの実寸)。
      expect(s.sizes).toMatch(/^\d+x\d+$/);
    }
    expect(narrow!.sizes).toBe('780x1688');
    expect(wide!.sizes).toBe('2560x1720');
  });

  it('shortcuts に /ja/scan へのエントリ (Android Chrome long-press 用)', () => {
    expect(m.shortcuts).toBeDefined();
    const scan = m.shortcuts!.find((s) => s.url === '/ja/scan');
    expect(scan).toBeDefined();
    expect(scan!.name.length).toBeGreaterThan(0);
    expect(scan!.icons).toBeDefined();
    expect(scan!.icons![0].sizes).toBe('512x512');
  });
});
