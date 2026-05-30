'use client';

// Circle Paymaster (USDC ガスレス) の **二重決済耐性 FSM + durable pending store**
// (Phase 1 計画 C1 最深)。
//
// なぜ専用 store が要るか:
//   merchant への USDC 転送は不可逆。bundler への送信 (broadcast) は RPC timeout /
//   5xx / 無応答でも「Pimlico は受理済・included しうる」= unknown 状態になりうる。
//   ここで auto-fallback したり新しい UserOp を組み直すと **二重決済**になる。
//   → broadcast の *前* に「送信意図 (submitting) + 完全な署名済 UserOp」を耐久化し、
//     復旧は (a) receipt 照会 か (b) *同一署名 op* の冪等 rebroadcast のみに限定する。
//
// なぜ best-effort の safeSet/resumeStore を流用しないか:
//   lib/storage.ts safeSet と lib/crossChain/resumeStore.ts は「書けなくても決済本体は
//   続行」(best-effort)。本 store は逆で **fail-closed** — 書込が確証できなければ送信を
//   中止する (記録なき broadcast = 復旧不能な二重決済リスク)。setItem が throw しない
//   private mode / quota silent-drop も read-back 検証で潰す。
//
// 永続層 = localStorage:
//   OpenPay は injected wallet (walletClient はブラウザ) の client-only アーキで、
//   サーバ署名は無い。よって pending store も client localStorage。localStorage 操作は
//   同期実行なので *同一タブ内* の read-modify-write はプリエンプトされず実質 atomic。
//   タブ跨ぎの真の CAS primitive は無いが、冪等キー (sender+callHash 込み) で同一決済は
//   同一レコードに収束し、submitting 到達後は「新規 op を作らない」不変条件で二重決済を
//   防ぐ。reload で paymentAttemptId が失われるケースは findRecoverable (sender+chainId
//   の二次 index スキャン) で submitting レコードを拾い receipt/rebroadcast で復旧する。
//
// FSM (横道 abandoned):
//   reserved → awaiting_signature → signed → submitting → confirmed
//                                                       ↘ failed
//   reserved/awaiting_signature/signed (= broadcast 前) は同一署名者が安全に abandon /
//   supersede 可能 (popup 拒否・タブ閉じ)。**submitting 到達後は abandon も新規 op 構築も
//   禁止** — recovery 経路のみ。

import {
  encodeAbiParameters,
  getAddress,
  keccak256,
  type Address,
  type Hex,
} from 'viem';
import { logger } from './logger';

export const PENDING_KEY_PREFIX = 'openpay.circle.pending.';
const PENDING_SCHEMA_VERSION = 1 as const;

export type PendingStatus =
  | 'reserved'
  | 'awaiting_signature'
  | 'signed'
  | 'submitting'
  | 'confirmed'
  | 'failed'
  | 'abandoned';

// broadcast 前 = 同一署名者が安全に abandon / 再署名 (supersede) 可能。
const PRE_SUBMIT_STATES: ReadonlySet<PendingStatus> = new Set<PendingStatus>([
  'reserved',
  'awaiting_signature',
  'signed',
]);

// それ以上遷移しない終端状態。
const TERMINAL_STATES: ReadonlySet<PendingStatus> = new Set<PendingStatus>([
  'confirmed',
  'failed',
  'abandoned',
]);

export function isPreSubmit(status: PendingStatus): boolean {
  return PRE_SUBMIT_STATES.has(status);
}

export function isTerminal(status: PendingStatus): boolean {
  return TERMINAL_STATES.has(status);
}

/** localStorage に保存する署名済 UserOp。呼出側 (circleSend) が
 * formatUserOperationRequest で RPC hex 形式に変換済の opaque blob を渡す
 * (bigint を含まず JSON 安全)。store は中身を解釈しない。 */
export type SerializedUserOp = Record<string, unknown>;

