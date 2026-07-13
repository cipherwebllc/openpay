import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { renderWithIntl } from '../_helpers/i18n';
import PrivacyPage from '@/app/[locale]/privacy/page';
import TermsPage from '@/app/[locale]/terms/page';
import { LEGAL_ENTITY } from '@/lib/legal';

describe('Shops API legal disclosure pack', () => {
  it('Privacy ja: 同意・目的・項目・電話除外・解除60秒・index/summary削除を表示', () => {
    renderWithIntl(<PrivacyPage />, { locale: 'ja' });
    const main = screen.getByRole('main').textContent ?? '';
    expect(main).toContain('明示的な同意');
    expect(main).toContain('店舗検索および注文支援');
    expect(main).toContain('電話番号は提供しません');
    expect(main).toContain('最大 60 秒');
    expect(main).toContain('掲載 index と検索用 summary を削除');
    expect(main).toContain(`施行日: ${LEGAL_ENTITY.privacyEffectiveDate}`);
  });

  it('Privacy en: same disclosure is rendered in English', () => {
    renderWithIntl(<PrivacyPage />, { locale: 'en' });
    const main = screen.getByRole('main').textContent ?? '';
    expect(main).toContain('explicit consent');
    expect(main).toContain('search and ordering assistance');
    expect(main).toContain('Phone numbers are not provided');
    expect(main).toContain('60 seconds');
    expect(main).toContain('listing index and search summary are deleted');
  });

  it('Terms ja/en: 目的限定許諾・再販/再配布制限・店舗由来/正確性を表示', () => {
    renderWithIntl(<TermsPage />, { locale: 'ja' });
    let main = screen.getByRole('main').textContent ?? '';
    expect(main).toContain('Shops API データの利用許諾');
    expect(main).toContain('検索および注文支援の目的に限り');
    expect(main).toContain('再販売');
    expect(main).toContain('一括で再配布');
    expect(main).toContain('各店舗が提供');

    renderWithIntl(<TermsPage />, { locale: 'en' });
    main = screen.getAllByRole('main')[1].textContent ?? '';
    expect(main).toContain('License for Shops API Data');
    expect(main).toContain('search and ordering assistance');
    expect(main).toContain('must not resell');
    expect(main).toContain('redistribute it in bulk');
    expect(main).toContain('supplied by');
  });

  it('README / llms.txt は endpoint・2 JPYC・opt-in・三値/電話除外を同期', () => {
    const readme = readFileSync('README.md', 'utf8');
    const llms = readFileSync('public/llms.txt', 'utf8');
    for (const text of [readme, llms]) {
      expect(text).toContain('/api/paid/jpyc-shops/search');
      expect(text).toContain('2 JPYC');
      expect(text.toLowerCase()).toContain('opt-in');
    }
    expect(readme).toContain('acceptingNow');
    expect(readme).toContain('`null`');
    expect(llms).toContain('電話番号は含まない');
  });
});
