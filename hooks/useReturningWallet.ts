'use client';

import { useEffect, useRef, useSyncExternalStore } from 'react';

// トップの「あなたの OpenPay」帯を出すかの目印: この端末で前回 Wallet をつないだまま離れたか
// (plans/lp-polish-2026-09.md §2.4.1)。wagmi が localStorage に残す `wagmi.store` の `state.current`
// (接続中の uid・切断や再接続の失敗で null) を見る。今つながっている証明ではない (ロック中の Wallet でも立つ) ので、
// 決めるのは帯の枠を出すかだけ。売上などの個人の中身は wagmi の status === 'connected' で決める。
// key は lib/wagmi.ts の createStorage (既定の prefix 'wagmi') + zustand persist の名前 'store'
// (形は tests/hooks/useReturningWallet.contract.test.ts が実物の wagmi で確かめる)。
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

// この document で帯を一度出したか。描画前 script の結果を使うのは、この document で最初の帯だけ
// (アプリ内の移動で戻ってきた帯に、読み込み時の結果を持ち越さない)。ほかの場所の hydration の失敗で
// client が描き直した帯も「最初の帯」なので、script の結果を使い、枠を消さない。
let consumed = false;

/**
 * 帯の枠を出すか (user の操作によらない分)。hydration 中は null (静的 HTML は未接続の見た目・script の属性を消さない)。
 * この document で最初の帯は描画前 script の結果、アプリ内の移動で来た帯は mount の時点でつながっていたか
 * (wagmi の状態はもう確定している)。どちらも開いたときに 1 回決めるだけで、後の再接続では変えない (押し下げない)。
 */
export function useReturningWallet(connectedNow: boolean): { hydrating: boolean; returning: boolean | null } {
  const hydrating = useSyncExternalStore(noopSubscribe, () => false, () => true);
  const firstInDocument = useRef(!consumed);
  const connectedAtMount = useRef(connectedNow);
  useEffect(() => {
    consumed = true;
  }, []);
  if (hydrating) return { hydrating, returning: null };
  return { hydrating, returning: firstInDocument.current ? readPrepaint() : connectedAtMount.current };
}

/** テストの初期化 (新しい document を開いた状態に戻す)。 */
export function resetReturningWalletForTest(): void {
  consumed = false;
}
