// 「お店の端末で送る」のレジ端末側 (plans/store-gas-wallet.md §13〜14 P2b-2)。店員に見せる名前は
// 「お店がガス代を肩代わりして送る」(呼び名の対応は lib/storeDevicePayment.ts の冒頭)。受け渡しで受け取った
// お客様の署名を、端末が自分で確かめてから、ガス用ウォレットの鍵で forwarder.settle を送る。
//
// 二重に送らない・誤って「受け取った」と言わない決まり:
//   - サーバの検証を信じ切らず、自分が作ったセッション (受取先・金額) と署名の中身を照合し、署名者を復元する。
//   - 期限の残りはブロックの時刻で測る (端末の時計のずれで期限切れの revert にガスを払わない)。
//   - 送る前に authorizationState が未使用・お客様の残高・simulate・ガスの上限と費用の上限を確かめる。
//   - 別タブとは Web Locks で直列化し、送った印 (nonce・hash) を「署名 → 印の保存 → 送信」の順で残す。
//     印を保存できなければ送らない。印があれば同じ署名は二度と送らない (その hash を見る)。
//   - 送信の失敗は relayer と同じ分類 (classifySendError)。届かなかったと確実で、authorizationState が
//     未使用だと確かめられたときだけ印を消して「送れませんでした」。それ以外は「送ったかもしれない」= 再送しない。
//   - 品物を渡す合図 (user 裁定): 送った tx の receipt が成功し、この支払いの Settled (6 項目) が一致したとき。
//     確定 (finalized) はサーバの判定 (/api/register/handoff/resolve) に寄せる。
//
// このモジュールは署名の復元と calldata の組み立てを含むので、レジの画面からは使うときだけ読み込む (dynamic import)。

