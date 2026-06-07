import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithIntl } from '../_helpers/i18n';
import { SiteFooter } from '@/components/SiteFooter';
import { LEGAL_ENTITY } from '@/lib/legal';

describe('SiteFooter', () => {
  it('ja: 4 legal link (利用規約/プライバシーポリシー/免責事項/特商法表記) を露出', () => {
    renderWithIntl(<SiteFooter />, { locale: 'ja' });
    const terms = screen.getByRole('link', { name: '利用規約' });
    const privacy = screen.getByRole('link', { name: 'プライバシーポリシー' });
    const disclaimer = screen.getByRole('link', { name: '免責事項' });
    const tokutei = screen.getByRole('link', { name: '特商法表記' });
    expect(terms.getAttribute('href')).toBe('/terms');
    expect(privacy.getAttribute('href')).toBe('/privacy');
    expect(disclaimer.getAttribute('href')).toBe('/disclaimer');
    expect(tokutei.getAttribute('href')).toBe('/tokutei');
  });

  it('en: 同じ link を英訳 (Terms of Service / Privacy Policy / Disclaimer / Business Disclosure) で露出', () => {
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

  it('note (OpenPay マガジン) へのテキストリンクが露出 (ja)', () => {
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

  // 3-step UI refactor (2026-05-23): poweredBy を soft + 技術詳細 (<details>) に
  // 分離。一般店主には「Web3」用語を出さず (ネガティブ印象回避)、開発者は
  // summary click で展開して ERC-4337 等の技術ラベルを確認できる。
  describe('poweredBy soft + 技術詳細', () => {
    it('ja: summary に soft 文言 (ステーブルコイン決済技術)、展開で ERC-4337 等の技術ラベル', () => {
      renderWithIntl(<SiteFooter />, { locale: 'ja' });
      const footer = screen.getByRole('contentinfo');
      // summary 文言 (default visible)
      expect(footer.textContent).toContain(
        'ステーブルコイン決済技術を利用しています',
      );
      // 旧の生 powered-by 文字列は summary に出ない (展開 trigger としてのみ存在)
      expect(footer.textContent).toContain('技術詳細');
      // 技術ラベル文字列は <details> 内に存在 (closed でも DOM にはある)。
      // 現行アーキテクチャに更新済: 旧 Pimlico/permissionless.js 中心 →
      // EIP-3009 (JPYC) / Circle Paymaster (USDC) / CCTP V2 (cross-chain) を前面に。
      expect(footer.textContent).toContain('EIP-3009');
      expect(footer.textContent).toContain('Circle Paymaster');
      expect(footer.textContent).toContain('CCTP V2');
      expect(footer.textContent).toContain('ERC-4337');
      expect(footer.textContent).toContain('ERC-7702');
    });

    it('en: 同じ構造で英訳 (Powered by stablecoin payment technology / Technical details)', () => {
      renderWithIntl(<SiteFooter />, { locale: 'en' });
      const footer = screen.getByRole('contentinfo');
      expect(footer.textContent).toContain(
        'Powered by stablecoin payment technology',
      );
      expect(footer.textContent).toContain('Technical details');
      expect(footer.textContent).toContain('ERC-4337');
    });

    it('<details> 要素の初期状態は closed (技術詳細は折り畳まれている)', () => {
      const { container } = renderWithIntl(<SiteFooter />, { locale: 'ja' });
      // footer 内の details (poweredBy の折り畳み)
      const detailsEls = container.querySelectorAll('details');
      // poweredBy の <details> 要素は 1 つ存在
      const poweredByDetails = Array.from(detailsEls).find((d) =>
        d.textContent?.includes('ステーブルコイン決済技術'),
      );
      expect(poweredByDetails).toBeDefined();
      expect(poweredByDetails!.open).toBe(false);
    });

    it('ja: summary に「Web3」リテラルが出ない (一般層に対する用語回避の regression guard)', () => {
      renderWithIntl(<SiteFooter />, { locale: 'ja' });
      const footer = screen.getByRole('contentinfo');
      // <details> closed 状態 (default) の visible summary 部分に「Web3」が無いこと。
      // 展開後の技術ラベル群には Web3 用語は元から含まれないので、textContent 全体で
      // 「Web3」が出現しないことを fence する。
      expect(footer.textContent).not.toMatch(/Web3/);
    });
  });
});
