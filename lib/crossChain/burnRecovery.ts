// CCTP burn の再開安全化 (A1): 前回 burn したかを on-chain の事実 (receipt / nonce /
// DepositForBurn log) で判定し、未確定なら money-path を止める。self-mint CCTP と Arc
// forwarding の両 executor が使う (R12 で execute.ts から移動・本文は分割前と同一)。

import type { Address, Hex, PublicClient } from 'viem';
import { logger } from '../logger';
import { CCTP_V2_TOKEN_MESSENGER_ADDRESS } from './cctp';
import {
  classifyBurnState,
  minGapBlocks,
  scanForBurnLog,
  MIN_GAP_MS,
  type BurnDecision,
  type BurnIntentMarker,
  type BurnReceiptState,
  type BurnScanResult,
  type BurnSlot,
} from './burnMarker';
import { CrossChainBurnUnresolvedError } from './executeErrors';
import { waitForReceiptOrThrow } from './executeShared';
import type { ProgressCallback } from './executeTypes';

// hash の receipt 状態を 3 値で読む。TransactionReceiptNotFoundError のみ 'notfound'、
// それ以外の reject (RPC ダウン / timeout) は transport 障害で「未着」と区別できないため
// throw で伝播する (決定表 row 21・txAlreadySucceeded と同じ CR-2 の区別)。
async function readBurnReceiptState(
  client: PublicClient,
  hash: Hex,
): Promise<BurnReceiptState> {
  try {
    const receipt = await client.getTransactionReceipt({ hash });
    return receipt.status === 'success' ? 'success' : 'reverted';
  } catch (e) {
    if ((e as { name?: unknown })?.name === 'TransactionReceiptNotFoundError') {
      return 'notfound';
    }
    throw e;
  }
}

interface ResolveBurnSlotArgs {
  client: PublicClient;
  slot: BurnSlot;
  marker: BurnIntentMarker | undefined;
  hash: Hex | undefined;
  depositor: Address;
  sourceChainId: number;
  autoReburnEnabled: boolean;
  allowManualReburn: boolean;
  onProgress: ProgressCallback;
  now: () => number;
}

/** 決定表の入力 (nonce / gap / log) を on-chain から集めて classifyBurnState に渡す。
 *  RPC 障害は握り潰さず throw する (「観測できなかった」を「起きていない」に潰すと二重
 *  burn になる)。 */