import {
  createPublicClient,
  erc20Abi,
  getAddress,
  isAddress,
  isHex,
  keccak256,
  parseAbi,
  zeroAddress,
  type Address,
  type Hex,
  type Log,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { transportForChain } from '@/lib/chains';
import { buildForwarderNonce, type ForwarderSettleParams } from '@/lib/relay/forwarderIntent';
import {
  encodeSettleCalldata,
  recoverReceiveWithAuthorizationSigner,
} from '@/lib/relay/forwarderSettle';
import { hasMatchingForwarderSettlement } from '@/lib/relay/forwarderSettledEvent';
import { classifySendError } from '@/lib/relay/selfHostRelayer';
import {
  readStoreGasWalletKey,
  storeGasWalletChain,
  withStoreGasWalletLock,
} from '@/lib/storeGasWallet';
import {
  STORE_DEVICE_CLOCK_SKEW_SEC,
  STORE_DEVICE_FEE_WEI,
  STORE_DEVICE_MAX_GAS_COST_WEI,
  STORE_DEVICE_MAX_VALIDITY_SEC,
  STORE_DEVICE_MIN_REMAINING_SEC,
  STORE_DEVICE_SETTLE_GAS_CAP,
} from '@/lib/storeDevicePayment';

/** 受け渡し (端末の読み取り・締め切り) が返す、お客様の署名の値 (10 進文字列)。 */
export type DeviceAuth = {
  from: string;
  merchantValue: string;
  feeValue: string;
  validAfter: string;
  validBefore: string;
  intentSalt: string;
  signature: string;
  nonce: string;
};

/** 端末が作ったセッションの値 (照合の基準)。 */
export type DeviceExpectation = {
  chainId: number;
  token: Address;
  forwarder: Address;
  feeReceiver: Address;
  merchant: Address;
  amount: bigint;
};

export type VerifiedDeviceAuth = { params: ForwarderSettleParams; signature: Hex; nonce: Hex };

export type DeviceVerifyReject =
  | 'malformed'
  | 'merchant_mismatch'
  | 'amount_mismatch'
  | 'fee_mismatch'
  | 'not_yet_valid'
  | 'zero_from'
  | 'zero_salt'
  | 'nonce_mismatch'
  | 'signature_mismatch';

function parseWei(value: unknown): bigint | null {
  return typeof value === 'string' && /^\d{1,78}$/.test(value) ? BigInt(value) : null;
}

function isBytes32(value: unknown): value is Hex {
  return typeof value === 'string' && isHex(value) && value.length === 66;
}

/**
 * 受け取った署名を、端末が作ったセッションと照合する (時刻・チェーンの状態は sendStoreDeviceSettle で見る)。
 * view の merchant・amount は受け渡しが返したセッションの値 (自分が作った値と同じはず)。
 */
export async function verifyDeviceAuth(
  view: { merchant: unknown; amount: unknown; auth: DeviceAuth },
  exp: DeviceExpectation,
): Promise<{ ok: true; value: VerifiedDeviceAuth } | { ok: false; reason: DeviceVerifyReject }> {
  const a = view.auth;
  const merchantValue = parseWei(a.merchantValue);
  const feeValue = parseWei(a.feeValue);
  const validAfter = parseWei(a.validAfter);
  const validBefore = parseWei(a.validBefore);
  if (
    typeof a.from !== 'string' ||
    !isAddress(a.from, { strict: false }) ||
    merchantValue === null ||
    feeValue === null ||
    validAfter === null ||
    validBefore === null ||
    !isBytes32(a.intentSalt) ||
    !isBytes32(a.nonce) ||
    typeof a.signature !== 'string' ||
    !isHex(a.signature) ||
    a.signature.length !== 132
  ) {
    return { ok: false, reason: 'malformed' };
  }
  if (
    typeof view.merchant !== 'string' ||
    !isAddress(view.merchant, { strict: false }) ||
    getAddress(view.merchant) !== exp.merchant
  ) {
    return { ok: false, reason: 'merchant_mismatch' };
  }
  if (parseWei(view.amount) !== exp.amount || merchantValue !== exp.amount) {
    return { ok: false, reason: 'amount_mismatch' };
  }
  if (feeValue !== STORE_DEVICE_FEE_WEI) return { ok: false, reason: 'fee_mismatch' };
  // お客様の画面は validAfter = 0 で署名する (それ以外は端末の想定外 = 送らない)。
  if (validAfter !== 0n) return { ok: false, reason: 'not_yet_valid' };
  const from = getAddress(a.from);
  // 契約は ZeroAddress・ZeroSalt で revert する (送る前に止めてガスを捨てない)。
  if (from === zeroAddress) return { ok: false, reason: 'zero_from' };
  if (/^0x0{64}$/.test(a.intentSalt)) return { ok: false, reason: 'zero_salt' };
  const params: ForwarderSettleParams = {
    from,
    merchant: exp.merchant,
    merchantValue,
    feeReceiver: exp.feeReceiver,
    feeValue,
    validAfter,
    validBefore,
    intentSalt: a.intentSalt,
  };
  // nonce は受取先・金額・手数料受取口・期限・salt・チェーン・forwarder への commit。
  const nonce = buildForwarderNonce(params, exp.chainId, exp.forwarder);
  if (nonce.toLowerCase() !== a.nonce.toLowerCase()) return { ok: false, reason: 'nonce_mismatch' };
  let signer: Address;
  try {
    signer = await recoverReceiveWithAuthorizationSigner(
      params,
      exp.chainId,
      exp.token,
      exp.forwarder,
      a.signature as Hex,
    );
  } catch {
    return { ok: false, reason: 'signature_mismatch' };
  }
  if (getAddress(signer) !== from) return { ok: false, reason: 'signature_mismatch' };
  return { ok: true, value: { params, signature: a.signature as Hex, nonce } };
}

// ---------------------------------------------------------------------------
// 送った印 (同じ署名を二度送らない・再読み込み後に結果を出す)
// ---------------------------------------------------------------------------

export const STORE_DEVICE_SENT_KEY = 'openpay:store-device-sent:v1';
// 印を残す時間 (お客様の署名の期限 + 確定まで十分な時間)。古い印は保存のたびに捨てる。
const SENT_MARK_KEEP_MS = 60 * 60_000;
const SENT_MARK_MAX = 20;

export type DeviceSentMark = {
  handoffId: string;
  chainId: number;
  nonce: Hex;
  hash: Hex;
  from: Address;
  merchant: Address;
  /** 請求額 (wei の 10 進文字列)。 */
  amount: string;
  validBefore: string;
  intentSalt: Hex;
  at: number;
};

function isMark(v: unknown): v is DeviceSentMark {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.handoffId === 'string' &&
    typeof o.chainId === 'number' &&
    isBytes32(o.nonce) &&
    isBytes32(o.hash) &&
    typeof o.from === 'string' &&
    isAddress(o.from) &&
    typeof o.merchant === 'string' &&
    isAddress(o.merchant) &&
    typeof o.amount === 'string' &&
    typeof o.validBefore === 'string' &&
    isBytes32(o.intentSalt) &&
    typeof o.at === 'number'
  );
}