export type PendingRecord = {
  schemaVersion: typeof PENDING_SCHEMA_VERSION;
  /** 安定冪等キー (computeIdempotencyKey)。nonce/userOpHash 非依存。 */
  key: string;
  status: PendingStatus;
  chainId: number;
  /** 署名者 (lowercase 正規化済)。authorization binding に使う。 */
  sender: Address;
  /** merchant transfer calls のみの hash (gas/permit を含めない → quote 再生成で不変)。 */
  callHash: Hex;
  /** 決済試行 ID (1 回の「支払う」操作で固定・retry で不変)。 */
  paymentAttemptId: string;
  provider: 'circle';
  /** permit spender になる Circle paymaster (allowlist 由来)。 */
  paymaster: Address;
  createdAt: number;
  updatedAt: number;
  // signed 以降に確定 (broadcast 前に永続される)。
  signedUserOp?: SerializedUserOp;
  userOpHash?: Hex;
  /** permit の EIP-712 digest (監査での突合用・任意)。 */
  permitDigest?: Hex;
  // confirmed 時。
  txHash?: Hex;
  /** receipt の success (UserOp が revert せず実行されたか)。confirmed 時に永続。
   * resultFromConfirmed の receipt 再取得失敗時に success を捏造しないために使う。 */
  success?: boolean;
  // failed 時。
  errorMessage?: string;
};

// ---- errors ----------------------------------------------------------------

/** localStorage 自体が使えない (SSR / private mode で throw)。fail-closed で送信中止。 */
export class PendingStoreUnavailableError extends Error {
  constructor(detail: string) {
    super(`pending store 利用不可 (送信を中止): ${detail}`);
    this.name = 'PendingStoreUnavailableError';
  }
}

/** 書込が確証できない (setItem 後の read-back 不一致 = quota silent drop 等)。 */
export class PendingStoreWriteError extends Error {
  constructor(detail: string) {
    super(`pending record 書込失敗 (送信を中止): ${detail}`);
    this.name = 'PendingStoreWriteError';
  }
}

/** CAS 失敗: 期待した status から遷移できない (並行更新 / 不正遷移)。 */
export class PendingStateError extends Error {
  constructor(detail: string) {
    super(`pending FSM 遷移エラー: ${detail}`);
    this.name = 'PendingStateError';
  }
}

/** record の署名者と操作要求者が一致しない (authorization binding 違反)。 */
export class PendingAuthorizationError extends Error {
  constructor(detail: string) {
    super(`pending record authorization エラー: ${detail}`);
    this.name = 'PendingAuthorizationError';
  }
}

// ---- key derivation --------------------------------------------------------

function normalizeAddress(addr: Address): Address {
  return getAddress(addr).toLowerCase() as Address;
}

/** merchant transfer calls *のみ* の hash。gas / permitAmount / nonce を含めないので
 * quote 再生成 (gas や permitAmount が変わる) で値が変わらない = 冪等キーが安定する。 */
export function computeCallHash(
  calls: ReadonlyArray<{ to: Address; data: Hex; value?: bigint }>,
): Hex {
  const encoded = encodeAbiParameters(
    [
      {
        type: 'tuple[]',
        components: [
          { name: 'to', type: 'address' },
          { name: 'data', type: 'bytes' },
          { name: 'value', type: 'uint256' },
        ],
      },
    ],
    [
      calls.map((c) => ({
        to: getAddress(c.to),
        data: c.data,
        value: c.value ?? 0n,
      })),
    ],
  );
  return keccak256(encoded);
}

/** 安定冪等キー = chainId + sender + paymentAttemptId + callHash。
 * nonce / userOpHash には依存させない (quote 再生成で変わるため・C1 深)。 */
export function computeIdempotencyKey(args: {
  chainId: number;
  sender: Address;
  paymentAttemptId: string;
  callHash: Hex;
}): string {
  return [
    args.chainId,
    normalizeAddress(args.sender),
    args.paymentAttemptId,
    args.callHash,
  ].join(':');
}

// ---- low-level persistence (fail-closed) -----------------------------------

function storageKey(key: string): string {
  return PENDING_KEY_PREFIX + key;
}

