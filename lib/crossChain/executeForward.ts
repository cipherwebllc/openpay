// CCTP Forwarding Service (Arc 宛て) 経路の executor (R12 で execute.ts から移動・本文は分割前と
// 同一)。executeCctpTransfer (executeCctp.ts) の入口から呼ばれる。型は executeTypes の leaf だけを
// 参照し、executeCctp を runtime import しない (cctp → forward → cctp の循環を作らない)。

import {
  decodeEventLog,
  erc20Abi,
  pad,
  zeroAddress,
  type Address,
  type Hex,
} from 'viem';
import { isArcCrossChainEnabled } from '../env';
import {
  ARC_USDC_ADDRESS,
  CCTP_FORWARD_HOOK_DATA,
  CCTP_V2_DEPOSIT_FOR_BURN_EVENT,
  CCTP_V2_TOKEN_MESSENGER_ADDRESS,
  acceptForwardQuote,
  computeForwardRequiredFee,
  fetchCctpBurnFees,
  encodeForwardDepositForBurnCalldata,
  findForwardMintByNonce,
  pollIrisForward,
  verifyForwardMint,
  type AcceptedQuote,
} from './cctp';
import { buildBurnMarker } from './burnMarker';
import { CROSS_CHAIN_BURN_AUTORESUME } from './config';
import { assertContractDeployed } from './deploycheck';
import type { CircleDomain } from './types';
import type {
  CctpResumeState,
  ExecuteCctpTransferArgs,
  ExecuteCctpTransferResult,
  ForwardResumeState,
} from './executeTypes';
import {
  CrossChainBurnUnresolvedError,
  CrossChainForwardPendingError,
  CrossChainQuoteExpiredError,
} from './executeErrors';
import { assertBurnResolved, resolveBurnSlot } from './burnRecovery';
import {
  ensureWalletChain,
  fireMerchantMint,
  resolveChainOrThrow,
  waitForReceiptOrThrow,
} from './executeShared';

export function assertForwardQuoteBinding(q: AcceptedQuote, args: {
  sourceChainId: number; destChainId: number; sourceDomain: CircleDomain; destDomain: CircleDomain;
  recipient: Address; valueAtomic: bigint;
}): void {
  // stale/外部生成 option の quote が別請求の送金認可へ波及するのを断つ。
  if (args.valueAtomic <= 0n || !Number.isSafeInteger(q.quotedAt) || !Number.isSafeInteger(q.expiresAt) ||
      q.sourceChainId !== args.sourceChainId || q.destChainId !== args.destChainId ||
      q.sourceDomain !== args.sourceDomain || q.destDomain !== args.destDomain ||
      q.recipient.toLowerCase() !== args.recipient.toLowerCase() || q.valueAtomic !== String(args.valueAtomic) ||
      !/^\d+$/.test(q.maxFeeAtomic) || !/^\d+$/.test(q.forwardFeeAtomic) ||
      !Number.isSafeInteger(q.minimumFeeBpsX1000) || q.minimumFeeBpsX1000 < 0 ||
      BigInt(q.grossAtomic) !== args.valueAtomic + BigInt(q.maxFeeAtomic) ||
      BigInt(q.maxFeeAtomic) !== BigInt(q.forwardFeeAtomic) + (args.valueAtomic * BigInt(q.minimumFeeBpsX1000) + 9_999_999n) / 10_000_000n ||
      q.expiresAt !== q.quotedAt + 300_000) throw new Error('Forward quote binding mismatch');
}

