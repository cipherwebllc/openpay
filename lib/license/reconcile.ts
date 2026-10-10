import 'server-only';

import { randomBytes } from 'node:crypto';
import { createPublicClient, isAddressEqual, parseAbi, parseEventLogs, type Hex } from 'viem';
import { chainObjectForId, transportForChain } from '@/lib/chains';
import { kvEval } from '@/lib/kv';
import { logger } from '@/lib/logger';
import { buildForwarderNonce } from '@/lib/relay/forwarderIntent';
import type {
  PurchaseIntent, IndeterminatePurchaseIntent, ReconcilePurchaseIntentResult, finalizeHostedPurchase,
} from '@/lib/x402/purchaseIntent';
import { rpcCallOptions } from '@/lib/x402/reconcileBudget';
import type { PageFetchOptions } from '@/lib/x402/reconcilePaging';
import { licenseEvalContext, licenseLuaVariant, type LicenseExpiryEvidence } from './stock';

const AUTH_ABI = parseAbi(['function authorizationState(address authorizer, bytes32 nonce) view returns (bool)']);
const USED = parseAbi(['event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)'])[0];
const SETTLED = parseAbi(['event Settled(address indexed from, bytes32 indexed nonce, address indexed merchant, uint256 merchantValue, address feeReceiver, uint256 feeValue)']);
type Claimed = Exclude<PurchaseIntent, { state: 'quoted' }>;
export type LicenseFinalizedBlock = { number: bigint; hash: Hex; timestamp: bigint; used: boolean };
// options.timeoutMs = deadline 付き (cron) の呼び出しだけ retry なし・この timeout (本文受信まで) で呼ぶ
// (第 7 回レビュー B4 follow-up)。全 method が受ける。省略時は既定の transport。
export type LicenseReconcileChain = {
  observe(intent: Claimed, options?: PageFetchOptions): Promise<LicenseFinalizedBlock>;
  receiptMatches(intent: Claimed, txHash: Hex, block: LicenseFinalizedBlock, options?: PageFetchOptions): Promise<boolean>;
  transactions(intent: Claimed, from: bigint, to: bigint, options?: PageFetchOptions): Promise<Hex[]>;
};
function client(intent: Claimed, options?: PageFetchOptions) {
  const chain = chainObjectForId(intent.chainId);
  if (!chain) throw new Error('unsupported license chain');
  // deadline = この呼び出しの絶対期限。observe の 3 RPC は 1 つの client で続けて呼ぶが、transport が RPC ごとに残り時間から signal を作るので合計が期限に収まる。
  const transport = options ? transportForChain(intent.chainId, { timeout: options.timeoutMs, retryCount: 0, deadline: options.deadlineAt }) : transportForChain(intent.chainId);
  return createPublicClient({ chain, transport });
}
export const defaultLicenseReconcileChain: LicenseReconcileChain = {
  observe: async (intent, options) => {
    const rpc = client(intent, options);
    const block = await rpc.getBlock({ blockTag: 'finalized' });
    const used = await rpc.readContract({ address: intent.token, abi: AUTH_ABI, functionName: 'authorizationState', args: [intent.claim.payer, intent.claim.nonce], blockNumber: block.number });
    const canonical = await rpc.getBlock({ blockNumber: block.number });
    if (canonical.hash !== block.hash) throw new Error('finality changed');
    return { number: block.number, hash: block.hash, timestamp: block.timestamp, used };
  },
  receiptMatches: async (intent, txHash, finalized, options) => {
    const rpc = client(intent, options);
    const receipt = await rpc.getTransactionReceipt({ hash: txHash });
    if (receipt.status !== 'success' || receipt.transactionHash !== txHash || receipt.blockNumber > finalized.number) return false;
    const canonical = await rpc.getBlock({ blockNumber: receipt.blockNumber });
    if (canonical.hash !== receipt.blockHash) return false;
    const used = parseEventLogs({ abi: [USED], logs: receipt.logs.filter((l) => isAddressEqual(l.address, intent.token)), strict: true });
    if (!used.some(({ args }) => isAddressEqual(args.authorizer, intent.claim.payer) && args.nonce === intent.claim.nonce)) return false;
    return parseEventLogs({ abi: SETTLED, logs: receipt.logs.filter((l) => isAddressEqual(l.address, intent.forwarder)), strict: true }).some(({ args }) =>
      isAddressEqual(args.from, intent.claim.payer) && args.nonce === intent.claim.nonce &&
      isAddressEqual(args.merchant, intent.merchant) && args.merchantValue === BigInt(intent.merchantValue) &&
      isAddressEqual(args.feeReceiver, intent.feeReceiver) && args.feeValue === BigInt(intent.feeValue));
  },
  transactions: async (intent, fromBlock, toBlock, options) => {
    const logs = await client(intent, options).getLogs({ address: intent.token, event: USED, args: { authorizer: intent.claim.payer, nonce: intent.claim.nonce }, fromBlock, toBlock });
    return logs.map((l) => l.transactionHash).filter((h): h is Hex => h !== null);
  },
};

