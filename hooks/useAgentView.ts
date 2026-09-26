'use client';

import { useSyncExternalStore } from 'react';

// /agent の並び順を決める「Agent Wallet を表示しているか」を、残高カード (持ち主) とページの並び (読み手) で共有する。
// 値を決めるのは残高カードだけ (端末の控え・?address= の復元後)。復元前は null = 未確定 (初回訪問と同じ並び)。
let hasWallet: boolean | null = null;

// 再訪時に残高カードをすぐ出すための端末ローカルの控え (公開アドレスのみ・秘密ではない)。
export const AGENT_ADDRESS_STORAGE_KEY = 'openpay.agent.address';
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

export function useAgentHasWallet(): boolean | null {
  // server と hydration は常に null (静的プリレンダリングの HTML は初回訪問の並び)。
  return useSyncExternalStore(subscribe, () => hasWallet, () => null);
}

/** テスト専用: モジュールの状態を初期化する。 */
export function resetAgentViewForTest(): void {
  hasWallet = null;
}
