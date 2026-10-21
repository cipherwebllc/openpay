'use client';

// 「Arc の売上を受け取る」ページの状態 (plans/arc-gateway-payout.md)。
// 読むもの: 接続中のアドレスの Arc の Gateway 残高・Circle の手数料・コントラクトかどうか・ガス代用の Arc の USDC。
// 引き出し: lib/crossChain/arcPayout.ts の requestArcPayout (署名 → attestation) → completeArcPayout (受け取りの取引)。
//
// 二重に引き出さない・別のアドレスの結果を混ぜないための決まり:
//   - 進み具合は引き出し元のアドレスごとに持つ (表示中のアカウントを切り替えても、元のアドレスの記録は消えない)。
//   - 押した瞬間に (描画を待たず) ref でアドレスごとに二度押しを止める。
//   - Circle の応答が分からない (時間切れ・5xx・照合の不一致) ときは、そのアドレスで 10 分間は新しい署名で引き出し直させない。
//     受け付けられていた場合も、10 分で失効して残高に戻る。
//   - attestation (10 分有効) は画面の state にだけ持つ。受け取りの取引は、失効までは同じ attestation で続きを送れる。
//     送った取引の hash は送った直後に残し、結果が分からなければ送り直さずに確かめ直す (受け取りの成否は
//     GatewayMinter の記録で決める)。続きを送れるのは引き出し元のアカウントだけ。
//     再読み込みで失われても、未使用の attestation は失効後に残高へ戻る (資金は失われない)。
//   - 署名・attestation は console にも Sentry にも出さない。

import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BaseError, InsufficientFundsError, type Address, type Hex, type PublicClient } from 'viem';
import { useAccount, usePublicClient, useSwitchChain, useWalletClient } from 'wagmi';
import { isNonDelegatedContractCode } from '@/lib/accountCode';
import { chainForSlug } from '@/lib/chains';
import {
  ArcPayoutError,
  arcPayoutChain,
  completeArcPayout,
  fetchArcPayoutFee,
  readArcMintGasShortfall,
  readArcPayoutBalance,
  requestArcPayout,
  type ArcPayoutAttestation,
  type ArcPayoutBalance,
  type ArcPayoutErrorCode,
  type ArcPayoutStep,
} from '@/lib/crossChain/arcPayout';
import { GatewayTransferRejectedError } from '@/lib/crossChain/gateway';
import { isUserRejection } from '@/lib/walletErrors';

/** Circle の応答が分からないときに引き出し直しを止める時間 (attestation の有効期間 10 分)。 */
export const ARC_PAYOUT_UNKNOWN_COOLDOWN_MS = 10 * 60 * 1000;

export type ArcPayoutStatus = {
  /** Arc か Base でコードを持つ (7702 の委任は除く) = コントラクトウォレット。 */
  contract: boolean;
  balance: ArcPayoutBalance;
  /** 手数料 (atomic)。残高が 0 なら見積もらない (null)。見積もりに失敗したら 'error'。 */
  fee: bigint | null | 'error';
  /** ガス代用の Arc の USDC (native・18 桁)。 */
  gas: bigint;
};

export type ArcPayoutFailure =
  | { code: 'rejected' }
  /** 受け取りの取引をガス代 (ウォレットの Arc の USDC) の不足で送れなかった。額は読めたときだけ。 */
  | { code: 'insufficient_gas'; balance?: bigint; shortfall?: bigint }
  | { code: 'circle_rejected'; status: number }
  | { code: 'circle_unknown' }
  | { code: 'account_changed' }
  | { code: ArcPayoutErrorCode | 'failed' };

export type ArcPayoutFlow =
  | { phase: 'idle' }
  | { phase: ArcPayoutStep }
  | { phase: 'done'; value: bigint; txHash: Hex | null }
  // pending があれば、失効までは受け取りの取引の続きを送れる (txHash があれば、まず確かめ直す)。
  // retryAfter までは新しい署名で引き出し直させない。
  | { phase: 'failed'; failure: ArcPayoutFailure; pending?: ArcPayoutAttestation; retryAfter?: number };

/** step = 失敗したときに進んでいた段階。依頼の途中で通信が切れたら、受け付けられた可能性がある。 */
/** viem がノードの「残高不足」(gas × 手数料 + value) と分類したエラーか。 */
function isInsufficientFunds(err: unknown): boolean {
  return err instanceof BaseError && err.walk((e) => e instanceof InsufficientFundsError) !== null;
}

