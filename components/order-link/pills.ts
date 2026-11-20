// 注文リンクの画面の切り替えの並び (リンクの種類・注文の送り先・消費税・サイトのボタンの設置のしかた)。押したものを白く浮かせる。
export const ORDER_LINK_PILL_GROUP = 'grid gap-1 rounded-xl bg-slate-100 p-1';

export const orderLinkPillClass = (active: boolean) =>
  `min-h-11 rounded-lg px-2 text-sm font-semibold transition-colors ${
    active ? 'bg-white text-slate-900 shadow-sm ring-1 ring-slate-200' : 'text-slate-600 hover:text-slate-900'
  }`;
