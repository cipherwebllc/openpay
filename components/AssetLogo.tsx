// トークン / チェーンの公式ロゴ (public/tokens/{symbol}.svg, public/chains/{slug}.svg)。
// 「読まずに分かる」UI のための共通部品。選択 UI (TokenChooser/ChainChooser) と
// 読み取り表示 (履歴行・ステータス行など) で共有する。
//
// alt 既定は空 (aria-hidden) — 隣に symbol/chain 名のテキストがある加算表示を想定。
// テキストが無い箇所では alt を渡して読み上げ可能にする。

import NextImage from 'next/image';
import type { TokenSymbol } from '@/lib/tokens';
import type { ChainSlug } from '@/lib/chains';

export function TokenLogo({
  symbol,
  size = 20,
  className,
  alt = '',
}: {
  symbol: TokenSymbol;
  size?: number;
  className?: string;
  alt?: string;
}) {
  return (
    <NextImage
      src={`/tokens/${symbol}.svg`}
      alt={alt}
      width={size}
      height={size}
      className={className ?? 'shrink-0'}
      aria-hidden={alt === '' ? true : undefined}
    />
  );
}

export function ChainLogo({
  slug,
  size = 18,
  className,
  alt = '',
}: {
  slug: ChainSlug;
  size?: number;
  className?: string;
  alt?: string;
}) {
  return (
    <NextImage
      src={`/chains/${slug}.svg`}
      alt={alt}
      width={size}
      height={size}
      className={className ?? 'shrink-0'}
      aria-hidden={alt === '' ? true : undefined}
    />
  );
}
