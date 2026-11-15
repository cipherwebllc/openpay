// トップの節で使う、ボタン・文字リンク・注・大きい数字・カード・アイコンの箱・見出しの型 (class の定数)。Server / Client どちらからも使える。
// 節ごとに色・角・高さ・字の大きさが違っていたのを、役割ごとに 1 つの型にそろえる (plans/lp-polish-2026-11.md P2・P3)。
// 強さの順は「ヒーローの主ボタン > 節の主ボタン > 副ボタン > 文字リンク」。ヒーローの主ボタン (components/LandingHero.tsx) は
// ページで 1 つだけの、いちばん大きいボタン (角 2xl・高さ 48px・太字 16px・大きな影・矢印つき) で、ここの型は使わない。
//
// 色 (tone) は節の色: brand = 紺 (ふつうの節)・shop = 緑 (お店の道具の節。緑の地の上・緑のアイコンの隣)・
// onDark = 締めの濃い紺の面。形 (角・高さ・字・余白・押したときの縮み・focus の輪) は tone が違っても同じ。

// 高さ 44px (押せる範囲)・角 xl・14px の中太字。幅は中身の幅 (全幅にしない = ヒーローの主ボタンより大きく見せない)。
// 上下の余白 (py-2.5) は、狭い画面で名前が 2 行に折れたときに字が縁に付かないため (1 行のときの高さは min-h-11 の 44px のまま)。
// 動きは色の変化と、押したときのわずかな縮みだけ (hover で浮かせない)。縮みは、動きを減らす設定 (prefers-reduced-motion:
// reduce) のときは付けない (motion-safe:)。型をそろえたことで、今まで縮まなかった副ボタンにも縮みが付くため。
const BUTTON =
  'inline-flex min-h-11 items-center justify-center gap-2 rounded-xl py-2.5 text-center text-sm font-semibold transition motion-safe:active:scale-[0.99] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2';
// 左右の余白: 主ボタンは 20px。副ボタンは 1 行に 2〜3 個並ぶので、スマホは 16px (320px 幅でも 2 つが 1 行に入る)・sm 以上は 20px。
const PRIMARY = `${BUTTON} px-5`;
const SECONDARY = `${BUTTON} px-4 sm:px-5`;

/** 節の主ボタン (塗り)。1 つの節に 1 つまで。 */
export const LANDING_PRIMARY = {
  brand: `${PRIMARY} bg-brand text-white shadow-sm hover:bg-brand-dark focus-visible:outline-brand`,
  shop: `${PRIMARY} bg-emerald-700 text-white shadow-sm hover:bg-emerald-800 focus-visible:outline-emerald-700`,
  // 濃い紺の面 (slate-900) の上では、紺の塗りは地との差が約 2:1 しかなく、ボタンの形が見えない。白の塗りに濃い字にする
  // (字と塗り 17.8:1・塗りと地 17.8:1)。
  onDark: `${PRIMARY} bg-white text-slate-900 shadow-sm hover:bg-slate-100 focus-visible:outline-white`,
} as const;

/** 副ボタン (白地に枠)。主ボタンの隣、または主ボタンのない節の入口。 */
export const LANDING_SECONDARY = {
  brand: `${SECONDARY} bg-white text-slate-700 ring-1 ring-inset ring-slate-300 hover:bg-slate-50 hover:text-brand focus-visible:outline-brand`,
  shop: `${SECONDARY} bg-white text-slate-700 ring-1 ring-inset ring-slate-300 hover:bg-slate-50 hover:text-emerald-800 focus-visible:outline-emerald-700`,
  // 濃い紺の面の上の副ボタンは、塗らずに枠と白い字 (白く塗ると、隣の主ボタンと同じ強さになる)。
  onDark: `${SECONDARY} bg-white/10 text-white ring-1 ring-inset ring-white/40 hover:bg-white/15 focus-visible:outline-white`,
} as const;