// localStorage を取得。使えなければ throw (fail-closed: 記録なしで送信させない)。
function requireStorage(): Storage {
  if (typeof window === 'undefined') {
    throw new PendingStoreUnavailableError('window 不在 (SSR)');
  }
  try {
    const s = window.localStorage;
    // private mode 等は getItem アクセス時点で throw しうるので軽く触る。
    s.getItem(PENDING_KEY_PREFIX + '__probe__');
    return s;
  } catch (error) {
    throw new PendingStoreUnavailableError(String(error));
  }
}

// fail-closed 書込: setItem 後に read-back して書けたことを確証する。private mode の
// silent drop / quota 超過を検出し、確証できなければ throw して送信を中止させる。
function writeRecord(rec: PendingRecord): void {
  const storage = requireStorage();
  const serialized = JSON.stringify(rec);
  try {
    storage.setItem(storageKey(rec.key), serialized);
  } catch (error) {
    throw new PendingStoreWriteError(`setItem throw: ${String(error)}`);
  }
  const back = storage.getItem(storageKey(rec.key));
  if (back !== serialized) {
    throw new PendingStoreWriteError('read-back 不一致 (quota silent drop の疑い)');
  }
}

/** key で record を読む。存在しなければ undefined。storage 自体が使えなければ throw
 * (CAS の前提が崩れるため fail-closed)。corrupt JSON は warn して undefined。 */
export function loadPendingRecord(key: string): PendingRecord | undefined {
  const storage = requireStorage();
  const raw = storage.getItem(storageKey(key));
  if (raw === null) return undefined;
  try {
    const parsed = JSON.parse(raw) as PendingRecord;
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      parsed.schemaVersion !== PENDING_SCHEMA_VERSION
    ) {
      logger.warn('circle.pending.corrupt-record', { key });
      return undefined;
    }
    return parsed;
  } catch (error) {
    logger.warn('circle.pending.parse-failed', { key, error });
    return undefined;
  }
}

function assertSender(rec: PendingRecord, sender: Address): void {
  if (rec.sender !== normalizeAddress(sender)) {
    throw new PendingAuthorizationError(
      `record sender=${rec.sender} ≠ requester=${normalizeAddress(sender)}`,
    );
  }
}

// ---- FSM transitions -------------------------------------------------------

export type ReserveResult = {
  record: PendingRecord;
  /** 既存レコードを再利用した (resume) なら true、新規作成なら false。 */
  resumed: boolean;
};

/** create-if-absent。既存があれば sender 検証の上 resume として返す。
 * - 既存が submitting/terminal → resume=true で返し、呼出側は **新規 op を作らず**
 *   recovery (receipt 照会 / 冪等 rebroadcast) に回す責務を負う。
 * - 既存が pre-submit → resume=true で返し、呼出側は再署名して継続して良い (未 broadcast)。
 * 書込が確証できなければ throw (fail-closed)。 */
export function reserveOrResume(init: {
  key: string;
  chainId: number;
  sender: Address;
  callHash: Hex;
  paymentAttemptId: string;
  paymaster: Address;
  now: number;
}): ReserveResult {
  const existing = loadPendingRecord(init.key);
  if (existing) {
    assertSender(existing, init.sender);
    return { record: existing, resumed: true };
  }
  const record: PendingRecord = {
    schemaVersion: PENDING_SCHEMA_VERSION,
    key: init.key,
    status: 'reserved',
    chainId: init.chainId,
    sender: normalizeAddress(init.sender),
    callHash: init.callHash,
    paymentAttemptId: init.paymentAttemptId,
    provider: 'circle',
    paymaster: getAddress(init.paymaster),
    createdAt: init.now,
    updatedAt: init.now,
  };
  writeRecord(record);
  return { record, resumed: false };
}

/** CAS 遷移: 現在 status が `from` のいずれかであることを確認してから `to` に進める。
 * sender binding を検証。並行更新 / 不正遷移は throw。書込は fail-closed。 */
