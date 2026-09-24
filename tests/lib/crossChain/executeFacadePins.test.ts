// R12 (lib/crossChain/execute.ts の protocol 別分割) の前に置いた pinning test。
// 分割前のコード (origin/main) でも同じ期待値で通ることを確認してから分割した。固定するもの:
//   1. facade (`@/lib/crossChain/execute`) の runtime export と、各 protocol 経路が実際に投げる
//      error の同一性 (hook / component の instanceof 判定が分割で壊れない)
//   2. 同時に走る 2 つの実行が resume/persist state を共有しない (module 単位の state が無い)
//      + deploycheck の cache が executor をまたいで 1 つ
//   3. protocol ごとの callback / 永続化 / 外部副作用の順序 (onProgress・onStep・commit・
//      wallet・receipt 待ち・HTTP)。期待値は分割前のコードの実測をそのまま書いたもの。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  getAddress,
  keccak256,
  pad,
  toHex,
  type Address,
  type Hex,
} from 'viem';
import * as facade from '@/lib/crossChain/execute';
import type {
  CctpResumeState,
  CrossChainProgress,
  ExecuteCctpTransferArgs,
  ExecuteGatewayTransferArgs,
  ForwardResumeState,
  GatewayResumeState,
  OnMerchantMint,
} from '@/lib/crossChain/execute';
import { GatewayRecoveryError as LeafGatewayRecoveryError } from '@/lib/crossChain/gatewayRecovery';
import * as cctp from '@/lib/crossChain/cctp';
import { GATEWAY_MINTER_ABI } from '@/lib/crossChain/gateway';
import { GATEWAY_MINTER_ADDRESS, GATEWAY_WALLET_ADDRESS } from '@/lib/crossChain/config';
import type { BurnIntentMarker } from '@/lib/crossChain/burnMarker';
import { CIRCLE_DOMAIN_BASE, CIRCLE_DOMAIN_POLYGON } from '@/lib/crossChain/types';
import { __resetContractDeployedCacheForTest } from '@/lib/crossChain/deploycheck';
import { env } from '@/lib/env';
import { gatewayAttestation, gatewaySpec } from '../../fixtures/gateway';
import sandboxFees from '../../fixtures/cctp/arc-forwarding/fees-6-to-26-sandbox.json';

const SOURCE_TOKEN = getAddress('0x036CbD53842c5426634e7929541eC2318f3dCF7e');
const DEST_TOKEN = getAddress('0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582');
const SIG = `0x${'22'.repeat(65)}` as Hex;

interface Party { account: Address; recipient: Address; feeReceiver: Address }
// 同時実行の分離を JSON の部分一致で調べるので、fixture の定数 (署名 0x11.. 等) と
// 偶然一致しない値を使う。
const A: Party = {
  account: getAddress('0x7a1c3e5f9b2d4c6a8e0f1b3d5c7e9a2b4d6f8a0c'),
  recipient: getAddress('0x2b4d6f8a0c7a1c3e5f9b2d4c6a8e0f1b3d5c7e9a'),
  feeReceiver: getAddress('0x9c8b7a6f5e4d3c2b1a0f9e8d7c6b5a4f3e2d1c0b'),
};
const B: Party = {
  account: getAddress('0x3e5f7a9b1c2d4e6f8a0b2c4d6e8f0a1b3c5d7e9f'),
  recipient: getAddress('0x5f7a9b1c3e2d4e6f8a0b2c4d6e8f0a1b3c5d7e91'),
  feeReceiver: getAddress('0x6a8c0e2f4b6d8f0a2c4e6f8b0d2f4a6c8e0b2d4f'),
};
const h = (n: number) => toHex(n, { size: 32 });
const tx = (who: string, label: string): Hex => keccak256(toHex(`${who}:${label}`));
const txs = (who: string, labels: string[]): Array<[string, Hex]> => labels.map((label) => [label, tx(who, label)]);

beforeEach(() => {
  vi.spyOn(env, 'enableGatewayCrossChain', 'get').mockReturnValue(true);
  vi.spyOn(env, 'enableUsdcArc', 'get').mockReturnValue(true);
  vi.spyOn(env, 'enableUsdcArcCrossChain', 'get').mockReturnValue(true);
  __resetContractDeployedCacheForTest();
});
afterEach(() => vi.restoreAllMocks());

// ---- trace の表記 ------------------------------------------------------------

function contract(addr: unknown): string {
  const a = String(addr).toLowerCase();
  if (a === cctp.CCTP_V2_TOKEN_MESSENGER_ADDRESS.toLowerCase()) return 'tokenMessenger';
  if (a === cctp.CCTP_V2_MESSAGE_TRANSMITTER_ADDRESS.toLowerCase()) return 'messageTransmitter';
  if (a === GATEWAY_MINTER_ADDRESS.toLowerCase()) return 'gatewayMinter';
  if (a === GATEWAY_WALLET_ADDRESS.toLowerCase()) return 'gatewayWallet';
  return a;
}
type Show = (v: string) => string;
function namer(entries: Array<[string, Hex]>): Show {
  const names = new Map(entries.map(([label, hash]) => [hash.toLowerCase(), label]));
  return (v) => names.get(v.toLowerCase()) ?? v;
}
function progressText(p: CrossChainProgress, show: Show): string {
  if ('hash' in p) return `${p.kind}:${show(p.hash)}`;
  if ('burnHash' in p) return `${p.kind}:${show(p.burnHash)}`;
  if ('targetChainId' in p) return `${p.kind}:${p.targetChainId}`;
  return p.kind;
}
function mintText(i: Parameters<OnMerchantMint>[0], show: Show): string {
  return `merchantMint(mint=${i.mintTxHash ? show(i.mintTxHash) : '-'} burn=${i.burnTxHash ? show(i.burnTxHash) : '-'}` +
    ` spec=${i.transferSpecHash ? 'yes' : '-'} forward=${i.forward ? `${i.forward.verifiedNetAtomic}/${i.forward.feeCollectedAtomic}` : '-'})`;
}
function forwardSummary(f: ForwardResumeState, show: Show): string {
  return [
    `state=${f.state}`, `scanFrom=${f.scanFromBlock}`, f.nonce && 'nonce',
    f.eventNonce !== undefined && `eventNonce=${f.eventNonce}`,
    f.sourceEvidence && `evidence=${show(f.sourceEvidence.txHash)}#${f.sourceEvidence.logIndex}`,
    f.sourceUnresolved !== undefined && `sourceUnresolved=${f.sourceUnresolved}`,
    f.candidateHash && `candidate=${show(f.candidateHash)}`,
    f.forwardState && `forwardState=${f.forwardState}`, f.delayReason && `delay=${f.delayReason}`,
    f.accounting && `accounting=${f.accounting.verifiedNetAtomic}/${f.accounting.feeCollectedAtomic}`,
  ].filter(Boolean).join(' ');
}
function cctpSummary(s: CctpResumeState, show: Show): string {
  return Object.keys(s).sort().map((k) => {
    const v = (s as Record<string, unknown>)[k];
    if (v === undefined) return `${k}=undefined`;
    if (typeof v === 'string') return `${k}=${show(v)}`;
    if (k === 'forward') return `forward(${forwardSummary(s.forward!, show)})`;
    if (k === 'feeBurnUnresolved') return `${k}=${s.feeBurnUnresolved!.kind}/${s.feeBurnUnresolved!.row}`;
    return k;
  }).join(' ');
}
function gatewaySummary(s: GatewayResumeState, show: Show): string {
  const leg = (l: GatewayResumeState['merchant']) => l ? l.attempts.map((a) => [
    a.status, a.intent?.signature && 'sig', a.intent?.requestTracked && 'tracked',
    a.intent?.requestSentAt !== undefined && 'sent', a.attestation && 'att', a.maxBlockHeight && `maxBH=${a.maxBlockHeight}`,
    a.txHashes.length > 0 && `tx=${a.txHashes.map(show).join('|')}`, a.settledTxHash && `settled=${show(a.settledTxHash)}`,
    a.receiptScanFrom && `scanFrom=${a.receiptScanFrom}`, `obs=${a.observations.map((o) => o.status).join('>')}`,
  ].filter(Boolean).join(' ')).join('; ') : '-';
  return [
    `merchant[${leg(s.merchant)}]`, `fee[${leg(s.fee)}]`, s.merchantAttestation && 'merchantAttestation',
    s.feeAttestation && 'feeAttestation', s.completion && `completion=${s.completion}`,
    s.feeUnresolved !== undefined && `feeUnresolved=${s.feeUnresolved}`,
  ].filter(Boolean).join(' ');
}

