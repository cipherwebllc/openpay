// cross-chain 決済の中断再開用 state を localStorage に永続化する。
// ページ再読込 / クラッシュ後でも、同じ決済 (同 account/chain/recipient/金額) を
// 再実行すれば完了済みステップを skip して続きから再開できる (execute.ts の
// resume / onStep と対で使う)。
//
// resume state は Hex (tx hash / attestation) と 10 進文字列 (burn-intent marker の
// block / amount) だけで bigint を含まないため JSON でそのまま serialize できる。
// 同額・同宛先の別請求に invoice nonce はない。Gateway 完了記録は必ず別ストアへ移し、
// 再開走査・次の請求の成功判定から除外する。
//
// 書込は 2 系統ある:
//   - saveResumeState      : best-effort (失敗しても決済本体を止めない)。既存の step 記録用。
//   - saveResumeStateStrict: fail-closed (read-back 検証、失敗は throw)。CCTP burn の
//     burn-intent marker と Gateway identity 用 — 永続化できなければ送金認可しない。

import type { Address } from 'viem';
import type { CctpResumeState, GatewayResumeState } from './execute';
import { logger } from '../logger';
import { activeGatewayAttempt, gatewayAttemptAbandoned, gatewayHasOutstanding, type GatewayRequestGuard, type GatewayAttempt } from './gatewayRecovery';

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

export type DiscriminatedResumeState =
  | { kind: 'absent' }
  | { kind: 'present'; state: CctpResumeState }
  | { kind: 'unreadable'; error: Error };
/** Arc 専用の fail-closed 読取。既存 loader の malformed 挙動は変えない。 */
export function loadResumeStateDiscriminated(k: ResumeSessionKey): DiscriminatedResumeState {
  try {
    if (typeof window === 'undefined') throw new Error('Storage unavailable');
    const raw = window.localStorage.getItem(keyString(k));
    if (raw === null) return { kind: 'absent' };
    const state = JSON.parse(raw) as CctpResumeState;
    if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('Invalid resume record');
    if (!state.burnIntent && !state.burnTxHash) throw new Error('Forward record has no burn marker or hash');
    const f = state.forward;
    if (!f || !['intent', 'broadcast', 'source-confirmed', 'awaiting-forward', 'forward-observed', 'verified'].includes(f.state) ||
        !f.acceptedQuote || !/^\d+$/.test(f.scanFromBlock)) throw new Error('Invalid forwarding record');
    const q = f.acceptedQuote;
    if (!Number.isSafeInteger(q.quotedAt) || !Number.isSafeInteger(q.expiresAt) || q.expiresAt !== q.quotedAt + 300_000 ||
        !Number.isSafeInteger(q.minimumFeeBpsX1000) || !/^\d+$/.test(q.forwardFeeAtomic) ||
        !/^\d+$/.test(q.grossAtomic) || !/^\d+$/.test(q.maxFeeAtomic) ||
        !/^\d+$/.test(q.valueAtomic) || !/^0x[0-9a-fA-F]{40}$/.test(q.recipient) ||
        q.sourceChainId !== k.sourceChainId || q.destChainId !== k.destChainId ||
        q.recipient.toLowerCase() !== k.recipient.toLowerCase() || q.valueAtomic !== String(k.valueAtomic)) throw new Error('Invalid quote binding');
    return { kind: 'present', state };
  } catch (error) {
    // 読めない記録を「支払いなし」にして二重支払いを開く波及を断つ。
    return { kind: 'unreadable', error: error instanceof Error ? error : new Error(String(error)) };
  }
}

export type GatewayStoredEntry = { kind: 'absent' } | { kind: 'present'; state: GatewayResumeState } | { kind: 'unreadable'; error: Error };
function readGatewayResumeState(k: ResumeSessionKey): GatewayStoredEntry {
  try {
    if (typeof window === 'undefined') throw new Error('Storage unavailable');
    const raw = window.localStorage.getItem(keyString(k));
    if (raw === null) return { kind: 'absent' };
    const state = JSON.parse(raw) as GatewayResumeState;
    if (!state || typeof state !== 'object' || Array.isArray(state) ||
        (!state.merchant && !state.merchantAttestation) ||
        (state.completion !== undefined && !['confirming', 'settled'].includes(state.completion))) throw new Error('Invalid Gateway resume record');
    for (const leg of [state.merchant, state.fee]) {
      if (!leg) continue;
      if (!Array.isArray(leg.attempts) || !leg.attempts.length || leg.attempts.some((a) =>
        !a || !/^0x[\da-f]{64}$/i.test(a.transferSpecHash) || !a.spec || !/^\d+$/.test(a.spec.value) ||
        !Array.isArray(a.txHashes) || !Array.isArray(a.observations))) throw new Error('Invalid Gateway leg identity');
    }
    return { kind: 'present', state };
  } catch (error) {
    // Storage corruption/unavailability cannot become permission to issue another authorization.
    return { kind: 'unreadable', error: error instanceof Error ? error : new Error(String(error)) };
  }
}

