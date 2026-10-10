// お店の端末のガス用ウォレット (レジ・plans/store-gas-wallet.md)。
//
// レジの端末がお客様の署名を自分のガス (各チェーンのネイティブ通貨: POL・KAIA・AVAX) で送るための専用の鍵。鍵はこの端末の localStorage にだけ
// 置き、OpenPay のサーバには送らない (fetch の body に載せない)。JPYC を受け取る店のウォレットとは別の鍵で、
// 入れるのは少額のガス代のトークンだけ (端末の紛失・ブラウザの侵害で失いうるのは入れた分のみ)。
// 同じ鍵 (同じアドレス) を対象のチェーン (lib/storeDevicePayment.ts の storeDeviceChainIds) すべてで使う。
//
// 鍵の扱いの決まり:
//   - 読み書きは lib/storage.ts の safeGet/safeSet を使わない (JSON 解析エラーの文面に保存内容の断片が
//     入り、logger → console / Sentry に鍵の断片が流れうるため)。失敗は固定の文言だけを返す。
//   - 「無い」と「壊れている / 読めない」を区別する。壊れた値の上に新しい鍵を作らない (入っているガス代のトークンを失う)。
//   - 鍵を React の state や戻り値に載せない。使う直前に readStoreGasWalletKey で読む。