const CAS =
  'local current=redis.call("GET",KEYS[1]); if current~=ARGV[2] then return -1 end; ' +
  'redis.call("SET",KEYS[1],ARGV[4]); ' +
  'if ARGV[5]==ARGV[6] then redis.call("ZREM",KEYS[2],ARGV[7]); else redis.call("ZADD",KEYS[2],ARGV[8],ARGV[7]); end; return 1; ';

async function cas(current: PurchaseIntent, raw: string, next: PurchaseIntent, now: number, evidence?: LicenseExpiryEvidence): Promise<boolean> {
  const r = await kvEval<number>(licenseLuaVariant(CAS), ['store:intent:' + current.intentSalt, 'store:intent:pending'], [
    '0', raw, '-1', JSON.stringify(next), evidence ? 'remove' : 'keep', 'remove', current.intentSalt,
    String(next.nextReconcileAt ?? now), '1', 'none', 'zset', 'table', '-2', licenseEvalContext(current, 'cas', now, evidence),
  ]);
  return r.ok && r.value === 1;
}

/**
 * license 専用。lease の満了・ローカル時計・試行回数だけでは在庫を戻さない。
 * failed_prebroadcast も署名は生きているため、canonical payment の採用か finalized unused まで保持。
 */
// deadline = 経過時間の予算 (epoch ms・第 7 回レビュー B4)。到達後はページを取りに行かず途中 cursor を保存する。
export async function reconcileLicensePurchase(current: PurchaseIntent, raw: string, now: number, finalizePurchase: typeof finalizeHostedPurchase, chain = defaultLicenseReconcileChain, deadline?: number): Promise<ReconcilePurchaseIntentResult> {
  if (current.state === 'settled') {
    const healed = await finalizePurchase({ intentSalt: current.intentSalt, txHash: current.txHash, settledAt: current.settledAt });
    return healed.ok ? { ok: true, state: 'settled', txHash: current.txHash } : { ok: false, reason: 'storage' };
  }
  if (current.state === 'quoted') return { ok: true, state: 'pending' };
  if (current.state === 'failed_prebroadcast' && current.failureReason === 'authorization_expired_unused') return { ok: true, state: 'failed_prebroadcast' };
  if ((current.reconcileLeaseUntil ?? 0) > now || (current.state === 'settling' && current.leaseUntil > now)) return { ok: true, state: 'pending' };
  const leased: Claimed = { ...current, reconcileLeaseId: randomBytes(32).toString('hex'), reconcileLeaseUntil: now + 120_000, nextReconcileAt: now + 120_000 };
  if (!await cas(current, raw, leased, now)) return { ok: true, state: 'pending' };
  const leasedRaw = JSON.stringify(leased);
  let fromBlock = BigInt(leased.reconcileFromBlock ?? leased.anchorBlock);
  const reschedule = async (): Promise<ReconcilePurchaseIntentResult> => {
    const next = { ...leased, nextReconcileAt: now + 30_000, lastCheckedAt: now, reconcileFromBlock: fromBlock.toString() };
    delete next.reconcileLeaseId; delete next.reconcileLeaseUntil;
    return await cas(leased, leasedRaw, next, now) ? { ok: true, state: 'pending' } : { ok: false, reason: 'storage' };
  };
  try {
    const nonce = buildForwarderNonce({ from: leased.claim.payer, merchant: leased.merchant, merchantValue: BigInt(leased.merchantValue), feeReceiver: leased.feeReceiver, feeValue: BigInt(leased.feeValue), validAfter: BigInt(leased.claim.validAfter), validBefore: BigInt(leased.claim.validBefore), intentSalt: leased.intentSalt }, leased.chainId, leased.forwarder);
    if (nonce !== leased.claim.nonce) return reschedule();
    // deadline 付きでは全 RPC の直前に残り時間を見る (null = 始めずに次回へ・{ timeoutMs } = retry なし 1 回)。
    const observeRpc = rpcCallOptions(deadline);
    if (observeRpc === null) return reschedule();
    const block = observeRpc ? await chain.observe(leased, observeRpc) : await chain.observe(leased);
    if (!block.used) {
      if (block.timestamp <= BigInt(leased.claim.validBefore)) return reschedule();
      const failed: PurchaseIntent = {
        ...leased, state: 'failed_prebroadcast', attemptId: 'attemptId' in leased ? leased.attemptId : randomBytes(32).toString('hex'),
        attempt: 'attempt' in leased ? leased.attempt : 1, settlementStartedAt: now, leaseUntil: now,
        failedAt: now, failureReason: 'authorization_expired_unused',
      };
      // 失敗した旧 hash を failed record へ持ち越して parser を壊さない。証拠は reservation に保存する。
      delete (failed as unknown as { txHash?: Hex }).txHash;
      delete failed.reconcileLeaseId; delete failed.reconcileLeaseUntil;
      const evidence: LicenseExpiryEvidence = { blockNumber: block.number.toString(), blockHash: block.hash, timestamp: block.timestamp.toString(), authorizationUsed: false };
      return await cas(leased, leasedRaw, failed, now, evidence) ? { ok: true, state: 'failed_prebroadcast' } : { ok: false, reason: 'storage' };
    }
    const finalize = async (hash: Hex, candidatePageStart?: bigint): Promise<ReconcilePurchaseIntentResult | null> => {
      // 候補 1 件の照合の前に残り時間を見る。足りなければ照合せず候補のページ (保存済み hash なら現 cursor) から延期。
      const receiptRpc = rpcCallOptions(deadline);
      if (receiptRpc === null) { if (candidatePageStart !== undefined) fromBlock = candidatePageStart; return reschedule(); }
      try {
        if (!(receiptRpc ? await chain.receiptMatches(leased, hash, block, receiptRpc) : await chain.receiptMatches(leased, hash, block))) return null;
      } catch {
        // 走査で新しく見つけた候補の receipt 一時障害で証拠のページを飛ばさない (第 7 回レビュー B3):
        // その候補のページを cursor に保存して次回再試行し、在庫 hold と entitlement 未付与の長期化を断つ。
        if (candidatePageStart !== undefined) { fromBlock = candidatePageStart; return reschedule(); }
        // 欠落した旧 receipt の障害を replacement receipt の探索へ波及させない。
        return null;
      }
      const adopted: IndeterminatePurchaseIntent = {
        ...leased, state: 'indeterminate', txHash: hash, indeterminateAt: now,
        attemptId: 'attemptId' in leased ? leased.attemptId : randomBytes(32).toString('hex'),
        attempt: 'attempt' in leased ? leased.attempt : 1, settlementStartedAt: now, leaseUntil: now,
      };
      if (!await cas(leased, leasedRaw, adopted, now)) return { ok: true, state: 'pending' };
      const result = await finalizePurchase({ intentSalt: leased.intentSalt, txHash: hash, settledAt: now });
      return result.ok ? { ok: true, state: 'settled', txHash: hash } : { ok: false, reason: 'storage' };
    };
    if ('txHash' in leased && leased.txHash) {
      const result = await finalize(leased.txHash); if (result) return result;
    }
    for (let page = 0; page < 20 && fromBlock <= block.number; page++) {
      // 時間予算は取得前に「残り時間 − cursor 保存の予約」で見て、1 回の RPC に足りなければ未取得ページの先頭を
      // cursor に残す (打ち切りは失敗でも未払いでもない)。取るときは残り時間で切った timeout で RPC を呼ぶ。
      const pageRpc = rpcCallOptions(deadline);
      if (pageRpc === null) return reschedule();
      const to = fromBlock + 1999n < block.number ? fromBlock + 1999n : block.number;
      const pageStart = fromBlock;
      const hashes = pageRpc ? await chain.transactions(leased, pageStart, to, pageRpc) : await chain.transactions(leased, pageStart, to);
      for (const hash of hashes) {
        const result = await finalize(hash, pageStart); if (result) return result;
      }
      fromBlock = to + 1n;
    }
    if (fromBlock > block.number) fromBlock = BigInt(leased.anchorBlock);
    return reschedule();
  } catch (error) {
    // RPC 不明を「未払い」と解釈して在庫再販へ波及させない。hold と回復 index は無期限に残す。
    logger.warn('license.reconcile_indeterminate', { intentSalt: leased.intentSalt, error });
    return reschedule();
  }
}
