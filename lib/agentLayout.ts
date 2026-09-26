// /agent の見た目の定数 (server の page と client の残高カードで共有するため 'use client' の外に置く)。

// 描画前の script が Wallet ありと判定した再訪で、復元前の残高カードに予約する高さ (見出し + 残高の面の実測)。
// 初回訪問 (属性なし) の空状態は短いので予約しない。
export const AGENT_WALLET_RESERVE = 'group-data-[agent-view=wallet]:min-h-[18rem] sm:group-data-[agent-view=wallet]:min-h-[16.5rem]';
