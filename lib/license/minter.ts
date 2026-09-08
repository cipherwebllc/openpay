import 'server-only';

import { randomUUID } from 'node:crypto';
import {
  createWalletClient, encodeFunctionData, isAddressEqual, keccak256, parseAbi, parseEventLogs,
  parseTransaction, recoverTransactionAddress, zeroAddress, type Hex, type TransactionReceipt, type TransactionSerialized,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { kvGet, kvSetNxGet } from '@/lib/kv';
import { logger } from '@/lib/logger';
import { buildForwarderNonce } from '@/lib/relay/forwarderIntent';
import { getPurchaseIntent } from '@/lib/x402/purchaseIntent';
import { sendReverifyAlert } from '@/lib/x402/reverify';
import { licenseNftEnabled } from './config';
import { licenseMinterPrivateKey } from './minterKey';
import { computeLicensePaymentKey } from './paymentKey';
import { confirmLicenseRegistration } from './registration';
import { repairLicenseIndexes } from './repair';
import { licenseRpc, licenseTransport } from './rpc';
import type { LicenseJob, LicenseMintJob } from './jobs';
import { LICENSE_ACTIVE_SUBMISSION, LICENSE_WORKER_LOCK, licenseDueMembers, quarantineLicenseJob, readLicenseJob, saveLicenseJob } from './workerStore';

export const LICENSE_ABI = parseAbi([
  'function registerLicense(uint256 id,uint64 maxSupply,bool transferable,string uri,bytes32 definitionHash)',
  'function mintFor(address to,uint256 id,bytes32 paymentKey)',
  'function licenseOf(uint256 id) view returns ((uint64 maxSupply,uint64 minted,bool transferable,bool exists,bytes32 definitionHash))',
  'function paymentKeyOf(bytes32 key) view returns ((uint256 id,address to))',
  'event LicenseRegistered(uint256 indexed id,uint64 maxSupply,bool transferable,bytes32 definitionHash)',
  'event LicenseMinted(uint256 indexed id,address indexed to,bytes32 indexed paymentKey)',
  'error ERC1155InvalidReceiver(address receiver)',
]);
const PAYMENT_ABI = parseAbi([
  'function authorizationState(address authorizer,bytes32 nonce) view returns (bool)',
  'event AuthorizationUsed(address indexed authorizer,bytes32 indexed nonce)',
  'event Settled(address indexed from,bytes32 indexed nonce,address indexed merchant,uint256 merchantValue,address feeReceiver,uint256 feeValue)',
]);
const MAX_GAS = 600_000n;
const MAX_TX_COST = 10n ** 17n; // 0.1 POL。見積り超過を切り詰めて送信せず、運営修復へ回す。
const MIN_RESERVE = 10n ** 17n;
export const licenseBackoff = (attempts: number) => Math.min(3_600_000, 300_000 * 2 ** Math.min(10, Math.max(0, attempts - 1)));
class Deadline extends Error {}
class Repair extends Error {}
class LostLease extends Error {}

function callData(job: LicenseJob): Hex {
  const d = job.license;
  return job.kind === 'mint'
    ? encodeFunctionData({ abi: LICENSE_ABI, functionName: 'mintFor', args: [job.payer, BigInt(d.tokenId), job.paymentKey] })
    : encodeFunctionData({ abi: LICENSE_ABI, functionName: 'registerLicense', args: [BigInt(d.tokenId), BigInt(d.supply), d.transferable, d.termsUrl, d.definitionHash] });
}

/** EOA を relay と分離する。誤設定による同一 nonce 空間への送信を拒否する。 */
function minterAccount() {
  const key = licenseMinterPrivateKey();
  if (!key) throw new Error('minter_key_unavailable');
  const relay = process.env.RELAYER_PRIVATE_KEY;
  if (relay && relay.toLowerCase() === key.toLowerCase()) throw new Repair('minter_must_differ_from_relayer');
  return privateKeyToAccount(key);
}

async function processJob(member: string, token: string, deadline: number): Promise<void> {
  const check = () => { if (Date.now() >= deadline) throw new Deadline(); };
  const step = async <T>(action: () => Promise<T>): Promise<T> => { check(); return action(); };
  const read = await step(() => readLicenseJob(member));
  // 破損 due が先頭を占め続ける波及を断つ。原本/恒久 index は残して運営修復を待つ。
  if (read === 'corrupt') await step(() => quarantineLicenseJob(member, token));
  if (typeof read === 'string') throw new Error('job_' + read);
  let { job, raw } = read;
  if (job.nextAttemptAt > Date.now() || (job.lease && job.lease.until > Date.now()) ||
    (['minted', 'registered', 'needs_repair'].includes(job.status) && !job.alertPending)) return;
  const save = async (next: LicenseJob, lane: 'take' | 'keep' | 'release' = 'keep') => {
    check();
    if (!await saveLicenseJob(member, raw, next, token, lane)) throw new LostLease();
    job = next; raw = JSON.stringify(next);
  };
  await save({ ...job, lease: { token, until: Date.now() + 55_000 } });
  const reschedule = async (reason: string, repair = false) => {
    const attempts = job.attempts + 1;
    // 不明な送信は attempt 10 でも submitted のまま hash を追う。新しい nonce で再 mint しない。
    const status = job.submission && !repair ? 'submitted' : repair || attempts >= 10 ? 'needs_repair' : 'retryable';
    await save({ ...job, status, attempts, lastError: reason, nextAttemptAt: Date.now() + licenseBackoff(attempts),
      ...(attempts >= 10 || repair ? { alertPending: job.alertedAt === undefined } : {}) });
  };
  const alert = async () => {
    if (!job.alertPending) return;
    const url = process.env.ALERT_WEBHOOK_URL;
    // 通知の停止は記録済み義務と隣のジョブへ波及させない。失敗は次回の due に残す。
    if (!url || !await step(() => sendReverifyAlert(url, 'OpenPay license needs repair: ' + member + ' (' + job.lastError + ')'))) return;
    await save({ ...job, alertPending: false, alertedAt: Date.now() });
  };
  try {
    if (job.status === 'needs_repair') { await alert(); return; }
    const rpc = licenseRpc(job.license.tokenChainId, deadline);
    const head = await step(() => rpc.getBlock({ blockTag: 'finalized' }));
    const canonicalReceipt = async (hash: Hex): Promise<TransactionReceipt | null> => {
      const receipt = await step(() => rpc.getTransactionReceipt({ hash }));
      if (receipt.blockNumber > head.number) return null;
      const block = await step(() => rpc.getBlock({ blockNumber: receipt.blockNumber }));
      if (receipt.transactionHash !== hash || block.hash !== receipt.blockHash) throw new Repair('receipt_reorg_or_mismatch');
      return receipt;
    };
    const stableHead = async () => {
      if ((await step(() => rpc.getBlock({ blockNumber: head.number }))).hash !== head.hash) throw new Repair('finality_changed');
    };

    if (job.kind === 'mint') {
      const mint = job;
      const intent = await step(() => getPurchaseIntent(mint.intentSalt));
      // 壊れた outbox/intent の組合せを、別決済の mint 証拠として利用しない。
      if (!intent || typeof intent === 'string' || intent.state !== 'settled' || intent.txHash !== mint.txHash ||
        intent.resourceId !== mint.productId || intent.metadata.license?.definitionHash !== mint.license.definitionHash ||
        !isAddressEqual(intent.claim.payer, mint.payer) || Object.keys(intent.claim).length !== Object.keys(mint.payment).length ||
        Object.entries(intent.claim).some(([key, value]) => mint.payment[key as keyof typeof mint.payment] !== value) ||
        computeLicensePaymentKey({ paymentChainId: BigInt(intent.chainId), paymentToken: intent.token, payer: intent.claim.payer, authorizationNonce: intent.claim.nonce }) !== mint.paymentKey) throw new Repair('payment_identity_mismatch');
      const c = intent.claim;
      if (buildForwarderNonce({ from: c.payer, merchant: c.merchant, merchantValue: BigInt(c.merchantValue), feeReceiver: c.feeReceiver, feeValue: BigInt(c.feeValue), validAfter: BigInt(c.validAfter), validBefore: BigInt(c.validBefore), intentSalt: mint.intentSalt }, c.chainId, c.forwarder) !== c.nonce) throw new Repair('payment_nonce_mismatch');
      const receipt = await canonicalReceipt(mint.txHash);
      if (!receipt) {
        await save({ ...job, status: job.submission ? 'submitted' : 'awaiting_finality', nextAttemptAt: Date.now() + 300_000 }); return;
      }
      const used = parseEventLogs({ abi: PAYMENT_ABI, eventName: 'AuthorizationUsed', logs: receipt.logs.filter((l) => isAddressEqual(l.address, c.token)), strict: true });
      const settled = parseEventLogs({ abi: PAYMENT_ABI, eventName: 'Settled', logs: receipt.logs.filter((l) => isAddressEqual(l.address, c.forwarder)), strict: true });
      if (receipt.status !== 'success' || !used.some(({ args }) => isAddressEqual(args.authorizer, c.payer) && args.nonce === c.nonce) ||
        !settled.some(({ args }) => isAddressEqual(args.from, c.payer) && args.nonce === c.nonce && isAddressEqual(args.merchant, c.merchant) && args.merchantValue === BigInt(c.merchantValue) && isAddressEqual(args.feeReceiver, c.feeReceiver) && args.feeValue === BigInt(c.feeValue)) ||
        !await step(() => rpc.readContract({ address: c.token, abi: PAYMENT_ABI, functionName: 'authorizationState', args: [c.payer, c.nonce], blockNumber: head.number }))) throw new Repair('payment_tuple_mismatch');
      if (mint.paymentBlock && (mint.paymentBlock.blockHash !== receipt.blockHash || mint.paymentBlock.blockNumber !== receipt.blockNumber.toString())) throw new Repair('payment_reorg');
      await stableHead();
      await save({ ...mint, status: mint.submission ? 'submitted' : 'pending', paymentBlock: { blockNumber: receipt.blockNumber.toString(), blockHash: receipt.blockHash } });
    }

    const d = job.license;
    const registered = await step(() => rpc.readContract({ address: d.contract, abi: LICENSE_ABI, functionName: 'licenseOf', args: [BigInt(d.tokenId)], blockNumber: head.number }));
    if (registered.exists && (registered.definitionHash !== d.definitionHash || registered.maxSupply !== BigInt(d.supply) || registered.transferable !== d.transferable)) throw new Repair('definition_mismatch');
    if (job.kind === 'mint' && !registered.exists) throw new Error('registration_pending');

    const complete = async (hash: Hex) => {
      const receipt = await canonicalReceipt(hash);
      if (!receipt) { await reschedule('receipt_not_finalized'); return; }
      if (receipt.status !== 'success') throw new Repair('transaction_reverted');
      if (job.kind === 'register') {
        const confirmed = await step(() => confirmLicenseRegistration(job.productId, hash, rpc));
        if (confirmed === 'conflict') throw new Repair('registration_receipt_mismatch');
        if (confirmed !== 'registered') { await reschedule('registration_' + confirmed); return; }
        await save({ ...job, status: 'registered', alertPending: false, mintTxHash: hash, mintBlock: { blockNumber: receipt.blockNumber.toString(), blockHash: receipt.blockHash } }, 'release');
      } else {
        const mint = job;
        const matches = parseEventLogs({ abi: LICENSE_ABI, eventName: 'LicenseMinted', logs: receipt.logs.filter((l) => isAddressEqual(l.address, d.contract)), strict: true })
          .some(({ args }) => args.id === BigInt(d.tokenId) && isAddressEqual(args.to, mint.payer) && args.paymentKey === mint.paymentKey);
        const record = await step(() => rpc.readContract({ address: d.contract, abi: LICENSE_ABI, functionName: 'paymentKeyOf', args: [mint.paymentKey], blockNumber: head.number }));
        if (!matches || record.id !== BigInt(d.tokenId) || !isAddressEqual(record.to, mint.payer)) throw new Repair('mint_receipt_mismatch');
        await stableHead();
        await save({ ...mint, status: 'minted', alertPending: false, mintTxHash: hash, mintBlock: { blockNumber: receipt.blockNumber.toString(), blockHash: receipt.blockHash } }, 'release');
      }
    };

    // 消費済み key は job の保存時点にかかわらず再 mint しない。replacement の event も探索する。
    let consumed = false;
    if (job.kind === 'mint') {
      const mint = job;
      const record = await step(() => rpc.readContract({ address: d.contract, abi: LICENSE_ABI, functionName: 'paymentKeyOf', args: [mint.paymentKey], blockNumber: head.number }));
      consumed = !isAddressEqual(record.to, zeroAddress);
      if (consumed && (record.id !== BigInt(d.tokenId) || !isAddressEqual(record.to, mint.payer))) throw new Repair('consumed_key_mismatch');
    }
    if (job.submission) {
      const s = job.submission;
      const tx = parseTransaction(s.serializedTransaction);
      if (tx.chainId !== d.tokenChainId || tx.nonce !== s.nonce || !tx.to || !isAddressEqual(tx.to, d.contract) || tx.data !== callData(job) || (tx.value ?? 0n) !== 0n ||
        !isAddressEqual(await step(() => recoverTransactionAddress({ serializedTransaction: s.serializedTransaction as TransactionSerialized })), s.signer)) throw new Repair('signed_transaction_mismatch');
      let receipt: TransactionReceipt | null = null;
      try { receipt = await step(() => rpc.getTransactionReceipt({ hash: s.hash })); } catch (error) {
        // RPC 障害/未採掘 hash が、新 nonce の発行へ波及しない。下で同じ署名だけ再送する。
        if (error instanceof Deadline) throw error;
      }
      if (receipt) { await complete(s.hash); return; }
    }
    if (consumed || (job.kind === 'register' && registered.exists)) {
      const fromBlock = BigInt(job.scanFromBlock ?? job.submission?.fromBlock ?? '0');
      const toBlock = fromBlock + 1999n < head.number ? fromBlock + 1999n : head.number;
      if (fromBlock > head.number) { await reschedule('event_not_found', true); return; }
      const logs = job.kind === 'mint'
        ? await step(() => rpc.getLogs({ address: d.contract, event: LICENSE_ABI[5], args: { paymentKey: (job as LicenseMintJob).paymentKey }, fromBlock, toBlock }))
        : await step(() => rpc.getLogs({ address: d.contract, event: LICENSE_ABI[4], args: { id: BigInt(d.tokenId) }, fromBlock, toBlock }));
      const hash = logs.find((l) => l.transactionHash)?.transactionHash;
      if (hash) { await complete(hash); return; }
      await save({ ...job, scanFromBlock: (toBlock + 1n).toString(), nextAttemptAt: Date.now() + 300_000 }); return;
    }
    if (job.submission) {
      const s = job.submission;
      const finalizedNonce = await step(() => rpc.getTransactionCount({ address: s.signer, blockNumber: head.number }));
      if (finalizedNonce > s.nonce) throw new Repair('nonce_replaced_without_license');
      await save({ ...job, status: 'submitted' }, 'take');
      await step(() => rpc.sendRawTransaction({ serializedTransaction: s.serializedTransaction }));
      await reschedule('submission_unconfirmed'); return;
    }
    const active = await step(() => kvGet(LICENSE_ACTIVE_SUBMISSION));
    if (!active.ok) throw new LostLease();
    // 未解決の署名は pending nonce に現れない場合がある。別ジョブへの nonce 再利用を隔離する。
    if (active.value !== null && active.value !== member) return;
    const account = minterAccount();
    const wallet = createWalletClient({ account, chain: rpc.chain, transport: licenseTransport(d.tokenChainId, deadline) });
    const data = callData(job);
    if (job.kind === 'mint') {
      const mint = job;
      await step(() => rpc.simulateContract({ account, address: d.contract, abi: LICENSE_ABI, functionName: 'mintFor', args: [mint.payer, BigInt(d.tokenId), mint.paymentKey] }));
    } else {
      await step(() => rpc.simulateContract({ account, address: d.contract, abi: LICENSE_ABI, functionName: 'registerLicense', args: [BigInt(d.tokenId), BigInt(d.supply), d.transferable, d.termsUrl, d.definitionHash] }));
    }
    const nonce = await step(() => rpc.getTransactionCount({ address: account.address, blockTag: 'pending' }));
    const prepared = await step(() => wallet.prepareTransactionRequest({ account, chain: rpc.chain, to: d.contract, data, value: 0n, nonce }));
    const gas = prepared.gas;
    const fee = prepared.maxFeePerGas ?? prepared.gasPrice;
    if (gas === undefined || fee === undefined || gas > MAX_GAS || gas * fee > MAX_TX_COST) throw new Error('gas_budget_exceeded');
    if (await step(() => rpc.getBalance({ address: account.address })) < gas * fee + MIN_RESERVE) throw new Error('minter_funding_low');
    const serializedTransaction = await step(() => wallet.signTransaction(prepared));
    const hash = keccak256(serializedTransaction);
    // broadcast より先に nonce/署名/hash と恒久送信枠を同一 CAS で記録。応答消失でも再利用しない。
    await save({ ...job, status: 'submitted', submission: { serializedTransaction, hash, nonce, signer: account.address, fromBlock: head.number.toString() }, nextAttemptAt: Date.now() + 300_000 }, 'take');
    await step(() => rpc.sendRawTransaction({ serializedTransaction }));
  } catch (error) {
    // 期限切れ/lease 喪失で stale worker が追記や送信を続ける波及を断つ。
    if (error instanceof Deadline || error instanceof LostLease || Date.now() >= deadline) return;
    // RPC の本文/鍵/署名を永続エラーや通知へ漏らさず、失敗したジョブだけ再試行する。
    await reschedule(error instanceof Repair ? error.message : 'rpc_or_funding_failure', error instanceof Repair);
  }
  await alert();
}

export type LicenseWorkerResult = { ok: true; skipped?: 'disabled' | 'locked'; processed: number; failed: number } | { ok: false; error: 'storage_unavailable' };

/** cron と after() が同じロックを使う。receipt 待ちはせず、due を次 run へ引き継ぐ。 */
export async function runLicenseWorker(options: { member?: string; deadline?: number } = {}): Promise<LicenseWorkerResult> {
  if (!licenseNftEnabled()) return { ok: true, skipped: 'disabled', processed: 0, failed: 0 };
  const started = Date.now();
  const deadline = Math.min(options.deadline ?? started + 40_000, started + 40_000);
  const token = randomUUID();
  const lock = await kvSetNxGet(LICENSE_WORKER_LOCK, token, 55);
  if (!lock.ok) return { ok: false, error: 'storage_unavailable' };
  if (lock.value !== null) return { ok: true, skipped: 'locked', processed: 0, failed: 0 };
  let processed = 0; let failed = 0;
  try {
    if (Date.now() >= deadline) return { ok: true, processed, failed };
    if (!options.member && !await repairLicenseIndexes()) return { ok: false, error: 'storage_unavailable' };
    if (Date.now() >= deadline) return { ok: true, processed, failed };
    let members: string[];
    if (options.member) members = [options.member];
    else {
      const active = await kvGet(LICENSE_ACTIVE_SUBMISSION);
      if (!active.ok) return { ok: false, error: 'storage_unavailable' };
      if (Date.now() >= deadline) return { ok: true, processed, failed };
      const due = await licenseDueMembers(Date.now());
      if (due === 'storage') return { ok: false, error: 'storage_unavailable' };
      // 古い due 20 件が送信枠待ちでも、その後ろの未解決 hash を先に回復して starvation を防ぐ。
      members = [...new Set([...(active.value ? [active.value] : []), ...due])].slice(0, 20);
    }
    for (const member of members) {
      if (Date.now() >= deadline) break;
      try { await processJob(member, token, deadline); processed++; } catch {
        // 破損/KV 障害が隣の義務の処理を止めない。原本と恒久 index を修復用に保持する。
        failed++; logger.warn('license.worker_job_failed', { member });
      }
    }
    return { ok: true, processed, failed };
  } finally {
    // 自動失効のみ。遅延した run が次の所有者の lock を消す波及を作らない。
  }
}
