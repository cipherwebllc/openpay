import { decodeFunctionResult, encodeFunctionData, parseAbi, type Hex, type PublicClient } from 'viem';
import type { AttestationResponse, TransferSpec } from './types';
import { GATEWAY_MINTER_ADDRESS } from './config';
import { validateGatewayAttestation } from './gatewayAttestation';

export type GatewayStatus = 'unknown' | 'awaiting-finality' | 'expired-unused' | 'awaiting-balance' | 'replaceable' | 'mintable' | 'paid' | 'confirming' | 'abandoned-unsigned' | 'abandoned-unsent' | 'rejected-request';
export interface GatewayObservation {
  status: GatewayStatus;
  blockHash?: Hex;
  blockNumber?: string;
  height?: string;
  used?: boolean;
  latestBlockHash?: Hex;
  latestBlockNumber?: string;
  latestHeight?: string;
  latestUsed?: boolean;
  funding?: { sourceDomain: number; depositor: string; token: 'USDC'; requiredAtomic: string; availableAtomic?: string; observedAt: number };
  detail?: string;
}
export type SavedGatewaySpec = Omit<TransferSpec, 'value'> & { value: string };
export interface GatewayAttempt {
  transferSpecHash: Hex;
  spec: SavedGatewaySpec;
  intent?: { maxBlockHeight: string; maxFee: string; signature?: Hex; requestTracked?: true; requestSentAt?: number };
  attestation?: AttestationResponse;
  obtainedAt?: number;
  maxBlockHeight?: string;
  txHashes: Hex[];
  observations: GatewayObservation[];
  status: GatewayStatus;
  settledTxHash?: Hex;
  receiptScanFrom?: string;
  receiptScanTo?: string;
  receiptFailures?: number;
  receiptRetryAt?: number;
  receiptScanComplete?: boolean;
}
export interface GatewayLeg { attempts: GatewayAttempt[] }
export interface GatewayResumeState {
  completion?: 'confirming' | 'settled';
  feeUnresolved?: boolean;
  merchantAttestation?: AttestationResponse;
  feeAttestation?: AttestationResponse;
  mintTxHash?: Hex;
  feeMintTxHash?: Hex;
  merchant?: GatewayLeg;
  fee?: GatewayLeg;
}
export interface GatewayReplacement {
  merchant?: Hex;
  fee?: Hex;
  /** Explicit authorization of a never-submitted fee, bound to the existing merchant identity. */
  authorizeFee?: Hex;
}
export interface GatewayRequestGuard { phase: 'merchant' | 'fee'; transferSpecHash: Hex }
export function cloneGatewayState(state: GatewayResumeState): GatewayResumeState {
  return JSON.parse(JSON.stringify(state)) as GatewayResumeState;
}
export function gatewayAttemptAbandoned(attempt: GatewayAttempt): boolean {
  return ['abandoned-unsigned', 'abandoned-unsent', 'rejected-request'].includes(attempt.status);
}
export class GatewayRecoveryError extends Error {
  constructor(public readonly state: GatewayResumeState) { super('Gateway recovery requires rechecking or explicit replacement'); this.name = 'GatewayRecoveryError'; }
}
export function activeGatewayAttempt(leg?: GatewayLeg) {
  if (!leg) return undefined;
  for (let i = leg.attempts.length - 1; i >= 0; i--) {
    if (!gatewayAttemptAbandoned(leg.attempts[i])) return leg.attempts[i];
  }
  return undefined;
}
export function gatewayHasOutstanding(state: GatewayResumeState): boolean {
  return !!(activeGatewayAttempt(state.merchant) || state.merchantAttestation || activeGatewayAttempt(state.fee) || state.feeAttestation);
}
export function gatewayCanRelease(state: GatewayResumeState): boolean {
  const m = activeGatewayAttempt(state.merchant);
  const f = activeGatewayAttempt(state.fee);
  if (!gatewayHasOutstanding(state)) return true;
  return m?.status === 'replaceable' && (!f ? !state.feeAttestation : f.status === 'replaceable' || f.status === 'paid');
}