export function loadGatewayResumeState(k: ResumeSessionKey): GatewayStoredEntry {
  const entry = readGatewayResumeState(k);
  if (entry.kind !== 'present') return entry;
  const state = entry.state;
  // A paid observation can precede completion notification; only explicit completion releases the invoice.
  if (state.completion !== 'settled') return entry;
  try {
    archiveGatewayResumeState(k, state);
    return { kind: 'absent' };
  } catch (error) {
    // An incomplete move must keep the active record so receipt evidence is never silently discarded.
    return { kind: 'unreadable', error: error instanceof Error ? error : new Error(String(error)) };
  }
}

export function scanGatewayResumeStates(scope: Omit<ResumeSessionKey, 'kind' | 'sourceChainId'>):
  { kind: 'ok'; entries: { key: ResumeSessionKey; state: GatewayResumeState }[] } | { kind: 'unreadable'; error: Error } {
  try {
    if (typeof window === 'undefined') throw new Error('Storage unavailable');
    const store = window.localStorage;
    const entries: { key: ResumeSessionKey; state: GatewayResumeState }[] = [];
    const names = Array.from({ length: store.length }, (_, i) => store.key(i));
    for (const name of names) {
      if (!name?.startsWith(`${PREFIX}gateway:`)) continue;
      const parts = name.slice(PREFIX.length).split(':');
      const [, source, dest, account, recipient, value, fee] = parts;
      if (account !== scope.account.toLowerCase() || dest !== String(scope.destChainId) ||
          recipient !== scope.recipient.toLowerCase() || value !== String(scope.valueAtomic) || fee !== String(scope.feeAtomic)) continue;
      if (parts.length !== 7) throw new Error('Malformed Gateway storage key');
      if (!/^\d+$/.test(source) || !Number.isSafeInteger(Number(source))) throw new Error('Malformed Gateway source');
      const key: ResumeSessionKey = { ...scope, kind: 'gateway', sourceChainId: Number(source) };
      const entry = loadGatewayResumeState(key);
      if (entry.kind === 'unreadable') return entry;
      if (entry.kind === 'present' && gatewayHasOutstanding(entry.state)) entries.push({ key, state: entry.state });
    }
    return { kind: 'ok', entries };
  } catch (error) {
    // Failed enumeration must keep the parent lock, even if balance routing yields no options.
    return { kind: 'unreadable', error: error instanceof Error ? error : new Error(String(error)) };
  }
}


/** Preserve every identity when another tab has written since our initial read. */
export function saveGatewayResumeStateStrict(k: ResumeSessionKey, next: GatewayResumeState, beforeSigning?: GatewayResumeState, beforeRequest?: GatewayRequestGuard): void {
  const entry = readGatewayResumeState(k);
  if (entry.kind === 'unreadable') throw entry.error;
  const current = entry.kind === 'present' ? entry.state : {};
  if (beforeRequest) {
    // Re-read immediately before the request marker: another tab's abandonment must prevent a second transfer.
    const active = activeGatewayAttempt(current[beforeRequest.phase]);
    if (!active || active.transferSpecHash !== beforeRequest.transferSpecHash || active.status !== 'unknown' ||
        !active.intent?.signature || active.intent.requestSentAt !== undefined) {
      throw new ResumeStoreWriteError('Gateway attempt changed before transfer request');
    }
  }
  if (beforeSigning) {
    // A concurrent authorization must stop signing, not be overwritten by our stale replacement.
    for (const phase of ['merchant', 'fee'] as const) {
      if (activeGatewayAttempt(current[phase])?.transferSpecHash !== activeGatewayAttempt(beforeSigning[phase])?.transferSpecHash) {
        throw new ResumeStoreWriteError('Gateway attempt changed before signing');
      }
    }
  }
  const merged = { ...current, ...next };
  for (const phase of ['merchant', 'fee'] as const) {
    if (!current[phase]) continue;
    const incoming = new Map(next[phase]?.attempts.map((a) => [a.transferSpecHash, a]));
    const attempts: GatewayAttempt[] = current[phase].attempts.map((old) => {
      const update = incoming.get(old.transferSpecHash);
      incoming.delete(old.transferSpecHash);
      if (!update) return old;
      // A late wallet result must not revive an authorization another tab has already released.
      return { ...old, ...update, status: gatewayAttemptAbandoned(old) ? old.status : update.status, attestation: update.attestation ?? old.attestation,
        txHashes: [...new Set([...old.txHashes, ...update.txHashes])],
        observations: [...new Map([...old.observations, ...update.observations].map((o) => [JSON.stringify(o), o])).values()] };
    });
    // Preserve concurrent attempts after our known identities so they remain outstanding.
    const known = new Set(next[phase]?.attempts.map((a) => a.transferSpecHash));
    merged[phase] = { attempts: [...attempts.filter((a) => known.has(a.transferSpecHash)), ...incoming.values(),
      ...attempts.filter((a) => !known.has(a.transferSpecHash))] };
  }
  saveResumeStateStrict(k, merged);
}

