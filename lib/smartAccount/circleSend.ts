'use client';

// Circle Paymaster (USDC ガスレス) 決済の **二重決済耐性オーケストレータ** (計画 C1)。
//
// 不可逆な merchant 転送を二重に出さないため、送信を FSM (lib/circlePending.ts) で
// 段階管理する:
//   permit 署名(popup1) → UserOp prepare+sign(popup2) → **署名済 op を永続** →
//   submitting を永続 (broadcast_intent・fail-closed) → **raw broadcast** → 確定。
//
// 不変条件:
//   - 永続 (pending store) は fail-closed: 書込が確証できなければ送信しない。
//   - **submitting 到達後は fallback も新規 op 構築も禁止**。応答ロスト / wait timeout は
//     「included しうる unknown」として扱い、recovery は (a) receipt 照会 か
//     (b) *同一署名 op* の冪等 rebroadcast のみ。新しい op は決して作らない。
//   - cross-invocation (reload / 再クリック): 同一 sender+chain+callHash の submitting
//     宙吊りがあれば、新規送信せず先にそれを recover する。
//
// useBatchPayment の circle 分岐がこの executeCirclePayment を呼ぶ。permitAmount の
// 算定 (gas 実費 + per-chain surcharge) は chunk 5 (useGasQuoteCircle) が担い、ここへは
// 確定値が渡る (本 module は fee ポリシーを持たない)。

import { keccak256, type Address, type Hex } from 'viem';
import { WaitForUserOperationReceiptTimeoutError } from 'viem/account-abstraction';
import {
  broadcastCircleUserOp,
  prepareAndSignCircleUserOp,
  signUsdcPermit,
  waitForCircleReceipt,
  type BatchCall,
  type CircleSmartAccountBundle,
  type SignedCircleUserOp,
} from '@/lib/smartAccount/circleAccount';
import type { ConnectedWalletClient } from '@/lib/smartAccount/simpleAccount';
import {
  abandon,
  computeCallHash,
  computeIdempotencyKey,
  findRecoverable,
  loadPendingRecord,
  markAwaitingSignature,
  markConfirmed,
  markSigned,
  markSubmitting,
  reserveOrResume,
  type PendingRecord,
} from '@/lib/circlePending';
import { logger } from '@/lib/logger';
import type { PublicClient } from 'viem';

export type CirclePaymentResult = {
  userOpHash: Hex;
  txHash: Hex;
  blockNumber: bigint;
  success: boolean;
  /** UserOp が消費した native gas (wei)。Circle (erc20) では reconciliation に使わないが
   * 形を pimlico 経路と揃える。recovery (poll) 経由で不明なときは 0n。 */
  actualGasCost: bigint;
};

/** broadcast 済 (or 済かもしれない) だが timeout 内に included を確認できなかった状態。
 * **失敗ではない** — op は後で included しうるし、findRecoverable で復旧できる。UI は
 * 「送信済・確認待ち。再読み込みしても二重決済にならない」と案内する。 */
export class CirclePendingError extends Error {
  readonly userOpHash: Hex;
  constructor(userOpHash: Hex) {
    super(
      'USDC ガスレス決済を送信しましたが、確定の確認に時間がかかっています。' +
        'ページを再読み込みしても二重決済にはなりません (自動で復旧を試みます)。',
    );
    this.name = 'CirclePendingError';
    this.userOpHash = userOpHash;
  }
}

type Receipt = Awaited<ReturnType<typeof waitForCircleReceipt>>;

function toResult(userOpHash: Hex, receipt: Receipt): CirclePaymentResult {
  return {
    userOpHash,
    txHash: receipt.receipt.transactionHash,
    blockNumber: receipt.receipt.blockNumber,
    success: receipt.success,
    actualGasCost: receipt.actualGasCost,
  };
}

// waitForUserOperationReceipt の timeout を「まだ pending」(null) に変換する。
// それ以外の error は伝播させる (bundler 障害等は recovery 対象外)。
async function waitOrNull(
  bundle: CircleSmartAccountBundle,
  hash: Hex,
): Promise<Receipt | null> {
  try {
    return await waitForCircleReceipt({ bundle, hash });
  } catch (error) {
    if (error instanceof WaitForUserOperationReceiptTimeoutError) return null;
    throw error;
  }
}

