// /agent の見た目の定数 (server の page と client の残高カードで共有するため 'use client' の外に置く)。

// 描画前の script が Wallet ありと判定した再訪で、復元前の残高カードに予約する高さ (見出し + 残高の面の実測)。
// 初回訪問 (属性なし) の空状態は短いので予約しない。
export const AGENT_WALLET_RESERVE = 'group-data-[agent-view=wallet]:min-h-[18rem] sm:group-data-[agent-view=wallet]:min-h-[16.5rem]';

// 再訪 (Wallet あり) の PC (lg 以上) はダッシュボード: 左の主列 = 残高・活動・購入 → 頼めること、右の列 = 接続・上限の注意・手動設定・リンク。
// 初回訪問は 1 列のまま (セットアップは 1 本の流れで読むほうが迷わない)。
// 行は [残高][頼めること] の 2 本。右の列は React の判定後に接続と残りを 1 つの要素 (aside) にまとめて 1〜2 行目にまたがらせ、
// 左右がそれぞれ独立に縦へ積まれるようにする (右の列が長くても頼めることが押し下げられず、左の列に空白ができない)。
// 残高と頼めることの親は変えない (残高カードを作り直さず、入力中のフォーカスも失わない)。
// 描画前 (script の判定だけ・DOM はまだ初回訪問の並び) は、接続を右の 1 行目・残りを右の 2 行目に置く暫定の配置。
export const AGENT_PAGE_WIDTH = 'mx-auto min-w-0 max-w-3xl lg:data-[agent-view=wallet]:max-w-none';
export const AGENT_PAGE_GRID = 'flex min-w-0 flex-col gap-8 lg:group-data-[agent-view=wallet]:grid lg:group-data-[agent-view=wallet]:grid-cols-[minmax(0,1fr)_20rem] lg:group-data-[agent-view=wallet]:grid-rows-[auto_1fr] lg:group-data-[agent-view=wallet]:items-start';
export const AGENT_PAGE_AREA = {
  wallet: 'lg:group-data-[agent-view=wallet]:col-start-1 lg:group-data-[agent-view=wallet]:row-[1/2]',
  tryPrompts: 'lg:group-data-[agent-view=wallet]:col-start-1 lg:group-data-[agent-view=wallet]:row-[2/3]',
  connect: 'lg:group-data-[agent-view=wallet]:col-start-2 lg:group-data-[agent-view=wallet]:row-[1/2]',
  rest: 'lg:group-data-[agent-view=wallet]:col-start-2 lg:group-data-[agent-view=wallet]:row-[2/3]',
  aside: 'lg:group-data-[agent-view=wallet]:col-start-2 lg:group-data-[agent-view=wallet]:row-[1/3]',
} as const;
// 右の列の中で 2 列に分かれる grid (使い方の 2 択・手動設定の入力) は 1 列に戻す (幅 20rem では選択肢の文字が切れる)。
export const AGENT_SIDE_SINGLE_COLUMN = 'lg:group-data-[agent-view=wallet]:grid-cols-1';
