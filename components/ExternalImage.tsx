// 利用者が入力した任意の第三者 https 画像 (アバター・カバー・商品画像等) を描く素の <img>。
// wrapper 要素は足さず、DOM は呼び出し側が書いた <img> そのもの。state を持たない純表示なので
// server からも描画可 (ただし server component から使うときは関数を渡せないので onError={null} のみ)。
//
// loading・referrerPolicy・decoding・onError は部品側に既定を持たせず、呼び出し側が毎回明示する
// (undefined = その属性を出さない・onError={null} = 失敗時もブラウザの壊れ画像のまま)。
// 既定を持たせると呼び出しごとに違う現行の通信/描画 (メニュー grid は Referer を送る・lazy の
// 有無等) が黙って変わるため。方針の統一は別 PR (B-R7) で差分として明示して行う。
// 失敗 URL の記録・URL 変更時の reset・ギャラリーの選択連携は呼び出し側の onError が持つ。
//
// 対象外 (素の <img> のまま): アフィリエイト計測画像・自社 asset (/chains/*.svg・ガイド図版)・
// ウォレットアイコン (EIP-6963 data URI)・QR/blob・印刷面 (モバイル注文ポスター)・OG 画像生成。

import type { ComponentPropsWithoutRef, ReactEventHandler } from 'react';

type ImgProps = ComponentPropsWithoutRef<'img'>;

export type ExternalImageProps = Omit<
  ImgProps,
  'alt' | 'loading' | 'referrerPolicy' | 'decoding' | 'onError'
> & {
  alt: string;
  // 3 つとも省略不可。undefined を渡すと属性を出さない (= 現行の「指定なし」を明示する)。
  loading: ImgProps['loading'];
  referrerPolicy: ImgProps['referrerPolicy'];
  decoding: ImgProps['decoding'];
  // 省略不可。null = 失敗時の fallback なし。
  onError: ReactEventHandler<HTMLImageElement> | null;
};

export function ExternalImage({ onError, ...imgProps }: ExternalImageProps) {
  // alt の再指定は jsx-a11y (spread の中を見ない) のため。既存 key への再代入なので props の
  // key 順 = 属性の出力順は呼び出し側の記述順のまま変わらない。
  // 任意 URL を next/image の最適化 (remotePatterns) に通さない。
  // eslint-disable-next-line @next/next/no-img-element
  return <img {...imgProps} alt={imgProps.alt} onError={onError ?? undefined} />;
}
