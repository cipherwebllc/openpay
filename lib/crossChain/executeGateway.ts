// Circle Gateway 経路の executor (R12 で execute.ts から移動・本文は分割前と同一)。
// 再開は finalized の消費/期限証拠で判定し、通常再開は再署名しない (X12)。resume/persist の
// state は実行ごとの local 変数だけに持つ。

import {
  keccak256,
  pad,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { env } from '../env';
import {
  CROSS_CHAIN_DISABLED,
  GATEWAY_MINTER_ADDRESS,
  GATEWAY_WALLET_ADDRESS,
} from './config';
import { assertContractDeployed } from './deploycheck';
import {
  buildBurnIntent,
  encodeGatewayMintCalldata,
  getBurnIntentTypedData,
  requestAttestation,
  GatewayTransferRejectedError,
  readGatewayBurnIntentContext,
  estimateGatewayMaxFee,
  type BuildBurnIntentOverrides,
} from './gateway';
import { readGatewayUnifiedBalance } from './balance';
import { decodeGatewayAttestation, encodeGatewayTransferSpec, validateGatewayAttestation } from './gatewayAttestation';
import {
  activeGatewayAttempt,
  cloneGatewayState,
  gatewayHasOutstanding,
  gatewayUsedAtLatest,
  readGatewaySnapshot,
  GatewayRecoveryError,
  reconcileGatewayAttempt,
  recoverGatewayMintHash,
  type GatewayAttempt,
  type GatewayReplacement,
  type GatewayRequestGuard,
  type GatewayResumeState,
} from './gatewayRecovery';
import type {
  TransferSpec,
  CircleDomain,
  FetchLike,
  SignedBurnIntentRequest,
} from './types';
import type { OnMerchantMint, ProgressCallback, SwitchChainFn } from './executeTypes';
import {
  ensureWalletChain,
  fireMerchantMint,
  isFeeReceiverBridgeable,
  resolveChainOrThrow,
} from './executeShared';

// ========== Gateway path ==========

export interface ExecuteGatewayTransferArgs {
  walletClient: WalletClient;
  sourcePublicClient: PublicClient;
  destPublicClient: PublicClient;
  switchChainAsync: SwitchChainFn;
  account: Address;
  sourceChainId: number;
  destChainId: number;
  sourceDomain: CircleDomain;
  destDomain: CircleDomain;
  sourceToken: Address;
  destToken: Address;
  recipient: Address;
  /** merchant 宛にブリッジする額 (= amount - feeAmount)。 */
  valueAtomic: bigint;
  /** OpenPay 利用料の送り先 (operator)。指定 + feeAmount>0 で fee ブリッジ実行。 */
  feeReceiver?: Address;
  /** OpenPay 利用料 (atomic)。dest チェーンで feeReceiver に mint される。 */
  feeAmount?: bigint;
  /** 中断からの再開用 state。完了済 step を skip する。 */
  resume?: GatewayResumeState;
  /** Explicit user consent bound to the resolved leg identity; never inferred from resume. */
  replacement?: GatewayReplacement;
  /** Other source attempts are unresolved: reconcile without broadcasting this merchant again. */
  recheckOnly?: boolean;
  /** A new Pay click may retry an authorization that was definitively never submitted. */
  newPayment?: boolean;
  /** step 完了ごとに最新の resume state を report (永続化用)。 */
  onStep?: (state: GatewayResumeState, beforeSigning?: GatewayResumeState, beforeRequest?: GatewayRequestGuard) => void;
  overrides?: BuildBurnIntentOverrides;
  fetch?: FetchLike;
  attestationBaseUrl?: string;
  onProgress?: ProgressCallback;
  /** merchant mint 確定時に発火 (fee mint より前)。会計ログ用。詳細は OnMerchantMint。 */
  onMerchantMint?: OnMerchantMint;
}

export type ExecuteGatewayTransferResult = {
  path: 'gateway';
  signature?: Hex;
  attestation: Hex;
  attestationSignature: Hex;
  transferSpecHash: Hex;
  feeMintTxHash?: Hex;
  feeUnresolved?: boolean;
  destChainId: number;
} & ({ settlement: 'transaction'; mintTxHash: Hex } | { settlement: 'hashless'; mintTxHash?: undefined });

export function assertGatewayTransferEnabled(resume?: GatewayResumeState): void {
  // Rollout OFF must not hide existing attestations or unresolved transfer requests.
  if ((!env.enableGatewayCrossChain || CROSS_CHAIN_DISABLED) && !resume?.merchantAttestation && !resume?.merchant) {
    throw new Error('Gateway cross-chain is disabled');
  }
}

export async function executeGatewayTransfer(args: ExecuteGatewayTransferArgs): Promise<ExecuteGatewayTransferResult> {
  assertGatewayTransferEnabled(args.resume);
  if (args.resume?.completion) throw new GatewayRecoveryError(args.resume);
  const onProgress = args.onProgress ?? (() => {});
  const feeAmount = args.feeAmount ?? 0n;
  const bridgeFee = isFeeReceiverBridgeable(args.feeReceiver, feeAmount);
  const state: GatewayResumeState = cloneGatewayState(args.resume ?? {});
  let merchantSignature: Hex | undefined;
  const persist = (beforeSigning?: GatewayResumeState, beforeRequest?: GatewayRequestGuard) => {
    // An authorization without durable identity can become a second payment after reload.
    if (!args.onStep) throw new Error('Gateway requires durable attempt storage');
    args.onStep(cloneGatewayState(state), beforeSigning, beforeRequest);
  };
  const phases = ['merchant', ...(bridgeFee || state.fee || state.feeAttestation ? ['fee' as const] : [])] as const;
  const expectedSpec = (phase: 'merchant' | 'fee', salt: Hex): TransferSpec => ({
    version: 1, sourceDomain: args.sourceDomain, destinationDomain: args.destDomain,
    sourceContract: pad(GATEWAY_WALLET_ADDRESS), destinationContract: pad(GATEWAY_MINTER_ADDRESS),
    sourceToken: pad(args.sourceToken), destinationToken: pad(args.destToken),
    sourceDepositor: pad(args.account), sourceSigner: pad(args.overrides?.sourceSigner ?? args.account),
    destinationRecipient: pad(phase === 'merchant' ? args.recipient : args.feeReceiver!),
    destinationCaller: args.overrides?.destinationCaller ?? pad(zeroAddress),
    value: phase === 'merchant' ? args.valueAtomic : feeAmount, salt, hookData: '0x',
  });
  const observe = async (attempt: GatewayAttempt) => {
    const proof = await reconcileGatewayAttempt(args.destPublicClient, args.destChainId, attempt);
    attempt.observations.push(proof);
    attempt.status = proof.status;
    if (proof.status === 'paid') {
      const hash = await recoverGatewayMintHash(args.destPublicClient, attempt, proof, args.destChainId);
      if (hash) attempt.settledTxHash = hash;
    }
    persist();
  };
  // Legacy fields are retained verbatim. Only byte-derived metadata can be reconstructed.
  for (const phase of phases) {
    const legacy = phase === 'merchant' ? state.merchantAttestation : state.feeAttestation;
    // A tracked authorization without the pre-request marker never reached the transfer API.
    // Older unsigned records are safe too: signature persistence has always preceded HTTP.
    // A signed old record lacks requestTracked, so its missing marker is not proof of an unsent request.
    for (const saved of state[phase]?.attempts ?? []) {
      if (!saved.attestation && saved.intent && (!saved.intent.signature || saved.intent.requestTracked) &&
          saved.intent.requestSentAt === undefined && saved.status === 'unknown') {
        saved.status = saved.intent.signature ? 'abandoned-unsent' : 'abandoned-unsigned';
        persist();
      }
    }
    let attempt = activeGatewayAttempt(state[phase]);
    try {
      if (!attempt && legacy) {
        const decoded = decodeGatewayAttestation(legacy.attestation);
        const validated = validateGatewayAttestation(legacy, expectedSpec(phase, decoded.spec.salt));
        const hash = phase === 'merchant' ? state.mintTxHash : state.feeMintTxHash;
        attempt = { transferSpecHash: validated.transferSpecHash, spec: { ...validated.spec, value: String(validated.spec.value) },
          attestation: legacy, maxBlockHeight: String(validated.maxBlockHeight), txHashes: hash ? [hash] : [], observations: [], status: 'unknown' };
        state[phase] = { attempts: [attempt] };
      }
      if (attempt) {
        const expected = expectedSpec(phase, attempt.spec.salt);
        if (keccak256(encodeGatewayTransferSpec(expected)) !== attempt.transferSpecHash ||
            keccak256(encodeGatewayTransferSpec({ ...attempt.spec, value: BigInt(attempt.spec.value) })) !== attempt.transferSpecHash) {
          throw new Error('Gateway saved identity mismatch');
        }
        if (attempt.attestation) {
          const decoded = validateGatewayAttestation(attempt.attestation, expected, attempt.transferSpecHash);
          attempt.maxBlockHeight = String(decoded.maxBlockHeight);
        }
        await observe(attempt);
      }
    } catch (error) {
      // Corrupt/unsupported saved bytes stay available for recovery; never fall through to signing.
      if (attempt) { attempt.status = 'unknown'; attempt.observations.push({ status: 'unknown', detail: String(error) }); }
      persist();
      if (phase === 'merchant') throw new GatewayRecoveryError(state);
    }
  }

  const fundingGate = async () => {
    const outstanding = phases.map((p) => activeGatewayAttempt(state[p])).filter((a): a is GatewayAttempt => !!a && a.status !== 'paid');
    if (state.feeAttestation && !state.fee) return false;
    if (!outstanding.length || outstanding.some((a) => a.status !== 'expired-unused')) return false;
    // Surplus funds cannot prove non-payment: only query AFTER every outstanding leg's final proof.
    const required = outstanding.reduce((n, a) => n + BigInt(a.spec.value) +
      (BigInt(a.intent?.maxFee ?? '0') > estimateGatewayMaxFee(BigInt(a.spec.value), args.overrides)
        ? BigInt(a.intent!.maxFee) : estimateGatewayMaxFee(BigInt(a.spec.value), args.overrides)), 0n);
    const balance = await readGatewayUnifiedBalance(args.account, [args.sourceDomain], { fetch: args.fetch, baseUrl: args.attestationBaseUrl });
    const funded = balance.status === 'ok' && balance.perDomain.size === 1 &&
      (balance.perDomain.get(args.sourceDomain) ?? -1n) >= required;
    const funding = { sourceDomain: args.sourceDomain, depositor: args.account, token: 'USDC' as const,
      requiredAtomic: String(required), availableAtomic: balance.status === 'ok' ? balance.perDomain.get(args.sourceDomain)?.toString() : undefined,
      observedAt: Date.now() };
    for (const a of outstanding) {
      a.status = funded ? 'replaceable' : 'awaiting-balance';
      a.observations.push({ status: a.status, funding });
    }
    persist();
    return funded;
  };
  await fundingGate();
  const fresh = !gatewayHasOutstanding(state) && (!args.resume || Object.keys(args.resume).length === 0 || args.newPayment === true);
  if (args.recheckOnly && fresh) throw new GatewayRecoveryError(state);
  const replacements = phases.filter((p) => args.replacement?.[p] !== undefined);
  const authorizeFee = args.replacement?.authorizeFee;
  if (authorizeFee && (replacements.length || !bridgeFee || activeGatewayAttempt(state.merchant)?.status !== 'mintable' ||
      authorizeFee !== activeGatewayAttempt(state.merchant)?.transferSpecHash || activeGatewayAttempt(state.fee) || state.feeAttestation)) throw new GatewayRecoveryError(state);
  if (args.recheckOnly && (replacements.length || authorizeFee)) throw new GatewayRecoveryError(state);
  if (replacements.length > 1) throw new GatewayRecoveryError(state);
  if (replacements.length) {
    if (!env.enableGatewayCrossChain || CROSS_CHAIN_DISABLED) throw new Error('Gateway cross-chain is disabled');
    for (const phase of replacements) {
      const attempt = activeGatewayAttempt(state[phase]);
      if (phase === 'fee' && activeGatewayAttempt(state.merchant)?.status !== 'paid') throw new GatewayRecoveryError(state);
      if (!attempt || args.replacement?.[phase] !== attempt.transferSpecHash || attempt.status !== 'replaceable') throw new GatewayRecoveryError(state);
    }
  }

  const signAndAttest = async (phase: 'merchant' | 'fee') => {
    if (args.recheckOnly || !env.enableGatewayCrossChain || CROSS_CHAIN_DISABLED) throw new GatewayRecoveryError(state);
    onProgress({ kind: 'switch_chain', targetChainId: args.sourceChainId });
    await ensureWalletChain(args.walletClient, args.switchChainAsync, args.sourceChainId);
    await assertContractDeployed(args.sourcePublicClient, GATEWAY_WALLET_ADDRESS, args.sourceChainId);
    const context = await readGatewayBurnIntentContext(args.sourcePublicClient, args.sourceChainId);
    if (!fresh) {
      // Repeat finality, binding and all-leg funding checks immediately before replacement signing.
      for (const p of phases) { const a = activeGatewayAttempt(state[p]); if (a) await observe(a); }
      await fundingGate();
      const prior = activeGatewayAttempt(state[phase]);
      if (phase === 'fee' && authorizeFee) {
        if (activeGatewayAttempt(state.merchant)?.status !== 'mintable' ||
            activeGatewayAttempt(state.merchant)?.transferSpecHash !== authorizeFee || prior || state.feeAttestation) throw new GatewayRecoveryError(state);
      } else if (!prior || prior.status !== 'replaceable' || args.replacement?.[phase] !== prior.transferSpecHash) throw new GatewayRecoveryError(state);
    }
    const intent = buildBurnIntent({ sourceDomain: args.sourceDomain, destinationDomain: args.destDomain,
      sourceToken: args.sourceToken, destinationToken: args.destToken, depositor: args.account,
      recipient: phase === 'merchant' ? args.recipient : args.feeReceiver!, value: phase === 'merchant' ? args.valueAtomic : feeAmount,
      ...context, overrides: args.overrides });
    const attempt: GatewayAttempt = { transferSpecHash: keccak256(encodeGatewayTransferSpec(intent.spec)),
      spec: { ...intent.spec, value: String(intent.spec.value) }, intent: { maxBlockHeight: String(intent.maxBlockHeight), maxFee: String(intent.maxFee), requestTracked: true },
      txHashes: [], observations: [], status: 'unknown' };
    if (state[phase]?.attempts.some((a) => a.transferSpecHash === attempt.transferSpecHash)) throw new GatewayRecoveryError(state);
    const beforeSigning = cloneGatewayState(state);
    state[phase] = { attempts: [...(state[phase]?.attempts ?? []), attempt] };
    persist(beforeSigning); // compare/merge and save spec/salt BEFORE signing and BEFORE the transfer HTTP request.
    onProgress({ kind: phase === 'fee' ? 'fee_sign' : 'sign' });
    const typed = getBurnIntentTypedData(intent);
    let signature: Hex;
    try {
      signature = await args.walletClient.signTypedData({ account: args.account, ...typed });
    } catch (error) {
      // A declined wallet signature cannot settle; keep history without locking future Pay clicks.
      attempt.status = 'abandoned-unsigned';
      persist();
      throw error;
    }
    attempt.intent!.signature = signature;
    persist();
    if (phase === 'merchant') merchantSignature = signature;
    onProgress({ kind: phase === 'fee' ? 'fee_attest' : 'attest' });
    const signed: SignedBurnIntentRequest = { burnIntent: intent, signature };
    try {
      // The attestation cannot predate this finalized block; retain a safe lower bound for optional receipt lookup.
      attempt.receiptScanFrom = String((await readGatewaySnapshot(args.destPublicClient, args.destChainId, 'finalized')).number);
    } catch {
      // Optional lookup metadata failure must not discard a signed attempt or authorize a retry.
    }
    const guard = { phase, transferSpecHash: attempt.transferSpecHash };
    persist(undefined, guard); // Re-read stored status before setting the pre-request marker.
    attempt.intent!.requestSentAt = Date.now();
    persist(undefined, guard); // Persist before HTTP: a lost response must remain an outstanding request.
    let attestation;
    try {
      attestation = await requestAttestation(signed, { fetch: args.fetch, baseUrl: args.attestationBaseUrl });
    } catch (error) {
      // Definitive API rejection cannot mint; network/ambiguous failures retain the lock and identity.
      if (error instanceof GatewayTransferRejectedError && error.definitive) {
        attempt.status = 'rejected-request';
        persist();
      }
      throw error;
    }
    attempt.attestation = attestation;
    attempt.obtainedAt = Date.now();
    // Keep the raw response even when validation fails (including unsupported AttestationSet).
    if (phase === 'merchant' && !state.merchantAttestation) state.merchantAttestation = attestation;
    if (phase === 'fee' && !state.feeAttestation) state.feeAttestation = attestation;
    persist();
    const decoded = validateGatewayAttestation(attestation, intent.spec, attempt.transferSpecHash);
    attempt.maxBlockHeight = String(decoded.maxBlockHeight);
    persist();
    await observe(attempt);
  };
  for (const phase of phases) {
    if (fresh || replacements.includes(phase) || (phase === 'fee' && authorizeFee)) await signAndAttest(phase);
  }

  const settle = async (phase: 'merchant' | 'fee') => {
    const attempt = activeGatewayAttempt(state[phase]);
    if (!attempt || !attempt.attestation) return;
    if (args.recheckOnly || attempt.status !== 'mintable') return;
    onProgress({ kind: 'switch_chain', targetChainId: args.destChainId });
    await ensureWalletChain(args.walletClient, args.switchChainAsync, args.destChainId);
    await assertContractDeployed(args.destPublicClient, GATEWAY_MINTER_ADDRESS, args.destChainId);
    try {
      const hash = await args.walletClient.sendTransaction({ account: args.account, chain: resolveChainOrThrow(args.destChainId, 'destination'),
        to: GATEWAY_MINTER_ADDRESS, data: encodeGatewayMintCalldata(attempt.attestation.attestation, attempt.attestation.signature) });
      attempt.txHashes.push(hash);
      persist();
      onProgress({ kind: phase === 'fee' ? 'fee_dest_tx_pending' : 'dest_tx_pending', hash });
      const receipt = await args.destPublicClient.waitForTransactionReceipt({ hash });
      if (receipt.status === 'success' && await gatewayUsedAtLatest(args.destPublicClient, args.destChainId, attempt.transferSpecHash)) {
        attempt.status = 'confirming';
        attempt.settledTxHash = hash;
        persist();
        return;
      }
    } catch {
      // Expiry, replay, generic revert and transport ambiguity all require the same on-chain proof.
      // No receipt/revert is evidence of unused expiry, and no local hash is promoted to success here.
    }
    await observe(attempt);
  };
  // Preserve needFeeAtt ordering: a never-authorized fee cannot be silently waived by ordinary recovery.
  if (bridgeFee && activeGatewayAttempt(state.merchant)?.status === 'mintable' && !activeGatewayAttempt(state.fee)?.attestation) throw new GatewayRecoveryError(state);
  await settle('merchant');
  const merchant = activeGatewayAttempt(state.merchant);
  if (!merchant || !['paid', 'confirming'].includes(merchant.status) || !merchant.attestation) throw new GatewayRecoveryError(state);
  fireMerchantMint(args.onMerchantMint, { mintTxHash: merchant.settledTxHash, transferSpecHash: merchant.transferSpecHash });
  if (bridgeFee) await settle('fee');
  await fundingGate();
  const fee = activeGatewayAttempt(state.fee);
  state.feeUnresolved = (bridgeFee || !!state.fee || !!state.feeAttestation) && (!fee || !['paid', 'confirming'].includes(fee.status));
  state.completion = merchant.status === 'paid' && fee?.status !== 'confirming' ? 'settled' : 'confirming';
  persist();
  return { path: 'gateway', signature: merchantSignature, attestation: merchant.attestation.attestation,
    attestationSignature: merchant.attestation.signature, transferSpecHash: merchant.transferSpecHash,
    ...(merchant.settledTxHash ? { settlement: 'transaction', mintTxHash: merchant.settledTxHash } as const : { settlement: 'hashless' } as const),
    feeMintTxHash: fee?.settledTxHash, feeUnresolved: state.feeUnresolved, destChainId: args.destChainId };
}
