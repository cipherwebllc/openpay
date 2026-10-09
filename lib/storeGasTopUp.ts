// 「接続中のウォレットから補充」の操作の記録 (この端末の localStorage・タブをまたいで共有)。
//
// 目的: 届く途中の補充の宛先 (ガス用ウォレットの鍵) を消させない・同じ宛先への補充を重ねない・画面を離れて戻っても
// 途中の補充を見失わない。記録は 1 件ずつ id を持ち、自分の記録だけを片付ける (別のタブの記録を消さない)。
//
// 記録の状態 (時間の経過は「操作のブロック解除」にだけ使い、「入らなかった」の証拠にはしない):
//   - 途中 (alive・次の補充と鍵の削除を止める): ウォレットで確認中 (tx が無い) は 30 分 (確認中のタブは 1 分ごとに延ばす)。
//     送った (tx がある) は 1 日。
//   - 確かめられていない (stale・止めないが、消す前に警告する): 送って 1 日たっても receipt が無い・送り手の nonce が
//     消費されたのに receipt が無い (置き換えられた可能性)・送れたか分からない (送信の失敗) まま 30 分たった。
//     時間では消えない。
//   - 片付ける (消す) のは: 自分の hash の receipt が取れた・ウォレットで断った (送っていない)・警告を見せたうえでの
//     鍵の削除、だけ。ウォレットで確認中のまま切れた記録 (送った印も失敗の印も無い) は次の記録を置くときに掃除する。
//     無限に溜まらないよう、確かめられていない記録は宛先ごとに最新 TOPUP_MAX_UNRESOLVED 件まで残し、溢れた分は最古から
//     捨てる (警告の対象から外れる)。
// 読み書きは鍵の Web Lock の中で呼ぶこと (lib/storeGasWallet.ts の withStoreGasWalletLock)。同じタブの変化は
// onStoreGasTopUpChange で購読する (storage イベントは自タブに届かない)。

import { TransactionReceiptNotFoundError, isAddress, isHex, type Address, type Hex } from 'viem';

export const STORE_GAS_TOPUP_KEY = 'openpay:store-gas-wallet:topup:v2';
export const TOPUP_APPROVAL_TTL_MS = 30 * 60 * 1000;
export const TOPUP_SENT_TTL_MS = 24 * 60 * 60 * 1000;
export const TOPUP_HEARTBEAT_MS = 60 * 1000;
export const TOPUP_MAX_UNRESOLVED = 20;
// 端末の時計の小さなずれは許し、それより先の時刻の記録は捨てる (先の時刻で切れずに残り続けない)。
const FUTURE_SKEW_MS = 5 * 60 * 1000;

export type StoreGasTopUpRecord = {
  id: string;
  address: Address;
  chainId: number;
  /** 置いた時刻・確認中のタブが延ばした時刻 (ミリ秒)。 */
  at: number;
  hash?: Hex;
  /**
   * 送った tx の送り手と nonce (同じ tx から読んだ組だけ・画面の接続先ではない)。receipt が無くても nonce の消費で
   * 「置き換えられた可能性」を見る。
   */
  from?: Address;
  nonce?: number;
  /** 送り手の nonce が消費されたのに receipt が無い (置き換えられた可能性)。途中ではなく「確かめられていない」として扱う。 */
  suspect?: true;
  /** 送れたかどうか分からない (ウォレットで断った以外の送信の失敗)。30 分は途中、その後は「確かめられていない」。 */
  unknown?: true;
};

function isRecord(v: unknown, now: number): v is StoreGasTopUpRecord {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.id === 'string' &&
    typeof r.address === 'string' &&
    isAddress(r.address, { strict: false }) &&
    typeof r.chainId === 'number' &&
    typeof r.at === 'number' &&
    Number.isFinite(r.at) &&
    r.at <= now + FUTURE_SKEW_MS &&
    (r.hash === undefined || (typeof r.hash === 'string' && isHex(r.hash) && r.hash.length === 66)) &&
    (r.from === undefined || (typeof r.from === 'string' && isAddress(r.from, { strict: false }))) &&
    (r.nonce === undefined || (typeof r.nonce === 'number' && Number.isInteger(r.nonce) && r.nonce >= 0)) &&
    (r.suspect === undefined || r.suspect === true) &&
    (r.unknown === undefined || r.unknown === true)
  );
}

