import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithIntl } from '../_helpers/i18n';
import { ExploreEntryCard } from '@/components/ExploreEntry';
import type { ExploreEntry } from '@/lib/explore';

// affiliate=true (成果報酬リンク) と通常リンクで、景表法「広告」開示チップと rel が
// 切り替わることを fence する。AccountingAffiliates (/history) と表記を統一。
const affiliateEntry: ExploreEntry = {
  id: 'gmo-coin',
  name: 'GMOコイン',
  url: 'https://px.a8.net/svt/ejp?a8mat=TEST',
  category: 'exchange',
  description: { ja: 'テスト説明', en: 'Test description' },
  badges: ['jp-only'],
  affiliate: true,
};

const plainEntry: ExploreEntry = {
  id: 'coincheck',
  name: 'Coincheck',
  url: 'https://coincheck.com/',
  category: 'exchange',
  description: { ja: '国内取引所', en: 'JP exchange' },
  badges: ['jp-only'],
};

describe('ExploreEntryCard: アフィリエイト開示 (景表法)', () => {
  it('affiliate=true: 「広告」開示チップを出す', () => {
    renderWithIntl(<ExploreEntryCard entry={affiliateEntry} />);
    expect(screen.getByText('広告')).toBeInTheDocument();
  });

  it('affiliate=true: rel に sponsored + nofollow + noopener を含む (有料リンク明示)', () => {
    renderWithIntl(<ExploreEntryCard entry={affiliateEntry} />);
    const rel = screen.getByRole('link').getAttribute('rel') ?? '';
    expect(rel).toContain('sponsored');
    expect(rel).toContain('nofollow');
    expect(rel).toContain('noopener');
  });

  it('affiliate なし: 「広告」チップを出さず rel は noopener noreferrer のみ', () => {
    renderWithIntl(<ExploreEntryCard entry={plainEntry} />);
    expect(screen.queryByText('広告')).not.toBeInTheDocument();
    const rel = screen.getByRole('link').getAttribute('rel') ?? '';
    expect(rel).not.toContain('sponsored');
    expect(rel).toBe('noopener noreferrer');
  });

  it('href / target / name / description / badge を描画', () => {
    renderWithIntl(<ExploreEntryCard entry={affiliateEntry} />);
    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('href', affiliateEntry.url);
    expect(link).toHaveAttribute('target', '_blank');
    expect(screen.getByText('GMOコイン')).toBeInTheDocument();
    expect(screen.getByText('テスト説明')).toBeInTheDocument();
    expect(screen.getByText('日本居住者')).toBeInTheDocument();
  });

  it('en locale: 「広告」チップは "Ad" になる', () => {
    renderWithIntl(<ExploreEntryCard entry={affiliateEntry} />, { locale: 'en' });
    expect(screen.getByText('Ad')).toBeInTheDocument();
    expect(screen.getByText('Test description')).toBeInTheDocument();
  });
});
