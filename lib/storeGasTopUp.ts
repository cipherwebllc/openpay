// 「接続中のウォレットから補充」の操作の記録 (この端末の localStorage・タブをまたいで共有)。
//
// 目的: 届く途中の補充の宛先 (ガス用ウォレットの鍵) を消させない・同じ宛先への補充を重ねない・画面を離れて戻っても
// 途中の補充を見失わない。記録は 1 件ずつ id を持ち、自分の記録だけを片付ける (別のタブの記録を消さない)。
//
// 記録の寿命:
//   - ウォレットで確認中 (tx が無い): 30 分。確認中のタブは 1 分ごとに延ばす (タブが生きている間は切れない・
//     タブを閉じた確認はいずれ切れる = 鍵を永久に消せなくしない)。
//   - 送った (tx がある): 自分の hash の receipt が見つかったときだけ片付ける (resolveStoreGasTopUp)。受け取れないまま
//     1 日たつか、送り手の nonce が消費されたのに receipt が無い (置き換えられた可能性) なら「結果を確かめられていない」
//     (stale) に変わり、次の補充と鍵を消すのは止めず、消す前の注意だけに使う (時間の経過も nonce の消費も「入らなかった」
//     の証拠ではない・まだ入りうる)。7 日で捨てる (壊れた記録・証拠を取れない記録で注意が永久に残らない)。
// 読み書きは鍵の Web Lock の中で呼ぶこと (lib/storeGasWallet.ts の withStoreGasWalletLock)。

import { TransactionReceiptNotFoundError, isAddress, isHex, type Address, type Hex } from 'viem';

export const STORE_GAS_TOPUP_KEY = 'openpay:store-gas-wallet:topup:v2';
export const TOPUP_APPROVAL_TTL_MS = 30 * 60 * 1000;
export const TOPUP_SENT_TTL_MS = 24 * 60 * 60 * 1000;
export const TOPUP_SENT_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
export const TOPUP_HEARTBEAT_MS = 60 * 1000;
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
    (r.suspect === undefined || r.suspect === true)
  );
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
    return true;
  } catch {
    return false;
  }
}

/** 途中 (次の補充と鍵の削除を止める)。 */
function alive(r: StoreGasTopUpRecord, now: number): boolean {
  return !r.suspect && now - r.at < (r.hash ? TOPUP_SENT_TTL_MS : TOPUP_APPROVAL_TTL_MS);
}

/** 送って 1 日たっても結果を確かめられていない・置き換えられた可能性がある (止めないが、消す前に注意する)。 */
function stale(r: StoreGasTopUpRecord, now: number): boolean {
  return !!r.hash && !alive(r, now) && now - r.at < TOPUP_SENT_KEEP_MS;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** このアドレスへの途中の補充 (確認中・送った) の記録。 */
export function liveStoreGasTopUps(address: Address, now: number = Date.now()): StoreGasTopUpRecord[] {
  return Object.values(readAll(now)).filter((r) => same(r.address, address) && alive(r, now));
}

/** このアドレスへの、送って 1 日たっても結果を確かめられていない補充の記録 (7 日まで)。 */
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
  // 切れた記録は掃除する (この端末の記録が溜まり続けない)。結果を確かめられていない記録は残す (消す前の注意に使う)。
  for (const [id, r] of Object.entries(records)) if (!alive(r, now) && !stale(r, now)) delete records[id];
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

/** resolveStoreGasTopUp が使う RPC の読み取り (viem の PublicClient の一部)。 */
export type StoreGasTopUpEvidenceClient = {
  getTransactionReceipt(args: { hash: Hex }): Promise<{ status: 'success' | 'reverted'; transactionHash: Hex }>;
  getTransactionCount(args: { address: Address; blockTag: 'latest' }): Promise<number>;
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
  /** まだ証拠が無い。sender はこの呼び出しで tx から読んだ送り手と nonce の組 (記録に足す)。 */
  | { kind: 'pending'; sender?: StoreGasTopUpSender };

/**
 * 送った補充の結果の証拠を集める。時間の経過は証拠にしない (A5/G3): receipt があれば結果。無くても送り手の nonce が
 * 消費されていれば「置き換えられた可能性」(記録は消さない・警告に変える)。読む順は nonce → receipt (nonce が消費された
 * 後に receipt を探すので、その間に入った自分の tx を見落とさない)。送り手と nonce は同じ tx から読んだ組だけを使う
 * (記録の送り手と違う tx の nonce は使わない)。RPC の障害 (receipt を読めない等) は証拠にせず途中のまま。
 */
export async function resolveStoreGasTopUp(
  client: StoreGasTopUpEvidenceClient,
  r: StoreGasTopUpRecord & { hash: Hex },
): Promise<StoreGasTopUpResolution> {
  let from = r.from;
  let nonce = r.nonce;
  let learned: StoreGasTopUpSender | undefined;
  const pending = (): StoreGasTopUpResolution => (learned ? { kind: 'pending', sender: learned } : { kind: 'pending' });
  if (from === undefined || nonce === undefined) {
    try {
      const tx = await client.getTransaction({ hash: r.hash });
      if (from === undefined || same(from, tx.from)) {
        from = tx.from;
        nonce = tx.nonce;
        learned = { from: tx.from, nonce: tx.nonce };
      }
    } catch {
      // まだ RPC に見えない・読めない。nonce なしで receipt だけ見る。
    }
  }
  let count: number | undefined;
  if (from !== undefined && nonce !== undefined) {
    try {
      count = await client.getTransactionCount({ address: from, blockTag: 'latest' });
    } catch {
      // 読めなければ nonce では判定しない。
    }
  }
  try {
    const receipt = await client.getTransactionReceipt({ hash: r.hash });
    return { kind: 'receipt', receipt: { status: receipt.status, transactionHash: receipt.transactionHash } };
  } catch (e) {
    // 「見つからない」以外 (RPC の障害) は判定できない → 途中のまま。
    if (!(e instanceof TransactionReceiptNotFoundError)) return pending();
  }
  if (count !== undefined && nonce !== undefined && count > nonce) return { kind: 'nonce_consumed' };
  return pending();
}
