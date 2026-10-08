// 「接続中のウォレットから補充」の操作の記録 (この端末の localStorage・タブをまたいで共有)。
//
// 目的: 届く途中の補充の宛先 (ガス用ウォレットの鍵) を消させない・同じ宛先への補充を重ねない・画面を離れて戻っても
// 途中の補充を見失わない。記録は 1 件ずつ id を持ち、自分の記録だけを片付ける (別のタブの記録を消さない)。
//
// 記録の寿命:
//   - ウォレットで確認中 (tx が無い): 30 分。確認中のタブは 1 分ごとに延ばす (タブが生きている間は切れない・
//     タブを閉じた確認はいずれ切れる = 鍵を永久に消せなくしない)。
//   - 送った (tx がある): 結果 (receipt) が見つかったら片付ける。見つからないまま 1 日たったら無効 (取り消し・置き換えで
//     元の tx が入らなかった)。
// 読み書きは鍵の Web Lock の中で呼ぶこと (lib/storeGasWallet.ts の withStoreGasWalletLock)。

import { isAddress, isHex, type Address, type Hex } from 'viem';

export const STORE_GAS_TOPUP_KEY = 'openpay:store-gas-wallet:topup:v2';
export const TOPUP_APPROVAL_TTL_MS = 30 * 60 * 1000;
export const TOPUP_SENT_TTL_MS = 24 * 60 * 60 * 1000;
export const TOPUP_HEARTBEAT_MS = 60 * 1000;

export type StoreGasTopUpRecord = {
  id: string;
  address: Address;
  chainId: number;
  /** 置いた時刻・確認中のタブが延ばした時刻 (ミリ秒)。 */
  at: number;
  hash?: Hex;
};

function isRecord(v: unknown): v is StoreGasTopUpRecord {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.id === 'string' &&
    typeof r.address === 'string' &&
    isAddress(r.address, { strict: false }) &&
    typeof r.chainId === 'number' &&
    typeof r.at === 'number' &&
    (r.hash === undefined || (typeof r.hash === 'string' && isHex(r.hash) && r.hash.length === 66))
  );
}

/** 記録をすべて読む。壊れた値・形の違う記録は捨てる (壊れた記録で鍵を永久に消せなくしない)。 */
function readAll(): Record<string, StoreGasTopUpRecord> {
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
    return Object.fromEntries(Object.entries(parsed).filter(([, v]) => isRecord(v))) as Record<
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

function alive(r: StoreGasTopUpRecord, now: number): boolean {
  return now - r.at < (r.hash ? TOPUP_SENT_TTL_MS : TOPUP_APPROVAL_TTL_MS);
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** このアドレスへの途中の補充 (確認中・送った) の記録。 */
export function liveStoreGasTopUps(address: Address, now: number = Date.now()): StoreGasTopUpRecord[] {
  return Object.values(readAll()).filter((r) => same(r.address, address) && alive(r, now));
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
  const records = readAll();
  // 切れた記録は掃除する (この端末の記録が溜まり続けない)。
  for (const [id, r] of Object.entries(records)) if (!alive(r, now)) delete records[id];
  if (Object.values(records).some((r) => same(r.address, address))) return { ok: false, reason: 'busy' };
  const id = `${now.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  records[id] = { id, address, chainId, at: now };
  return writeAll(records) ? { ok: true, id } : { ok: false, reason: 'storage' };
}

/** 確認中の記録を延ばす (確認中のタブが 1 分ごとに呼ぶ)。 */
export function touchStoreGasTopUp(id: string, now: number = Date.now()): void {
  const records = readAll();
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
  op: { id: string; address: Address; chainId: number },
  hash: Hex,
  now: number = Date.now(),
): void {
  const records = readAll();
  records[op.id] = { id: op.id, address: op.address, chainId: op.chainId, at: now, hash };
  writeAll(records);
}

/** 記録を片付ける (結果が出た・送らなかった)。自分の id だけ。 */
export function finishStoreGasTopUp(id: string): void {
  const records = readAll();
  if (!(id in records)) return;
  delete records[id];
  writeAll(records);
}