// n 者が到着するまで全員を待たせる。2 つの実行を確実に交互に進めるために使う。
function barrier(n: number): () => Promise<void> {
  let arrived = 0;
  let release!: () => void;
  const all = new Promise<void>((resolve) => { release = resolve; });
  return async () => {
    arrived += 1;
    if (arrived >= n) release();
    await all;
  };
}

// ---- CCTP (self-mint) harness ------------------------------------------------

function cctpMarker(p: Party, amount: bigint): BurnIntentMarker {
  return { v: 1, chainId: 84532, block: '990', nonceLatest: 1, noncePending: 1, at: 0,
    depositor: p.account, burnToken: SOURCE_TOKEN, mintRecipient: p.recipient, amount: String(amount), destinationDomain: 7 };
}
function cctpHarness(o: {
  who: Party; txs: Array<[string, Hex]>; feeAmount?: bigint; resume?: CctpResumeState;
  /** 再開時は既に送った tx を飛ばす (名前付けには全 tx を使う)。 */
  queueFrom?: number; pendingNonce?: number; approveGate?: () => Promise<void>;
}) {
  const trace: string[] = [];
  const states: CctpResumeState[] = [];
  const show = namer(o.txs);
  const queue = o.txs.slice(o.queueFrom ?? 0).map(([, hash]) => hash);
  const approveHash = o.txs.find(([label]) => label === 'approve')?.[1];
  let chainId = 0;
  const wallet = {
    getChainId: vi.fn(async () => chainId),
    writeContract: vi.fn(async (a: { functionName: string; args: [Address, bigint] }) => {
      const hash = queue.shift()!;
      trace.push(`wallet.${a.functionName}(${contract(a.args[0])},${a.args[1]})=${show(hash)}`);
      return hash;
    }),
    sendTransaction: vi.fn(async (a: { to: Address }) => {
      const hash = queue.shift()!;
      trace.push(`wallet.send(${contract(a.to)})=${show(hash)}`);
      return hash;
    }),
  };
  const client = (role: 'source' | 'dest') => ({
    getBlockNumber: vi.fn(async () => 1000n),
    getTransactionCount: vi.fn(async (a: { blockTag?: string }) => (a.blockTag === 'pending' ? o.pendingNonce ?? 1 : 1)),
    getTransactionReceipt: vi.fn(async (a: { hash: Hex }) => {
      trace.push(`${role}.receipt(${show(a.hash)})`);
      return { status: 'success' };
    }),
    waitForTransactionReceipt: vi.fn(async (a: { hash: Hex }) => {
      trace.push(`${role}.wait(${show(a.hash)})`);
      if (a.hash === approveHash) await o.approveGate?.();
      return { status: 'success' };
    }),
    getCode: vi.fn(async (a: { address: Address }) => {
      trace.push(`${role}.getCode(${contract(a.address)})`);
      return '0x60016000' as Hex;
    }),
  });
  const source = client('source');
  const dest = client('dest');
  const fetch = vi.fn(async (url: string) => {
    const hit = o.txs.find(([, hash]) => url.toLowerCase().includes(hash.toLowerCase()));
    trace.push(`fetch.iris(${hit ? hit[0] : url})`);
    return new Response(JSON.stringify({ messages: [{ status: 'complete', message: hit ? hit[1].slice(0, 10) : '0xaa', attestation: '0xbb' }] }), { status: 200 });
  });
  const args: ExecuteCctpTransferArgs = {
    walletClient: wallet as never, sourcePublicClient: source as never, destPublicClient: dest as never,
    switchChainAsync: vi.fn(async ({ chainId: next }: { chainId: number }) => {
      trace.push(`switch(${next})`);
      chainId = next;
    }),
    account: o.who.account, sourceChainId: 84532, destChainId: 80002,
    sourceDomain: CIRCLE_DOMAIN_BASE, destDomain: CIRCLE_DOMAIN_POLYGON, sourceToken: SOURCE_TOKEN,
    recipient: o.who.recipient, valueAtomic: 1_000_000n,
    ...(o.feeAmount ? { feeReceiver: o.who.feeReceiver, feeAmount: o.feeAmount } : {}),
    resume: o.resume, fetch: fetch as never,
    pollOptions: { sleep: async () => undefined, now: () => 0 },
    commitBurnIntent: (marker, slot) => { trace.push(`commit(${slot},${marker.amount})`); },
    onStep: (state) => { states.push(state); trace.push(`step{${cctpSummary(state, show)}}`); },
    onProgress: (p) => { trace.push(`progress(${progressText(p, show)})`); },
    onMerchantMint: (i) => { trace.push(mintText(i, show)); },
  };
  return { args, trace, states, wallet, source, dest, fetch };
}