const GATEWAY_RECEIPTS_PREFIX = 'openpay.xchain.gateway.receipts.';
export interface GatewayReceiptRecord {
  session: Omit<ResumeSessionKey, 'valueAtomic' | 'feeAtomic'> & { valueAtomic: string; feeAtomic: string };
  state: GatewayResumeState;
}
function receiptKey(record: GatewayReceiptRecord): string {
  return `${GATEWAY_RECEIPTS_PREFIX}${record.session.account}:${record.session.destChainId}:${activeGatewayAttempt(record.state.merchant)!.transferSpecHash}`.toLowerCase();
}
export function saveGatewayReceipt(record: GatewayReceiptRecord): void {
  const store = storage();
  if (!store) throw new ResumeStoreWriteError('Gateway receipt storage unavailable');
  const key = receiptKey(record); const raw = JSON.stringify(record);
  store.setItem(key, raw);
  if (store.getItem(key) !== raw) throw new ResumeStoreWriteError('Gateway receipt read-back mismatch');
}
export function archiveGatewayResumeState(k: ResumeSessionKey, state: GatewayResumeState): void {
  if (state.completion !== 'settled') throw new ResumeStoreWriteError('Gateway finality missing');
  const store = storage();
  if (!store) throw new ResumeStoreWriteError('Gateway receipt storage unavailable');
  const key = keyString(k); const raw = store.getItem(key);
  const current = raw ? JSON.parse(raw) as GatewayResumeState : state;
  // Archiving a stale result must never remove a concurrently created payment or its fee attempt.
  for (const phase of ['merchant', 'fee'] as const) {
    if (activeGatewayAttempt(current[phase])?.transferSpecHash !== activeGatewayAttempt(state[phase])?.transferSpecHash) {
      throw new ResumeStoreWriteError('Gateway attempt changed before archival');
    }
  }
  saveGatewayReceipt({ session: { ...k, valueAtomic: String(k.valueAtomic), feeAtomic: String(k.feeAtomic) }, state: { ...state, ...current, completion: state.completion, feeUnresolved: state.feeUnresolved } });
  if (store.getItem(key) !== raw) throw new ResumeStoreWriteError('Gateway attempt changed during archival');
  store.removeItem(key);
}

/** Receipts are not resume candidates. Failure here cannot lock a new invoice or fire onSuccess. */
export function loadGatewayReceipts(account: Address, destChainId: number): GatewayReceiptRecord[] {
  const result: GatewayReceiptRecord[] = [];
  try {
    const store = storage();
    if (!store) return result;
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i);
      if (!key?.startsWith(`${GATEWAY_RECEIPTS_PREFIX}${account}:${destChainId}:`.toLowerCase())) continue;
      try {
        const record = JSON.parse(store.getItem(key)!) as GatewayReceiptRecord;
        if (record.session.account.toLowerCase() === account.toLowerCase() && record.session.destChainId === destChainId &&
            ['confirming', 'settled'].includes(record.state.completion ?? '') && activeGatewayAttempt(record.state.merchant)) result.push(record);
      } catch {
        // One damaged receipt must not prevent backfilling the other completed payments.
      }
    }
  } catch {
    // Storage access failures in optional backfill must not affect the active payment.
  }
  return result;
}


/** Own successful receipts remain on their invoice key until finality; unrelated invoices are unblocked. */
export function loadGatewayConfirmingStates(account: Address, destChainId: number): { key: ResumeSessionKey; state: GatewayResumeState }[] {
  const entries: { key: ResumeSessionKey; state: GatewayResumeState }[] = [];
  try {
    const store = storage();
    if (!store) return entries;
    for (let i = 0; i < store.length; i++) {
      const name = store.key(i);
      if (!name?.startsWith(`${PREFIX}gateway:`)) continue;
      const parts = name.slice(PREFIX.length).split(':');
      const [, source, dest, payer, recipient, value, fee] = parts;
      if (payer !== account.toLowerCase() || dest !== String(destChainId)) continue;
      if (parts.length !== 7 || !/^\d+$/.test(source) || !Number.isSafeInteger(Number(source)) ||
          !/^0x[\da-f]{40}$/i.test(recipient) || !/^\d+$/.test(value) || !/^\d+$/.test(fee)) continue;
      const key: ResumeSessionKey = { kind: 'gateway', account, sourceChainId: Number(source), destChainId,
        recipient: recipient as Address, valueAtomic: BigInt(value), feeAtomic: BigInt(fee) };
      const entry = readGatewayResumeState(key);
      if (entry.kind === 'present' && entry.state.completion === 'confirming') entries.push({ key, state: entry.state });
    }
  } catch {
    // Optional polling cannot spread a storage failure to a different active invoice; its own scan stays strict.
  }
  return entries;
}
