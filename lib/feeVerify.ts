// JPYC 利用料の on-chain 検証。指定 tx の receipt logs から「セッション wallet → OpenPay
// 受領アドレス」への JPYC ERC20 Transfer を集計し、tier 額以上かを判定する (server 専用)。
// 二重付与防止 (txHash idempotency) と SIWE 認証は呼び出し側 (/api/fee/verify) の責務。
import { getAddress, type Address, type Hex } from 'viem';

// keccak256("Transfer(address,address,uint256)") — ERC20 標準の不変トピック。
const ERC20_TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

export type FeeTransferExpected = {
  token: Address; // 該当 chain の JPYC
  from: Address; // 支払い元 (セッション wallet)
  to: Address; // OpenPay 受領アドレス
  minValue: bigint; // tier 額 (JPYC minor units)
};

export type FeeVerifyResult =
  // blockNumber は **on-chain 検証 (verifyJpycFeeOnChain) のみ** で埋まる (receipt から取得)。
  // 純関数 verifyJpycFeeTransfer は logs しか持たないため常に undefined。Pro 加入 route は
  // この blockNumber → getBlock で支払い tx の block timestamp を引き、決定論的な付与満了
  // (= blockTs + 30日) を算出する (now() を使わない・retry 冪等の核心)。
  | { ok: true; value: bigint; blockNumber?: bigint }
  | {
      ok: false;
      reason:
        | 'no_matching_transfer'
        | 'amount_too_low'
        | 'tx_reverted'
        | 'tx_not_found'
        // RPC/transport 障害 (ダウン/rate limit/network/timeout)。tx_not_found (= 顧客が
        // 未マイニング/誤った hash を出した) とは別物で、呼出側は retryable + alert に回す。
        | 'rpc_error';
    };

// viem の Log と構造的に互換な最小形 (テストでモック可能・重い generic を避ける)。
export type FeeReceiptLog = {
  address: string;
  topics: readonly string[];
  data: string;
};

function topicToAddress(topic: string): Address {
  // indexed address は 32byte 左 0 詰め。末尾 40 hex = アドレス。
  return getAddress(`0x${topic.slice(-40)}` as Hex);
}

/**
 * 純関数: receipt logs から expected.token の Transfer(from→to) を合算し minValue 以上か判定。
 * 同一 tx 内の複数 Transfer は合算する (分割送金の保険)。
 */
export function verifyJpycFeeTransfer(args: {
  logs: readonly FeeReceiptLog[];
  expected: FeeTransferExpected;
}): FeeVerifyResult {
  const token = getAddress(args.expected.token);
  const from = getAddress(args.expected.from);
  const to = getAddress(args.expected.to);

  let total = 0n;
  let matched = false;
  for (const log of args.logs) {
    let logToken: Address;
    try {
      logToken = getAddress(log.address);
    } catch {
      continue;
    }
    if (logToken !== token) continue;
    if (log.topics.length < 3) continue;
    if (log.topics[0].toLowerCase() !== ERC20_TRANSFER_TOPIC) continue;

    let logFrom: Address;
    let logTo: Address;
    try {
      logFrom = topicToAddress(log.topics[1]);
      logTo = topicToAddress(log.topics[2]);
    } catch {
      continue;
    }
    if (logFrom !== from || logTo !== to) continue;

    let value: bigint;
    try {
      value = BigInt(log.data);
    } catch {
      continue;
    }
    total += value;
    matched = true;
  }

  if (!matched) return { ok: false, reason: 'no_matching_transfer' };
  if (total < args.expected.minValue) {
    return { ok: false, reason: 'amount_too_low' };
  }
  return { ok: true, value: total };
}

type ReceiptReader = {
  getTransactionReceipt: (a: { hash: Hex }) => Promise<{
    status: 'success' | 'reverted';
    logs: readonly FeeReceiptLog[];
    // viem の receipt は blockNumber: bigint を含む。Pro 加入の決定論的付与で使う
    // (block timestamp → targetExpiresAt)。billing/settle 経路はこの値を読まない (period 基準)。
    blockNumber?: bigint;
  }>;
};

/** on-chain: receipt 取得 → status 確認 → 純関数で照合。publicClient は chain ごとに呼出側が用意。
 *  成功時は receipt の blockNumber を結果に載せる (純関数の判定は不変・追加フィールドのみ)。 */
