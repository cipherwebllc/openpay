'use client';

// 通貨 (JPYC / USDC) 選択ボタン grid。QrGenerator (店舗 QR) と TipEmbedGenerator
// (Tip widget) で共有する。公式ロゴ (public/tokens/{jpyc,usdc}.svg) + symbol の
// 2 要素のみ表示し視覚密度を抑える。Field/label は ChainChooser と同様に呼出側責務。
//
// 注: CheckoutLinkGenerator は「symbol + 対応 chain 数 hint」の別レイアウト
// (ロゴ無し) を使うため本コンポーネントは共有せず据え置き (variant 分岐を避ける)。

import NextImage from 'next/image';
import { defaultDeploymentForSymbol, type TokenSymbol } from '@/lib/tokens';

export function TokenChooser({
  selected,
  onSelect,
}: {
  selected: TokenSymbol;
  onSelect: (token: TokenSymbol) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-2">
      {(['jpyc', 'usdc'] as TokenSymbol[]).map((tok) => {
        const info = defaultDeploymentForSymbol(tok);
        const active = selected === tok;
        return (
          <button
            key={tok}
            type="button"
            onClick={() => onSelect(tok)}
            className={`flex items-center justify-center gap-2 rounded-lg border px-3 py-3 text-sm font-semibold transition ${
              active
                ? 'border-brand bg-brand/5 text-brand-dark'
                : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'
            }`}
          >
            <NextImage
              src={`/tokens/${tok}.svg`}
              alt=""
              width={24}
              height={24}
              className="h-6 w-6 shrink-0"
              aria-hidden
            />
            <span>{info.displaySymbol}</span>
          </button>
        );
      })}
    </div>
  );
}