/** 印の一覧。読み取りの失敗は ok: false (「印なし」と区別する: 失敗を印なしと読むと二度送りうる)。 */
export function readSentMarks(): { ok: true; marks: DeviceSentMark[] } | { ok: false } {
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(STORE_DEVICE_SENT_KEY);
  } catch {
    return { ok: false };
  }
  if (!raw) return { ok: true, marks: [] };
  try {
    const v = JSON.parse(raw) as unknown;
    return { ok: true, marks: Array.isArray(v) ? v.filter(isMark) : [] };
  } catch {
    return { ok: true, marks: [] };
  }
}

/** 印を足して読み戻しで確かめる。保存できなければ false (呼び出し側は送らない)。 */
export function addSentMark(mark: DeviceSentMark, nowMs: number): boolean {
  const read = readSentMarks();
  if (!read.ok) return false;
  const kept = read.marks
    .filter((m) => nowMs - m.at < SENT_MARK_KEEP_MS && m.nonce.toLowerCase() !== mark.nonce.toLowerCase())
    .slice(-(SENT_MARK_MAX - 1));
  try {
    window.localStorage.setItem(STORE_DEVICE_SENT_KEY, JSON.stringify([...kept, mark]));
  } catch {
    return false;
  }
  const back = readSentMarks();
  return back.ok && back.marks.some((m) => m.hash.toLowerCase() === mark.hash.toLowerCase());
}

/** 届かなかったと確かめた送信の印を消す (消せなければ false = 「送ったかもしれない」のまま)。 */
export function removeSentMark(hash: Hex): boolean {
  const read = readSentMarks();
  if (!read.ok) return false;
  try {
    window.localStorage.setItem(
      STORE_DEVICE_SENT_KEY,
      JSON.stringify(read.marks.filter((m) => m.hash.toLowerCase() !== hash.toLowerCase())),
    );
  } catch {
    return false;
  }
  const back = readSentMarks();
  return back.ok && !back.marks.some((m) => m.hash.toLowerCase() === hash.toLowerCase());
}

// ---------------------------------------------------------------------------
// 送信
// ---------------------------------------------------------------------------

/** 送信に使うチェーン・鍵の操作 (hook が viem で組む・テストでは差し替える)。 */
export type DeviceSendIo = {
  /** 最新ブロックの時刻 (秒)。期限の残りはこれで測る。 */
  chainNowSec: () => Promise<bigint>;
  authorizationUsed: (from: Address, nonce: Hex) => Promise<boolean>;
  /** お客様の JPYC 残高 (wei)。 */
  tokenBalance: (from: Address) => Promise<bigint>;
  /** ガス用ウォレットの POL 残高 (wei)。 */
  nativeBalance: () => Promise<bigint>;
  /** settle を simulate する (revert なら throw)。 */
  simulate: (data: Hex) => Promise<void>;
  estimateGas: (data: Hex) => Promise<bigint>;
  pendingNonce: () => Promise<number>;
  /** 鍵を読んで tx に署名する (送らない)。鍵が無い・違うときは throw。 */
  signTx: (data: Hex, gas: bigint, nonce: number) => Promise<{ raw: Hex; hash: Hex; maxFeePerGas: bigint }>;
  sendRawTransaction: (raw: Hex) => Promise<void>;
  /** 別タブと直列化する (Web Locks)。 */
  withLock: <T>(fn: () => Promise<T>) => Promise<T>;
  nowMs: () => number;
};

export type DeviceNotSentReason =
  | 'expiring'
  | 'used'
  | 'customer_balance'
  | 'simulate_failed'
  | 'gas_limit'
  | 'gas_too_high'
  | 'native_insufficient'
  | 'storage'
  | 'send_rejected'
  | 'rpc';

export type DeviceSendResult =
  // 送った (または送ったかもしれない)。この印 (hash) を見る。印は結果に含める (読み直しの失敗で見失わない)。
  | { kind: 'sent'; hash: Hex; mark: DeviceSentMark }
  // この署名は前に送った印がある (別タブ・再読み込み前)。その hash を見る。
  | { kind: 'already'; hash: Hex; mark: DeviceSentMark }
  // 送っていない (確実)。お客様の署名は期限まで有効なまま (端末は自動で再送しない)。
  | { kind: 'not_sent'; reason: DeviceNotSentReason };

