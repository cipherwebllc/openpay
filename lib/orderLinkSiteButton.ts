// 注文リンクの「何度でも使える」リンクを、お店のサイトの商品ページに置く「JPYCで支払う」ボタンの HTML (純関数)。
// 貼るのは単一の <a> だけ (JavaScript・iframe・class・外部 CSS なし)。リンク先は buildOrderLink が作った URL を
// そのまま使い (URL の作り方は変えない)、属性の値として実体参照化する (URL の引数の区切りの & が &amp; になる)。
// target="_blank" rel="noopener" はチップのボタン (components/tip-embed-generator/snippets.ts) と同じ (お店のページが残る)。
// 見た目は OpenPay の主ボタン (bg-brand・rounded-xl・font-bold・text-base) に合わせ、貼ったサイトの CSS に左右されにくいよう、
// 見た目に効く値をすべて style に書く (inline の style は、サイトの CSS の !important の無い指定より強い)。
// 作る画面の見本は、この関数の戻り値をそのまま描く (見本と貼ったボタンの見た目をそろえる)。

import { escapeHtmlAttr } from './htmlEscape';

/** OpenPay の主ボタンの色 (tailwind.config.ts の brand.DEFAULT)。白い文字とのコントラストは AA を満たす。 */
const BRAND = '#1e40af';

/**
 * ボタンの style。値に " を使わない (属性は " で囲むので、書体の名前は ' で囲む)。
 * - min-height 44px: スマホで押しやすい大きさ (line-height 20px + 上下の padding 12px = 44px)。
 * - border・box-shadow: リンクに下線を枠や影で描くテーマがあるので消す。
 * - letter-spacing・font-feature-settings: 和文のサイトは本文に字間や詰め組 (palt) を付けることが多い。ボタンに
 *   引き継がせない (OpenPay の画面も palt なので、これが無いと見本と貼ったボタンで文字の幅が変わる)。
 */
export const ORDER_LINK_SITE_BUTTON_STYLE = [
  'display:inline-block',
  'box-sizing:border-box',
  'min-height:44px',
  'padding:12px 24px',
  'border:0',
  'border-radius:12px',
  `background:${BRAND}`,
  'color:#ffffff',
  "font-family:system-ui,-apple-system,'Segoe UI','Hiragino Sans','Noto Sans JP',sans-serif",
  'font-size:16px',
  'font-weight:700',
  'line-height:20px',
  'letter-spacing:normal',
  'font-feature-settings:normal',
  'text-align:center',
  'text-decoration:none',
  'box-shadow:none',
].join(';');

/** 商品ページに貼るボタンの HTML (1 行)。url は注文リンク (buildOrderLink の url)、label はボタンの文字。 */
export function orderLinkSiteButtonHtml(url: string, label: string): string {
  return `<a href="${escapeHtmlAttr(url)}" target="_blank" rel="noopener" style="${ORDER_LINK_SITE_BUTTON_STYLE}">${escapeHtmlAttr(label)}</a>`;
}