import { isAddress, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

export const STORE_GAS_WALLET_STORAGE_KEY = 'openpay:store-gas-wallet:v1';

// forwarder.settle 1 回の目安ガス (残り回数の概算用・送信時の上限ではない)。Amoy 実機の gasUsed は 15.6〜17.4 万
// (2026-10-08・レジ/決済QR から各 1 回) なので 20 万で少し多めに見積もる (残り回数を多く見せてガス代切れで送れない、
// を避ける)。送信時の上限は別 (lib/storeDevicePayment.ts の STORE_DEVICE_SETTLE_GAS_CAP = 50 万・見積もりを切り詰めない)。
export const STORE_GAS_SETTLE_GAS_ESTIMATE = 200_000n;

// 入れておく目安 (ネイティブ通貨・チェーンごと・10 進の文字列)。1 回の送信 (約 13〜17 万 gas) の実測: Polygon 0.01〜0.05 POL
// (単価 55〜274 gwei)・Kaia 約 0.003 KAIA (25 gkei)・Avalanche 約 0.0008 AVAX (5 gwei)。少額にとどめる (端末の紛失・
// ブラウザの侵害で失いうるのは入れた分だけ)。「接続中のウォレットから補充」の既定額 (min) と 1 回の上限 (max) にも使う。
// 画面の表示 (「1〜2」「1–2」) は locale ごとの記号なので messages (RegisterMode.storeGasWallet.fundRange) が持ち、
// ここは数値だけ返す。
const FUND_GUIDE: Readonly<Record<number, { min: string; max: string }>> = {
  137: { min: '1', max: '2' },
  80002: { min: '1', max: '2' },
  8217: { min: '1', max: '2' },
  1001: { min: '1', max: '2' },
  43114: { min: '0.05', max: '0.1' },
  43113: { min: '0.05', max: '0.1' },
};

/** 入れておく目安の数値 (画面の目安・補充の既定額と 1 回の上限)。表に無いチェーンは null。 */
export function storeGasFundRange(chainId: number): { min: string; max: string } | null {
  return FUND_GUIDE[chainId] ?? null;
}

const PERSIST_ASKED_KEY = 'openpay:store-gas-wallet:persist-asked:v1';

/**
 * ブラウザに「この端末のデータを消されにくくする」よう頼む (navigator.storage.persist)。認めるかはブラウザが決める
 * (Safari 17 以降はホーム画面に追加したアプリなどで認める・Chrome は利用状況で判断・Firefox は許可を尋ねる)。
 * 頼むのは鍵 (アドレス) ごとに 1 回だけ (Firefox で開くたびに尋ねない)。2 回目以降は認められているかを読むだけ。
 * 結果: true = 認められた / false = 認められない / null = 頼めない。鍵の作成・表示を止めない (頼めなくても失敗に
 * しない = 付帯の処理を本体に波及させない)。
 */
export async function requestStoreGasWalletPersistence(address: Address): Promise<boolean | null> {
  try {
    const storage = typeof navigator === 'undefined' ? undefined : navigator.storage;
    if (!storage?.persist) return null;
    if (storage.persisted && (await storage.persisted())) return true;
    if (window.localStorage.getItem(PERSIST_ASKED_KEY) === address) return false;
    window.localStorage.setItem(PERSIST_ASKED_KEY, address);
    return await storage.persist();
  } catch {
    return null;
  }
}

// 端末をまたがない直列化の鍵 (同じ端末の別タブで作る・消す・送るが重ならないように)。
export const STORE_GAS_WALLET_LOCK = 'openpay:store-gas-wallet';

type StoredRecord = { v: 1; privateKey: Hex; address: Address; createdAt: number };

/** 画面や hook に渡してよい公開情報 (鍵を含まない)。 */
export type StoreGasWalletInfo = { address: Address; createdAt: number };

export type StoreGasWalletState =
  | { state: 'none' }
  | { state: 'ok'; info: StoreGasWalletInfo }
  // 値はあるが壊れている・鍵とアドレスが食い違う・鍵が範囲外
  | { state: 'corrupt' }
  // localStorage を読めない (プライベートブラウズ・ストレージ拒否)
  | { state: 'unavailable' };


type RawRead = { ok: true; raw: string | null } | { ok: false };

function readRaw(): RawRead {
  if (typeof window === 'undefined') return { ok: false };
  try {
    return { ok: true, raw: window.localStorage.getItem(STORE_GAS_WALLET_STORAGE_KEY) };
  } catch {
    return { ok: false };
  }
}

function parseRecord(raw: string): StoredRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null; // 例外の文面 (保存内容の断片を含む) は捨てる
  }
  if (!value || typeof value !== 'object') return null;
  const o = value as Record<string, unknown>;
  if (
    o.v !== 1 ||
    typeof o.privateKey !== 'string' ||
    !/^0x[0-9a-fA-F]{64}$/.test(o.privateKey) ||
    typeof o.address !== 'string' ||
    !isAddress(o.address, { strict: false }) ||
    typeof o.createdAt !== 'number'
  ) {
    return null;
  }
  let derived: Address;
  try {
    // ゼロや曲線の範囲外の鍵は throw する。壊れた値としてパネル内に隔離する (レジ全体を落とさない)。
    derived = privateKeyToAccount(o.privateKey as Hex).address;
  } catch {
    return null;
  }
  if (derived.toLowerCase() !== o.address.toLowerCase()) return null;
  return { v: 1, privateKey: o.privateKey as Hex, address: derived, createdAt: o.createdAt };
}

/** 保存状態を読む (鍵は返さない)。 */
export function loadStoreGasWallet(): StoreGasWalletState {
  const read = readRaw();
  if (!read.ok) return { state: 'unavailable' };
  if (read.raw === null) return { state: 'none' };
  const record = parseRecord(read.raw);
  if (!record) return { state: 'corrupt' };
  return { state: 'ok', info: { address: record.address, createdAt: record.createdAt } };
}

/** 送信の直前にだけ鍵を読む。期待するアドレスと違えば null (別タブで作り直された等)。 */
export function readStoreGasWalletKey(expected: Address): Hex | null {
  const read = readRaw();
  if (!read.ok || read.raw === null) return null;
  const record = parseRecord(read.raw);
  if (!record || record.address.toLowerCase() !== expected.toLowerCase()) return null;
  return record.privateKey;
}

export type CreateStoreGasWalletResult =
  | { ok: true; info: StoreGasWalletInfo }
  | { ok: false; reason: 'already_exists' | 'corrupt' | 'storage_unavailable' };