async function executeForwardTransfer(args: ExecuteCctpTransferArgs): Promise<ExecuteCctpTransferResult> {
  let state: CctpResumeState = { ...args.resume };
  let f = state.forward;
  const now = args.now ?? Date.now;
  const progress = args.onProgress ?? (() => {});
  const persist = (patch: Partial<CctpResumeState>, forwardPatch: Partial<ForwardResumeState> = {}) => {
    f = { ...f!, ...forwardPatch };
    state = { ...state, ...patch, forward: f };
    args.onStep?.(state);
  };
  // broadcast 以降の認可は保存済 quote。期限・新規 enablement は回復を遮断しない。
  const saved = f && (f.state !== 'intent' || !!state.burnTxHash || !!f.sourceEvidence);
  let quote = saved ? f!.acceptedQuote : args.forward!.acceptedQuote;
  assertForwardQuoteBinding(quote, args);
  if (!f) {
    if (!isArcCrossChainEnabled()) throw new Error('Arc forwarding disabled');
    if (now() >= quote.expiresAt) throw new CrossChainQuoteExpiredError();
  }
  const unresolved = () => new CrossChainBurnUnresolvedError({ kind: 'wait', slot: 'merchant',
    detail: 'Forward burn evidence unavailable or mismatched', row: 21, reburnable: false,
    sourceChainId: args.sourceChainId, depositor: args.account, burnTxHash: state.burnTxHash });

  if (!f?.sourceEvidence && (!f || f.state === 'intent' || f.state === 'broadcast')) {
    // pre-confirmation は既存決定表を必ず probe。post-confirmation はここへ戻さない。
    const decision = await resolveBurnSlot({ client: args.sourcePublicClient, slot: 'merchant',
      marker: state.burnIntent, hash: state.burnTxHash, depositor: args.account,
      sourceChainId: args.sourceChainId, autoReburnEnabled: args.allowAutoReburn ?? CROSS_CHAIN_BURN_AUTORESUME,
      allowManualReburn: args.allowManualReburn === true, onProgress: progress, now });
    assertBurnResolved(decision, { slot: 'merchant', sourceChainId: args.sourceChainId,
      depositor: args.account, hash: state.burnTxHash }, progress);
    if (decision.action !== 'burn' && f) quote = f.acceptedQuote;
    if (decision.action === 'adopt') persist({ burnTxHash: decision.hash });
    if (decision.action === 'burn') {
      if (!isArcCrossChainEnabled()) throw new Error('Arc forwarding disabled');
      const fee = await fetchCctpBurnFees(args.sourceDomain, args.destDomain, { forward: true, fetch: args.fetch, baseUrl: args.irisBaseUrl });
      if (args.forward!.allowBurn === false || (saved && args.forward!.allowBurn !== true)) {
        throw new CrossChainQuoteExpiredError(acceptForwardQuote({ ...args, valueAtomic: String(args.valueAtomic) }, fee, now()));
      }
      // 既存決定表が未 burn/revert を確定した場合だけ、新しい明示同意を適用する。
      quote = args.forward!.acceptedQuote;
      assertForwardQuoteBinding(quote, args);
      if (now() >= quote.expiresAt || computeForwardRequiredFee(args.valueAtomic, fee) > BigInt(quote.maxFeeAtomic)) throw new CrossChainQuoteExpiredError();
      const scanFromBlock = f?.scanFromBlock ?? String(await args.destPublicClient.getBlockNumber());
      const sourceChain = resolveChainOrThrow(args.sourceChainId, 'source');
      await ensureWalletChain(args.walletClient, args.switchChainAsync, args.sourceChainId);
      await assertContractDeployed(args.sourcePublicClient, CCTP_V2_TOKEN_MESSENGER_ADDRESS, args.sourceChainId);
      progress({ kind: 'approve' });
      const approveTxHash = await args.walletClient.writeContract({ address: args.sourceToken, abi: erc20Abi,
        functionName: 'approve', args: [CCTP_V2_TOKEN_MESSENGER_ADDRESS, BigInt(quote.grossAtomic)],
        account: args.account, chain: sourceChain });
      await waitForReceiptOrThrow(args.sourcePublicClient, approveTxHash, 'forward approve');
      // 何の波及を断つか: 負荷分散 RPC で receipt が見えても nonce/allowance の view が遅れることがある
      // (2026-09-17 Base Sepolia E2E で実測)。遅れた nonce で marker を作ると、burn 未送信なのに
      // 決定表が「nonce 進行・log 無し」(row 8) の manual に倒れる。approve 反映を待ってから marker を作る。
      // allowance が gross 以上に見える = approve 後の state がこのノードに反映済み (nonce も同じ state)。
      for (let i = 0; i < 15; i += 1) {
        const allowance = await args.sourcePublicClient.readContract({ address: args.sourceToken, abi: erc20Abi,
          functionName: 'allowance', args: [args.account, CCTP_V2_TOKEN_MESSENGER_ADDRESS] });
        if (allowance >= BigInt(quote.grossAtomic)) break;
        await new Promise((r) => setTimeout(r, 2000));
      }
      const marker = await buildBurnMarker({ client: args.sourcePublicClient, chainId: args.sourceChainId,
        depositor: args.account, burnToken: args.sourceToken, mintRecipient: args.recipient,
        amount: BigInt(quote.grossAtomic), destinationDomain: args.destDomain, now });
      f = { acceptedQuote: quote, state: 'intent', scanFromBlock };
      // marker + quote は同じ strict write。hash が失われても gross/認可を復元できる。
      args.commitBurnIntent(marker, 'merchant', { forward: f });
      persist({ burnIntent: marker, approveTxHash });
      const burnData = encodeForwardDepositForBurnCalldata({ value: args.valueAtomic,
        maxFee: BigInt(quote.maxFeeAtomic), destinationDomain: args.destDomain, recipient: args.recipient, burnToken: args.sourceToken });
      let burnTxHash: Hex | undefined;
      for (let attempt = 0; burnTxHash === undefined; attempt += 1) {
        try {
          burnTxHash = await args.walletClient.sendTransaction({ account: args.account, chain: sourceChain,
            to: CCTP_V2_TOKEN_MESSENGER_ADDRESS, data: burnData });
        } catch (error) {
          // 何の波及を断つか: ウォレット側ノードの allowance view 遅延で gas 見積が revert する
          // (hash は返らない = 未 broadcast)。allowance 不足の revert だけ有界に再試行し、
          // それ以外 (ユーザ拒否・残高不足等) はそのまま投げる。
          const message = error instanceof Error ? error.message : String(error);
          if (attempt >= 3 || !/allowance/i.test(message)) throw error;
          await new Promise((r) => setTimeout(r, 3000));
        }
      }
      persist({ burnTxHash }, { state: 'broadcast' });
      progress({ kind: 'source_tx_pending', hash: burnTxHash });
      await args.sourcePublicClient.waitForTransactionReceipt({ hash: burnTxHash });
    }
  }
  if (!state.burnTxHash || !state.burnIntent || !f) throw unresolved();
  const marker = state.burnIntent;
  // source-confirmed の証拠は毎回 chain で再確認。reorg/RPC 不通から再 burn は開かない。
  try {
    const receipt = await args.sourcePublicClient.getTransactionReceipt({ hash: state.burnTxHash });
    const matches = receipt.status === 'success' && marker.chainId === args.sourceChainId &&
      (!receipt.from || receipt.from.toLowerCase() === args.account.toLowerCase()) ? receipt.logs.filter((log) => {
      if (log.address.toLowerCase() !== CCTP_V2_TOKEN_MESSENGER_ADDRESS.toLowerCase()) return false;
      try {
        const { args: burn } = decodeEventLog({ abi: [CCTP_V2_DEPOSIT_FOR_BURN_EVENT], ...log });
        return burn.amount === BigInt(marker.amount) && burn.amount === BigInt(quote.grossAtomic) &&
          burn.burnToken.toLowerCase() === marker.burnToken.toLowerCase() && burn.burnToken.toLowerCase() === args.sourceToken.toLowerCase() &&
          burn.depositor.toLowerCase() === args.account.toLowerCase() && burn.depositor.toLowerCase() === marker.depositor.toLowerCase() &&
          burn.mintRecipient.toLowerCase() === pad(args.recipient).toLowerCase() && marker.mintRecipient.toLowerCase() === args.recipient.toLowerCase() &&
          burn.destinationDomain === args.destDomain && marker.destinationDomain === args.destDomain &&
          burn.destinationCaller === pad(zeroAddress) && burn.maxFee === BigInt(quote.maxFeeAtomic) &&
          burn.hookData === CCTP_FORWARD_HOOK_DATA && burn.minFinalityThreshold === 1000;
      } catch {
        // 同 receipt の無関係 log を burn 証拠へ波及させない。
        return false;
      }
    }) : [];
    if (matches.length !== 1) throw unresolved();
    persist({}, { sourceUnresolved: false, sourceEvidence: { txHash: state.burnTxHash, logIndex: matches[0].logIndex,
      blockNumber: String(receipt.blockNumber), blockHash: receipt.blockHash },
    state: f.state === 'intent' || f.state === 'broadcast' ? 'source-confirmed' : f.state });
  } catch {
    // 証拠の消失を未送信扱いにして二重 burn する波及を断つ。state/証拠は保持。
    persist({}, { sourceUnresolved: true });
    throw unresolved();
  }
  const burnHash = state.burnTxHash;
  const complete = (): ExecuteCctpTransferResult => {
    fireMerchantMint(args.onMerchantMint, { burnTxHash: burnHash, mintTxHash: state.mintTxHash!, forward: f!.accounting! });
    return { path: 'cctp-v2', approveTxHash: state.approveTxHash, burnTxHash: burnHash,
      mintTxHash: state.mintTxHash!, destChainId: args.destChainId };
  };
  const verify = async (hash: Hex) => {
    persist({}, { state: 'forward-observed', candidateHash: hash });
    const result = await verifyForwardMint({ destClient: args.destPublicClient, txHash: hash,
      sourceDomain: args.sourceDomain, nonce: f!.nonce!, mintRecipient: args.recipient, mintToken: ARC_USDC_ADDRESS,
      minAmount: args.valueAtomic, burnToken: args.sourceToken, grossAmount: BigInt(quote.grossAtomic),
      maxFee: BigInt(quote.maxFeeAtomic), messageSender: args.account });
    if (!result.ok) { persist({}, { state: 'awaiting-forward', candidateHash: undefined }); return false; }
    persist({ mintTxHash: hash }, { state: 'verified', accounting: { grossAtomic: quote.grossAtomic,
      maxFeeAtomic: quote.maxFeeAtomic, verifiedNetAtomic: String(result.verifiedNetAtomic), feeCollectedAtomic: String(result.feeCollectedAtomic) } });
    return true;
  };
  // verified 後の中断も on-chain を再検証して会計/cleanup を完遂。
  if (f!.state === 'verified' && state.mintTxHash && f!.nonce && await verify(state.mintTxHash)) return complete();
  progress({ kind: 'forward_pending', burnHash });
  persist({}, { state: 'awaiting-forward' });
  const pollNow = args.pollOptions?.now ?? Date.now;
  const start = pollNow();
  const timeout = args.pollOptions?.timeoutMs ?? 180_000;
  const sleep = args.pollOptions?.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  do {
    try {
      const message = await pollIrisForward(args.sourceDomain, burnHash, { fetch: args.fetch, baseUrl: args.irisBaseUrl });
      if (message) persist({}, { forwardState: message.forwardState, delayReason: message.delayReason ?? undefined });
      const nonce = message?.decodedMessage?.nonce ?? message?.eventNonce;
      if (nonce && /^0x[0-9a-fA-F]{64}$/.test(nonce) && (!f!.nonce || f!.nonce.toLowerCase() === nonce.toLowerCase())) {
        // Iris 取得直後に保存し、その後の RPC/HTTP 障害でも nonce 探索を継続可能にする。
        persist({}, { nonce: nonce as Hex, eventNonce: message?.eventNonce,
          forwardState: message?.forwardState, delayReason: message?.delayReason ?? undefined,
          candidateHash: message?.forwardTxHash && /^0x[0-9a-fA-F]{64}$/.test(message.forwardTxHash) ? message.forwardTxHash : f!.candidateHash });
      }
    } catch {
      // Iris 障害を既知 nonce の on-chain 探索へ波及させない。成功判定は下だけ。
    }
    try {
      if (f!.nonce) {
        if (f!.candidateHash && await verify(f!.candidateHash)) return complete();
        const found = await findForwardMintByNonce(args.destPublicClient, { nonce: f!.nonce,
          sourceDomain: args.sourceDomain, fromBlock: BigInt(f!.scanFromBlock) });
        for (const hash of found.hashes) if (await verify(hash)) return complete();
        persist({}, { scanFromBlock: String(found.nextBlock) });
      }
    } catch {
      // RPC 不可用を決済失敗/再 burn に波及させず、候補とカーソルを保持して再確認へ。
    }
    if (pollNow() - start >= timeout) break;
    await sleep(args.pollOptions?.intervalMs ?? 2000);
  } while (pollNow() - start <= timeout);
  persist({}, { state: 'awaiting-forward' });
  throw new CrossChainForwardPendingError(state);
}

// executeCctpTransfer (executeCctp.ts) の入口からだけ呼ぶ (facade からは再 export しない)。
export { executeForwardTransfer };