const abi = parseAbi([
  'function isTransferSpecHashUsed(bytes32) view returns (bool)',
  'event AttestationUsed(address indexed token, address indexed recipient, bytes32 indexed transferSpecHash, uint32 sourceDomain, bytes32 sourceDepositor, bytes32 sourceSigner, uint256 value)',
]);
// Explicit policy: finalized RPC tag, never latest/safe/confirmation-count fallback.
// Unsupported chains/providers stay locked. Arbitrum finalized L2 snapshots carry L1 EVM heights.
const finalizedChains = new Set([1, 11155111, 137, 80002, 8453, 84532, 10, 11155420, 42161, 421614, 43114, 43113]);
type Rpc = (a: { method: string; params: unknown[] }) => Promise<unknown>;
interface Snapshot { hash: Hex; number: bigint; height: bigint }
export async function readGatewaySnapshot(client: PublicClient, chainId: number, tag: 'finalized' | 'latest' | Hex): Promise<Snapshot> {
  if (!finalizedChains.has(chainId)) throw new Error('Unsupported Gateway finality policy');
  const raw = await (client.request as Rpc)({ method: 'eth_getBlockByNumber', params: [tag, false] }) as Record<string, unknown> | null;
  const height = chainId === 42161 || chainId === 421614 ? raw?.l1BlockNumber : raw?.number;
  if (!raw || typeof raw.hash !== 'string' || !/^0x[\da-f]{64}$/i.test(raw.hash) ||
      typeof raw.number !== 'string' || !/^0x[\da-f]+$/i.test(raw.number) ||
      typeof height !== 'string' || !/^0x[\da-f]+$/i.test(height)) throw new Error('Invalid Gateway snapshot height/hash');
  return { hash: raw.hash as Hex, number: BigInt(raw.number), height: BigInt(height) };
}
async function usedAt(client: PublicClient, hash: Hex, block: Snapshot) {
  // EIP-1898 requireCanonical closes the read-between-heads/reorg window. No number fallback.
  const result = await (client.request as Rpc)({ method: 'eth_call', params: [{ to: GATEWAY_MINTER_ADDRESS,
    data: encodeFunctionData({ abi, functionName: 'isTransferSpecHashUsed', args: [hash] }) },
  { blockHash: block.hash, requireCanonical: true }] });
  if (typeof result !== 'string' || !/^0x0{63}[01]$/.test(result)) throw new Error('Invalid Gateway consumption response');
  return decodeFunctionResult({ abi, functionName: 'isTransferSpecHashUsed', data: result as Hex });
}
async function assertCanonical(client: PublicClient, block: Snapshot) {
  const raw = await (client.request as Rpc)({ method: 'eth_getBlockByNumber', params: [`0x${block.number.toString(16)}`, false] }) as { hash?: string } | null;
  if (raw?.hash?.toLowerCase() !== block.hash.toLowerCase()) throw new Error('Gateway snapshot changed');
}
/** Only a successful receipt observed by the broadcasting client may use latest for completion. */
export async function gatewayUsedAtLatest(client: PublicClient, chainId: number, hash: Hex): Promise<boolean> {
  const latest = await readGatewaySnapshot(client, chainId, 'latest');
  const used = await usedAt(client, hash, latest);
  await assertCanonical(client, latest);
  return used;
}

export async function reconcileGatewayAttempt(client: PublicClient, chainId: number, attempt: GatewayAttempt): Promise<GatewayObservation> {
  try {
    if (!attempt.attestation || attempt.maxBlockHeight === undefined) return { status: 'unknown', detail: 'Unresolved transfer request' };
    const finalized = await readGatewaySnapshot(client, chainId, 'finalized');
    const used = await usedAt(client, attempt.transferSpecHash, finalized);
    const proof = { blockHash: finalized.hash, blockNumber: String(finalized.number), height: String(finalized.height), used };
    await assertCanonical(client, finalized);
    if (used) return { ...proof, status: 'paid' };
    if (finalized.height > BigInt(attempt.maxBlockHeight)) return { ...proof, status: 'expired-unused' };
    const latest = await readGatewaySnapshot(client, chainId, 'latest');
    if (latest.number < finalized.number || latest.height < finalized.height ||
        (latest.number === finalized.number && latest.hash !== finalized.hash)) throw new Error('Inconsistent Gateway snapshots');
    const latestUsed = await usedAt(client, attempt.transferSpecHash, latest);
    await assertCanonical(client, finalized);
    return { ...proof, latestBlockHash: latest.hash, latestBlockNumber: String(latest.number), latestHeight: String(latest.height), latestUsed,
      status: latestUsed || latest.height > BigInt(attempt.maxBlockHeight) ? 'awaiting-finality' : 'mintable' };
  } catch (error) {
    // RPC/reorg failures cannot turn ambiguous payment evidence into replacement permission.
    return { status: 'unknown', detail: error instanceof Error ? error.message : String(error) };
  }
}

