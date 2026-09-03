// cross-chain 決済の中断再開用 state を localStorage に永続化する。
// ページ再読込 / クラッシュ後でも、同じ決済 (同 account/chain/recipient/金額) を
// 再実行すれば完了済みステップを skip して続きから再開できる (execute.ts の
// resume / onStep と対で使う)。
//
// resume state は Hex (tx hash / attestation) と 10 進文字列 (burn-intent marker の
// block / amount) だけで bigint を含まないため JSON でそのまま serialize できる。
// session key に金額・chain・recipient を含めるので、別の決済に stale state が誤適用される
// ことはない。
//
// 書込は 2 系統ある:
//   - saveResumeState      : best-effort (失敗しても決済本体を止めない)。既存の step 記録用。
//   - saveResumeStateStrict: fail-closed (read-back 検証、失敗は throw)。CCTP burn の
//     burn-intent marker 専用 — 「marker を書けないなら burn しない」を成立させるため。

import type { Address } from 'viem';
import type { CctpResumeState, GatewayResumeState } from './execute';
import { logger } from '../logger';

export type ResumeState = CctpResumeState | GatewayResumeState;

export interface ResumeSessionKey {
  account: Address;
  kind: 'gateway' | 'cctp-v2';
  sourceChainId: number;
  destChainId: number;
  recipient: Address;
  /** merchant 本送金額 (atomic) */
  valueAtomic: bigint;
  /** OpenPay 利用料 (atomic) */
  feeAtomic: bigint;
}

const PREFIX = 'openpay.xchain.resume.';

// SSR / localStorage 非対応環境では undefined を返し、保存系は no-op になる。
// sandboxed iframe 等で window.localStorage アクセス自体が SecurityError を投げる
// ケースも握り潰して undefined にする (永続化は best-effort)。
function storage(): Storage | undefined {
  try {
    if (typeof window === 'undefined') return undefined;
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function keyString(k: ResumeSessionKey): string {
  return (
    PREFIX +
    [
      k.kind,
      k.sourceChainId,
      k.destChainId,
      k.account,
      k.recipient,
      k.valueAtomic.toString(),
      k.feeAtomic.toString(),
    ].join(':')
  ).toLowerCase();
}

export function loadResumeState<T extends ResumeState>(
  k: ResumeSessionKey,
): T | undefined {
  const s = storage();
  if (!s) return undefined;
  try {
    const raw = s.getItem(keyString(k));
    if (!raw) return undefined;
    return JSON.parse(raw) as T;
  } catch (error) {
    // getItem が throw する環境 / corrupt な entry は無視して新規実行扱いにする
    // (決済開始を block しない)。
    logger.warn('cross-chain.resume.load-failed', { error });
    return undefined;
  }
}

export function saveResumeState(k: ResumeSessionKey, state: ResumeState): void {
  const s = storage();
  if (!s) return;
  try {
    s.setItem(keyString(k), JSON.stringify(state));
  } catch (error) {
    // quota 超過 / private mode 等で setItem が throw しても、進行中の決済を
    // 巻き込まない (永続化は best-effort、resume が効かなくなるだけ)。決済本体は
    // 続行させる。
    logger.warn('cross-chain.resume.save-failed', { error });
  }
}

/** 記録できないまま送金させないための例外 (掟 13: 偽成功を作らない)。 */
export class ResumeStoreWriteError extends Error {
  constructor(detail: string) {
    super(`cross-chain resume state を保存できません: ${detail}`);
    this.name = 'ResumeStoreWriteError';
  }
}

/** fail-closed 書込: setItem 後に read-back して書けたことを確証する。private mode の
 *  silent drop / quota 超過をここで検出し、確証できなければ throw する。
 *  何の波及を断つ防御か: 「marker を書けていないのに burn を broadcast する」= 再開時に
 *  未 burn と誤判定して二重支払いになる経路そのものを断つ (lib/circlePending.ts と同型)。 */
export function saveResumeStateStrict(
  k: ResumeSessionKey,
  state: ResumeState,
): void {
  const s = storage();
  if (!s) throw new ResumeStoreWriteError('localStorage が使えません (SSR / private mode)');
  const key = keyString(k);
  const serialized = JSON.stringify(state);
  try {
    s.setItem(key, serialized);
  } catch (error) {
    throw new ResumeStoreWriteError(`setItem throw: ${String(error)}`);
  }
  let back: string | null;
  try {
    back = s.getItem(key);
  } catch (error) {
    throw new ResumeStoreWriteError(`read-back throw: ${String(error)}`);
  }
  if (back !== serialized) {
    throw new ResumeStoreWriteError('read-back 不一致 (quota silent drop の疑い)');
  }
}

export function clearResumeState(k: ResumeSessionKey): void {
  const s = storage();
  if (!s) return;
  try {
    s.removeItem(keyString(k));
  } catch (error) {
    // removeItem が throw しても完了済みの決済を error にしない (best-effort)。
    logger.warn('cross-chain.resume.clear-failed', { error });
  }
}

export function hasResumeState(k: ResumeSessionKey): boolean {
  const s = storage();
  if (!s) return false;
  try {
    return s.getItem(keyString(k)) !== null;
  } catch {
    // getItem が throw する環境では「resume なし」扱い (render を巻き込まない)。
    return false;
  }
}