/**
 * 主ボタンと副ボタンの組の並べ方。横に並べ、スマホで横に入らない組は縦に積んで 2 つの幅をそろえる (広い方の中身の幅)。
 * 中央寄せ。左寄せの節では使う側で lg:mx-0 lg:justify-start を足す。
 */
export const LANDING_ACTION_STACK =
  'mx-auto flex w-fit max-w-full flex-col items-stretch gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-center';

/** ボタンを横に並べる行 (入らなければ折り返す)。スマホでも横に入る組と、副ボタンだけの行に使う。 */
export const LANDING_ACTION_ROW = 'flex flex-wrap items-center justify-center gap-2 sm:gap-3';

// 矢印つきの文字リンク (ボタンより弱い入口)。高さ 44px (押せる範囲)・14px の中太字・hover で下線。
// 矢印は LANDING_LINK_ARROW (hover で右へ少し動く)。リンク名は見えている文字だけ (矢印は aria-hidden・掟 8)。
const TEXT_LINK =
  'group inline-flex min-h-11 items-center gap-1 rounded-md text-sm font-semibold underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2';

export const LANDING_TEXT_LINK = {
  brand: `${TEXT_LINK} text-brand focus-visible:outline-brand`,
  shop: `${TEXT_LINK} text-emerald-800 focus-visible:outline-emerald-700`,
} as const;

/** 文字リンクの矢印 (lucide の ArrowRight に付ける)。hover で右へ動くのは、動きを減らす設定でないときだけ。 */
export const LANDING_LINK_ARROW = 'h-4 w-4 shrink-0 transition-transform motion-safe:group-hover:translate-x-0.5';

// 小さな注 (但し書き・開示の補足)。12px・行間 1.625・slate-600。
// slate-600 は、白 (7.6:1)・ページの地 slate-50 (7.2:1)・試算の淡い青の地 (7.0:1) のどれの上でも 4.5:1 を超える
// (slate-500 は淡い青の地の上で 4.4:1 になる)。
/** 注の字 (大きさ・行間・色) だけ。折り返しを自前で決めている所 (使い方の動画の注) で使う。 */
export const LANDING_NOTE_TEXT = 'text-xs leading-relaxed text-slate-600';

/** 注。左寄せ。表や囲みに付く注は、その幅のまま使う。 */
export const LANDING_NOTE = `${LANDING_NOTE_TEXT} [word-break:auto-phrase] supports-[word-break:auto-phrase]:text-pretty`;

/**
 * 中央寄せの節の注。スマホは左寄せ (何行にもなる注を中央寄せにすると行の頭がそろわず読みにくい)。
 * 幅を中身に合わせて中央に置く (w-fit) ので、1 行に入る短い注は中央に見える。sm 以上は中央寄せ。
 */
export const LANDING_NOTE_CENTERED = `${LANDING_NOTE} mx-auto w-fit max-w-2xl text-left sm:text-center`;

// 大きい数字 (0円〜・27 万円 など)。太さ・行の高さ・字間・数字の幅を 1 つにそろえる (料金のカード
// components/pricing/PricingPieces.tsx の SummaryCard と同じ)。色は「誰が払うか」などの意味なので、使う側が決める。
const FIGURE = 'font-extrabold leading-none tracking-tight tabular-nums';

export const LANDING_FIGURE = {
  /** 表のセルの中の数字。 */
  cell: `${FIGURE} text-xl`,
  /** カードの中の数字 (料金のカードと同じ 2.25rem)。カードの幅に合わせて縮めるときは、使う側が大きさだけを決める。 */
  card: `${FIGURE} text-4xl`,
  /** 節に 1 つだけの結果の数字 (試算の結果)。 */
  result: `${FIGURE} text-5xl`,
  /** 大きさを使う側が決めるとき (カードの幅に合わせて縮める導入メリットの数字)。上限は card と同じ 2.25rem にする。 */
  base: FIGURE,
} as const;

