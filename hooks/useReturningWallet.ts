'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';

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
// 結果 (true / false) は読めなかったとき (localStorage の例外・壊れた JSON) も false で残す = この読み込みで script が
// 走った印。React はこの印の有無で、script が走った読み込みと、別のページから client の遷移で来た (script は走っていない)
// ときを見分ける。失敗は「出さない」に倒す (ブラウザ API の失敗を描画へ波及させない)。
// 再訪なら帯の外枠に 2 つの属性を付ける。data-returning = 帯を出す (このページで user がつないだときも React が yes にする)・
// data-returning-open = 開いたときに再訪と判定した (React も開いたときの判定だけで決める)。ヒーローを小さくするのは後者だけ
// (components/LandingHero.tsx・このページでつないだときに縮めると、接続のときのずれが増える)。
// ⚠️ CSP の script-src が 'unsafe-inline' 前提 (next.config.mjs)。nonce 方式へ移るときはこの script にも nonce を渡す。
export const RETURNING_WALLET_PREPAINT = `(function(){var y=false;try{var s=JSON.parse(localStorage.getItem(${JSON.stringify(WAGMI_STORE_KEY)})||'null');y=!!(s&&s.state&&s.state.current)}catch(e){}window.${PREPAINT_GLOBAL}=y;if(y){var p=document.currentScript.parentElement;p.setAttribute('data-returning','yes');p.setAttribute('data-returning-open','yes')}})()`;

/** 描画前 script の結果。この読み込みで script が走っていない (または、もう使った) ときは null。 */
function readPrepaint(): boolean | null {
  const value = (window as unknown as Record<string, unknown>)[PREPAINT_GLOBAL];
  return typeof value === 'boolean' ? value : null;
}

const noopSubscribe = () => () => {};

/**
 * 開いたときに再訪と判定したか (user の操作によらない分)。hydration 中は null (静的 HTML は未接続の見た目・script の属性を消さない)。
 * 描画前 script が走った読み込みで最初に mount した帯は、script の結果。script が走っていない帯 (別のページから client の
 * 遷移で来た・アプリ内の移動で戻ってきた) は、mount の時点でつながっていたか (wagmi の状態はもう確定している)。
 * どちらも開いたときに 1 回決めるだけで、後の再接続では変えない (押し下げない)。
 */
export function useReturningWallet(connectedNow: boolean): { hydrating: boolean; returning: boolean | null } {
  const hydrating = useSyncExternalStore(noopSubscribe, () => false, () => true);
  // mount の時点で決める (初期化は mount の 1 回だけ)。server には window が無いので決めない (hydration の間は使わない)。
  // hydration に失敗して client が帯を作り直したときは、まだ結果を使っていない (効果は commit の後) ので、script の結果を使う。
  const [atMount] = useState<boolean | null>(() => (typeof window === 'undefined' ? null : (readPrepaint() ?? connectedNow)));
  useEffect(() => {
    // script の結果は、この読み込みで最初に mount した帯の 1 回だけ使う。消しておかないと、アプリ内の移動で戻ってきた帯が
    // 読み込みのときの古い結果を使う (その間の切断・接続を無視して、出す / 出さないを決めてしまう)。
    delete (window as unknown as Record<string, unknown>)[PREPAINT_GLOBAL];
  }, []);
  if (hydrating) return { hydrating, returning: null };
  return { hydrating, returning: atMount };
}

/** テストの初期化 (新しい document を開いた状態に戻す = 描画前 script の結果が無い)。 */
export function resetReturningWalletForTest(): void {
  delete (window as unknown as Record<string, unknown>)[PREPAINT_GLOBAL];
}
