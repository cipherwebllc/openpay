// CCTP V2 (self-mint) 経路の executor (R12 で execute.ts から移動・本文は分割前と同一)。
// Arc 宛て (forward-only destination) は入口で executeForward に振り分ける。resume/persist の
// state は実行ごとの local 変数だけに持つ。

import { erc20Abi, type Address, type Hex } from 'viem';
import { logger } from '../logger';
import {
  CCTP_V2_MESSAGE_TRANSMITTER_ADDRESS,
  CCTP_V2_TOKEN_MESSENGER_ADDRESS,
  encodeDepositForBurnCalldata,
  encodeReceiveMessageCalldata,
  pollIrisAttestation,
} from './cctp';
import { buildBurnMarker, type BurnDecision, type BurnSlot } from './burnMarker';
import {
  domainForChainId,
  isForwardOnlyDestination,
  CROSS_CHAIN_BURN_AUTORESUME,
} from './config';
import { assertContractDeployed } from './deploycheck';
import type {
  BurnUnresolvedNote,
  CctpResumeState,
  ExecuteCctpTransferArgs,
  ExecuteCctpTransferResult,
} from './executeTypes';
import { assertBurnResolved, resolveBurnSlot, settleBurn } from './burnRecovery';
import {
  ensureWalletChain,
  fireMerchantMint,
  isFeeReceiverBridgeable,
  resolveChainOrThrow,
  txAlreadySucceeded,
  waitForReceiptOrThrow,
} from './executeShared';
import { executeForwardTransfer } from './executeForward';

// ========== CCTP V2 path ==========

