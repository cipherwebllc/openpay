// トークン / チェーンの公式ロゴ (public/tokens/{symbol}.svg, public/chains/{slug}.svg)。
// 「読まずに分かる」UI のための共通部品。選択 UI (TokenChooser/ChainChooser) と
// 読み取り表示 (履歴行・ステータス行など) で共有する。
//
// alt 既定は空 (aria-hidden) — 隣に symbol/chain 名のテキストがある加算表示を想定。
// テキストが無い箇所では alt を渡して読み上げ可能にする。

import NextImage from 'next/image';
import type { TokenSymbol } from '@/lib/tokens';
import { chainLogoPathForId, type ChainSlug } from '@/lib/chains';

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

// トークンを主役 (size) に据え、チェーンロゴを右下に小バッジ (白縁) で重ねた合成アイコン。
// 「USDC を Optimism で持っている」を一目で示す (チェーンロゴ単独だと OP / KAIA 等の
// ネイティブトークンと誤読されるのを防ぐ)。chainLogoPathForId が未整備 chain
// (World Chain / Sonic 等) で undefined の場合はトークンアイコンのみ描画する。
// 隣にトークン記号 / チェーン名のテキストがある前提で aria-hidden。
export function TokenOnChainBadge({
  symbol,
  chainId,
  size = 24,
}: {
  symbol: TokenSymbol;
  chainId: number;
  size?: number;
}) {
  const chainLogo = chainLogoPathForId(chainId);
  const badge = Math.round(size * 0.58);
  return (
    <span
      className="relative inline-block shrink-0"
      style={{ width: size, height: size }}
    >
      <TokenLogo symbol={symbol} size={size} />
      {chainLogo && (
        <NextImage
          src={chainLogo}
          alt=""
          width={badge}
          height={badge}
          aria-hidden
          className="absolute -bottom-1 -right-1 rounded-full bg-white ring-2 ring-white"
        />
      )}
    </span>
  );
}