// 同じタブの購読者 (storage イベントは自タブに届かないため)。書き込みが成功したときに呼ぶ。
const listeners = new Set<() => void>();

/** 記録の変化 (このタブの書き込み) を購読する。戻り値で解除。別のタブの変化は storage イベントで読む。 */
export function onStoreGasTopUpChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 記録をすべて読む。壊れた値・形の違う記録・先の時刻の記録は捨てる (壊れた記録で鍵を永久に消せなくしない)。 */
function readAll(now: number = Date.now()): Record<string, StoreGasTopUpRecord> {
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(STORE_GAS_TOPUP_KEY);
  } catch {
    return {};
  }
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([, v]) => isRecord(v, now))) as Record<
      string,
      StoreGasTopUpRecord
    >;
  } catch {
    return {};
  }
}

function writeAll(records: Record<string, StoreGasTopUpRecord>): boolean {
  try {
    if (Object.keys(records).length === 0) window.localStorage.removeItem(STORE_GAS_TOPUP_KEY);
    else window.localStorage.setItem(STORE_GAS_TOPUP_KEY, JSON.stringify(records));
  } catch {
    return false;
  }
  for (const l of listeners) l();
  return true;
}

/** 途中 (次の補充と鍵の削除を止める)。時間が過ぎると止めなくなるだけで、記録の意味は変わらない。 */
function alive(r: StoreGasTopUpRecord, now: number): boolean {
  return !r.suspect && now - r.at < (r.hash ? TOPUP_SENT_TTL_MS : TOPUP_APPROVAL_TTL_MS);
}

/**
 * 結果を確かめられていない (止めないが、消す前に警告する): 送った (1 日たった・置き換えの可能性) と、送れたか分からない
 * (30 分たった)。時間では消えない。
 */
function stale(r: StoreGasTopUpRecord, now: number): boolean {
  return (!!r.hash || !!r.unknown) && !alive(r, now);
}