export async function executeCctpTransfer(
  args: ExecuteCctpTransferArgs,
): Promise<ExecuteCctpTransferResult> {
  // 恒久 policy を入口で検証し、lookup 追加が既存 self-mint/fee leg へ波及するのを断つ。
  if (isForwardOnlyDestination(args.destChainId) !== !!args.forward) throw new Error('Forward-only destination requires forwarding');
  if (args.forward) {
    if (args.destDomain !== 26 || domainForChainId(args.sourceChainId) !== args.sourceDomain || isForwardOnlyDestination(args.sourceChainId)) throw new Error('Invalid forwarding domains');
    if ((args.feeAmount ?? 0n) !== 0n) throw new Error('Forwarding does not support a fee leg');
    return executeForwardTransfer(args);
  }
  const onProgress = args.onProgress ?? (() => {});
  const onStep = args.onStep ?? (() => {});
  const feeReceiver = args.feeReceiver;
  const feeAmount = args.feeAmount ?? 0n;
  const bridgeFee = isFeeReceiverBridgeable(feeReceiver, feeAmount);

  let state: CctpResumeState = { ...(args.resume ?? {}) };
  const persist = (patch: Partial<CctpResumeState>) => {
    state = { ...state, ...patch };
    onStep(state);
  };

  // 明示的に Chain object を解決する。args.walletClient.chain は wagmi の
  // useWalletClient closure を経由するため switchChainAsync 後も stale な
  // reference (= UI 起動時の dest chain) のまま、viem の writeContract /
  // sendTransaction が「current chain mismatch」エラーを投げる根本原因。
  // 2026-05-24 incident: Avalanche→OP 経路で approve が dest (OP) chain object で
  // 呼ばれて wallet (Avalanche) と mismatch、payment 全 abort。chainObjectForId で
  // sourceChainId/destChainId から都度解決し、stale closure を回避する。
  const sourceChain = resolveChainOrThrow(args.sourceChainId, 'source');
  const destChain = resolveChainOrThrow(args.destChainId, 'destination');

  // A1: 「burnTxHash が無い = 未 burn」という素朴な判定を廃し、marker + on-chain の事実
  // (receipt / nonce / DepositForBurn log) で slot ごとに分岐を決める。決定表は
  // burnMarker.classifyBurnState (設計 §4)。判定は送金前なので chain switch より先に行い、
  // wait / manual なら wallet popup を一切出さずに止める。
  const allowAutoReburn = args.allowAutoReburn ?? CROSS_CHAIN_BURN_AUTORESUME;
  const allowManualReburn = args.allowManualReburn === true;
  const nowFn = args.now ?? Date.now;
  const resolveSlot = (slot: BurnSlot): Promise<BurnDecision> =>
    resolveBurnSlot({
      client: args.sourcePublicClient,
      slot,
      marker: slot === 'merchant' ? state.burnIntent : state.feeBurnIntent,
      hash: slot === 'merchant' ? state.burnTxHash : state.feeBurnTxHash,
      depositor: args.account,
      sourceChainId: args.sourceChainId,
      autoReburnEnabled: allowAutoReburn,
      allowManualReburn,
      onProgress,
      now: nowFn,
    });

  const merchantDecision = await resolveSlot('merchant');
  assertBurnResolved(
    merchantDecision,
    {
      slot: 'merchant',
      sourceChainId: args.sourceChainId,
      depositor: args.account,
      hash: state.burnTxHash,
    },
    onProgress,
  );
  // D3: fee slot の未確定は **merchant を人質に取らない**。merchant 側が確定している限り、
  // fee が wait / manual でも merchant の attestation + mint はそのまま進める (掟 13: 付帯
  // 処理の障害を本体に波及させない)。fee は自動で再 burn せず、resume state と結果に
  // 「未確定」を記録して UI が二次通知を出す (人間が後で解決する)。
  const feeDecision = bridgeFee ? await resolveSlot('fee') : undefined;
  const feeUnresolved: BurnUnresolvedNote | undefined =
    feeDecision && (feeDecision.action === 'wait' || feeDecision.action === 'manual')
      ? {
          kind: feeDecision.action,
          row: feeDecision.row,
          reason: feeDecision.reason,
          reburnable:
            feeDecision.action === 'manual' ? feeDecision.reburnable : false,
        }
      : undefined;
  if (feeUnresolved) {
    onProgress({ kind: 'fee_burn_unconfirmed' });
    logger.warn('cross-chain.burn.unresolved', {
      kind: feeUnresolved.kind,
      slot: 'fee',
      row: feeUnresolved.row,
      reason: feeUnresolved.reason,
      sourceChainId: args.sourceChainId,
      blocking: false,
    });
    persist({ feeBurnUnresolved: feeUnresolved });
  }

  const needMerchantBurn = merchantDecision.action === 'burn';
  const needFeeBurn = feeDecision?.action === 'burn';
  // adopt は「走査で見つけた成功済 burn hash を採用する」だけなので wallet も chain switch
  // も要らない。approve/burn block の外で先に永続化しておく。
  if (merchantDecision.action === 'adopt') {
    persist({ burnTxHash: merchantDecision.hash });
    onProgress({ kind: 'source_tx_pending', hash: merchantDecision.hash });
  }
  if (feeDecision?.action === 'adopt') {
    persist({ feeBurnTxHash: feeDecision.hash });
    onProgress({ kind: 'fee_source_tx_pending', hash: feeDecision.hash });
  }

  // 1. source chain 上で approve + burn (まだ burn していない分だけ)。
  if (needMerchantBurn || needFeeBurn) {
    onProgress({ kind: 'switch_chain', targetChainId: args.sourceChainId });
    await ensureWalletChain(
      args.walletClient,
      args.switchChainAsync,
      args.sourceChainId,
    );

    // 顧客が実 USDC を approve する送信先 (source chain の CCTP TokenMessenger) が
    // 実 deploy 済かを approve/burn 前に確認する (存在確認のみ・codehash pin しない)。
    await assertContractDeployed(
      args.sourcePublicClient,
      CCTP_V2_TOKEN_MESSENGER_ADDRESS,
      args.sourceChainId,
    );

    // merchant + fee の両 burn を 1 回の approve でカバーする (再開時は残りの burn
    // 用に再 approve、allowance 上書きは無害)。
    onProgress({ kind: 'approve' });
    const approveHash = await args.walletClient.writeContract({
      address: args.sourceToken,
      abi: erc20Abi,
      functionName: 'approve',
      args: [CCTP_V2_TOKEN_MESSENGER_ADDRESS, args.valueAtomic + feeAmount],
      chain: sourceChain,
      account: args.account,
    });
    await waitForReceiptOrThrow(
      args.sourcePublicClient,
      approveHash,
      'cctp approve',
    );
    persist({ approveTxHash: approveHash });

    // 1 件分の depositForBurn を実行する closure。
    const burn = async (recipient: Address, value: bigint): Promise<Hex> => {
      const data = encodeDepositForBurnCalldata({
        value,
        destinationDomain: args.destDomain,
        recipient,
        burnToken: args.sourceToken,
        overrides: args.overrides,
      });
      return args.walletClient.sendTransaction({
        account: args.account,
        chain: sourceChain,
        to: CCTP_V2_TOKEN_MESSENGER_ADDRESS,
        data,
      });
    };

    // burn hash は broadcast 直後 (receipt 待ち前) に永続化する。receipt 待ちの間に
    // tab を閉じる / RPC が落ちると resume state に burn hash が残らず、再開時に
    // 再 burn してしまう = 二重支払いになるため。CCTP の depositForBurn は nonce
    // 単位で独立 (idempotent でない) ので、ここが二重支払いの防御線。
    // A1: hash 永続化の **さらに手前** に marker (送るつもり) を fail-closed で置き、
    // 「broadcast したが hash を書けなかった」窓も塞ぐ。再開時は保存済 hash の
    // attestation を poll して mint へ進む。
    const makeMarker = (recipient: Address, value: bigint) => () =>
      buildBurnMarker({
        client: args.sourcePublicClient,
        chainId: args.sourceChainId,
        depositor: args.account,
        burnToken: args.sourceToken,
        mintRecipient: recipient,
        amount: value,
        destinationDomain: args.destDomain,
        now: nowFn,
      });

    if (needMerchantBurn) {
      await settleBurn({
        client: args.sourcePublicClient,
        buildMarker: makeMarker(args.recipient, args.valueAtomic),
        commit: (marker) => {
          args.commitBurnIntent(marker, 'merchant');
          persist({ burnIntent: marker });
        },
        broadcast: () => burn(args.recipient, args.valueAtomic),
        onBroadcast: (hash) => {
          persist({ burnTxHash: hash });
          onProgress({ kind: 'source_tx_pending', hash });
        },
        label: 'cctp burn',
      });
    }
    if (needFeeBurn) {
      // needFeeBurn → bridgeFee=true → isFeeReceiverBridgeable が feeReceiver!==undefined を保証
      await settleBurn({
        client: args.sourcePublicClient,
        buildMarker: makeMarker(feeReceiver!, feeAmount),
        commit: (marker) => {
          args.commitBurnIntent(marker, 'fee');
          persist({ feeBurnIntent: marker });
        },
        broadcast: () => burn(feeReceiver!, feeAmount),
        onBroadcast: (hash) => {
          persist({ feeBurnTxHash: hash });
          onProgress({ kind: 'fee_source_tx_pending', hash });
        },
        label: 'cctp fee burn',
      });
    }
  }

  const burnHash = state.burnTxHash;
  if (!burnHash) {
    throw new Error(
      'executeCctpTransfer: merchant burn hash missing (resume state 不整合)',
    );
  }

  // 2. attestation を取得して dest で mint。broadcast 済の mint hash があれば landed を
  //    検証し、成功済なら skip (再 mint は message 既消費で revert)。未確定のもののみ
  //    attestation を poll して (再)送信し、broadcast 直後に hash を永続化する
  //    (receipt 待ち中の中断で「landed 済なのに resume で必ず revert」になる stuck 防止)。
  const merchantMintLanded = state.mintTxHash
    ? await txAlreadySucceeded(args.destPublicClient, state.mintTxHash)
    : false;
  // D3: fee slot が未確定の run では fee を「この run の対象外」に倒す (poll も mint も
  // しない)。未確定 = burn したかどうかが判らない状態なので、その hash で Iris を poll すると
  // timeout まで待たされ、merchant の mint が fee に人質を取られる。
  const feeInScope = bridgeFee && feeUnresolved === undefined;
  const feeMintLanded = !feeInScope
    ? true
    : state.feeMintTxHash
      ? await txAlreadySucceeded(args.destPublicClient, state.feeMintTxHash)
      : false;

  let attestationMessage: Hex | undefined;
  let attestationSignature: Hex | undefined;

  // resume で merchant mint が既に landed している場合、この run では再 mint しない
  // (merchantIris は !merchantMintLanded のときだけ取得される)。確定済の merchant 着金を
  // fee mint より前にここで会計ログ発火する (fee mint 失敗でも取りこぼさない・dedup は集計層)。
  if (merchantMintLanded && state.mintTxHash) {
    fireMerchantMint(args.onMerchantMint, {
      mintTxHash: state.mintTxHash,
      burnTxHash: burnHash,
    });
  }

  if (!merchantMintLanded || !feeMintLanded) {
    onProgress({ kind: 'poll_attestation' });
    // burn hash から attestation を再取得 (Iris は永続なので resume でも取得可能)。
    // merchant と fee の poll は Promise.allSettled で並列化する。fee 側は merchant の
    // attestation 可用性に依存しない (逆も同様)。直列だとどちらかが timeout で throw した
    // 際、もう一方の burn 済資金の mint まで巻き添えで放置される (merchant timeout → fee
    // 永久未 mint / fee timeout → merchant 着金まで止まる)。並列化して、取得できた側だけは
    // 確実に mint し、取得できなかった側のエラーは mint 完了後に throw する (landed 分の hash
    // は persist 済なので、次回 resume は失敗側だけを再 poll する)。
    const pollOpts = {
      fetch: args.fetch,
      baseUrl: args.irisBaseUrl,
      intervalMs: args.pollOptions?.intervalMs,
      timeoutMs: args.pollOptions?.timeoutMs,
      sleep: args.pollOptions?.sleep,
      now: args.pollOptions?.now,
    };
    const needMerchantPoll = !merchantMintLanded;
    const needFeePoll = !feeMintLanded && state.feeBurnTxHash !== undefined;

    const merchantPoll = needMerchantPoll
      ? pollIrisAttestation(args.sourceDomain, burnHash, pollOpts)
      : undefined;
    const feePoll = needFeePoll
      ? pollIrisAttestation(args.sourceDomain, state.feeBurnTxHash!, pollOpts)
      : undefined;

    const [merchantSettled, feeSettled] = await Promise.allSettled([
      merchantPoll ?? Promise.resolve(undefined),
      feePoll ?? Promise.resolve(undefined),
    ]);

    let merchantIris: { message: Hex; attestation: Hex } | undefined;
    let feeIris: { message: Hex; attestation: Hex } | undefined;
    // 取得できなかった (rejected) 側のエラー。両方必要だった場合、片方だけ rejected なら
    // 取得できた mint を完了させてから throw する (もう一方の burn 済資金を巻き込まない)。
    let merchantPollError: unknown;
    let feePollError: unknown;

    if (needMerchantPoll) {
      if (merchantSettled.status === 'fulfilled' && merchantSettled.value) {
        merchantIris = {
          message: merchantSettled.value.message as Hex,
          attestation: merchantSettled.value.attestation as Hex,
        };
        attestationMessage = merchantIris.message;
        attestationSignature = merchantIris.attestation;
      } else if (merchantSettled.status === 'rejected') {
        merchantPollError = merchantSettled.reason;
      }
    }
    if (needFeePoll) {
      if (feeSettled.status === 'fulfilled' && feeSettled.value) {
        feeIris = {
          message: feeSettled.value.message as Hex,
          attestation: feeSettled.value.attestation as Hex,
        };
      } else if (feeSettled.status === 'rejected') {
        feePollError = feeSettled.reason;
      }
    }

    // 必要だった poll が両方 reject → どちらの attestation も使えないので chain switch せず
    // 即時 throw する (merchant 側のエラーを優先して伝播)。
    const merchantFailed = needMerchantPoll && merchantIris === undefined;
    const feeFailed = needFeePoll && feeIris === undefined;
    if (merchantFailed && feeFailed) {
      throw merchantPollError ?? feePollError;
    }

    onProgress({ kind: 'switch_chain', targetChainId: args.destChainId });
    await ensureWalletChain(
      args.walletClient,
      args.switchChainAsync,
      args.destChainId,
    );
    // receiveMessage (mint) 送信先 (dest chain の CCTP MessageTransmitter) が実 deploy
    // 済かを送信前に確認する。
    await assertContractDeployed(
      args.destPublicClient,
      CCTP_V2_MESSAGE_TRANSMITTER_ADDRESS,
      args.destChainId,
    );

    if (merchantIris) {
      const mintData = encodeReceiveMessageCalldata(
        merchantIris.message,
        merchantIris.attestation,
      );
      const mintHash = await args.walletClient.sendTransaction({
        account: args.account,
        chain: destChain,
        to: CCTP_V2_MESSAGE_TRANSMITTER_ADDRESS,
        data: mintData,
      });
      persist({ mintTxHash: mintHash });
      onProgress({ kind: 'dest_tx_pending', hash: mintHash });
      await waitForReceiptOrThrow(args.destPublicClient, mintHash, 'cctp mint');
      // fresh merchant mint 確定 → 会計ログ発火 (下の fee mint より前)。
      fireMerchantMint(args.onMerchantMint, {
        mintTxHash: mintHash,
        burnTxHash: burnHash,
      });
    }
    if (feeIris) {
      const feeMintData = encodeReceiveMessageCalldata(
        feeIris.message,
        feeIris.attestation,
      );
      const feeMintHash = await args.walletClient.sendTransaction({
        account: args.account,
        chain: destChain,
        to: CCTP_V2_MESSAGE_TRANSMITTER_ADDRESS,
        data: feeMintData,
      });
      persist({ feeMintTxHash: feeMintHash });
      onProgress({ kind: 'fee_dest_tx_pending', hash: feeMintHash });
      await waitForReceiptOrThrow(
        args.destPublicClient,
        feeMintHash,
        'cctp fee mint',
      );
    }

    // 片方だけ取得できたケース: 取得できた mint を完了させた後で、取得できなかった側の
    // エラーを throw する。landed 分の hash は persist 済なので、次回 resume は失敗側だけを
    // 再 poll する。末尾の整合性チェック (approve/mint 未完了) より前に throw することで、
    // merchant poll 失敗時に「内部不整合」へ化けさせない。
    if (merchantFailed) throw merchantPollError;
    if (feeFailed) throw feePollError;
  }

  if (!state.approveTxHash || !state.mintTxHash) {
    throw new Error('executeCctpTransfer: approve / mint 未完了 (内部不整合)');
  }

  return {
    path: 'cctp-v2',
    approveTxHash: state.approveTxHash,
    burnTxHash: burnHash,
    attestationMessage,
    attestationSignature,
    mintTxHash: state.mintTxHash,
    feeBurnTxHash: state.feeBurnTxHash,
    feeMintTxHash: state.feeMintTxHash,
    feeBurnUnresolved: feeUnresolved,
    destChainId: args.destChainId,
  };
}