/**
 * 受け取りの取引を送れなかったのがガス代の不足のせいか (表示のための診断・投げない)。不足の額が分かれば額つき、
 * 額は分からないが見積もりか送信のエラーがノードの残高不足なら額なし、それ以外 (足りている・読めない) は null。
 */
async function gasShortfallFailure(
  client: PublicClient,
  pending: ArcPayoutAttestation,
  sendError: unknown,
): Promise<ArcPayoutFailure | null> {
  try {
    const { balance, shortfall } = await readArcMintGasShortfall(client, pending);
    return shortfall > 0n ? { code: 'insufficient_gas', balance, shortfall } : null;
  } catch (readError) {
    return isInsufficientFunds(readError) || isInsufficientFunds(sendError) ? { code: 'insufficient_gas' } : null;
  }
}

export function arcPayoutFailureOf(err: unknown, step: ArcPayoutStep | undefined): ArcPayoutFailure {
  if (err instanceof ArcPayoutError) return { code: err.code };
  if (err instanceof GatewayTransferRejectedError) {
    // 拒否が確定した応答だけ「受け付けなかった」と言う。時間切れ・5xx は受け付けられた可能性がある。
    return err.definitive ? { code: 'circle_rejected', status: err.status } : { code: 'circle_unknown' };
  }
  if (isUserRejection(err)) return { code: 'rejected' };
  // 依頼中の通信の失敗・attestation の照合の不一致は、Circle が残高を引き当てた可能性がある。
  if (step === 'requesting') return { code: 'circle_unknown' };
  return { code: 'failed' };
}

const IDLE: ArcPayoutFlow = { phase: 'idle' };