// submitting で宙吊りの record を確定させる recovery 経路。
//   1) included を待つ (broadcast 済で応答だけロストしたケースを拾う)
//   2) まだなら *同一署名 op* を冪等 rebroadcast (broadcast 自体が届かず crash したケース)
//      → 再 wait
// confirmed にできたら結果を、まだ pending なら null を返す (record は submitting 維持)。
async function recoverSubmitting(args: {
  bundle: CircleSmartAccountBundle;
  record: PendingRecord;
  sender: Address;
  now: () => number;
}): Promise<CirclePaymentResult | null> {
  const { bundle, record, sender, now } = args;
  if (!record.userOpHash || !record.signedUserOp) {
    // submitting なのに署名済 op が無い = あり得ない (markSubmitting が防ぐ) が、
    // 万一なら確定不能なので pending 扱い (新規 op は作らない)。
    return null;
  }
  const hash = record.userOpHash;

  let receipt = await waitOrNull(bundle, hash);
  if (!receipt) {
    logger.info('circle.recover.rebroadcast', { userOpHash: hash });
    try {
      await broadcastCircleUserOp({
        bundle,
        signedUserOp: record.signedUserOp as SignedCircleUserOp,
      });
    } catch (error) {
      // "already known" / nonce 使用済 等は in-flight or 確定済の証左なので無害。
      logger.info('circle.recover.rebroadcast-noop', {
        userOpHash: hash,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    // submitting を冪等再入して updatedAt を更新 (掃除対象から守る)。
    markSubmitting({ key: record.key, sender, now: now() });
    receipt = await waitOrNull(bundle, hash);
  }

  if (receipt) {
    markConfirmed({
      key: record.key,
      sender,
      txHash: receipt.receipt.transactionHash,
      now: now(),
    });
    return toResult(hash, receipt);
  }
  return null;
}

export type ExecuteCirclePaymentArgs = {
  bundle: CircleSmartAccountBundle;
  publicClient: PublicClient;
  walletClient: ConnectedWalletClient;
  /** 委任済 EOA (= account owner)。permit signer かつ pending record の認可主体。 */
  owner: Address;
  /** merchant (+ split/fee) への transfer calls。 */
  calls: BatchCall[];
  /** Circle paymaster に与える permit allowance (gas 実費+surcharge を賄う上限・chunk5)。 */
  permitAmount: bigint;
  /** 1 回の「支払う」操作で固定の試行 ID (retry で不変・正規の再決済では別値)。 */
  paymentAttemptId: string;
  /** テスト用に注入可能な時刻源。 */
  now?: () => number;
};

/** Circle 経路の 1 決済を二重決済耐性付きで実行する。confirmed の結果を返すか、
 * 確認待ちなら CirclePendingError を投げる (失敗ではない・後で復旧可能)。 */
export async function executeCirclePayment(
  args: ExecuteCirclePaymentArgs,
): Promise<CirclePaymentResult> {
  const { bundle, publicClient, walletClient, owner, calls, permitAmount } = args;
  const now = args.now ?? (() => Date.now());
  const sender = owner;
  const chainId = bundle.chainId;
  const callHash = computeCallHash(calls);

  // --- cross-invocation recovery -----------------------------------------
  // reload / timeout 後の再クリックで、同じ決済 (同一 callHash) の submitting 宙吊りが
  // あれば **新規送信せず** それを確定させる。これが「応答ロスト→再試行で二重決済」の
  // 主要ガード。
  const inflight = findRecoverable({ sender, chainId }).filter(
    (r) => r.callHash === callHash,
  );
  for (const rec of inflight) {
    const recovered = await recoverSubmitting({ bundle, record: rec, sender, now });
    if (recovered) return recovered;
    // まだ confirm できない → 新規送信は危険なので pending を投げて待たせる。
    throw new CirclePendingError(rec.userOpHash as Hex);
  }

  // --- reserve (idempotency gate) ----------------------------------------
  const key = computeIdempotencyKey({
    chainId,
    sender,
    paymentAttemptId: args.paymentAttemptId,
    callHash,
  });
  const { record, resumed } = reserveOrResume({
    key,
    chainId,
    sender,
    callHash,
    paymentAttemptId: args.paymentAttemptId,
    paymaster: bundle.paymasterAddress,
    now: now(),
  });

  if (resumed) {
    if (record.status === 'confirmed') {
      return await resultFromConfirmed(bundle, record);
    }
    if (record.status === 'submitting') {
      const recovered = await recoverSubmitting({ bundle, record, sender, now });
      if (recovered) return recovered;
      throw new CirclePendingError(record.userOpHash as Hex);
    }
    if (record.status === 'failed' || record.status === 'abandoned') {
      throw new Error(
        'この決済試行は既に終了しています。新しい決済として実行し直してください。',
      );
    }
    // pre-submit (reserved/awaiting_signature/signed): まだ broadcast していないので
    // 下の通常フローで (再) 署名して送信して良い。
  }

  // --- normal flow --------------------------------------------------------
  markAwaitingSignature({ key, sender, now: now() });

  let paymasterData: Hex;
  let permitSignature: Hex;
  try {
    const signed = await signUsdcPermit({
      publicClient,
      walletClient,
      bundle,
      owner,
      permitAmount,
    }); // popup1
    paymasterData = signed.paymasterData;
    permitSignature = signed.permitSignature;
  } catch (error) {
    // 署名前/署名拒否 = 未 broadcast の確定的失敗 → abandon (二重決済リスクなし)。
    abandon({ key, sender, now: now() });
    throw error;
  }

  let signedUserOp: SignedCircleUserOp;
  let userOpHash: Hex;
  try {
    const prepared = await prepareAndSignCircleUserOp({
      bundle,
      calls,
      paymasterData,
    }); // popup2 (signUserOperation)
    signedUserOp = prepared.signedUserOp;
    userOpHash = prepared.userOpHash;
  } catch (error) {
    abandon({ key, sender, now: now() });
    throw error;
  }

  // 署名済 op を **broadcast 前に** 永続 (応答ロスト時に同一 op を rebroadcast するため)。
  markSigned({
    key,
    sender,
    signedUserOp,
    userOpHash,
    permitDigest: keccak256(permitSignature),
    now: now(),
  });

  // broadcast_intent を永続 (fail-closed)。ここを過ぎたら fallback/新規 op 禁止。
  markSubmitting({ key, sender, now: now() });

  try {
    await broadcastCircleUserOp({ bundle, signedUserOp });
  } catch (error) {
    // 応答ロスト: op は受理・included しうる。auto-fallback 禁止 → recovery。
    logger.warn('circle.broadcast.response-lost', {
      userOpHash,
      error: error instanceof Error ? error.message : String(error),
    });
    const rec = loadPendingRecord(key);
    const recovered = rec
      ? await recoverSubmitting({ bundle, record: rec, sender, now })
      : null;
    if (recovered) return recovered;
    throw new CirclePendingError(userOpHash);
  }

  // broadcast 受理 → included を待つ。
  const receipt = await waitOrNull(bundle, userOpHash);
  if (receipt) {
    markConfirmed({
      key,
      sender,
      txHash: receipt.receipt.transactionHash,
      now: now(),
    });
    return toResult(userOpHash, receipt);
  }
  // 受理されたが timeout 内に未 included → recovery (rebroadcast + 再 wait)。
  const rec = loadPendingRecord(key);
  const recovered = rec
    ? await recoverSubmitting({ bundle, record: rec, sender, now })
    : null;
  if (recovered) return recovered;
  throw new CirclePendingError(userOpHash);
}

// confirmed record から結果を復元する (resume 時)。actualGasCost は recovery では
// 取れないので receipt 再照会で success/txHash/blockNumber を埋め、無ければ record 値。
async function resultFromConfirmed(
  bundle: CircleSmartAccountBundle,
  record: PendingRecord,
): Promise<CirclePaymentResult> {
  const hash = record.userOpHash as Hex;
  const receipt = await waitOrNull(bundle, hash);
  if (receipt) return toResult(hash, receipt);
  return {
    userOpHash: hash,
    txHash: (record.txHash ?? ('0x' as Hex)) as Hex,
    blockNumber: 0n,
    success: true,
    actualGasCost: 0n,
  };
}
