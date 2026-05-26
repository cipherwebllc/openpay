// cross-chain 決済の中断再開用 state を localStorage に永続化する。
// ページ再読込 / クラッシュ後でも、同じ決済 (同 account/chain/recipient/金額) を
// 再実行すれば完了済みステップを skip して続きから再開できる (execute.ts の
// resume / onStep と対で使う)。
//
// resume state は Hex (tx hash / attestation) のみで bigint を含まないため JSON で
// そのまま serialize できる。session key に金額・chain・recipient を含めるので、
// 別の決済に stale state が誤適用されることはない。

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
  const raw = s.getItem(keyString(k));
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    // corrupt な entry は無視して新規実行扱い (決済開始を block しない)。
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

export function clearResumeState(k: ResumeSessionKey): void {
  const s = storage();
  if (!s) return;
  s.removeItem(keyString(k));
}

export function hasResumeState(k: ResumeSessionKey): boolean {
  const s = storage();
  if (!s) return false;
  return s.getItem(keyString(k)) !== null;
}