// ---- Gateway harness ---------------------------------------------------------

function gatewayHarness(o: {
  who: Party; mints: Array<[string, Hex]>; feeAmount?: bigint; resume?: GatewayResumeState;
  signGate?: () => Promise<void>;
}) {
  const trace: string[] = [];
  const states: GatewayResumeState[] = [];
  const show = namer(o.mints);
  const queue = o.mints.map(([, hash]) => hash);
  const minted = new Map<Hex, { hash: Hex; finalized: boolean }>();
  const blockHash = pad('0x01');
  let chainId = 0;
  const wallet = {
    getChainId: vi.fn(async () => chainId),
    signTypedData: vi.fn(async (a: { message: { spec: { value: bigint } } }) => {
      trace.push(`wallet.sign(${a.message.spec.value})`);
      await o.signGate?.();
      return SIG;
    }),
    sendTransaction: vi.fn(async (a: { to: Address; data: Hex }) => {
      const hash = queue.shift()!;
      const decoded = decodeFunctionData({ abi: GATEWAY_MINTER_ABI, data: a.data });
      minted.set(keccak256(`0x${(decoded.args[0] as string).slice(82)}`), { hash, finalized: false });
      trace.push(`wallet.send(${contract(a.to)})=${show(hash)}`);
      return hash;
    }),
  };
  const client = (role: 'source' | 'dest') => ({
    getBlockNumber: vi.fn(async () => 1000n),
    readContract: vi.fn(async () => 302_400n),
    waitForTransactionReceipt: vi.fn(async (a: { hash: Hex }) => {
      trace.push(`${role}.wait(${show(a.hash)})`);
      for (const m of minted.values()) if (m.hash === a.hash) m.finalized = true;
      return { status: 'success' };
    }),
    request: vi.fn(async (a: { method: string; params: unknown[] }) => a.method === 'eth_call'
      ? pad(minted.get(`0x${(a.params[0] as { data: string }).data.slice(-64)}` as Hex)?.finalized ? '0x01' : '0x00')
      : { hash: blockHash, number: '0x3e8' }),
    getLogs: vi.fn(async (a: { args: { transferSpecHash: Hex } }) => {
      const m = minted.get(a.args.transferSpecHash);
      return m?.finalized ? [{ transactionHash: m.hash, blockNumber: 1000n, blockHash, removed: false }] : [];
    }),
    getTransactionReceipt: vi.fn(async () => ({ status: 'success', blockNumber: 1000n, blockHash })),
    getCode: vi.fn(async (a: { address: Address }) => {
      trace.push(`${role}.getCode(${contract(a.address)})`);
      return '0x60016000' as Hex;
    }),
  });
  const source = client('source');
  const dest = client('dest');
  const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
    const spec = JSON.parse(String(init?.body))[0].burnIntent.spec;
    trace.push(`fetch.gatewayTransfer(${spec.value})`);
    return new Response(JSON.stringify(gatewayAttestation({ ...spec, value: BigInt(spec.value) }, 1_000_000n)), { status: 200 });
  });
  const args: ExecuteGatewayTransferArgs = {
    walletClient: wallet as never, sourcePublicClient: source as never, destPublicClient: dest as never,
    switchChainAsync: vi.fn(async ({ chainId: next }: { chainId: number }) => {
      trace.push(`switch(${next})`);
      chainId = next;
    }),
    account: o.who.account, sourceChainId: 84532, destChainId: 80002,
    sourceDomain: CIRCLE_DOMAIN_BASE, destDomain: CIRCLE_DOMAIN_POLYGON,
    sourceToken: SOURCE_TOKEN, destToken: DEST_TOKEN, recipient: o.who.recipient, valueAtomic: 1_000_000n,
    ...(o.feeAmount ? { feeReceiver: o.who.feeReceiver, feeAmount: o.feeAmount } : {}),
    resume: o.resume, fetch: fetch as never,
    onStep: (state, beforeSigning, beforeRequest) => {
      states.push(state);
      trace.push(`step{${gatewaySummary(state, show)}}` +
        (beforeSigning ? ` beforeSigning{${gatewaySummary(beforeSigning, show)}}` : '') +
        (beforeRequest ? ` guard=${beforeRequest.phase}` : ''));
    },
    onProgress: (p) => { trace.push(`progress(${progressText(p, show)})`); },
    onMerchantMint: (i) => { trace.push(mintText(i, show)); },
  };
  return { args, trace, states, wallet, source, dest, fetch };
}

// ---- Forward (Arc) harness ---------------------------------------------------