export async function recoverGatewayMintHash(client: PublicClient, attempt: GatewayAttempt, proof: GatewayObservation, chainId?: number): Promise<Hex | undefined> {
  if (!proof.blockNumber || (attempt.receiptRetryAt ?? 0) > Date.now()) return undefined;
  const end = BigInt(proof.blockNumber);
  try {
    // Saved hashes first; only matching successful mint events qualify (never our reverted hash).
    for (const hash of [...attempt.txHashes].reverse()) {
      try {
        const receipt = await client.getTransactionReceipt({ hash });
        if (receipt.status !== 'success' || receipt.blockNumber > end) continue;
        await assertCanonical(client, { hash: receipt.blockHash, number: receipt.blockNumber, height: 0n });
        const logs = await client.getLogs({ address: GATEWAY_MINTER_ADDRESS, event: abi[1], args: { transferSpecHash: attempt.transferSpecHash }, blockHash: receipt.blockHash });
        if (logs.some((l) => !l.removed && l.transactionHash === hash)) return hash;
      } catch {
        // A dropped local transaction must not hide another caller's successful mint logs.
      }
    }
    if (attempt.receiptScanComplete) return undefined;
    // A pre-request finalized snapshot or finalized-unused observation bounds this attestation's lifetime.
    // Legacy records with neither have no safe lower bound: keep hashless success, never scan to genesis.
    const unused = attempt.observations.find((o) => o.used === false && o.blockNumber && o.blockHash);
    const lower = attempt.receiptScanFrom ?? unused?.blockNumber;
    if (lower === undefined || attempt.maxBlockHeight === undefined) {
      attempt.receiptScanComplete = true;
      return undefined;
    }
    const first = BigInt(lower);
    const expiry = BigInt(attempt.maxBlockHeight);
    let scanEnd = attempt.receiptScanTo === undefined ? end : BigInt(attempt.receiptScanTo);
    if (scanEnd > end) scanEnd = end;
    if (chainId === 42161 || chainId === 421614) {
      // Contract expiry uses L1 heights on Arbitrum; binary search maps the upper bound into L2 log numbers.
      if (attempt.receiptScanTo === undefined && BigInt(proof.height!) > expiry) {
        let lo = first; let hi = scanEnd + 1n;
        while (lo < hi) {
          const mid = (lo + hi) / 2n;
          const block = await readGatewaySnapshot(client, chainId, `0x${mid.toString(16)}`);
          if (block.height <= expiry) lo = mid + 1n;
          else hi = mid;
        }
        scanEnd = lo - 1n;
      }
    } else if (scanEnd > expiry) scanEnd = expiry;
    if (scanEnd < first) { attempt.receiptScanComplete = true; return undefined; }
    const start = scanEnd - first > 1999n ? scanEnd - 1999n : first;
    const logs = await client.getLogs({ address: GATEWAY_MINTER_ADDRESS, event: abi[1], args: { transferSpecHash: attempt.transferSpecHash }, fromBlock: start, toBlock: scanEnd });
    const log = logs.find((l) => !l.removed && l.transactionHash && l.blockNumber !== null && l.blockNumber >= start && l.blockNumber <= scanEnd);
    if (log?.transactionHash && log.blockHash && log.blockNumber !== null) {
      await assertCanonical(client, { hash: log.blockHash, number: log.blockNumber, height: 0n });
      attempt.receiptFailures = 0; attempt.receiptRetryAt = undefined;
      return log.transactionHash;
    }
    attempt.receiptFailures = 0; attempt.receiptRetryAt = undefined;
    if (start === first) attempt.receiptScanComplete = true;
    else attempt.receiptScanTo = String(start - 1n);
  } catch {
    // Receipt-detail outages cannot undo finalized consumption or hammer the same failing provider every poll.
    deferReceiptLookup(attempt);
  }
  return undefined;
}


function deferReceiptLookup(attempt: GatewayAttempt) {
  attempt.receiptFailures = (attempt.receiptFailures ?? 0) + 1;
  attempt.receiptRetryAt = Date.now() + Math.min(600_000, 10_000 * 2 ** Math.min(attempt.receiptFailures, 6));
}

/** Read-only receipt maintenance: never broadcasts, signs, or completes an active invoice. */
export async function reconcileGatewayReceipt(client: PublicClient, chainId: number, saved: GatewayResumeState): Promise<GatewayResumeState> {
  const state = cloneGatewayState(saved);
  for (const phase of ['merchant', 'fee'] as const) {
    const attempt = activeGatewayAttempt(state[phase]);
    if (!attempt || !['confirming', 'paid', 'expired-unused'].includes(attempt.status) || (attempt.receiptRetryAt ?? 0) > Date.now()) continue;
    if (attempt.status === 'paid' && (attempt.settledTxHash || attempt.receiptScanComplete)) continue;
    try {
      const decoded = validateGatewayAttestation(attempt.attestation!, { ...attempt.spec, value: BigInt(attempt.spec.value) }, attempt.transferSpecHash);
      attempt.maxBlockHeight = String(decoded.maxBlockHeight);
      const cached = state.completion === 'settled' && attempt.status === 'paid'
        ? attempt.observations.find((o) => o.status === 'paid' && o.used && o.blockNumber && o.blockHash) : undefined;
      const proof = cached ?? await reconcileGatewayAttempt(client, chainId, attempt);
      if (!cached) attempt.observations.push(proof);
      if (proof.status === 'paid') {
        attempt.status = 'paid';
        // A successful latest receipt may have been reorged; final receipt details need canonical evidence too.
        attempt.settledTxHash = await recoverGatewayMintHash(client, attempt, proof, chainId);
      } else if (proof.status === 'expired-unused') {
        // Report lost confirmation distinctly; a prior onSuccess must never silently authorize another payment.
        attempt.status = 'expired-unused';
        if (phase === 'fee') state.feeUnresolved = true;
        attempt.settledTxHash = undefined;
        attempt.receiptRetryAt = Date.now() + 600_000;
      } else if (proof.status === 'unknown') deferReceiptLookup(attempt);
    } catch {
      // Optional receipt backfill cannot turn an already reported payment into another authorization.
      deferReceiptLookup(attempt);
    }
  }
  if (activeGatewayAttempt(state.merchant)?.status === 'paid' && activeGatewayAttempt(state.fee)?.status !== 'confirming') state.completion = 'settled';
  return state;
}
