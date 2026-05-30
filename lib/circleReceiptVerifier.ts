// Circle Paymaster (USDC ガスレス) の徴収額 reconciliation (計画 C2/C3深)。
//
// balanceOf 差分は別タブ/別 wallet 操作/refund/同 block の無関係転送で汚染されるため
// **audit source にしない**。ここでは **tx receipt の per-UserOp scope** で
// circlePaymasterNetUsdc を再計算する:
//   net = Σ(customer→Circle paymaster の USDC Transfer) − Σ(paymaster→customer 返金)
//
// per-UserOp scope の必要性 (C2):
//   1 bundle に同一 sender の UserOp が複数入りうるため、tx 全体の Transfer 合算は誤集計。
//   各 UserOp の境界は EntryPoint の `UserOperationEvent` (UserOp 末尾に emit) で区切られ、
//   その UserOp の validation/execution/**postOp 徴収** はすべて直前の UserOperationEvent
//   からこの UserOp の UserOperationEvent までの log 範囲に収まる。この範囲だけを見る。
//
// binding 不変条件 (C3深):
//   client 申告フィールドを信用せず、**pending store record (source of truth) の
//   expected userOpHash/sender/paymaster** が receipt 上の UserOperationEvent と一致する
//   ことを証明してから net を採用する。一致しなければ `unreconciled`。

import {
  getAddress,
  keccak256,
  toBytes,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';

// keccak256(UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256))
// = EntryPoint v0.6/v0.7/v0.8 共通の UserOperationEvent topic0。
export const USER_OPERATION_EVENT_TOPIC =
  keccak256(
    toBytes(
      'UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)',
    ),
  );
// keccak256(Transfer(address,address,uint256)) = ERC20 Transfer topic0。
export const ERC20_TRANSFER_TOPIC = keccak256(
  toBytes('Transfer(address,address,uint256)'),
);

/** receipt log の最小形 (viem の Log から必要分だけ)。テストで合成しやすいよう薄く保つ。 */
export type ReceiptLog = {
  address: Address;
  topics: Hex[];
  data: Hex;
  logIndex: number;
};

export type CircleReconcileExpected = {
  /** pending record 由来 (source of truth)。 */
  userOpHash: Hex;
  sender: Address;
  /** Circle paymaster (permit spender・allowlist 由来)。 */
  paymaster: Address;
  /** USDC token アドレス。 */
  token: Address;
};

export type CircleReconcileResult =
  | {
      status: 'verified';
      /** customer→paymaster − paymaster→customer (raw USDC, 6dp)。 */
      netUsdc: bigint;
      /** 監査用の内訳。 */
      pulledUsdc: bigint;
      refundedUsdc: bigint;
    }
  | { status: 'unreconciled'; reason: string };

// 32byte topic (左 0 padding) を checksum address に。
function topicToAddress(topic: Hex): Address {
  return getAddress(`0x${topic.slice(-40)}`);
}

function eq(a: Address, b: Address): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * tx receipt の logs (bundle 全体) から、expected.userOpHash の UserOp scope に限定して
 * Circle の net USDC 徴収を再計算する。binding 不一致 / event 不在は unreconciled。
 *
 * 純粋関数 (RPC 非依存)。verifyCircleReceiptOnChain が publicClient で logs を供給する。
 */
export function reconcileCircleNetUsdc(args: {
  logs: ReceiptLog[];
  expected: CircleReconcileExpected;
}): CircleReconcileResult {
  const { expected } = args;
  // logIndex 昇順で安定させる (receipt が順不同で来ても scope 計算を正しくする)。
  const logs = [...args.logs].sort((a, b) => a.logIndex - b.logIndex);

  // UserOperationEvent を logIndex 順に抽出。
  const opEvents = logs
    .filter((l) => l.topics[0] === USER_OPERATION_EVENT_TOPIC)
    .map((l) => ({
      logIndex: l.logIndex,
      userOpHash: l.topics[1],
      sender: l.topics[2] ? topicToAddress(l.topics[2]) : undefined,
      paymaster: l.topics[3] ? topicToAddress(l.topics[3]) : undefined,
    }));

  const targetIdx = opEvents.findIndex(
    (e) => e.userOpHash?.toLowerCase() === expected.userOpHash.toLowerCase(),
  );
  if (targetIdx === -1) {
    return {
      status: 'unreconciled',
      reason: 'UserOperationEvent (expected userOpHash) が receipt に無い',
    };
  }
  const target = opEvents[targetIdx];

  // binding 検証: receipt 上の sender / paymaster が pending record と一致するか。
  if (!target.sender || !eq(target.sender, expected.sender)) {
    return {
      status: 'unreconciled',
      reason: `sender 不一致 (receipt=${target.sender} expected=${expected.sender})`,
    };
  }
  if (!target.paymaster || !eq(target.paymaster, expected.paymaster)) {
    return {
      status: 'unreconciled',
      reason: `paymaster 不一致 (receipt=${target.paymaster} expected=${expected.paymaster})`,
    };
  }

  // scope: 直前の UserOperationEvent (無ければ -∞) より後 〜 この UserOp の event 以下。
  const prevEventLogIndex = targetIdx > 0 ? opEvents[targetIdx - 1].logIndex : -1;
  const scope = logs.filter(
    (l) => l.logIndex > prevEventLogIndex && l.logIndex <= target.logIndex,
  );

  let pulled = 0n;
  let refunded = 0n;
  for (const l of scope) {
    if (!eq(l.address, expected.token)) continue;
    if (l.topics[0] !== ERC20_TRANSFER_TOPIC) continue;
    if (l.topics.length < 3) continue; // indexed from/to が無い異常 log は無視
    const from = topicToAddress(l.topics[1]);
    const to = topicToAddress(l.topics[2]);
    const value = BigInt(l.data);
    // 顧客 → paymaster (gas 徴収)。merchant/split/fee 転送 (to≠paymaster) は除外される。
    if (eq(from, expected.sender) && eq(to, expected.paymaster)) {
      pulled += value;
    }
    // paymaster → 顧客 (prefund 過大分の返金)。
    else if (eq(from, expected.paymaster) && eq(to, expected.sender)) {
      refunded += value;
    }
  }

  return {
    status: 'verified',
    netUsdc: pulled - refunded,
    pulledUsdc: pulled,
    refundedUsdc: refunded,
  };
}

/** on-chain receipt を取得して reconcile する (server/offline verifier 用)。
 * txHash の tx receipt 全体 (bundle) を取り、per-UserOp scope で net を再計算する。 */
export async function verifyCircleReceiptOnChain(args: {
  publicClient: PublicClient;
  txHash: Hex;
  expected: CircleReconcileExpected;
}): Promise<CircleReconcileResult> {
  const receipt = await args.publicClient.getTransactionReceipt({
    hash: args.txHash,
  });
  const logs: ReceiptLog[] = receipt.logs.map((l) => ({
    address: l.address,
    topics: l.topics as Hex[],
    data: l.data,
    logIndex: l.logIndex,
  }));
  return reconcileCircleNetUsdc({ logs, expected: args.expected });
}