export async function verifyJpycFeeOnChain(args: {
  publicClient: ReceiptReader;
  txHash: Hex;
  expected: FeeTransferExpected;
}): Promise<FeeVerifyResult> {
  let receipt: Awaited<ReturnType<ReceiptReader['getTransactionReceipt']>>;
  try {
    receipt = await args.publicClient.getTransactionReceipt({ hash: args.txHash });
  } catch (e) {
    // viem は未マイニング/不明な tx に TransactionReceiptNotFoundError を投げる (= 顧客側
    // の正当な「まだ見つからない」)。それ以外 (RPC ダウン / rate limit / network / timeout) は
    // transport 障害として区別し、呼出側で retryable 503 + alert へ回す。
    const name = (e as { name?: unknown })?.name;
    if (name === 'TransactionReceiptNotFoundError') {
      return { ok: false, reason: 'tx_not_found' };
    }
    return { ok: false, reason: 'rpc_error' };
  }
  if (receipt.status !== 'success') return { ok: false, reason: 'tx_reverted' };
  const result = verifyJpycFeeTransfer({ logs: receipt.logs, expected: args.expected });
  // 照合成功時のみ blockNumber を付加する (失敗時は reason だけ・形を変えない)。
  // settle はこのフィールドを無視するので既存挙動に影響しない (追加のみ・破壊なし)。
  if (result.ok && receipt.blockNumber !== undefined) {
    return { ...result, blockNumber: receipt.blockNumber };
  }
  return result;
}

// ===========================================================================
// from 非依存の「to への着金」検証 (受注リレー用)。
// verifyJpycFeeTransfer は from 厳格 (billing/settle が依存) なので**触らず**、別関数として追加。
// ===========================================================================

export type JpycTransferToExpected = {
  token: Address; // 該当 chain の JPYC
  to: Address; // 受取先 (merchant)。from は問わない。
  minValue: bigint; // 最低着金額 (JPYC minor units)。受注リレーは dust フロアを使う。
};

/**
 * 純関数 (from 非依存): receipt logs から token の Transfer(* → to) を**全て合算**し minValue 以上か判定。
 * `verifyJpycFeeTransfer` と違い **from を問わない**。理由 (CRITICAL): forwarder(recover) 経路は
 * `customer→forwarder` のあと forwarder が `forwarder→merchant` + `forwarder→feeReceiver` に分割するため、
 * 「customer→merchant」ログが存在しない。from 厳格だと正当な着金を全取りこぼす。free 経路
 * (customer→merchant) も to 一致で拾える。受注リレーの「merchant への実着金確認」専用 (billing 不使用)。
 */
export function verifyJpycTransferTo(args: {
  logs: readonly FeeReceiptLog[];
  expected: JpycTransferToExpected;
}): FeeVerifyResult {
  const token = getAddress(args.expected.token);
  const to = getAddress(args.expected.to);

  let total = 0n;
  let matched = false;
  for (const log of args.logs) {
    let logToken: Address;
    try {
      logToken = getAddress(log.address);
    } catch {
      continue;
    }
    if (logToken !== token) continue;
    if (log.topics.length < 3) continue;
    if (log.topics[0].toLowerCase() !== ERC20_TRANSFER_TOPIC) continue;

    let logTo: Address;
    try {
      logTo = topicToAddress(log.topics[2]); // topics[1]=from は無視
    } catch {
      continue;
    }
    if (logTo !== to) continue;

    let value: bigint;
    try {
      value = BigInt(log.data);
    } catch {
      continue;
    }
    total += value;
    matched = true;
  }

  if (!matched) return { ok: false, reason: 'no_matching_transfer' };
  if (total < args.expected.minValue) {
    return { ok: false, reason: 'amount_too_low' };
  }
  return { ok: true, value: total };
}

/** on-chain (from 非依存): receipt 取得 → status 確認 → verifyJpycTransferTo で照合。
 *  成功時は **実着金合計 (value)** と blockNumber を返す (受注の権威額 + 決定論的 ts 用)。 */
export async function verifyJpycTransferToOnChain(args: {
  publicClient: ReceiptReader;
  txHash: Hex;
  expected: JpycTransferToExpected;
}): Promise<FeeVerifyResult> {
  let receipt: Awaited<ReturnType<ReceiptReader['getTransactionReceipt']>>;
  try {
    receipt = await args.publicClient.getTransactionReceipt({ hash: args.txHash });
  } catch (e) {
    const name = (e as { name?: unknown })?.name;
    if (name === 'TransactionReceiptNotFoundError') {
      return { ok: false, reason: 'tx_not_found' };
    }
    return { ok: false, reason: 'rpc_error' };
  }
  if (receipt.status !== 'success') return { ok: false, reason: 'tx_reverted' };
  const result = verifyJpycTransferTo({ logs: receipt.logs, expected: args.expected });
  if (result.ok && receipt.blockNumber !== undefined) {
    return { ...result, blockNumber: receipt.blockNumber };
  }
  return result;
}