function forwardHarness(o: {
  who: Party; ids: { approve: Hex; burn: Hex; mint: Hex; nonce: Hex }; resume?: CctpResumeState;
  iris?: 'nonce' | 'pending'; sourceLogs?: 'match' | 'none'; pendingNonce?: number;
  feesGate?: () => Promise<void>;
}) {
  const trace: string[] = [];
  const states: CctpResumeState[] = [];
  const show = namer([['approve', o.ids.approve], ['burn', o.ids.burn], ['mint', o.ids.mint]]);
  const { account, recipient } = o.who;
  const q = cctp.acceptForwardQuote({ sourceChainId: 84532, destChainId: 5042002,
    sourceDomain: 6, destDomain: 26, recipient, valueAtomic: '1000000' }, sandboxFees[0], 1000);
  const eventLog = (event: typeof cctp.CCTP_MESSAGE_RECEIVED_EVENT | typeof cctp.CCTP_MINT_AND_WITHDRAW_EVENT | typeof cctp.CCTP_V2_DEPOSIT_FOR_BURN_EVENT,
    args: Record<string, unknown>, data: Hex, address: Address, logIndex: number, tx: Hex) => ({
    address, topics: encodeEventTopics({ abi: [event], args }), data, logIndex,
    blockNumber: 100n, blockHash: h(4), transactionHash: tx, transactionIndex: 0, removed: false,
  });
  const body = ('0x' + [toHex(1, { size: 4 }), pad(SOURCE_TOKEN), pad(recipient), toHex(BigInt(q.grossAtomic), { size: 32 }),
    pad(account), toHex(BigInt(q.maxFeeAtomic), { size: 32 }), toHex(20000n, { size: 32 }), toHex(0n, { size: 32 }), cctp.CCTP_FORWARD_HOOK_DATA]
    .map((v) => v.slice(2)).join('')) as Hex;
  const destLogs = [
    eventLog(cctp.CCTP_MINT_AND_WITHDRAW_EVENT, { mintRecipient: recipient, mintToken: cctp.ARC_USDC_ADDRESS },
      encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [BigInt(q.grossAtomic) - 20000n, 20000n]), cctp.CCTP_V2_TOKEN_MESSENGER_ADDRESS, 1, o.ids.mint),
    eventLog(cctp.CCTP_MESSAGE_RECEIVED_EVENT, { caller: account, nonce: o.ids.nonce, finalityThresholdExecuted: 1000 },
      encodeAbiParameters([{ type: 'uint32' }, { type: 'bytes32' }, { type: 'bytes' }], [6, pad(cctp.CCTP_V2_TOKEN_MESSENGER_ADDRESS), body]), cctp.CCTP_V2_MESSAGE_TRANSMITTER_ADDRESS, 2, o.ids.mint),
  ];
  const sourceLog = eventLog(cctp.CCTP_V2_DEPOSIT_FOR_BURN_EVENT, { burnToken: SOURCE_TOKEN, depositor: account, minFinalityThreshold: 1000 },
    encodeAbiParameters([{ type: 'uint256' }, { type: 'bytes32' }, { type: 'uint32' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'bytes' }],
      [BigInt(q.grossAtomic), pad(recipient), 26, pad(cctp.CCTP_V2_TOKEN_MESSENGER_ADDRESS), h(0), BigInt(q.maxFeeAtomic), cctp.CCTP_FORWARD_HOOK_DATA]), cctp.CCTP_V2_TOKEN_MESSENGER_ADDRESS, 3, o.ids.burn);
  const sourceReceipt = { status: 'success', blockNumber: 100n, blockHash: h(4), logs: o.sourceLogs === 'none' ? [] : [sourceLog] };
  const source = {
    getBlockNumber: vi.fn(async () => 100n),
    getTransactionCount: vi.fn(async (a: { blockTag?: string }) => (a.blockTag === 'pending' ? o.pendingNonce ?? 1 : 1)),
    getCode: vi.fn(async (a: { address: Address }) => {
      trace.push(`source.getCode(${contract(a.address)})`);
      return '0x1234' as Hex;
    }),
    readContract: vi.fn(async () => 10n ** 30n),
    getTransactionReceipt: vi.fn(async (a: { hash: Hex }) => {
      trace.push(`source.receipt(${show(a.hash)})`);
      return sourceReceipt;
    }),
    waitForTransactionReceipt: vi.fn(async (a: { hash: Hex }) => {
      trace.push(`source.wait(${show(a.hash)})`);
      return sourceReceipt;
    }),
    getLogs: vi.fn(async () => []),
  };
  const dest = {
    getBlockNumber: vi.fn(async () => 100n),
    getLogs: vi.fn(async () => []),
    getTransactionReceipt: vi.fn(async (a: { hash: Hex }) => {
      trace.push(`dest.receipt(${show(a.hash)})`);
      return { status: 'success', blockNumber: 100n, blockHash: h(4), logs: destLogs };
    }),
  };
  const wallet = {
    getChainId: vi.fn(async () => 84532),
    writeContract: vi.fn(async (a: { functionName: string; args: [Address, bigint] }) => {
      trace.push(`wallet.${a.functionName}(${contract(a.args[0])},${a.args[1]})=approve`);
      return o.ids.approve;
    }),
    sendTransaction: vi.fn(async (a: { to: Address }) => {
      trace.push(`wallet.send(${contract(a.to)})=burn`);
      return o.ids.burn;
    }),
  };
  const fetch = vi.fn(async (url: string) => {
    if (url.includes('/fees/')) {
      trace.push('fetch.fees');
      await o.feesGate?.();
      return new Response(JSON.stringify(sandboxFees));
    }
    trace.push('fetch.irisForward');
    return new Response(JSON.stringify(o.iris === 'pending'
      ? { messages: [{ status: 'pending_confirmations', forwardState: 'PENDING', delayReason: 'amount_above_max' }] }
      : { messages: [{ decodedMessage: { nonce: o.ids.nonce }, forwardTxHash: o.ids.mint, status: 'complete' }] }));
  });
  const args: ExecuteCctpTransferArgs = {
    walletClient: wallet as never, sourcePublicClient: source as never, destPublicClient: dest as never,
    switchChainAsync: vi.fn(async ({ chainId }: { chainId: number }) => { trace.push(`switch(${chainId})`); }),
    account, sourceChainId: 84532, destChainId: 5042002, sourceDomain: 6, destDomain: 26,
    sourceToken: SOURCE_TOKEN, recipient, valueAtomic: 1_000_000n, feeAmount: 0n,
    forward: { acceptedQuote: q }, fetch: fetch as never, now: () => 2000, pollOptions: { timeoutMs: 0 }, resume: o.resume,
    commitBurnIntent: (marker, slot, metadata) => {
      trace.push(`commit(${slot},${marker.amount},${metadata ? forwardSummary(metadata.forward, show) : '-'})`);
    },
    onStep: (state) => { states.push(state); trace.push(`step{${cctpSummary(state, show)}}`); },
    onProgress: (p) => { trace.push(`progress(${progressText(p, show)})`); },
    onMerchantMint: (i) => { trace.push(mintText(i, show)); },
  };
  return { args, trace, states, wallet, source, dest, fetch, quote: q };
}

const forwardIds = (who: string) => ({ approve: tx(who, 'fwdApprove'), burn: tx(who, 'fwdBurn'), mint: tx(who, 'fwdMint'), nonce: tx(who, 'fwdNonce') });
const FWD_A = forwardIds('A');
const FWD_B = forwardIds('B');
const CCTP_LABELS = ['approve', 'burn', 'feeBurn', 'mint', 'feeMint'];
const CCTP_A = txs('A', CCTP_LABELS);
const CCTP_B = txs('B', CCTP_LABELS);
const GW_A = txs('A', ['gwMint', 'gwFeeMint']);
const GW_B = txs('B', ['gwMint', 'gwFeeMint']);

// ---- 1. facade の export と error の同一性 -------------------------------------