// ---- 入れ物の型 (P3) ----
// カードは 1 つの形 (角 2xl・白・低い影・淡い枠) にそろえる。枠は ring (box-shadow) で描き、幅を取らない。
// 形の違うもの (着色の入力の面 = 試算・料金のカード = /pricing と共有・主役の大きい面 = モバイルオーダーと締め・
// 比較表の外枠・実画面の見本) は、役割が違うので型にしない。

// カードの面 (角・白・低い影)。淡い枠 (ring) は、明るい地 (白い帯・slate-50) の上で白い面の縁を見せるためのもの。
const CARD_FACE = 'rounded-2xl bg-white shadow-card';

/** 静的なカード (導入メリット・特長・用途・3 ステップ・FAQ の外枠・なぜ今・注文リンク・見本の外枠・動画の枠)。 */
export const LANDING_CARD = `${CARD_FACE} ring-1 ring-slate-200/70`;

// 押せるカード (カード全体が 1 つのリンク)。hover は影を少し深くし、枠を濃くするだけ (浮かせない: 節のボタンと同じく
// 位置の動きを使わない)。focus の輪は節のボタンと同じ 2px・外側 2px。
const LINK_CARD_ACTION = 'transition hover:shadow-card-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2';

/** 押せるカード。色 (tone) は節の色: shop = 緑 (ガイドの入口)・onDark = 締めの濃い紺の面の上の白いカード (応援カード)。 */
export const LANDING_LINK_CARD = {
  shop: `${LANDING_CARD} ${LINK_CARD_ACTION} hover:ring-emerald-300 focus-visible:outline-emerald-700`,
  // 濃い紺の面の上では、白い面だけで縁が見える。淡い枠を付けると、白い面と地の間に灰色の縁が出る (撮って確かめた) ので付けない。
  // hover は中の飾りのボタンの色で分かる。focus の輪は白 (紺や緑の輪は地との差が小さく見えない・白は地との差 17.8:1)。
  onDark: `${CARD_FACE} ${LINK_CARD_ACTION} focus-visible:outline-white`,
} as const;

/**
 * カードの小見出しの大きさ・太さ・色 (14px・sm 以上 16px・中太字)。料金のカード (SummaryCard) と同じ。
 * タグ (h3 / span) と見出しの階層は使う側のまま。
 */
export const LANDING_CARD_TITLE = 'text-sm font-semibold text-slate-900 sm:text-base';

/**
 * アイコンの箱 (36px・角 xl)。中のアイコンは h-5 w-5。地の色と字の色は使う側が決める (誰が払うか・節の色の意味があるため)。
 * 箱なしの裸のアイコン (特長・用途・3 ステップ) は文字の頭の印なので、箱にしない。
 */
export const LANDING_ICON_BOX = 'grid h-9 w-9 shrink-0 place-items-center rounded-xl';

/**
 * 節の見出し (h2) の大きさ。md = ふつうの節・sm = 補足の節 (読みたい人が読む前提知識とよくある質問)。
 * 補足の節は 1 段小さくして、ふつうの節より一段弱く見せる (11 節が同じ強さで続いていた・P3)。
 */
export const LANDING_SECTION_TITLE = {
  md: 'text-[1.75rem] sm:text-4xl',
  sm: 'text-2xl sm:text-3xl',
} as const;

/**
 * 白い帯 (LandingBand) の上下の空き。帯の外 (上の節 → 帯の縁)・帯の中 (縁 → 中の節)・帯の後ろ (縁 → 次の節) を同じにする
 * (スマホ 48px・sm 以上 80px)。帯の後ろの節は自分の上の余白 (64 / 112px) を持つので、帯の側で「直後の節」の上の余白を
 * 打ち消す (帯の後ろの節は Store の flag で変わる = 販売の節が出ないときは AI の節。page.tsx で節ごとに付けると漏れる)。
 */
export const LANDING_BAND_SPACE = 'mt-12 py-12 sm:mt-20 sm:py-20 [&+section]:mt-12 sm:[&+section]:mt-20';