function transition(args: {
  key: string;
  sender: Address;
  from: PendingStatus | ReadonlyArray<PendingStatus>;
  to: PendingStatus;
  now: number;
  patch?: Partial<
    Pick<
      PendingRecord,
      | 'signedUserOp'
      | 'userOpHash'
      | 'permitDigest'
      | 'txHash'
      | 'success'
      | 'errorMessage'
    >
  >;
}): PendingRecord {
  const current = loadPendingRecord(args.key);
  if (!current) {
    throw new PendingStateError(`record 不在: ${args.key}`);
  }
  assertSender(current, args.sender);
  const fromSet = Array.isArray(args.from) ? args.from : [args.from];
  if (!fromSet.includes(current.status)) {
    throw new PendingStateError(
      `${args.key}: status=${current.status} は [${fromSet.join(',')}] からの遷移ではない (期待 → ${args.to})`,
    );
  }
  const next: PendingRecord = {
    ...current,
    ...args.patch,
    status: args.to,
    updatedAt: args.now,
  };
  writeRecord(next);
  return next;
}

/** reserved → awaiting_signature (permit/UserOp 署名 popup を出す直前)。 */
export function markAwaitingSignature(args: {
  key: string;
  sender: Address;
  now: number;
}): PendingRecord {
  return transition({
    key: args.key,
    sender: args.sender,
    from: ['reserved', 'awaiting_signature'],
    to: 'awaiting_signature',
    now: args.now,
  });
}

/** awaiting_signature → signed。**完全な署名済 UserOp + userOpHash を永続**する
 * (broadcast 前)。これにより submitting 後の復旧で *同一署名 op* を rebroadcast できる。 */
export function markSigned(args: {
  key: string;
  sender: Address;
  signedUserOp: SerializedUserOp;
  userOpHash: Hex;
  permitDigest?: Hex;
  now: number;
}): PendingRecord {
  return transition({
    key: args.key,
    sender: args.sender,
    from: ['awaiting_signature', 'signed'],
    to: 'signed',
    now: args.now,
    patch: {
      signedUserOp: args.signedUserOp,
      userOpHash: args.userOpHash,
      permitDigest: args.permitDigest,
    },
  });
}

/** signed → submitting (= broadcast_intent / may-have-broadcast)。
 * **bundler 呼び出しの直前に必ず成功させる**。署名済 op が無いまま submitting にはしない
 * (復旧不能になるため fail-closed)。この遷移以降は新規 op 構築・fallback 禁止。 */
export function markSubmitting(args: {
  key: string;
  sender: Address;
  now: number;
}): PendingRecord {
  const current = loadPendingRecord(args.key);
  if (!current) throw new PendingStateError(`record 不在: ${args.key}`);
  if (!current.signedUserOp || !current.userOpHash) {
    throw new PendingStateError(
      `${args.key}: 署名済 UserOp が無いまま submitting にできない (復旧不能防止)`,
    );
  }
  return transition({
    key: args.key,
    sender: args.sender,
    // submitting からの再入 (rebroadcast retry) を冪等に許可する。
    from: ['signed', 'submitting'],
    to: 'submitting',
    now: args.now,
  });
}

/** submitting → confirmed (receipt 取得)。success は receipt.success を永続する
 * (resultFromConfirmed が receipt 再取得に失敗しても success を捏造しないため)。 */
export function markConfirmed(args: {
  key: string;
  sender: Address;
  txHash: Hex;
  success: boolean;
  now: number;
}): PendingRecord {
  return transition({
    key: args.key,
    sender: args.sender,
    from: ['submitting', 'confirmed'],
    to: 'confirmed',
    now: args.now,
    patch: { txHash: args.txHash, success: args.success },
  });
}

/** failed へ。**submitting からは失敗確定にしない** (included しうる = unknown のため)。
 * pre-submit (署名前/署名後・未 broadcast) の確定的失敗のみ failed にできる。 */