/**
 * 新しい鍵を作って保存する。**何も無いときだけ** 作る (壊れた値・読めない状態の上には作らない)。
 * 保存できたことを読み戻しで確かめてから成功を返す (保存できない端末でアドレスを見せ、ガス代のトークンを入れた後に
 * 鍵が消える偽成功を断つ)。
 */
export function createStoreGasWallet(now: number = Date.now()): CreateStoreGasWalletResult {
  const current = loadStoreGasWallet();
  if (current.state === 'ok') return { ok: false, reason: 'already_exists' };
  if (current.state === 'corrupt') return { ok: false, reason: 'corrupt' };
  if (current.state === 'unavailable') return { ok: false, reason: 'storage_unavailable' };
  const privateKey = generatePrivateKey();
  const record: StoredRecord = {
    v: 1,
    privateKey,
    address: privateKeyToAccount(privateKey).address,
    createdAt: now,
  };
  try {
    window.localStorage.setItem(STORE_GAS_WALLET_STORAGE_KEY, JSON.stringify(record));
  } catch {
    return { ok: false, reason: 'storage_unavailable' };
  }
  const saved = readRaw();
  const parsed = saved.ok && saved.raw !== null ? parseRecord(saved.raw) : null;
  if (!parsed || parsed.privateKey !== privateKey) {
    return { ok: false, reason: 'storage_unavailable' };
  }
  return { ok: true, info: { address: parsed.address, createdAt: parsed.createdAt } };
}

/** この端末から鍵を消す。消えたことを読み戻しで確かめ、消せなかったら false (偽の成功を出さない)。 */
export function removeStoreGasWallet(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    window.localStorage.removeItem(STORE_GAS_WALLET_STORAGE_KEY);
  } catch {
    return false;
  }
  const after = readRaw();
  return after.ok && after.raw === null;
}

/**
 * 同じ端末の別タブと重ならないように直列化して実行する (Web Locks)。Web Locks が無いブラウザでは
 * そのまま実行する (タブ内の多重押しは呼び出し側の busy で止める)。
 */
export async function withStoreGasWalletLock<T>(fn: () => Promise<T>): Promise<T> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (!locks?.request) return fn();
  return locks.request(STORE_GAS_WALLET_LOCK, fn) as Promise<T>;
}

/**
 * このブラウザで別のタブとの排他 (Web Locks) が使えるか。使えない端末では「接続中のウォレットから補充」を始めない
 * (記録の読み書きが交差して二重に送る・片方の記録を失うのを止められないため・G11)。描画後にだけ呼ぶ (server では false)。
 */
export function hasStoreGasWalletLock(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.locks?.request === 'function';
}

/** 残高と現在のガス価格から、あと何回送れるかの目安 (0 以上の整数)。 */
export function estimateRemainingSends(balanceWei: bigint, gasPriceWei: bigint): number {
  if (balanceWei <= 0n || gasPriceWei <= 0n) return 0;
  const perSend = gasPriceWei * STORE_GAS_SETTLE_GAS_ESTIMATE;
  const n = balanceWei / perSend;
  return n > 9999n ? 9999 : Number(n);
}

// 「残りを戻す」の送金ガス。戻し先はウォレット (EOA) に限るので素の送金と同じ 21,000。
export const STORE_GAS_WITHDRAW_GAS = 21_000n;

/**
 * 「残りを戻す」で送れる額 (残高 − gas × maxFeePerGas)。実際のガス代はこの上限以下なので、
 * 差の少額が残ることがある。送れないなら 0。
 */
export function withdrawableAmount(
  balanceWei: bigint,
  gas: bigint,
  maxFeePerGasWei: bigint,
): bigint {
  const reserve = gas * maxFeePerGasWei;
  return balanceWei > reserve ? balanceWei - reserve : 0n;
}