/** ガスの見積に足す余裕 (+20%)。 */
function buffered(estimate: bigint): bigint {
  return estimate + estimate / 5n;
}

export async function sendStoreDeviceSettle(
  v: VerifiedDeviceAuth,
  ctx: { handoffId: string; chainId: number; forwarder: Address },
  io: DeviceSendIo,
): Promise<DeviceSendResult> {
  const data = encodeSettleCalldata(v.params, v.signature);
  const total = v.params.merchantValue + v.params.feeValue;
  return io.withLock(async () => {
    const marks = readSentMarks();
    if (!marks.ok) return { kind: 'not_sent', reason: 'storage' };
    const prior = marks.marks.find((m) => m.nonce.toLowerCase() === v.nonce.toLowerCase());
    if (prior) return { kind: 'already', hash: prior.hash, mark: prior };

    let signed: { raw: Hex; hash: Hex; maxFeePerGas: bigint };
    let gas: bigint;
    try {
      const now = await io.chainNowSec();
      const remaining = v.params.validBefore - now;
      if (remaining < BigInt(STORE_DEVICE_MIN_REMAINING_SEC)) return { kind: 'not_sent', reason: 'expiring' };
      if (remaining > BigInt(STORE_DEVICE_MAX_VALIDITY_SEC + STORE_DEVICE_CLOCK_SKEW_SEC)) {
        return { kind: 'not_sent', reason: 'expiring' };
      }
      if (await io.authorizationUsed(v.params.from, v.nonce)) return { kind: 'not_sent', reason: 'used' };
      if ((await io.tokenBalance(v.params.from)) < total) return { kind: 'not_sent', reason: 'customer_balance' };
      // POL が 0 だと見積もりの失敗 (= 読み取れない) に見えるので、先に「POL が足りない」と分かるようにする。
      if ((await io.nativeBalance()) === 0n) return { kind: 'not_sent', reason: 'native_insufficient' };
      try {
        await io.simulate(data);
      } catch {
        return { kind: 'not_sent', reason: 'simulate_failed' };
      }
      gas = buffered(await io.estimateGas(data));
      // 見積を超えて切り詰めると out-of-gas の revert にガスを捨てる → 上限を超えるなら送らない。
      if (gas > STORE_DEVICE_SETTLE_GAS_CAP) return { kind: 'not_sent', reason: 'gas_limit' };
      signed = await io.signTx(data, gas, await io.pendingNonce());
      const cost = gas * signed.maxFeePerGas;
      if (cost > STORE_DEVICE_MAX_GAS_COST_WEI) return { kind: 'not_sent', reason: 'gas_too_high' };
      if ((await io.nativeBalance()) < cost) return { kind: 'not_sent', reason: 'native_insufficient' };
    } catch {
      // 送る前の読み取り・署名の失敗 (RPC 障害・鍵が読めない) = 送っていない。
      return { kind: 'not_sent', reason: 'rpc' };
    }

    // 印を先に残す (送信の応答を失っても、同じ署名を二度送らず、この hash を見られる)。
    const mark: DeviceSentMark = {
      handoffId: ctx.handoffId,
      chainId: ctx.chainId,
      nonce: v.nonce,
      hash: signed.hash,
      from: v.params.from,
      merchant: v.params.merchant,
      amount: v.params.merchantValue.toString(),
      validBefore: v.params.validBefore.toString(),
      intentSalt: v.params.intentSalt,
      at: io.nowMs(),
    };
    if (!addSentMark(mark, io.nowMs())) return { kind: 'not_sent', reason: 'storage' };

    try {
      await io.sendRawTransaction(signed.raw);
      return { kind: 'sent', hash: signed.hash, mark };
    } catch (err) {
      const cls = classifySendError(err instanceof Error ? err.message : String(err));
      if (cls === 'known' || cls === 'uncertain') return { kind: 'sent', hash: signed.hash, mark };
      // 'fatal' / 'collision' = この tx は mempool に届いていない。この署名が未使用だと確かめられたときだけ
      // 印を消して「送れませんでした」(確かめられなければ送ったかもしれないとして hash を見る)。
      let used: boolean;
      try {
        used = await io.authorizationUsed(v.params.from, v.nonce);
      } catch {
        return { kind: 'sent', hash: signed.hash, mark };
      }
      if (used || !removeSentMark(signed.hash)) return { kind: 'sent', hash: signed.hash, mark };
      const insufficient = /insufficient funds/i.test(err instanceof Error ? err.message : String(err));
      return { kind: 'not_sent', reason: insufficient ? 'native_insufficient' : 'send_rejected' };
    }
  });
}

