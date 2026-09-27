'use client';

import { useRef, useSyncExternalStore } from 'react';

// トップの「あなたの OpenPay」帯を出すかの目印: この端末で前回 Wallet をつないだまま離れたか
// (plans/lp-polish-2026-09.md §2.4.1)。wagmi が localStorage に残す `wagmi.store` の `state.current`
// (接続中の uid・切断すると null) を見る。今つながっている証明ではない (再接続の失敗・未承認の Wallet でも立つ) ので、
// 決めるのは帯の枠を出すかだけ。売上などの個人の中身は wagmi の status === 'connected' で決める。
// key は lib/wagmi.ts の createStorage (既定の prefix 'wagmi') + zustand persist の名前 'store'。
export const WAGMI_STORE_KEY = 'wagmi.store';
const PREPAINT_GLOBAL = '__openpayReturningWallet';

// 描画前 script (server の HTML と hydration のときだけ描く)。帯の枠を最初の描画から出し、後から押し下げない。
// 読むのはこの script だけ: wagmi は起動時 (hydration より前) に初期状態 (current: null) を `wagmi.store` へ書き戻すので、
// 後から localStorage を読むと前回の状態は消えている (2026-09-28 実測)。結果は window に残し、hydration 後の判定に使う。
// 失敗は「出さない」に倒す (ブラウザ API の失敗を描画へ波及させない)。
// ⚠️ CSP の script-src が 'unsafe-inline' 前提 (next.config.mjs)。nonce 方式へ移るときはこの script にも nonce を渡す。
export const RETURNING_WALLET_PREPAINT = `(function(){try{var s=JSON.parse(localStorage.getItem(${JSON.stringify(WAGMI_STORE_KEY)})||'null'),y=!!(s&&s.state&&s.state.current);window.${PREPAINT_GLOBAL}=y;if(y)document.currentScript.parentElement.setAttribute('data-returning','yes')}catch(e){}})()`;

function readPrepaint(): boolean {
  return (window as unknown as Record<string, unknown>)[PREPAINT_GLOBAL] === true;
}

const noopSubscribe = () => () => {};

/**
 * 帯の枠を出すか。hydration 中は null (静的 HTML は未接続の見た目・script の属性を消さない)。
 * 静的 HTML から hydrate した帯は描画前 script の結果を使い、アプリ内の移動で来た帯は使わない
 * (wagmi の状態がもう確定しているので status だけで決める・前回の script の結果を持ち越さない)。
 */
export function useReturningWallet(): { hydrating: boolean; returning: boolean | null } {
  const hydrating = useSyncExternalStore(noopSubscribe, () => false, () => true);
  const fromStaticHtml = useRef(hydrating);
  if (hydrating) return { hydrating, returning: null };
  return { hydrating, returning: fromStaticHtml.current && readPrepaint() };
}