async function resolveBurnSlot(args: ResolveBurnSlotArgs): Promise<BurnDecision> {
  // 初回 (marker も hash も無い) は probe 不要 — 余計な RPC を打たずに従来どおり burn。
  if (!args.marker && !args.hash) {
    return classifyBurnState({
      marker: undefined,
      hash: undefined,
      receipt: undefined,
      pendingAhead: undefined,
      nonceAdvanced: false,
      gapSatisfied: false,
      timeGapSatisfied: false,
      scan: undefined,
      autoReburnEnabled: args.autoReburnEnabled,
      allowManualReburn: args.allowManualReburn,
    });
  }

  args.onProgress({ kind: 'burn_probe' });

  // D7 (受容したコスト): marker 導入前の旧 state (決定表 row 2) も、ここで source chain の
  // receipt を 1 本読む。以前は「hash があれば無条件に mint へ進む」だったので source RPC に
  // 一切依存しなかったが、revert / 置換された burn を掴んだまま Iris を永久 poll する恒久
  // wedge (A1-(ii)) を塞ぐには receipt の確認が要る。source RPC が落ちていると旧 state の
  // 再開も止まる (throw) — 「観測できなかった」を「成功していた」に潰さないための意図的な
  // 可用性コストとして受け入れる。
  const receipt = args.hash
    ? await readBurnReceiptState(args.client, args.hash)
    : undefined;
  // 成功済 hash は proceed 一択なので nonce も log も見ない (無駄な RPC を打たない)。
  if (receipt === 'success') {
    return classifyBurnState({
      marker: args.marker,
      hash: args.hash,
      receipt,
      pendingAhead: undefined,
      nonceAdvanced: false,
      gapSatisfied: false,
      timeGapSatisfied: false,
      scan: undefined,
      autoReburnEnabled: args.autoReburnEnabled,
      allowManualReburn: args.allowManualReburn,
    });
  }

  // 旧 state (marker 無し・row 3): 走査範囲が無いので log は見られないが、mempool だけは
  // 実測する。二段確認による再 burn を許すかどうかがこの実測 1 点に懸かっているため
  // (未計測のまま override すると mempool 滞留中の再 burn = 二重支払い・D1)。
  if (!args.marker) {
    const [noncePending, nonceLatest] = await Promise.all([
      args.client.getTransactionCount({
        address: args.depositor,
        blockTag: 'pending',
      }),
      args.client.getTransactionCount({
        address: args.depositor,
        blockTag: 'latest',
      }),
    ]);
    return classifyBurnState({
      marker: undefined,
      hash: args.hash,
      receipt,
      pendingAhead: noncePending > nonceLatest,
      nonceAdvanced: false,
      gapSatisfied: false,
      timeGapSatisfied: false, // marker が無い = 基準時刻が無い
      scan: undefined,
      autoReburnEnabled: args.autoReburnEnabled,
      allowManualReburn: args.allowManualReburn,
    });
  }

  const marker = args.marker;
  const [noncePending, nonceLatest, head] = await Promise.all([
    args.client.getTransactionCount({ address: args.depositor, blockTag: 'pending' }),
    args.client.getTransactionCount({ address: args.depositor, blockTag: 'latest' }),
    args.client.getBlockNumber(),
  ]);
  const pendingAhead = noncePending > nonceLatest;
  const nonceAdvanced =
    marker.nonceLatest !== null && nonceLatest > marker.nonceLatest;
  const markerBlock = marker.block === null ? null : BigInt(marker.block);
  const timeGapSatisfied = args.now() - marker.at >= MIN_GAP_MS;
  const gapSatisfied =
    markerBlock !== null &&
    head - markerBlock >= BigInt(minGapBlocks(marker.chainId)) &&
    timeGapSatisfied;

  // mempool に居るうちは log を走査しても意味がない (まだ mined していない) ので RPC を節約。
  // 走査範囲 (block) / 同定条件 (nonce) を欠く marker (row 4) も走査しない — scan を
  // undefined のままにすることで「走査できなかった」と「走査して 0 件だった」を
  // classifyBurnState 側で区別できる (二段確認を開けてよいかの判断が変わる・D1)。
  let scan: BurnScanResult | undefined;
  if (!pendingAhead && markerBlock !== null && marker.nonceLatest !== null) {
    scan = await scanForBurnLog({
      client: args.client,
      marker,
      head,
      tokenMessenger: CCTP_V2_TOKEN_MESSENGER_ADDRESS,
    });
  }

  return classifyBurnState({
    marker,
    hash: args.hash,
    receipt,
    pendingAhead,
    nonceAdvanced,
    gapSatisfied,
    timeGapSatisfied,
    scan,
    autoReburnEnabled: args.autoReburnEnabled,
    allowManualReburn: args.allowManualReburn,
  });
}

// 決定が wait / manual なら money-path を進めず専用 error で止める。
function assertBurnResolved(
  decision: BurnDecision,
  ctx: { slot: BurnSlot; sourceChainId: number; depositor: Address; hash?: Hex },
  onProgress: ProgressCallback,
): void {
  if (decision.action !== 'wait' && decision.action !== 'manual') return;
  onProgress({ kind: 'burn_unconfirmed' });
  logger.warn('cross-chain.burn.unresolved', {
    kind: decision.action,
    slot: ctx.slot,
    row: decision.row,
    reason: decision.reason,
    sourceChainId: ctx.sourceChainId,
  });
  throw new CrossChainBurnUnresolvedError({
    kind: decision.action,
    slot: ctx.slot,
    detail: decision.reason,
    row: decision.row,
    reburnable: decision.action === 'manual' ? decision.reburnable : false,
    sourceChainId: ctx.sourceChainId,
    depositor: ctx.depositor,
    burnTxHash: ctx.hash,
  });
}

/** source chain の burn 1 本を「再開安全」に送り出す (settleMint と対称)。
 *  marker を fail-closed で書いてから broadcast → hash 永続化 → receipt 検証、の順で、
 *  「記録の無い burn」も「burn の無い記録」も作らない。
 *  adopt (走査で一意特定した hash の採用) / proceed (既存 hash が成功済) は送金を伴わない
 *  ので呼出側で persist するだけ — ここには 'burn' decision しか来ない。 */
async function settleBurn(args: {
  client: PublicClient;
  buildMarker: () => Promise<BurnIntentMarker>;
  commit: (marker: BurnIntentMarker) => void;
  broadcast: () => Promise<Hex>;
  onBroadcast: (hash: Hex) => void;
  label: string;
}): Promise<void> {
  const marker = await args.buildMarker();
  // 書けなければ throw され、broadcast には到達しない (= 記録の無い burn を作らない)。
  args.commit(marker);
  const hash = await args.broadcast();
  args.onBroadcast(hash);
  await waitForReceiptOrThrow(args.client, hash, args.label);
}

// 分割先 executor 間でだけ共有する (facade からは再 export しない = 公開 API は分割前と同じ)。
export { assertBurnResolved, resolveBurnSlot, settleBurn };