/** 送った tx の receipt に、この支払いの Settled (6 項目) があるか (品物を渡す合図)。 */
export function receiptHasSettlement(
  logs: Log[],
  forwarder: Address,
  mark: Pick<DeviceSentMark, 'from' | 'nonce' | 'merchant' | 'amount'>,
  feeReceiver: Address,
): boolean {
  return hasMatchingForwarderSettlement(logs, forwarder, mark.from, mark.nonce, {
    merchant: mark.merchant,
    merchantValue: BigInt(mark.amount),
    feeReceiver,
    feeValue: STORE_DEVICE_FEE_WEI,
  });
}

// ---------------------------------------------------------------------------
// チェーンとの接続 (viem・公開 RPC・ガス用ウォレットの鍵)
// ---------------------------------------------------------------------------

const AUTHORIZATION_STATE_ABI = parseAbi([
  'function authorizationState(address authorizer, bytes32 nonce) view returns (bool)',
]);

/** 送った tx の結果 (品物を渡す合図の材料)。 */
export type DeviceReceipt = { status: 'success' | 'reverted'; logs: Log[] } | null;

export type DeviceWatchIo = {
  /** receipt を待つ (時間切れ・通信断は null = まだ分からない)。 */
  waitReceipt: (hash: Hex, timeoutMs: number) => Promise<DeviceReceipt>;
  /** いまの receipt (無い・読めないは null)。 */
  getReceipt: (hash: Hex) => Promise<DeviceReceipt>;
};

/**
 * レジ端末の送信と確認に使う IO を組む。鍵は signTx の中で送る直前にだけ読み、戻り値にも state にも載せない。
 * 別タブとの直列化はガス用ウォレットの Web Locks (「残りの POL を戻す」と同じロック = nonce を取り合わない)。
 */
export function createDeviceIo(input: {
  token: Address;
  forwarder: Address;
  gasAddress: Address;
}): DeviceSendIo & DeviceWatchIo {
  const chain = storeGasWalletChain();
  const client = createPublicClient({ chain, transport: transportForChain(chain.id) });
  const { token, forwarder, gasAddress } = input;
  const toReceipt = (r: { status: 'success' | 'reverted'; logs: Log[] }): DeviceReceipt => ({
    status: r.status,
    logs: r.logs,
  });
  return {
    chainNowSec: async () => (await client.getBlock({ blockTag: 'latest' })).timestamp,
    authorizationUsed: (from, nonce) =>
      client.readContract({
        address: token,
        abi: AUTHORIZATION_STATE_ABI,
        functionName: 'authorizationState',
        args: [from, nonce],
      }),
    tokenBalance: (from) =>
      client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [from] }),
    nativeBalance: () => client.getBalance({ address: gasAddress }),
    simulate: async (data) => {
      await client.call({ account: gasAddress, to: forwarder, data });
    },
    estimateGas: (data) => client.estimateGas({ account: gasAddress, to: forwarder, data }),
    pendingNonce: () => client.getTransactionCount({ address: gasAddress, blockTag: 'pending' }),
    signTx: async (data, gas, nonce) => {
      const fees = await client.estimateFeesPerGas();
      const key = readStoreGasWalletKey(gasAddress);
      if (!key) throw new Error('store_gas_wallet_key_unavailable');
      const raw = await privateKeyToAccount(key).signTransaction({
        chainId: chain.id,
        type: 'eip1559',
        to: forwarder,
        data,
        value: 0n,
        gas,
        nonce,
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      });
      return { raw, hash: keccak256(raw), maxFeePerGas: fees.maxFeePerGas };
    },
    sendRawTransaction: async (raw) => {
      await client.sendRawTransaction({ serializedTransaction: raw });
    },
    withLock: withStoreGasWalletLock,
    nowMs: () => Date.now(),
    waitReceipt: async (hash, timeoutMs) => {
      try {
        return toReceipt(await client.waitForTransactionReceipt({ hash, timeout: timeoutMs }));
      } catch {
        return null; // 時間切れ・通信断は「まだ分からない」(失敗とは言わない)
      }
    },
    getReceipt: async (hash) => {
      try {
        return toReceipt(await client.getTransactionReceipt({ hash }));
      } catch {
        return null;
      }
    },
  };
}