/** 掃除してよい: ウォレットで確認中のまま切れた (送った印も失敗の印も無い = 送ったことを示すものが無い)。 */
function expired(r: StoreGasTopUpRecord, now: number): boolean {
  return !r.hash && !r.unknown && !alive(r, now);
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * 書く前の整理: 確認中のまま切れた記録を捨て、確かめられていない記録は宛先ごとに最新 TOPUP_MAX_UNRESOLVED 件まで残して
 * 溢れた分は最古から捨てる (無限に溜まらない)。途中の記録と確かめられていない記録はそれ以外では捨てない。
 */
function prune(records: Record<string, StoreGasTopUpRecord>, now: number): void {
  for (const [id, r] of Object.entries(records)) if (expired(r, now)) delete records[id];
  const byAddress = new Map<string, StoreGasTopUpRecord[]>();
  for (const r of Object.values(records)) {
    if (!stale(r, now)) continue;
    const key = r.address.toLowerCase();
    byAddress.set(key, [...(byAddress.get(key) ?? []), r]);
  }
  for (const list of byAddress.values()) {
    if (list.length <= TOPUP_MAX_UNRESOLVED) continue;
    list.sort((a, b) => b.at - a.at);
    for (const r of list.slice(TOPUP_MAX_UNRESOLVED)) delete records[r.id];
  }
}

/** このアドレスへの途中の補充 (確認中・送った) の記録。 */
export function liveStoreGasTopUps(address: Address, now: number = Date.now()): StoreGasTopUpRecord[] {
  return Object.values(readAll(now)).filter((r) => same(r.address, address) && alive(r, now));
}

/** このアドレスへの、結果を確かめられていない補充の記録 (消す前に警告する)。 */
export function staleStoreGasTopUps(address: Address, now: number = Date.now()): StoreGasTopUpRecord[] {
  return Object.values(readAll(now)).filter((r) => same(r.address, address) && stale(r, now));
}

/**
 * 補充を始める記録を置く (鍵のロックの中で呼ぶ)。同じ宛先への補充が途中なら置かない ('busy')。保存できなければ
 * 'storage' (記録なしでは別のタブの「消す」を止められない = 補充しない)。
 */
export function reserveStoreGasTopUp(
  address: Address,
  chainId: number,
  now: number = Date.now(),
): { ok: true; id: string } | { ok: false; reason: 'busy' | 'storage' } {
  const records = readAll(now);
  prune(records, now);
  if (Object.values(records).some((r) => same(r.address, address) && alive(r, now))) {
    return { ok: false, reason: 'busy' };
  }
  const id = `${now.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  records[id] = { id, address, chainId, at: now };
  return writeAll(records) ? { ok: true, id } : { ok: false, reason: 'storage' };
}

/** 確認中の記録を延ばす (確認中のタブが 1 分ごとに呼ぶ)。 */
export function touchStoreGasTopUp(id: string, now: number = Date.now()): void {
  const records = readAll(now);
  const r = records[id];
  if (!r || r.hash) return;
  records[id] = { ...r, at: now };
  writeAll(records);
}

/**
 * 送った tx を記録に残す (画面を離れても、戻ったときに結果を見られる)。確認中の記録が切れて消えていても置き直す
 * (送った補充の宛先を消させない)。
 */
export function attachStoreGasTopUpHash(
  op: { id: string; address: Address; chainId: number; from?: Address; nonce?: number },
  hash: Hex,
  now: number = Date.now(),
): boolean {
  const records = readAll(now);
  prune(records, now);
  records[op.id] = {
    id: op.id,
    address: op.address,
    chainId: op.chainId,
    at: now,
    hash,
    ...(op.from ? { from: op.from } : {}),
    ...(op.nonce !== undefined ? { nonce: op.nonce } : {}),
  };
  return writeAll(records);
}

/**
 * 確認中の記録に「送れたかどうか分からない」の印を付ける (ウォレットで断った以外の送信の失敗)。30 分は途中として止め、
 * その後は「確かめられていない」として警告に残る (時間では消えない)。送った記録 (hash が真実) には付けない。
 */
export function markStoreGasTopUpUnknown(id: string, now: number = Date.now()): void {
  const records = readAll(now);
  const r = records[id];
  if (!r || r.hash) return;
  records[id] = { ...r, unknown: true };
  writeAll(records);
}

/**
 * 送った記録に、後から tx から読んだ送り手と nonce の組を足す (時刻は延ばさない・送った記録だけ)。記録に送り手があり、
 * それと違う組は足さない (別の tx の nonce と組にして、その消費で誤った判定をしない)。
 */
export function noteStoreGasTopUpSender(
  id: string,
  sender: { from: Address; nonce: number },
  now: number = Date.now(),
): void {
  const records = readAll(now);
  const r = records[id];
  if (!r || !r.hash) return;
  if (r.from && !same(r.from, sender.from)) return;
  records[id] = { ...r, from: sender.from, nonce: sender.nonce };
  writeAll(records);
}

/** 送った記録に「置き換えられた可能性」の印を付ける (途中 → 確かめられていない)。送った記録だけ。 */
export function markStoreGasTopUpSuspect(id: string, now: number = Date.now()): void {
  const records = readAll(now);
  const r = records[id];
  if (!r || !r.hash) return;
  records[id] = { ...r, suspect: true };
  writeAll(records);
}

/** 記録を片付ける (結果が出た・送らなかった)。自分の id だけ。 */
export function finishStoreGasTopUp(id: string, now: number = Date.now()): void {
  const records = readAll(now);
  if (!(id in records)) return;
  delete records[id];
  writeAll(records);
}

/** resolveStoreGasTopUp・readStoreGasTopUpSender が使う RPC の読み取り (viem の PublicClient の一部)。 */
export type StoreGasTopUpEvidenceClient = {
  getTransactionReceipt(args: { hash: Hex }): Promise<{ status: 'success' | 'reverted'; transactionHash: Hex }>;
  getTransactionCount(args: { address: Address; blockTag: 'latest' }): Promise<number>;
};

export type StoreGasTopUpSenderClient = {
  getTransaction(args: { hash: Hex }): Promise<{ nonce: number; from: Address }>;
};

export type StoreGasTopUpSender = { from: Address; nonce: number };

export type StoreGasTopUpResolution =
  /** 自分の hash の receipt (成功・revert)。記録を片付けてよい唯一の証拠。 */
  | { kind: 'receipt'; receipt: { status: 'success' | 'reverted'; transactionHash: Hex } }
  /**
   * 送り手の nonce が消費されたのに receipt が無い = 置き換えられた可能性。片付ける証拠ではない (自分の tx の成功でも
   * nonce は消費される・ノードの食い違いで receipt が遅れて見えることもある)。
   */
  | { kind: 'nonce_consumed' }
  /** まだ証拠が無い。 */
  | { kind: 'pending' };

/**
 * 送った補充の結果の証拠を集める。時間の経過は証拠にしない (A5/G3): receipt があれば結果 (先に読み、他の読み取りを
 * 待たない = 補助 RPC が遅くても片付けが止まらない)。無くても、記録に送り手と nonce の組があり、その nonce が消費されて
 * いれば「置き換えられた可能性」(記録は消さない・警告に変える。自分の tx が receipt と count の読み取りの間に入った場合も
 * 警告止まりで、次の読み直しの receipt で片付く)。組が無ければ nonce は見ない (組は readStoreGasTopUpSender で別に読む)。
 * RPC の障害 (receipt を読めない等) は証拠にせず途中のまま。
 */
export async function resolveStoreGasTopUp(
  client: StoreGasTopUpEvidenceClient,
  r: StoreGasTopUpRecord & { hash: Hex },
): Promise<StoreGasTopUpResolution> {
  try {
    const receipt = await client.getTransactionReceipt({ hash: r.hash });
    return { kind: 'receipt', receipt: { status: receipt.status, transactionHash: receipt.transactionHash } };
  } catch (e) {
    // 「見つからない」以外 (RPC の障害) は判定できない → 途中のまま。
    if (!(e instanceof TransactionReceiptNotFoundError)) return { kind: 'pending' };
  }
  if (r.from === undefined || r.nonce === undefined) return { kind: 'pending' };
  try {
    const count = await client.getTransactionCount({ address: r.from, blockTag: 'latest' });
    if (count > r.nonce) return { kind: 'nonce_consumed' };
  } catch {
    // 読めなければ nonce では判定しない。
  }
  return { kind: 'pending' };
}

/**
 * 送った tx から送り手と nonce の組を読む (付帯の読み取り・receipt の判定とは別に、待たずに呼ぶ)。記録に送り手があり、
 * それと tx の送り手が違えば null (別の tx の nonce を組にしない)。まだ RPC に見えない・読めないときも null。
 */
export async function readStoreGasTopUpSender(
  client: StoreGasTopUpSenderClient,
  r: Pick<StoreGasTopUpRecord, 'from'> & { hash: Hex },
): Promise<StoreGasTopUpSender | null> {
  try {
    const tx = await client.getTransaction({ hash: r.hash });
    if (r.from !== undefined && !same(r.from, tx.from)) return null;
    return { from: tx.from, nonce: tx.nonce };
  } catch {
    // まだ RPC に見えない (TransactionNotFoundError)・読めない。付帯の読み取りなので失敗を上に伝えない。
    return null;
  }
}
