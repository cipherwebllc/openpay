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
  /** UserOperationEvent を emit すべき EntryPoint アドレス (v0.8)。同名 event を出す別
   * contract による scope 汚染を防ぐため、発火元が EntryPoint であることを必須にする。 */
  entryPoint: Address;
};

// UserOperationEvent data = abi.encode(nonce, success(bool), actualGasCost, actualGasUsed)。
// success は 2 番目の 32-byte word。data が短い異常 log は判定不能として true 扱い
// (既存の verified 挙動を壊さず、binding/scope 側の検証に委ねる)。
function userOpSucceeded(data: Hex): boolean {
  const hex = data.startsWith('0x') ? data.slice(2) : data;
  if (hex.length < 128) return true;
  return BigInt(`0x${hex.slice(64, 128)}`) !== 0n;
}

// unreconciled の構造化分類。reason 文字列の regex マッチに依存せず、呼出側 (監査ログ) が
// binding 違反 (信頼境界破れ = RED FLAG) と良性ケースを確実に区別できるようにする。
//   event-absent      : expected userOpHash の UserOperationEvent が EntryPoint から出ていない
//   binding-sender    : receipt の sender が pending record と不一致
//   binding-paymaster : receipt の paymaster が expected (allowlist) と不一致 ← 最重要 RED FLAG
//   reverted          : UserOp success=false (merchant 転送 revert)
//   no-charge         : scope 内に customer→paymaster の徴収 Transfer が無い (collector≠paymaster
//                       の可能性 / testnet 無償 sponsor)。net=0 を verified と誤報告しないため。
export type UnreconciledKind =
  | 'event-absent'
  | 'binding-sender'
  | 'binding-paymaster'
  | 'reverted'
  | 'no-charge';

export type CircleReconcileResult =
  | {
      status: 'verified';
      /** customer→paymaster − paymaster→customer (raw USDC, 6dp)。 */
      netUsdc: bigint;
      /** 監査用の内訳。 */
      pulledUsdc: bigint;
      refundedUsdc: bigint;
    }
  | { status: 'unreconciled'; reason: string; kind: UnreconciledKind };

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

  // UserOperationEvent を logIndex 順に抽出。**発火元が expected.entryPoint であることを
  // 必須**にし、同名 event を出す別 contract による scope/targetIdx 汚染を防ぐ (C3 hardening)。
  const opEvents = logs
    .filter(
      (l) =>
        l.topics[0] === USER_OPERATION_EVENT_TOPIC &&
        eq(l.address, expected.entryPoint),
    )
    .map((l) => ({
      logIndex: l.logIndex,
      userOpHash: l.topics[1],
      sender: l.topics[2] ? topicToAddress(l.topics[2]) : undefined,
      paymaster: l.topics[3] ? topicToAddress(l.topics[3]) : undefined,
      data: l.data,
    }));

  const targetIdx = opEvents.findIndex(
    (e) => e.userOpHash?.toLowerCase() === expected.userOpHash.toLowerCase(),
  );
  if (targetIdx === -1) {
    return {
      status: 'unreconciled',
      kind: 'event-absent',
      reason: 'UserOperationEvent (expected userOpHash) が receipt に無い',
    };
  }
  const target = opEvents[targetIdx];

  // binding 検証: receipt 上の sender / paymaster が pending record と一致するか。
  if (!target.sender || !eq(target.sender, expected.sender)) {
    return {
      status: 'unreconciled',
      kind: 'binding-sender',
      reason: `sender 不一致 (receipt=${target.sender} expected=${expected.sender})`,
    };
  }
  if (!target.paymaster || !eq(target.paymaster, expected.paymaster)) {
    return {
      status: 'unreconciled',
      kind: 'binding-paymaster',
      reason: `paymaster 不一致 (receipt=${target.paymaster} expected=${expected.paymaster})`,
    };
  }
  // UserOp が revert していたら (success=false) 正常な決済ではない → unreconciled。
  // (merchant 転送は revert するが postOp の gas 徴収は起きうるため net は意味が異なる。
  //  「verified な成功決済」として報告しない。)
  if (!userOpSucceeded(target.data)) {
    return {
      status: 'unreconciled',
      kind: 'reverted',
      reason: 'UserOperation success=false (revert)',
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

  // scope 内に customer→paymaster の徴収が 1 件も無い = net を 0 と確定できない。
  // Circle が別 collector アドレスへ pull している (mainnet で要実測・runbook 参照) か、
  // testnet 無償 sponsor の可能性。net=0 を「verified」と誤報告せず unreconciled に倒し、
  // 監査で「徴収額不明」として可視化する (silent な 0 計上を防ぐ)。
  if (pulled === 0n) {
    return {
      status: 'unreconciled',
      kind: 'no-charge',
      reason:
        'scope 内に customer→paymaster の USDC 徴収が無い (collector≠paymaster の可能性 / 無償 sponsor)',
    };
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