describe('R12 pin: facade exports and error identity', () => {
  it('keeps the runtime export surface of the facade', () => {
    expect(Object.keys(facade).sort()).toEqual([
      'CrossChainBurnUnresolvedError',
      'CrossChainForwardPendingError',
      'CrossChainQuoteExpiredError',
      'GatewayRecoveryError',
      'assertForwardQuoteBinding',
      'assertGatewayTransferEnabled',
      'ensureWalletChain',
      'executeCctpTransfer',
      'executeGatewayTransfer',
    ]);
    // gatewayRecovery からの再 export は同じ class object のまま (hook は facade 経由で instanceof する)。
    expect(facade.GatewayRecoveryError).toBe(LeafGatewayRecoveryError);
  });

  it('CCTP merchant burn left unresolved throws the facade CrossChainBurnUnresolvedError', async () => {
    const t = cctpHarness({ who: A, txs: CCTP_A, pendingNonce: 2, resume: { burnIntent: cctpMarker(A, 1_000_000n) } });
    const error = await facade.executeCctpTransfer(t.args).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(facade.CrossChainBurnUnresolvedError);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ name: 'CrossChainBurnUnresolvedError', kind: 'wait', row: 5, slot: 'merchant', reburnable: false,
      sourceChainId: 84532, depositor: A.account });
    expect(t.wallet.writeContract).not.toHaveBeenCalled();
  });

  it('forward pre-confirmation probe (shared burn recovery) throws the facade CrossChainBurnUnresolvedError', async () => {
    const t = forwardHarness({ who: A, ids: FWD_A, pendingNonce: 2 });
    t.args.resume = { burnIntent: { ...cctpMarker(A, BigInt(t.quote.grossAtomic)), destinationDomain: 26 },
      forward: { acceptedQuote: t.quote, state: 'intent', scanFromBlock: '90' } };
    const error = await facade.executeCctpTransfer(t.args).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(facade.CrossChainBurnUnresolvedError);
    expect(error).toMatchObject({ kind: 'wait', row: 5, slot: 'merchant' });
    expect(t.trace).toContain('progress(burn_unconfirmed)');
  });

  it('forward source evidence mismatch throws the facade CrossChainBurnUnresolvedError (row 21)', async () => {
    const t = forwardHarness({ who: A, ids: FWD_A, sourceLogs: 'none' });
    const error = await facade.executeCctpTransfer(t.args).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(facade.CrossChainBurnUnresolvedError);
    expect(error).toMatchObject({ kind: 'wait', row: 21, slot: 'merchant', burnTxHash: FWD_A.burn });
    expect(t.states.at(-1)?.forward?.sourceUnresolved).toBe(true);
  });

  it('forward quote expiry and re-consent throw the facade CrossChainQuoteExpiredError', async () => {
    const expired = forwardHarness({ who: A, ids: FWD_A });
    expired.args.now = () => 999_999;
    const e1 = await facade.executeCctpTransfer(expired.args).catch((e: unknown) => e);
    expect(e1).toBeInstanceOf(facade.CrossChainQuoteExpiredError);
    expect(e1).toMatchObject({ name: 'CrossChainQuoteExpiredError', replacementQuote: undefined });

    const declined = forwardHarness({ who: A, ids: FWD_A });
    declined.args.forward = { acceptedQuote: declined.quote, allowBurn: false };
    const e2 = await facade.executeCctpTransfer(declined.args).catch((e: unknown) => e);
    expect(e2).toBeInstanceOf(facade.CrossChainQuoteExpiredError);
    expect((e2 as InstanceType<typeof facade.CrossChainQuoteExpiredError>).replacementQuote).toMatchObject({ recipient: A.recipient });
    expect(declined.wallet.writeContract).not.toHaveBeenCalled();
  });

  it('forward pending throws the facade CrossChainForwardPendingError carrying the last persisted state', async () => {
    const t = forwardHarness({ who: A, ids: FWD_A, iris: 'pending' });
    const error = await facade.executeCctpTransfer(t.args).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(facade.CrossChainForwardPendingError);
    expect(error).toMatchObject({ name: 'CrossChainForwardPendingError' });
    expect((error as InstanceType<typeof facade.CrossChainForwardPendingError>).resume).toBe(t.states.at(-1));
  });

  it('gateway recovery stop throws the facade GatewayRecoveryError (same class as the leaf)', async () => {
    const t = gatewayHarness({ who: A, mints: GW_A, resume: { completion: 'settled' } });
    const error = await facade.executeGatewayTransfer(t.args).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(facade.GatewayRecoveryError);
    expect(error).toBeInstanceOf(LeafGatewayRecoveryError);
    expect(error).toMatchObject({ name: 'GatewayRecoveryError', state: { completion: 'settled' } });
  });
});

// ---- 2. 同時実行の分離 ---------------------------------------------------------

function foreign(states: unknown[], other: Party, otherHashes: Hex[]): string[] {
  const needles = [other.account, other.recipient, other.feeReceiver, ...otherHashes].map((v) => v.slice(2).toLowerCase());
  return states.map((s) => JSON.stringify(s).toLowerCase()).filter((json) => needles.some((n) => json.includes(n)));
}
const withoutGetCode = (trace: string[]) => trace.filter((line) => !line.includes('.getCode('));
const getCodeCalls = (...clients: Array<{ getCode: { mock: { calls: unknown[][] } } }>) =>
  clients.flatMap((c) => c.getCode.mock.calls.map(([a]) => contract((a as { address: Address }).address)));

