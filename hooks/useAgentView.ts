'use client';

import { useSyncExternalStore } from 'react';

// /agent の並び順を決める「Agent Wallet を表示しているか」を、残高カード (持ち主) とページの並び (読み手) で共有する。
// 値を決めるのは残高カードだけ (端末の控え・?address= の復元後)。決まるまでは、描画前 script と同じ推定を使う。
let hasWallet: boolean | null = null;

// 再訪時に残高カードをすぐ出すための端末ローカルの控え (公開アドレスのみ・秘密ではない)。
export const AGENT_ADDRESS_STORAGE_KEY = 'openpay.agent.address';
// 推定は形だけを見る (checksum は見ない)。大文字小文字が混ざった不正な checksum のリンクは、
// 推定では Wallet あり → 残高カードの判定 (viem isAddress) で初回の並びへ 1 回だけ戻る。MCP のリンクは正しい checksum なので稀。
export const AGENT_ADDRESS_PATTERN = '^0x[0-9a-fA-F]{40}$';

const listeners = new Set<() => void>();

export function setAgentHasWallet(next: boolean): void {
  if (hasWallet === next) return;
  hasWallet = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function guessHasWallet(): boolean {
  // アプリ内のページ移動で来たときは描画前 script が走らない。残高カードの復元までの最初の描画を、
  // script と同じ推定でそろえる (再訪者に初回の並びが一瞬出るのを防ぐ)。ブラウザ API の失敗は「なし」扱いで描画へ波及させない。
  try {
    const pattern = new RegExp(AGENT_ADDRESS_PATTERN);
    return pattern.test(new URLSearchParams(window.location.search).get('address') ?? '') || pattern.test(window.localStorage.getItem(AGENT_ADDRESS_STORAGE_KEY) ?? '');
  } catch {
    return false;
  }
}

export function useAgentHasWallet(): boolean | null {
  // server と hydration は常に null (静的プリレンダリングの HTML は初回訪問の並び)。
  return useSyncExternalStore(subscribe, () => hasWallet ?? guessHasWallet(), () => null);
}

/** ページを離れるときに判定を捨てる (次に来たときに前回の値で並べない)。テストの初期化にも使う。 */
export function resetAgentView(): void {
  hasWallet = null;
}
