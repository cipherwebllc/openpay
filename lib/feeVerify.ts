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
  | { ok: true; value: bigint }
  | {
      ok: false;
      reason:
        | 'no_matching_transfer'
        | 'amount_too_low'
        | 'tx_reverted'
        | 'tx_not_found';
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
    if (log.topics[0]?.toLowerCase() !== ERC20_TRANSFER_TOPIC) continue;

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
  }>;
};

/** on-chain: receipt 取得 → status 確認 → 純関数で照合。publicClient は chain ごとに呼出側が用意。 */
export async function verifyJpycFeeOnChain(args: {
  publicClient: ReceiptReader;
  txHash: Hex;
  expected: FeeTransferExpected;
}): Promise<FeeVerifyResult> {
  let receipt: Awaited<ReturnType<ReceiptReader['getTransactionReceipt']>>;
  try {
    receipt = await args.publicClient.getTransactionReceipt({ hash: args.txHash });
  } catch {
    return { ok: false, reason: 'tx_not_found' };
  }
  if (!receipt) return { ok: false, reason: 'tx_not_found' };
  if (receipt.status !== 'success') return { ok: false, reason: 'tx_reverted' };
  return verifyJpycFeeTransfer({ logs: receipt.logs, expected: args.expected });
}