describe('R12 pin: concurrent executions do not share resume/persist state', () => {
  it('CCTP: two interleaved executions keep their own state, order, and results', async () => {
    const solo = cctpHarness({ who: A, txs: CCTP_A, feeAmount: 10_000n });
    await facade.executeCctpTransfer(solo.args);
    __resetContractDeployedCacheForTest();

    const gate = barrier(2);
    const a = cctpHarness({ who: A, txs: CCTP_A, feeAmount: 10_000n, approveGate: gate });
    const b = cctpHarness({ who: B, txs: CCTP_B, feeAmount: 10_000n, approveGate: gate });
    const [ra, rb] = await Promise.all([facade.executeCctpTransfer(a.args), facade.executeCctpTransfer(b.args)]);

    for (const [who, result] of [['A', ra], ['B', rb]] as const) {
      expect(result).toMatchObject({ approveTxHash: tx(who, 'approve'), burnTxHash: tx(who, 'burn'), feeBurnTxHash: tx(who, 'feeBurn'),
        mintTxHash: tx(who, 'mint'), feeMintTxHash: tx(who, 'feeMint') });
    }
    expect(foreign(a.states, B, CCTP_B.map(([, x]) => x))).toEqual([]);
    expect(foreign(b.states, A, CCTP_A.map(([, x]) => x))).toEqual([]);
    expect(withoutGetCode(a.trace)).toEqual(withoutGetCode(solo.trace));
    expect(withoutGetCode(b.trace)).toEqual(withoutGetCode(solo.trace));
    // 同じ state object を 2 つの実行で使い回さない。
    expect(a.states.some((s) => b.states.includes(s))).toBe(false);
    // deploycheck の in-flight/verified cache は 1 つ: 並行実行でも同じ contract の getCode は 1 回。
    expect(getCodeCalls(a.source, b.source).sort()).toEqual(['tokenMessenger']);
    expect(getCodeCalls(a.dest, b.dest).sort()).toEqual(['messageTransmitter']);
  });

  it('Gateway: two interleaved executions keep their own attempts, order, and results', async () => {
    const solo = gatewayHarness({ who: A, mints: GW_A, feeAmount: 10_000n });
    await facade.executeGatewayTransfer(solo.args);
    __resetContractDeployedCacheForTest();

    const gate = barrier(2);
    const a = gatewayHarness({ who: A, mints: GW_A, feeAmount: 10_000n, signGate: gate });
    const b = gatewayHarness({ who: B, mints: GW_B, feeAmount: 10_000n, signGate: gate });
    const [ra, rb] = await Promise.all([facade.executeGatewayTransfer(a.args), facade.executeGatewayTransfer(b.args)]);

    expect(ra).toMatchObject({ mintTxHash: tx('A', 'gwMint'), feeMintTxHash: tx('A', 'gwFeeMint'), settlement: 'transaction' });
    expect(rb).toMatchObject({ mintTxHash: tx('B', 'gwMint'), feeMintTxHash: tx('B', 'gwFeeMint'), settlement: 'transaction' });
    expect(ra.transferSpecHash).not.toBe(rb.transferSpecHash);
    expect(foreign(a.states, B, GW_B.map(([, x]) => x))).toEqual([]);
    expect(foreign(b.states, A, GW_A.map(([, x]) => x))).toEqual([]);
    expect(withoutGetCode(a.trace)).toEqual(withoutGetCode(solo.trace));
    expect(withoutGetCode(b.trace)).toEqual(withoutGetCode(solo.trace));
    expect(a.states.some((s) => b.states.includes(s))).toBe(false);
    expect(getCodeCalls(a.source, b.source).sort()).toEqual(['gatewayWallet']);
    expect(getCodeCalls(a.dest, b.dest).sort()).toEqual(['gatewayMinter']);
  });

  it('Forward: two interleaved executions keep their own forward state, order, and accounting', async () => {
    const solo = forwardHarness({ who: A, ids: FWD_A });
    await facade.executeCctpTransfer(solo.args);
    __resetContractDeployedCacheForTest();

    const gate = barrier(2);
    const a = forwardHarness({ who: A, ids: FWD_A, feesGate: gate });
    const b = forwardHarness({ who: B, ids: FWD_B, feesGate: gate });
    const [ra, rb] = await Promise.all([facade.executeCctpTransfer(a.args), facade.executeCctpTransfer(b.args)]);

    expect(ra).toMatchObject({ burnTxHash: FWD_A.burn, mintTxHash: FWD_A.mint, approveTxHash: FWD_A.approve });
    expect(rb).toMatchObject({ burnTxHash: FWD_B.burn, mintTxHash: FWD_B.mint, approveTxHash: FWD_B.approve });
    expect(foreign(a.states, B, Object.values(FWD_B))).toEqual([]);
    expect(foreign(b.states, A, Object.values(FWD_A))).toEqual([]);
    expect(withoutGetCode(a.trace)).toEqual(withoutGetCode(solo.trace));
    expect(withoutGetCode(b.trace)).toEqual(withoutGetCode(solo.trace));
    expect(a.states.some((s) => b.states.includes(s))).toBe(false);
    expect(getCodeCalls(a.source, b.source)).toEqual(['tokenMessenger']);
  });

  it('deploycheck cache is shared across executors (self-mint CCTP then forward on the same source chain)', async () => {
    const selfMint = cctpHarness({ who: A, txs: CCTP_A });
    await facade.executeCctpTransfer(selfMint.args);
    const forward = forwardHarness({ who: B, ids: FWD_B });
    await facade.executeCctpTransfer(forward.args);
    expect(getCodeCalls(selfMint.source)).toEqual(['tokenMessenger']);
    expect(getCodeCalls(forward.source)).toEqual([]);
  });

  it('caller-owned resume objects are never mutated', async () => {
    const cctpResume = Object.freeze({ approveTxHash: tx('A', 'approve'), burnIntent: Object.freeze(cctpMarker(A, 1_000_000n)), burnTxHash: tx('A', 'burn') });
    const c = cctpHarness({ who: A, txs: CCTP_A, queueFrom: 3, resume: cctpResume as CctpResumeState });
    await facade.executeCctpTransfer(c.args);
    expect(c.states.every((s) => s !== cctpResume)).toBe(true);

    const legacy = { merchantAttestation: gatewayAttestation({ ...gatewaySpec, sourceDepositor: pad(A.account), sourceSigner: pad(A.account),
      destinationRecipient: pad(A.recipient) }, 1_000_000n) };
    const before = JSON.stringify(legacy);
    const g = gatewayHarness({ who: A, mints: GW_A, resume: legacy });
    await facade.executeGatewayTransfer(g.args);
    expect(JSON.stringify(legacy)).toBe(before);
    expect(g.states.every((s) => s !== legacy)).toBe(true);
  });
});

// ---- 3. callback / 永続化 / 副作用の順序 ------------------------------------

