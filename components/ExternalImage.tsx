// 利用者が入力した任意の第三者 https 画像 (アバター・カバー・商品画像等) を描く素の <img>。
// wrapper 要素は足さず、DOM は呼び出し側が書いた <img> そのもの。state は持たないが onError (関数)
// が必須なので client component から使う (現行の呼び出し元はすべて client component)。
//
// loading・referrerPolicy・decoding・onError は部品側に既定を持たせず、呼び出し側が毎回明示する
// (undefined = その属性を出さない)。onError は必須 (壊れ画像 icon を出さない方針を型で強制)。
// 呼び出し側の方針 (B-R7・D8 で一律化):
//   - referrerPolicy="no-referrer": 全呼び出し。第三者の画像ホストへ OpenPay の origin も Referer として
//     渡さない (サイト全体の Referrer-Policy は strict-origin-when-cross-origin = origin だけは送る)。
//   - decoding="async": 全呼び出し。第三者画像の decode で描画を待たせない。
//   - loading="lazy": 初回表示で画面外になり得るもの (一覧・grid・編集画面の入力欄横・リンク行)。
//     ページ最上部のヒーロー (プロフ/店舗のカバー・アバター)・購入パネル最上部の大画像・常時見える
//     sticky のミニプレビューは lazy にしない (LCP を遅らせない・SSR の preload を残す)。
//   - onError: 壊れ画像 icon を出さず、各呼び出しの代替表示 (絵文字・頭文字・アイコン・非表示) へ戻す。
// 失敗 URL の記録・URL 変更時の reset・ギャラリーの選択連携は呼び出し側の onError が持つ。
//
// 対象外 (素の <img> のまま): アフィリエイト計測画像・自社 asset (/chains/*.svg・ガイド図版)・
// ウォレットアイコン (EIP-6963 data URI)・QR/blob・印刷面 (モバイル注文ポスター)・OG 画像生成。

import type { ComponentPropsWithoutRef, ReactEventHandler } from 'react';

type ImgProps = ComponentPropsWithoutRef<'img'>;

export type ExternalImageProps = Omit<
  ImgProps,
  'src' | 'alt' | 'loading' | 'referrerPolicy' | 'decoding' | 'onError'
> & {
  // 第三者の URL 文字列のみ (React の実験的な Blob 等は受けない)。node の key にも使う。
  src?: string;
  alt: string;
  // 3 つとも省略不可。undefined を渡すと属性を出さない (= 現行の「指定なし」を明示する)。
  loading: ImgProps['loading'];
  referrerPolicy: ImgProps['referrerPolicy'];
  decoding: ImgProps['decoding'];
  // 省略不可。失敗時は各呼び出しの代替表示へ戻す (壊れ画像 icon を出さない)。
  onError: ReactEventHandler<HTMLImageElement>;
};

export function ExternalImage({ onError, ...imgProps }: ExternalImageProps) {
  // key={src}: URL が変わったら <img> node を作り直す。error event は URL を持たないため、node を
  // 使い回すと旧 URL の遅れた error が新 URL の失敗として記録され得る・呼び出し側が node に直接
  // 付けた状態 (RegisterMode の display:none) が直した URL に残る。その波及を断つための key。
  // alt の再指定は jsx-a11y (spread の中を見ない) のため。既存 key への再代入なので props の
  // key 順 = 属性の出力順は呼び出し側の記述順のまま変わらない。
  // 任意 URL を next/image の最適化 (remotePatterns) に通さない。
  // eslint-disable-next-line @next/next/no-img-element
  return <img key={imgProps.src} {...imgProps} alt={imgProps.alt} onError={onError} />;
}