export function markFailed(args: {
  key: string;
  sender: Address;
  errorMessage: string;
  now: number;
}): PendingRecord {
  return transition({
    key: args.key,
    sender: args.sender,
    from: ['reserved', 'awaiting_signature', 'signed'],
    to: 'failed',
    now: args.now,
    patch: { errorMessage: args.errorMessage.slice(0, 500) },
  });
}

/** pre-submit を abandoned にする (popup 拒否・タブ閉じ・supersede)。
 * **submitting 以降は abandon 不可** (broadcast 済みかもしれないので宙吊りにしない)。 */
export function abandon(args: {
  key: string;
  sender: Address;
  now: number;
}): PendingRecord {
  return transition({
    key: args.key,
    sender: args.sender,
    from: ['reserved', 'awaiting_signature', 'signed'],
    to: 'abandoned',
    now: args.now,
  });
}

// ---- recovery scan ---------------------------------------------------------

// PENDING_KEY_PREFIX の全 record を走査し predicate に合うものを返す共有ヘルパ。
function scanPending(match: (r: PendingRecord) => boolean): PendingRecord[] {
  const storage = requireStorage();
  const out: PendingRecord[] = [];
  for (let i = 0; i < storage.length; i += 1) {
    const k = storage.key(i);
    if (!k || !k.startsWith(PENDING_KEY_PREFIX)) continue;
    const record = loadPendingRecord(k.slice(PENDING_KEY_PREFIX.length));
    if (record && match(record)) out.push(record);
  }
  return out;
}

/** reload 後など paymentAttemptId を失った状況で、復旧対象 (submitting のまま宙吊り)
 * の record を sender + chainId の二次 index でスキャンする。呼出側は各 record を
 * userOpHash receipt 照会 → 無ければ *同一署名 op* の冪等 rebroadcast で確定させる。 */
export function findRecoverable(args: {
  sender: Address;
  chainId: number;
}): PendingRecord[] {
  const sender = normalizeAddress(args.sender);
  return scanPending(
    (r) =>
      r.status === 'submitting' &&
      r.sender === sender &&
      r.chainId === args.chainId,
  );
}

/** 同一決済 (sender+chainId+callHash) の「生きている」record (abandoned/failed 以外 =
 * reserved/awaiting_signature/signed/submitting/confirmed) を列挙する。cross-invocation の
 * 二重決済ガードに使う: paymentAttemptId が呼出毎に変わっても callHash で別 attempt を検出し、
 * confirmed なら既支払い・submitting なら recover・pre-submit なら並行署名中として扱う。
 * excludeKey で自 attempt の record を除外する (reserveOrResume の同一キー resume と二重に扱わない)。 */
export function findLiveByCallHash(args: {
  sender: Address;
  chainId: number;
  callHash: Hex;
  excludeKey?: string;
}): PendingRecord[] {
  const sender = normalizeAddress(args.sender);
  return scanPending(
    (r) =>
      r.sender === sender &&
      r.chainId === args.chainId &&
      r.callHash === args.callHash &&
      r.key !== args.excludeKey &&
      r.status !== 'abandoned' &&
      r.status !== 'failed',
  );
}

/** confirmed / failed / abandoned の終端 record を掃除する (任意・容量管理)。
 * submitting / pre-submit は消さない (復旧情報を失わないため)。 */
export function pruneTerminal(olderThanMs: number, now: number): number {
  let storage: Storage;
  try {
    storage = requireStorage();
  } catch {
    return 0;
  }
  const toRemove: string[] = [];
  for (let i = 0; i < storage.length; i += 1) {
    const k = storage.key(i);
    if (!k || !k.startsWith(PENDING_KEY_PREFIX)) continue;
    const record = loadPendingRecord(k.slice(PENDING_KEY_PREFIX.length));
    if (!record) continue;
    if (isTerminal(record.status) && now - record.updatedAt > olderThanMs) {
      toRemove.push(k);
    }
  }
  for (const k of toRemove) {
    try {
      storage.removeItem(k);
    } catch {
      // best-effort prune (掃除失敗は決済に影響しない)。
    }
  }
  return toRemove.length;
}