// 分割前 (origin/main 164f49c2) のコードで実測した順序。分割でこの配列を書き換えないこと。
const EXPECTED: Record<string, string[]> = {
  gatewayFresh: [
    'progress(switch_chain:84532)',
    'switch(84532)',
    'source.getCode(gatewayWallet)',
    'step{merchant[unknown tracked obs=] fee[-]} beforeSigning{merchant[-] fee[-]}',
    'progress(sign)',
    'wallet.sign(1000000)',
    'step{merchant[unknown sig tracked obs=] fee[-]}',
    'progress(attest)',
    'step{merchant[unknown sig tracked scanFrom=1000 obs=] fee[-]} guard=merchant',
    'step{merchant[unknown sig tracked sent scanFrom=1000 obs=] fee[-]} guard=merchant',
    'fetch.gatewayTransfer(1000000)',
    'step{merchant[unknown sig tracked sent att scanFrom=1000 obs=] fee[-] merchantAttestation}',
    'step{merchant[unknown sig tracked sent att maxBH=1000000 scanFrom=1000 obs=] fee[-] merchantAttestation}',
    'step{merchant[mintable sig tracked sent att maxBH=1000000 scanFrom=1000 obs=mintable] fee[-] merchantAttestation}',
    'progress(switch_chain:84532)',
    'step{merchant[mintable sig tracked sent att maxBH=1000000 scanFrom=1000 obs=mintable] fee[unknown tracked obs=] merchantAttestation} beforeSigning{merchant[mintable sig tracked sent att maxBH=1000000 scanFrom=1000 obs=mintable] fee[-] merchantAttestation}',
    'progress(fee_sign)',
    'wallet.sign(10000)',
    'step{merchant[mintable sig tracked sent att maxBH=1000000 scanFrom=1000 obs=mintable] fee[unknown sig tracked obs=] merchantAttestation}',
    'progress(fee_attest)',
    'step{merchant[mintable sig tracked sent att maxBH=1000000 scanFrom=1000 obs=mintable] fee[unknown sig tracked scanFrom=1000 obs=] merchantAttestation} guard=fee',
    'step{merchant[mintable sig tracked sent att maxBH=1000000 scanFrom=1000 obs=mintable] fee[unknown sig tracked sent scanFrom=1000 obs=] merchantAttestation} guard=fee',
    'fetch.gatewayTransfer(10000)',
    'step{merchant[mintable sig tracked sent att maxBH=1000000 scanFrom=1000 obs=mintable] fee[unknown sig tracked sent att scanFrom=1000 obs=] merchantAttestation feeAttestation}',
    'step{merchant[mintable sig tracked sent att maxBH=1000000 scanFrom=1000 obs=mintable] fee[unknown sig tracked sent att maxBH=1000000 scanFrom=1000 obs=] merchantAttestation feeAttestation}',
    'step{merchant[mintable sig tracked sent att maxBH=1000000 scanFrom=1000 obs=mintable] fee[mintable sig tracked sent att maxBH=1000000 scanFrom=1000 obs=mintable] merchantAttestation feeAttestation}',
    'progress(switch_chain:80002)',
    'switch(80002)',
    'dest.getCode(gatewayMinter)',
    'wallet.send(gatewayMinter)=gwMint',
    'step{merchant[mintable sig tracked sent att maxBH=1000000 tx=gwMint scanFrom=1000 obs=mintable] fee[mintable sig tracked sent att maxBH=1000000 scanFrom=1000 obs=mintable] merchantAttestation feeAttestation}',
    'progress(dest_tx_pending:gwMint)',
    'dest.wait(gwMint)',
    'step{merchant[confirming sig tracked sent att maxBH=1000000 tx=gwMint settled=gwMint scanFrom=1000 obs=mintable] fee[mintable sig tracked sent att maxBH=1000000 scanFrom=1000 obs=mintable] merchantAttestation feeAttestation}',
    'merchantMint(mint=gwMint burn=- spec=yes forward=-)',
    'progress(switch_chain:80002)',
    'wallet.send(gatewayMinter)=gwFeeMint',
    'step{merchant[confirming sig tracked sent att maxBH=1000000 tx=gwMint settled=gwMint scanFrom=1000 obs=mintable] fee[mintable sig tracked sent att maxBH=1000000 tx=gwFeeMint scanFrom=1000 obs=mintable] merchantAttestation feeAttestation}',
    'progress(fee_dest_tx_pending:gwFeeMint)',
    'dest.wait(gwFeeMint)',
    'step{merchant[confirming sig tracked sent att maxBH=1000000 tx=gwMint settled=gwMint scanFrom=1000 obs=mintable] fee[confirming sig tracked sent att maxBH=1000000 tx=gwFeeMint settled=gwFeeMint scanFrom=1000 obs=mintable] merchantAttestation feeAttestation}',
    'step{merchant[confirming sig tracked sent att maxBH=1000000 tx=gwMint settled=gwMint scanFrom=1000 obs=mintable] fee[confirming sig tracked sent att maxBH=1000000 tx=gwFeeMint settled=gwFeeMint scanFrom=1000 obs=mintable] merchantAttestation feeAttestation completion=confirming feeUnresolved=false}',
  ],
  gatewayLegacyResume: [
    'step{merchant[mintable att maxBH=1000000 obs=mintable] fee[-] merchantAttestation}',
    'progress(switch_chain:80002)',
    'switch(80002)',
    'dest.getCode(gatewayMinter)',
    'wallet.send(gatewayMinter)=gwMint',
    'step{merchant[mintable att maxBH=1000000 tx=gwMint obs=mintable] fee[-] merchantAttestation}',
    'progress(dest_tx_pending:gwMint)',
    'dest.wait(gwMint)',
    'step{merchant[confirming att maxBH=1000000 tx=gwMint settled=gwMint obs=mintable] fee[-] merchantAttestation}',
    'merchantMint(mint=gwMint burn=- spec=yes forward=-)',
    'step{merchant[confirming att maxBH=1000000 tx=gwMint settled=gwMint obs=mintable] fee[-] merchantAttestation completion=confirming feeUnresolved=false}',
  ],
  cctpFresh: [
    'progress(switch_chain:84532)',
    'switch(84532)',
    'source.getCode(tokenMessenger)',
    'progress(approve)',
    'wallet.approve(tokenMessenger,1010000)=approve',
    'source.wait(approve)',
    'step{approveTxHash=approve}',
    'commit(merchant,1000000)',
    'step{approveTxHash=approve burnIntent}',
    'wallet.send(tokenMessenger)=burn',
    'step{approveTxHash=approve burnIntent burnTxHash=burn}',
    'progress(source_tx_pending:burn)',
    'source.wait(burn)',
    'commit(fee,10000)',
    'step{approveTxHash=approve burnIntent burnTxHash=burn feeBurnIntent}',
    'wallet.send(tokenMessenger)=feeBurn',
    'step{approveTxHash=approve burnIntent burnTxHash=burn feeBurnIntent feeBurnTxHash=feeBurn}',
    'progress(fee_source_tx_pending:feeBurn)',
    'source.wait(feeBurn)',
    'progress(poll_attestation)',
    'fetch.iris(burn)',
    'fetch.iris(feeBurn)',
    'progress(switch_chain:80002)',
    'switch(80002)',
    'dest.getCode(messageTransmitter)',
    'wallet.send(messageTransmitter)=mint',
    'step{approveTxHash=approve burnIntent burnTxHash=burn feeBurnIntent feeBurnTxHash=feeBurn mintTxHash=mint}',
    'progress(dest_tx_pending:mint)',
    'dest.wait(mint)',
    'merchantMint(mint=mint burn=burn spec=- forward=-)',
    'wallet.send(messageTransmitter)=feeMint',
    'step{approveTxHash=approve burnIntent burnTxHash=burn feeBurnIntent feeBurnTxHash=feeBurn feeMintTxHash=feeMint mintTxHash=mint}',
    'progress(fee_dest_tx_pending:feeMint)',
    'dest.wait(feeMint)',
  ],
  cctpResume: [
    'progress(burn_probe)',
    'source.receipt(burn)',
    'progress(poll_attestation)',
    'fetch.iris(burn)',
    'progress(switch_chain:80002)',
    'switch(80002)',
    'dest.getCode(messageTransmitter)',
    'wallet.send(messageTransmitter)=mint',
    'step{approveTxHash=approve burnIntent burnTxHash=burn mintTxHash=mint}',
    'progress(dest_tx_pending:mint)',
    'dest.wait(mint)',
    'merchantMint(mint=mint burn=burn spec=- forward=-)',
  ],
  cctpFeeUnresolved: [
    'progress(burn_probe)',
    'source.receipt(burn)',
    'progress(burn_probe)',
    'progress(fee_burn_unconfirmed)',
    'step{approveTxHash=approve burnIntent burnTxHash=burn feeBurnIntent feeBurnUnresolved=wait/5}',
    'progress(poll_attestation)',
    'fetch.iris(burn)',
    'progress(switch_chain:80002)',
    'switch(80002)',
    'dest.getCode(messageTransmitter)',
    'wallet.send(messageTransmitter)=mint',
    'step{approveTxHash=approve burnIntent burnTxHash=burn feeBurnIntent feeBurnUnresolved=wait/5 mintTxHash=mint}',
    'progress(dest_tx_pending:mint)',
    'dest.wait(mint)',
    'merchantMint(mint=mint burn=burn spec=- forward=-)',
  ],
  forwardFresh: [
    'fetch.fees',
    'source.getCode(tokenMessenger)',
    'progress(approve)',
    'wallet.approve(tokenMessenger,1022683)=approve',
    'source.wait(approve)',
    'commit(merchant,1022683,state=intent scanFrom=100)',
    'step{approveTxHash=approve burnIntent forward(state=intent scanFrom=100)}',
    'wallet.send(tokenMessenger)=burn',
    'step{approveTxHash=approve burnIntent burnTxHash=burn forward(state=broadcast scanFrom=100)}',
    'progress(source_tx_pending:burn)',
    'source.wait(burn)',
    'source.receipt(burn)',
    'step{approveTxHash=approve burnIntent burnTxHash=burn forward(state=source-confirmed scanFrom=100 evidence=burn#3 sourceUnresolved=false)}',
    'progress(forward_pending:burn)',
    'step{approveTxHash=approve burnIntent burnTxHash=burn forward(state=awaiting-forward scanFrom=100 evidence=burn#3 sourceUnresolved=false)}',
    'fetch.irisForward',
    'step{approveTxHash=approve burnIntent burnTxHash=burn forward(state=awaiting-forward scanFrom=100 evidence=burn#3 sourceUnresolved=false)}',
    'step{approveTxHash=approve burnIntent burnTxHash=burn forward(state=awaiting-forward scanFrom=100 nonce evidence=burn#3 sourceUnresolved=false candidate=mint)}',
    'step{approveTxHash=approve burnIntent burnTxHash=burn forward(state=forward-observed scanFrom=100 nonce evidence=burn#3 sourceUnresolved=false candidate=mint)}',
    'dest.receipt(mint)',
    'step{approveTxHash=approve burnIntent burnTxHash=burn forward(state=verified scanFrom=100 nonce evidence=burn#3 sourceUnresolved=false candidate=mint accounting=1002683/20000) mintTxHash=mint}',
    'merchantMint(mint=mint burn=burn spec=- forward=1002683/20000)',
  ],
};

