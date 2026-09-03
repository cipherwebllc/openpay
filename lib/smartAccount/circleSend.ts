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
  findLiveByCallHash,
  gcStalePreSubmit,
  loadPendingRecord,
  markAwaitingSignature,
  markConfirmed,
  markSigned,
  markSubmitting,
  pruneStaleSubmitting,
  pruneTerminal,
  reserveOrResume,
  type PendingRecord,
  type PendingStatus,
} from '@/lib/circlePending';
import { logger } from '@/lib/logger';
import type { PublicClient } from 'viem';

// pre-submit (reserved/awaiting_signature/signed) record をどれだけ「進行中」とみなすか。
// これを超えて更新されていない pre-submit は reload で見捨てられた orphan とみなし、
// cross-invocation ガードで block せず abandon して掃除する (恒久ブロック防止)。署名 popup を
// 2 つ跨いでも通常は数秒〜数十秒なので 3 分は十分長い安全側。
const PRE_SUBMIT_STALE_MS = 3 * 60 * 1000;

// 同一 callHash の confirmed record をどれだけ「偶発二重決済」とみなして抑止するか。
// この窓内の再決済 (reload/再クリック) は既支払い結果を返して新規 broadcast しない。窓を
// 過ぎた同額再決済は **正規のリピート購入** (例: 同じ店で同額を再度) とみなし通す
// (callHash は paymentAttemptId 非依存なので、窓が無いと正規リピートを恒久抑止してしまう)。
const CONFIRMED_DEDUP_WINDOW_MS = 90 * 1000;

// 終端 record (confirmed/failed/abandoned) を localStorage に保持する期間。これを過ぎたら
// pruneTerminal が物理削除する。CONFIRMED_DEDUP_WINDOW_MS (90s) を十分上回る必要がある
// (confirmed を消す前に偶発二重決済の dedup 窓を確実に過ぎさせる)。
const TERMINAL_RETENTION_MS = 24 * 60 * 60 * 1000;

// submitting のまま放置された孤児 record を物理削除するまでの期間。broadcast 直後に reload →
// 同一 callHash を二度と起動しないと、submitting record は gcStalePreSubmit (pre-submit のみ) にも
// pruneTerminal (terminal のみ) にも該当せず永久残留する (緩慢リーク)。7 日後の同一 callHash
// 再決済は CONFIRMED_DEDUP_WINDOW_MS (90s) を遥かに超え正規リピート扱いなので回収して安全。
const SUBMITTING_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

// gcStalePreSubmit が pre-submit 孤児を「確実に死んでいる」とみなす閾値。
// **PRE_SUBMIT_STALE_MS (3分) より遥かに長くする**こと。理由: GC は全 callHash 横断で
// 走るため、別タブの正規だが低速な署名 (wallet popup を数分開けっ放し等) を 3分閾値で
// 巻き込むと、その attempt の markSigned CAS が失敗し決済が壊れる (二重決済ではないが UX 破壊)。
// 同一 callHash の「並行中だから新規を block するか」判断は guard が PRE_SUBMIT_STALE_MS で行い、
// GC は純粋に容量管理 (どんな低速署名も到達しない長さ = 1時間) に限定して干渉を避ける。
const PRE_SUBMIT_GC_MS = 60 * 60 * 1000;

