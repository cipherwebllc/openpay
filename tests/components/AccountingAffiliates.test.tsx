import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithIntl as render } from '../_helpers/i18n';
import { AccountingAffiliates } from '@/components/AccountingAffiliates';

describe('AccountingAffiliates', () => {
  it('広告ラベル + 4 件の A8 アフィリエイトリンク (nofollow・別タブ)', () => {
    render(<AccountingAffiliates />);
    expect(screen.getByText('広告')).toBeInTheDocument();
    const a8 = screen
      .getAllByRole('link')
      .filter((l) => l.getAttribute('href')?.includes('px.a8.net'));
    expect(a8).toHaveLength(4);
    for (const l of a8) {
      expect(l.getAttribute('rel')).toContain('nofollow');
      expect(l).toHaveAttribute('target', '_blank');
    }
  });

  it('各バナーに製品名 alt (a11y) + インプレッションビーコンは aria-hidden', () => {
    const { container } = render(<AccountingAffiliates />);
    expect(screen.getByAltText(/freee会計/)).toBeInTheDocument();
    expect(screen.getByAltText('マネーフォワード クラウド会計')).toBeInTheDocument();
    expect(screen.getByAltText('弥生シリーズ')).toBeInTheDocument();
    // 1x1 ビーコン (alt 空 + aria-hidden) が 4 件
    expect(container.querySelectorAll('img[aria-hidden="true"]')).toHaveLength(4);
  });
});