function expectTrace(name: string, trace: string[]): void {
  expect(trace).toEqual(EXPECTED[name]);
}

describe('R12 pin: callback and persistence ordering per protocol', () => {
  it('gateway: fresh merchant + fee', async () => {
    const t = gatewayHarness({ who: A, mints: GW_A, feeAmount: 10_000n });
    await facade.executeGatewayTransfer(t.args);
    expectTrace('gatewayFresh', t.trace);
  });

  it('gateway: resume from a saved legacy attestation', async () => {
    const legacy = { merchantAttestation: gatewayAttestation({ ...gatewaySpec, sourceDepositor: pad(A.account), sourceSigner: pad(A.account),
      destinationRecipient: pad(A.recipient) }, 1_000_000n) };
    const t = gatewayHarness({ who: A, mints: GW_A, resume: legacy });
    await facade.executeGatewayTransfer(t.args);
    expectTrace('gatewayLegacyResume', t.trace);
  });

  it('cctp: fresh merchant + fee', async () => {
    const t = cctpHarness({ who: A, txs: CCTP_A, feeAmount: 10_000n });
    await facade.executeCctpTransfer(t.args);
    expectTrace('cctpFresh', t.trace);
  });

  it('cctp: resume after the merchant burn (probe → poll → mint)', async () => {
    const t = cctpHarness({ who: A, txs: CCTP_A, queueFrom: 3, resume: {
      approveTxHash: tx('A', 'approve'), burnIntent: cctpMarker(A, 1_000_000n), burnTxHash: tx('A', 'burn') } });
    await facade.executeCctpTransfer(t.args);
    expectTrace('cctpResume', t.trace);
  });

  it('cctp: fee slot unresolved does not hold the merchant mint (D3)', async () => {
    const t = cctpHarness({ who: A, txs: CCTP_A, queueFrom: 3, feeAmount: 10_000n, pendingNonce: 2, resume: {
      approveTxHash: tx('A', 'approve'), burnIntent: cctpMarker(A, 1_000_000n), burnTxHash: tx('A', 'burn'),
      feeBurnIntent: { ...cctpMarker(A, 10_000n), mintRecipient: A.feeReceiver } } });
    const result = await facade.executeCctpTransfer(t.args);
    expect(result.feeBurnUnresolved).toMatchObject({ kind: 'wait', row: 5 });
    expectTrace('cctpFeeUnresolved', t.trace);
  });

  it('forward: fresh burn → forward verification', async () => {
    const t = forwardHarness({ who: A, ids: FWD_A });
    await facade.executeCctpTransfer(t.args);
    expectTrace('forwardFresh', t.trace);
  });
});
