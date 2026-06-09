import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithIntl as render } from '../_helpers/i18n';
import { TokenLogo, ChainLogo, TokenOnChainBadge } from '@/components/AssetLogo';
import { chainLogoPathForId } from '@/lib/chains';

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

// TokenOnChainBadge: トークン主役 + チェーン右下バッジの合成。唯一の分岐 =
// chainLogoPathForId が undefined のとき (未整備 chain) はバッジを描かず graceful degrade する。
// 前提 (logo の有無) を実 chainLogoPathForId で固定してから img 枚数で描画分岐を検証する
// (next/image の src 変換に依存しない。本体はモックしない)。
describe('TokenOnChainBadge', () => {
  it('チェーンロゴ有りの chain: トークン + チェーンバッジの 2 枚を重ねて描画', () => {
    // testnet env: Polygon Amoy (80002) は polygon.svg ありが前提。
    expect(chainLogoPathForId(80002)).toBeTruthy();
    const { container } = render(
      <TokenOnChainBadge symbol="usdc" chainId={80002} />,
    );
    expect(container.querySelectorAll('img')).toHaveLength(2);
  });

  it('チェーンロゴ無しの chain: トークンのみ描画 (graceful degrade・バッジ無し)', () => {
    // 未対応 chainId は slug 解決不可 → logo undefined が前提。
    expect(chainLogoPathForId(999_999)).toBeUndefined();
    const { container } = render(
      <TokenOnChainBadge symbol="jpyc" chainId={999_999} />,
    );
    expect(container.querySelectorAll('img')).toHaveLength(1);
  });

  it('全 img は装飾 (aria-hidden) — 隣のトークン記号/チェーン名が読み上げを担う', () => {
    render(<TokenOnChainBadge symbol="usdc" chainId={80002} />);
    expect(screen.queryByRole('img')).toBeNull();
  });
});
