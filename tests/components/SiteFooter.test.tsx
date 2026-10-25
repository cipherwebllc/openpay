import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithIntl } from '../_helpers/i18n';
import { SiteFooter } from '@/components/SiteFooter';
import { LEGAL_ENTITY } from '@/lib/legal';
import { detectSocialPlatform, socialIconPath } from '@/lib/socialLinks';

// @handle compact 判定 (P3) 用に usePathname だけ差し替え可能にする。既定 null =
// 従来挙動 (フル footer) なので既存テストは無影響。
const pathnameMock = vi.hoisted(() => ({ value: null as string | null }));
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  usePathname: () => pathnameMock.value,
}));

describe('SiteFooter', () => {
  it('ja: legal link と運用透明性を露出', () => {
    renderWithIntl(<SiteFooter />, { locale: 'ja' });
    const terms = screen.getByRole('link', { name: '利用規約' });
    const privacy = screen.getByRole('link', { name: 'プライバシーポリシー' });
    const disclaimer = screen.getByRole('link', { name: '免責事項' });
    const tokutei = screen.getByRole('link', { name: '特商法表記' });
    const transparency = screen.getByRole('link', { name: '運用透明性' });
    expect(terms.getAttribute('href')).toBe('/terms');
    expect(privacy.getAttribute('href')).toBe('/privacy');
    expect(disclaimer.getAttribute('href')).toBe('/disclaimer');
    expect(tokutei.getAttribute('href')).toBe('/tokutei');
    expect(transparency.getAttribute('href')).toBe('/transparency');
  });

  it('en: legal link と Operational Transparency を英語で露出', () => {
    renderWithIntl(<SiteFooter />, { locale: 'en' });
    expect(
      screen.getByRole('link', { name: 'Terms of Service' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'Privacy Policy' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Disclaimer' })).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'Business Disclosure' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'Operational Transparency' }),
    ).toHaveAttribute('href', '/transparency');
  });

  // 全ガイドのハブ (/guide) は nav の先頭。兄弟リンクと同じく locale なし href (middleware が /{locale}/guide へ)。
  it.each([
    ['ja', 'ガイド'],
    ['en', 'Guides'],
  ] as const)('%s: 先頭に全ガイドのハブ「%s」→ /guide (可視テキストが名前)', (locale, name) => {
    renderWithIntl(<SiteFooter />, { locale });
    const link = screen.getByRole('link', { name });
    expect(link).toHaveAttribute('href', '/guide');
    expect(link).not.toHaveAttribute('aria-label');
    expect(link.textContent).toBe(name);
    const nav = link.closest('nav')!;
    expect(nav.querySelector('a')).toBe(link);
  });

  // 料金ページ (/pricing) は「ガイド」の直後。兄弟リンクと同じく locale なし href (middleware が /{locale}/pricing へ)。
  it.each([
    ['ja', '料金', 'ガイド'],
    ['en', 'Pricing', 'Guides'],
  ] as const)('%s: 「ガイド」の次に料金「%s」→ /pricing (可視テキストが名前)', (locale, name, guides) => {
    renderWithIntl(<SiteFooter />, { locale });
    const link = screen.getByRole('link', { name });
    expect(link).toHaveAttribute('href', '/pricing');
    expect(link).not.toHaveAttribute('aria-label');
    expect(link.textContent).toBe(name);
    const anchors: HTMLElement[] = Array.from(link.closest('nav')!.querySelectorAll('a'));
    expect(anchors.indexOf(link)).toBe(anchors.indexOf(screen.getByRole('link', { name: guides })) + 1);
  });

  it('事業者名と copyright を表示する', () => {
    renderWithIntl(<SiteFooter />, { locale: 'ja' });
    // copyright 行に LEGAL_ENTITY.companyName が含まれる
    const footer = screen.getByRole('contentinfo');
    expect(footer.textContent).toContain(LEGAL_ENTITY.companyName);
  });

  it('GitHub source link が新規 tab で開く形 + noopener で表示される', () => {
    renderWithIntl(<SiteFooter />, { locale: 'ja' });
    const link = screen.getByRole('link', { name: 'ソースコード (GitHub)' });
    expect(link.getAttribute('href')).toBe(
      'https://github.com/cipherwebllc/openpay',
    );
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('en locale で source link が "Source on GitHub" として render', () => {
    renderWithIntl(<SiteFooter />, { locale: 'en' });
    const link = screen.getByRole('link', { name: 'Source on GitHub' });
    expect(link.getAttribute('href')).toBe(
      'https://github.com/cipherwebllc/openpay',
    );
  });

  it('X (旧 Twitter) 公式アカウントへのリンクが aria-label 付きで露出 (ja)', () => {
    renderWithIntl(<SiteFooter />, { locale: 'ja' });
    const link = screen.getByRole('link', {
      name: 'OpenPay の X (旧 Twitter)',
    });
    expect(link.getAttribute('href')).toBe('https://x.com/openpay_jp');
    expect(link.getAttribute('target')).toBe('_blank');
    // tabnabbing 防御 (window.opener 経由) — 既存 GitHub link と同方針
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('en locale で X link aria-label が "OpenPay on X" として render', () => {
    renderWithIntl(<SiteFooter />, { locale: 'en' });
    const link = screen.getByRole('link', { name: 'OpenPay on X' });
    expect(link.getAttribute('href')).toBe('https://x.com/openpay_jp');
  });

  it('Discord 公式チャンネルへのリンクが aria-label 付きで露出 (ja)', () => {
    renderWithIntl(<SiteFooter />, { locale: 'ja' });
    const link = screen.getByRole('link', { name: 'OpenPay の Discord' });
    expect(link.getAttribute('href')).toBe('https://discord.gg/Cfywb3aNWg');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('en locale で Discord link aria-label が "OpenPay on Discord" として render', () => {
    renderWithIntl(<SiteFooter />, { locale: 'en' });
    const link = screen.getByRole('link', { name: 'OpenPay on Discord' });
    expect(link.getAttribute('href')).toBe('https://discord.gg/Cfywb3aNWg');
  });

  it('note (OpenPay マガジン) へのアイコンリンクが aria-label 付きで露出 (ja)', () => {
    renderWithIntl(<SiteFooter />, { locale: 'ja' });
    const link = screen.getByRole('link', { name: 'note (OpenPay マガジン)' });
    expect(link.getAttribute('href')).toBe(
      'https://note.com/masia02/m/mf28261a21eb1',
    );
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('en locale で note link が "note (OpenPay Magazine)" として render', () => {
    renderWithIntl(<SiteFooter />, { locale: 'en' });
    const link = screen.getByRole('link', { name: 'note (OpenPay Magazine)' });
    expect(link.getAttribute('href')).toBe(
      'https://note.com/masia02/m/mf28261a21eb1',
    );
  });

  it('YouTube チャンネル (登録の確認つき) へのアイコンリンクが aria-label 付きで露出 (ja)', () => {
    renderWithIntl(<SiteFooter />, { locale: 'ja' });
    const link = screen.getByRole('link', { name: 'OpenPay の YouTube' });
    expect(link.getAttribute('href')).toBe(
      'https://www.youtube.com/@openpay_jp?sub_confirmation=1',
    );
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('en locale で YouTube link aria-label が "OpenPay on YouTube" として render', () => {
    renderWithIntl(<SiteFooter />, { locale: 'en' });
    const link = screen.getByRole('link', { name: 'OpenPay on YouTube' });
    expect(link.getAttribute('href')).toBe(
      'https://www.youtube.com/@openpay_jp?sub_confirmation=1',
    );
  });

  it('最下段は X・YouTube・note・Discord・GitHub の順のアイコンだけ (文字なし・名前は aria-label = title・@handle の SNS 行と同じアイコン)', () => {
    renderWithIntl(<SiteFooter />, { locale: 'ja' });
    const names = ['OpenPay の X (旧 Twitter)', 'OpenPay の YouTube', 'note (OpenPay マガジン)', 'OpenPay の Discord', 'ソースコード (GitHub)'];
    const links = names.map((name) => screen.getByRole('link', { name }));
    // 5 つとも同じ段に、この順で並ぶ。
    const row = links[0].parentElement!;
    expect(Array.from(row.querySelectorAll('a'))).toEqual(links);
    for (const link of links) {
      expect(link.textContent).toBe('');
      expect(link.getAttribute('title')).toBe(link.getAttribute('aria-label'));
      const path = link.querySelector('svg[aria-hidden] path');
      expect(path).not.toBeNull();
      // プロフィール (@handle) の SNS アイコンと同じ形。
      expect(path!.getAttribute('d')).toBe(socialIconPath(detectSocialPlatform(link.getAttribute('href')!)));
    }
  });

  it('print:hidden が footer 要素に付与されている (QR ポスター印刷時非表示)', () => {
    renderWithIntl(<SiteFooter />, { locale: 'ja' });
    const footer = screen.getByRole('contentinfo');
    // tailwind class が含まれていれば OK (実 CSS は別途検証不要)
    expect(footer.className).toContain('print:hidden');
  });

  it('現在年 = copyrightStartYear なら単年表示', () => {
    vi.spyOn(Date.prototype, 'getFullYear').mockReturnValue(
      LEGAL_ENTITY.copyrightStartYear,
    );
    try {
      renderWithIntl(<SiteFooter />, { locale: 'ja' });
      const footer = screen.getByRole('contentinfo');
      expect(footer.textContent).toContain(
        String(LEGAL_ENTITY.copyrightStartYear),
      );
      expect(footer.textContent).not.toMatch(
        new RegExp(`${LEGAL_ENTITY.copyrightStartYear}-\\d{4}`),
      );
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('現在年 > copyrightStartYear ならレンジ表示 (start-current)', () => {
    const futureYear = LEGAL_ENTITY.copyrightStartYear + 3;
    vi.spyOn(Date.prototype, 'getFullYear').mockReturnValue(futureYear);
    try {
      renderWithIntl(<SiteFooter />, { locale: 'ja' });
      const footer = screen.getByRole('contentinfo');
      expect(footer.textContent).toMatch(
        new RegExp(`${LEGAL_ENTITY.copyrightStartYear}-${futureYear}`),
      );
    } finally {
      vi.restoreAllMocks();
    }
  });

  // 全ページのフッターから技術の羅列を外した (2026-10-25 user 裁定・技術は運用透明性ページと GitHub にある)。
  describe('技術の羅列を出さない・お問い合わせ (Discord)', () => {
    it.each(['ja', 'en'] as const)('%s: 技術ラベルの <details> が無い', (locale) => {
      const { container } = renderWithIntl(<SiteFooter />, { locale });
      const footer = screen.getByRole('contentinfo');
      for (const label of ['EIP-3009', 'Circle Paymaster', 'CCTP V2', 'ERC-4337', 'ERC-7702', 'Pimlico']) {
        expect(footer.textContent).not.toContain(label);
      }
      expect(container.querySelector('details')).toBeNull();
      expect(footer.textContent).not.toMatch(/Web3/);
    });

    it.each([
      ['ja', 'お問い合わせ (Discord)'],
      ['en', 'Contact (Discord)'],
    ] as const)('%s: リンク列にお問い合わせがあり、行き先は SNS 行の Discord と同じ URL (メールアドレスは載せない)', (locale, name) => {
      renderWithIntl(<SiteFooter />, { locale });
      const contact = screen.getByRole('link', { name });
      expect(contact).toHaveAttribute('href', 'https://discord.gg/Cfywb3aNWg');
      expect(contact).toHaveAttribute('target', '_blank');
      expect(contact).toHaveAttribute('rel', 'noopener noreferrer');
      expect(contact.closest('nav')).not.toBeNull();
      const icon = screen.getByRole('link', { name: locale === 'ja' ? 'OpenPay の Discord' : 'OpenPay on Discord' });
      expect(icon.getAttribute('href')).toBe(contact.getAttribute('href'));
      expect(screen.getByRole('contentinfo').textContent).not.toMatch(/@[a-z0-9-]+\.(com|jp)/i);
    });
  });
});

describe('SiteFooter — @handle compact (受取ページ磨き上げ P3)', () => {
  it('@handle ページでは技術開示/SNS 行/AI ストア導線を出さず legal + copyright に絞る', () => {
    pathnameMock.value = '/ja/@alice';
    try {
      renderWithIntl(<SiteFooter />, { locale: 'ja' });
      // legal は残る (特商法/透明性への到達性は削らない)
      expect(screen.getByRole('link', { name: '利用規約' })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: '特商法表記' })).toBeInTheDocument();
      expect(
        screen.getByText(new RegExp(LEGAL_ENTITY.companyName)),
      ).toBeInTheDocument();
      // OpenPay 宣伝味の行は出さない
      // SNS・ソースの段 (アイコンだけで文字が無い) はリンクの名前で確かめる。
      for (const name of ['OpenPay の X (旧 Twitter)', 'OpenPay の YouTube', 'note (OpenPay マガジン)', 'OpenPay の Discord', 'ソースコード (GitHub)']) {
        expect(screen.queryByRole('link', { name })).toBeNull();
      }
      expect(screen.queryByRole('link', { name: 'お問い合わせ (Discord)' })).toBeNull();
      expect(screen.queryByRole('link', { name: 'AIストア' })).toBeNull();
      // ガイドのハブも OpenPay 側の導線なので出さない。
      expect(screen.queryByRole('link', { name: 'ガイド' })).toBeNull();
      // 料金は特商法・運用透明性と同じ開示寄りのリンクなので @handle でも出す (買い手が負担を確かめられる)。
      const pricing = screen.getByRole('link', { name: '料金' });
      expect(pricing).toHaveAttribute('href', '/pricing');
      // ガイドが無いので nav の先頭に来る。
      expect(pricing.closest('nav')!.querySelector('a')).toBe(pricing);
    } finally {
      pathnameMock.value = null;
    }
  });

  it('通常ページ (@handle 以外) は従来どおりフル footer', () => {
    pathnameMock.value = '/ja/create';
    try {
      renderWithIntl(<SiteFooter />, { locale: 'ja' });
      expect(screen.getByRole('link', { name: 'お問い合わせ (Discord)' })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'OpenPay の YouTube' })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'ガイド' })).toHaveAttribute('href', '/guide');
    } finally {
      pathnameMock.value = null;
    }
  });
});
