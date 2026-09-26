'use client';

import { useSyncExternalStore, type ReactNode } from 'react';
import { AGENT_ADDRESS_STORAGE_KEY, useAgentHasWallet } from '@/hooks/useAgentView';

// 静的 HTML は初回訪問の並び (接続が先頭)。再訪者 (端末の控え or ?address= のリンク) は描画前にこの script が
// 並びを Wallet 先頭へ切り替え、残高カードの復元 (hydration 後) を待つ間に接続カードが先頭でちらつくのを防ぐ。
// 失敗しても初回訪問の並びのまま表示され、復元後に React が並べ直す (ブラウザ API の失敗を描画へ波及させない)。
// ⚠️ CSP の script-src が 'unsafe-inline' 前提 (next.config.mjs)。nonce 方式へ移るときはこの script にも nonce を渡す。
export const AGENT_VIEW_PREPAINT = `(function(){try{var r=/^0x[0-9a-fA-F]{40}$/,q=new URLSearchParams(location.search).get('address')||'';if(r.test(q)||r.test(localStorage.getItem(${JSON.stringify(AGENT_ADDRESS_STORAGE_KEY)})||''))document.currentScript.parentElement.setAttribute('data-agent-view','wallet')}catch(e){}})()`;

const noopSubscribe = () => () => {};

type Slot = { readonly key: string; readonly node: ReactNode; readonly className: string };

// 状態で変わるのは先頭 3 節の順番だけ。初回訪問: 接続 → Wallet → 頼めること。Wallet あり: Wallet → 頼めること → 接続。
// CSS の order は描画前 (script) の見た目用、DOM の並べ替えは復元後の読み上げ・フォーカス順用。両者の順番は一致させる。
export function AgentPageSections({ connect, wallet, tryPrompts, children }: { connect: ReactNode; wallet: ReactNode; tryPrompts: ReactNode; children: ReactNode }) {
  const hasWallet = useAgentHasWallet();
  // script は server の HTML と hydration のときだけ描く。client だけの描画 (ページ間の移動) では実行されない
  // (React は client で作った script を実行しない) ので描かず、hydration 後も DOM から外す。
  const prerendered = useSyncExternalStore(noopSubscribe, () => false, () => true);
  const connectSlot: Slot = { key: 'connect', node: connect, className: 'order-1 group-data-[agent-view=wallet]:order-3' };
  const walletSlot: Slot = { key: 'wallet', node: wallet, className: 'order-2 group-data-[agent-view=wallet]:order-1' };
  const trySlot: Slot = { key: 'try', node: tryPrompts, className: 'order-3 group-data-[agent-view=wallet]:order-2' };
  const slots = hasWallet ? [walletSlot, trySlot, connectSlot] : [connectSlot, walletSlot, trySlot];
  return (
    // 未確定 (null) の間は属性を描かず、script が付けた値を hydration で消さない。確定後は明示の値で上書きする
    // (script の推定と残高カードの判定が食い違っても、判定のほうへ揃う)。
    <div data-agent-view={hasWallet === null ? undefined : hasWallet ? 'wallet' : 'setup'} suppressHydrationWarning className="group flex min-w-0 flex-col gap-8">
      {prerendered ? <script dangerouslySetInnerHTML={{ __html: AGENT_VIEW_PREPAINT }} /> : null}
      {slots.map((slot) => <div key={slot.key} className={`min-w-0 ${slot.className}`}>{slot.node}</div>)}
      <div className="order-4 flex min-w-0 flex-col gap-8">{children}</div>
    </div>
  );
}
