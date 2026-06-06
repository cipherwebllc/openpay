import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithIntl as render } from '../_helpers/i18n';
import { TokenLogo, ChainLogo } from '@/components/AssetLogo';

// AssetLogo の唯一のロジック = alt の有無で a11y 露出 (alt あり=読み上げ可 / 無し=aria-hidden)。
// next/image の src 変換には依存しない assertion にする。
describe('AssetLogo', () => {
  it('TokenLogo: alt 指定で読み上げ可能な img', () => {
    render(<TokenLogo symbol="jpyc" alt="JPYC" />);
    expect(screen.getByRole('img', { name: 'JPYC' })).toBeInTheDocument();
  });

  it('ChainLogo: alt 指定で読み上げ可能な img', () => {
    render(<ChainLogo slug="polygon" alt="Polygon" />);
    expect(screen.getByRole('img', { name: 'Polygon' })).toBeInTheDocument();
  });

  it('alt 既定 ("") は aria-hidden = 装飾扱い (a11y ツリーから除外・隣のテキストが読み上げを担う)', () => {
    const { container } = render(<TokenLogo symbol="usdc" />);
    expect(screen.queryByRole('img')).toBeNull();
    expect(container.querySelector('img')).not.toBeNull();
  });
});