export function useArcPayout() {
  const { address } = useAccount();
  const arc = arcPayoutChain();
  const base = chainForSlug('base');
  const arcClient = usePublicClient({ chainId: arc.id });
  const baseClient = usePublicClient({ chainId: base.id });
  const { data: walletClient } = useWalletClient();
  const { switchChainAsync } = useSwitchChain();
  const queryClient = useQueryClient();

  const status = useQuery({
    queryKey: ['arcPayout', address],
    enabled: !!address && !!arcClient && !!baseClient,
    queryFn: async (): Promise<ArcPayoutStatus> => {
      const owner = address as Address;
      const [arcCode, baseCode, balance, gas] = await Promise.all([
        arcClient!.getCode({ address: owner }),
        baseClient!.getCode({ address: owner }),
        readArcPayoutBalance(owner),
        arcClient!.getBalance({ address: owner }),
      ]);
      let fee: ArcPayoutStatus['fee'] = null;
      if (balance.status === 'ok' && balance.available > 0n) {
        // 見積もりの失敗は「手数料を出せない」に閉じる (残高の表示まで巻き込まない)。
        fee = await fetchArcPayoutFee(owner, balance.available).catch(() => 'error' as const);
      }
      return {
        contract: isNonDelegatedContractCode(arcCode) || isNonDelegatedContractCode(baseCode),
        balance,
        fee,
        gas,
      };
    },
  });

  // 引き出し元のアドレス → 進み具合。表示中のアカウントを切り替えても消さない。
  const [flows, setFlows] = useState<Readonly<Record<string, ArcPayoutFlow>>>({});
  // クリックの時点の値を読むための写し。書き換えと同時に更新する (描画の後の effect で写すと、描画と effect の
  // 間のクリックが古い値を読み、続きの送信や 10 分の制限を見落とす)。
  const flowsRef = useRef(flows);
  const inflight = useRef(new Set<string>());
  const current = useRef<Address | undefined>(address);
  useEffect(() => {
    current.current = address;
  }, [address]);

  const setFlowFor = useCallback((who: Address, flow: ArcPayoutFlow) => {
    flowsRef.current = { ...flowsRef.current, [who]: flow };
    setFlows(flowsRef.current);
  }, []);
  const refresh = useCallback(
    (who: Address) => void queryClient.invalidateQueries({ queryKey: ['arcPayout', who] }),
    [queryClient],
  );

  const finish = useCallback(async (from: Address, pending: ArcPayoutAttestation) => {
    if (!walletClient || !arcClient) return;
    let latest = pending;
    try {
      const txHash = await completeArcPayout(pending, {
        walletClient,
        publicClient: arcClient,
        switchChainAsync,
        onStep: (phase) => setFlowFor(from, { phase }),
        onBroadcast: (hash) => { latest = { ...pending, txHash: hash }; },
      });
      setFlowFor(from, { phase: 'done', value: pending.value, txHash });
    } catch (err) {
      const failure = arcPayoutFailureOf(err, undefined);
      // 失効したら続きは無い (残高に戻るのを待つ)。受け取りにならなかったと確かめた取引は忘れて送り直せるようにする。
      // それ以外 (結果が分からない・ウォレットで断った・読み取りの失敗) は送った取引の hash ごと残し、まず確かめ直す。
      const next = failure.code === 'attestation_expired'
        ? undefined
        : failure.code === 'mint_not_completed' ? { ...latest, txHash: undefined } : latest;
      const failed: ArcPayoutFlow = { phase: 'failed', failure, ...(next ? { pending: next } : {}) };
      setFlowFor(from, failed);
      // 受け取りの取引を送れなかった (まだ送っていない) ときだけ、ガス代の不足が原因かを後から確かめて表示に足す。
      // ウォレットによっては残高不足だと確認画面で送れず「取り消し」で返るので、エラーの種類だけでは決めない。
      // 表示だけの分類で、続きの送り方 (next) は変えない。失敗の表示と送り直しを先に確定し、診断を待たせない
      // (診断の読み取りが止まっても、10 分の送り直しの時間を食わないため)。
      if (next && !next.txHash && (failure.code === 'rejected' || failure.code === 'failed')) {
        void gasShortfallFailure(arcClient, next, err).then((gasFailure) => {
          // 診断の間に送り直した・別の結果になったら、古い診断で上書きしない。
          if (gasFailure && flowsRef.current[from] === failed) setFlowFor(from, { ...failed, failure: gasFailure });
        });
      }
    } finally {
      refresh(from);
    }
  }, [arcClient, refresh, setFlowFor, switchChainAsync, walletClient]);

  const withdraw = useCallback(async () => {
    if (!address || !walletClient || !arcClient || inflight.current.has(address)) return;
    const prior = flowsRef.current[address];
    if (prior?.phase === 'failed' && prior.retryAfter !== undefined && Date.now() < prior.retryAfter) return;
    if (prior?.phase === 'failed' && prior.pending) return;
    const from = address;
    inflight.current.add(from);
    let last: ArcPayoutStep | undefined;
    try {
      let pending: ArcPayoutAttestation;
      try {
        pending = await requestArcPayout(from, {
          walletClient,
          publicClient: arcClient,
          switchChainAsync,
          onStep: (phase) => { last = phase; setFlowFor(from, { phase }); },
        });
      } catch (err) {
        const failure = arcPayoutFailureOf(err, last);
        setFlowFor(from, {
          phase: 'failed',
          failure,
          ...(failure.code === 'circle_unknown' ? { retryAfter: Date.now() + ARC_PAYOUT_UNKNOWN_COOLDOWN_MS } : {}),
        });
        refresh(from);
        return;
      }
      if (current.current !== from) {
        // 署名の後にアカウントが変わった: 送らずに残し、元のアカウントに戻したら続きを送れるようにする。
        setFlowFor(from, { phase: 'failed', failure: { code: 'account_changed' }, pending });
        return;
      }
      await finish(from, pending);
    } finally {
      inflight.current.delete(from);
    }
  }, [address, arcClient, finish, refresh, setFlowFor, switchChainAsync, walletClient]);

  /** 受け取りの取引の続き (送った取引があればまず確かめ直す)。引き出し元のアカウントだけ。 */
  const continueMint = useCallback(async () => {
    if (!address || inflight.current.has(address)) return;
    const flow = flowsRef.current[address];
    if (flow?.phase !== 'failed' || !flow.pending || flow.pending.depositor !== address) return;
    inflight.current.add(address);
    try {
      await finish(address, flow.pending);
    } finally {
      inflight.current.delete(address);
    }
  }, [address, finish]);

  const flow = (address && flows[address]) || IDLE;
  // 別のアカウントの引き出しで、受け取りの取引の続きが残っているもの (そのアカウントに戻すよう案内する)。
  const otherPending = Object.entries(flows).find(
    ([who, f]) => who !== address && f.phase === 'failed' && !!f.pending,
  )?.[0] as Address | undefined;

  return {
    address,
    status,
    flow,
    otherPending,
    withdraw,
    continueMint,
    reload: () => (address ? refresh(address) : undefined),
    walletReady: !!walletClient,
    arcChainId: arc.id,
  };
}
