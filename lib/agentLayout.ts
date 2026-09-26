// /agent の見た目の定数 (server の page と client の残高カードで共有するため 'use client' の外に置く)。

// 描画前の script が Wallet ありと判定した再訪で、復元前の残高カードに予約する高さ (見出し + 残高の面の実測)。
// 初回訪問 (属性なし) の空状態は短いので予約しない。
export const AGENT_WALLET_RESERVE = 'group-data-[agent-view=wallet]:min-h-[18rem] sm:group-data-[agent-view=wallet]:min-h-[16.5rem]';

// 再訪 (Wallet あり) の PC (lg 以上) はダッシュボード: 左の主列 = 残高・活動・購入 → 頼めること、右の列 = 接続・上限の注意・手動設定・リンク。
// 初回訪問は 1 列のまま (セットアップは 1 本の流れで読むほうが迷わない)。どちらも data-agent-view で切り替えるので
// 描画前 script の判定にも追従する (要素の親は変えない: 残高カードを作り直さず、入力中のフォーカスも失わない)。
// 行 = [右 1][右 2][余白 1fr][頼めること]。残高カードは 1〜3 行目にまたがり、右の列より長いぶんは 3 行目が吸収する
// (差が右の項目の行に配られて、右の項目の間が空くのを防ぐ)。
export const AGENT_PAGE_WIDTH = 'mx-auto min-w-0 max-w-3xl lg:data-[agent-view=wallet]:max-w-none';
export const AGENT_PAGE_GRID = 'flex min-w-0 flex-col gap-8 lg:group-data-[agent-view=wallet]:grid lg:group-data-[agent-view=wallet]:grid-cols-[minmax(0,1fr)_20rem] lg:group-data-[agent-view=wallet]:grid-rows-[auto_auto_1fr_auto] lg:group-data-[agent-view=wallet]:items-start';
export const AGENT_PAGE_AREA = {
  wallet: 'lg:group-data-[agent-view=wallet]:col-start-1 lg:group-data-[agent-view=wallet]:row-[1/4]',
  tryPrompts: 'lg:group-data-[agent-view=wallet]:col-start-1 lg:group-data-[agent-view=wallet]:row-[4/5]',
  connect: 'lg:group-data-[agent-view=wallet]:col-start-2 lg:group-data-[agent-view=wallet]:row-[1/2]',
  rest: 'lg:group-data-[agent-view=wallet]:col-start-2 lg:group-data-[agent-view=wallet]:row-[2/3]',
} as const;