// cross-invocation ガードの処理優先度。confirmed/submitting を pre-submit より先に評価し、
// stale でない pre-submit が confirmed/submitting を CirclePendingError で masked するのを防ぐ。
function statusRank(s: PendingStatus): number {
  switch (s) {
    case 'confirmed':
      return 0;
    case 'submitting':
      return 1;
    case 'signed':
      return 2;
    case 'awaiting_signature':
      return 3;
    case 'reserved':
      return 4;
    default:
      return 9; // failed/abandoned は findLiveByCallHash で除外済 (安全側)
  }
}

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
  /** 確認待ち op の hash。pre-submit (まだ未署名/未 broadcast の別 attempt 検出) では undefined。 */
  readonly userOpHash?: Hex;
  constructor(userOpHash?: Hex) {
    super(
      'USDC ガスレス決済を処理中です (確認待ち、または別タブで進行中)。' +
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
        signedUserOp: record.signedUserOp,
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
      success: receipt.success,
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
  const key = computeIdempotencyKey({
    chainId,
    sender,
    paymentAttemptId: args.paymentAttemptId,
    callHash,
  });

  // --- housekeeping (best-effort・決済本体に影響させない) ------------------
  // 放置された pre-submit 孤児 (別 attempt) を abandon し、古い終端 record を物理削除する。
  // GC は PRE_SUBMIT_GC_MS (≫ PRE_SUBMIT_STALE_MS) を使い、別タブの正規だが低速な署名を
  // 巻き込まない (容量管理に限定)。自 attempt (key) は excludeKey で守る。失敗は無視。
  try {
    gcStalePreSubmit(PRE_SUBMIT_GC_MS, now(), key);
    pruneTerminal(TERMINAL_RETENTION_MS, now());
    pruneStaleSubmitting(SUBMITTING_RETENTION_MS, now());
  } catch {
    /* housekeeping 失敗は決済に影響しない */
  }

  // --- cross-invocation 二重決済ガード ------------------------------------
  // paymentAttemptId は呼出毎に変わりうるので、冪等キー一致 (reserveOrResume) だけでは
  // 別 attempt (別タブ/別デバイス/reload/再クリック) を捕捉できない。**callHash で同一決済の
  // 生きている別 record を全状態スキャン**し、自 attempt (excludeKey) 以外が在れば新規 op を
  // 作らない:
  //   confirmed (直近)  → 偶発二重 → 既支払い結果を返す。confirmed (古い) → 正規の再決済とみなし通す。
  //   submitting        → recover (receipt 照会 or 同一署名 op の冪等 rebroadcast)。
  //   pre-submit (直近)  → 別 attempt が署名中 → 並行 broadcast を作らず CirclePendingError。
  //   pre-submit (stale) → reload 放置の orphan → abandon して block しない。
  // status 優先 (confirmed > submitting > pre-submit) で処理し、stale でない pre-submit が
  // 先に来て confirmed/submitting を CirclePendingError で masked するのを防ぐ。
  // ⚠️ scan→reserve は単一同期 tick で自タブ内は実質 atomic だが、タブ/デバイス跨ぎの真の同時
  // race は localStorage の限界で完全には塞げない。**並行 (同一 nonce) race** は両 attempt が
  // 同一 sender の key-0 sequential nonce を取るため EntryPoint の nonce 一意性で吸収される
  // (先着 1 件のみ included、後発は AA25 invalid-nonce で revert = merchant 転送は 1 回)。
  // ⚠️ ただし「先行が confirmed 済 → 別デバイス (ローカル記録なし) で同じ QR を再決済」は新しい
  // nonce を取るため別決済として通る。これは server 権威の請求状態を持たない非カストディ設計の
  // 一般特性で、JPYC relay / Pimlico 7702 / standard の全ライブ経路と同じ (Circle 固有ではない)。
  // 正本は on-chain / 履歴で、店舗は着金確認で運用する (将来 server 請求 dedup を入れるなら全経路共通)。
  const live = findLiveByCallHash({ sender, chainId, callHash, excludeKey: key }).sort(
    (a, b) => statusRank(a.status) - statusRank(b.status),
  );
  for (const rec of live) {
    if (rec.status === 'confirmed') {
      // 直近 confirmed = reload/再クリックによる偶発二重 → 既支払い結果を返す (冪等)。
      // 窓を過ぎた古い confirmed = 正規の同額リピート決済 → 抑止せず新規決済を許可。
      // ⚠️ confirmed は「included された」だけで **成功とは限らない** (success:false =
      // revert)。revert 済 record で dedup すると、支払いが起きていないのに 90 秒間
      // 再試行が全部ブロックされる。**除外するのは success:false と断定できる record だけ**:
      // success を持たない旧 record / 想定外の値で dedup を外すと、支払い済みなのに
      // 二重決済へ通してしまう (取り違えたときの被害が非対称なので dedup 側に倒す)。
      if (
        rec.success !== false &&
        now() - rec.updatedAt <= CONFIRMED_DEDUP_WINDOW_MS
      ) {
        return await resultFromConfirmed(bundle, rec);
      }
      continue;
    }
    if (rec.status === 'submitting') {
      const recovered = await recoverSubmitting({ bundle, record: rec, sender, now });
      if (recovered) return recovered;
      throw new CirclePendingError(rec.userOpHash);
    }
    // reserved / awaiting_signature / signed (pre-submit・未 broadcast)。
    if (now() - rec.updatedAt > PRE_SUBMIT_STALE_MS) {
      // reload で見捨てられた orphan → abandon して掃除し、block しない。並行遷移で from
      // 不一致になっても無害 (二重決済ではなく一過性エラー) なので握り潰して continue。
      try {
        abandon({ key: rec.key, sender, now: now() });
      } catch {
        /* 並行 submitting 遷移等 → 次回スキャンで submitting として recover される */
      }
      continue;
    }
    // 直近の pre-submit = 別 attempt が署名中。並行 broadcast を作らない。
    throw new CirclePendingError(rec.userOpHash);
  }

  // --- reserve (idempotency gate・自 attempt のクラッシュ resume) ----------
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
      success: receipt.success,
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
// 取れないので receipt 再照会で success/txHash/blockNumber を埋め、無ければ **永続済の
// record.success** を使う (receipt 取得失敗時に success:true を捏造して revert 済 op を
// 成功誤報告しない)。record.success が未確定 (旧 record) なら false 側に倒す。
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
    success: record.success ?? false,
    actualGasCost: 0n,
  };
}
