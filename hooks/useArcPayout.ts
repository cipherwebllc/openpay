'use client';

// 「Arc の売上を受け取る」ページの状態 (plans/arc-gateway-payout.md)。
// 読むもの: 接続中のアドレスの Arc の Gateway 残高・Circle の手数料・コントラクトかどうか・ガス代用の Arc の USDC。
// 引き出し: lib/crossChain/arcPayout.ts の requestArcPayout (署名 → attestation) → sendArcPayoutMint (受け取りの取引)。
//
// 二重に引き出さない・別のアドレスの結果を混ぜないための決まり:
//   - 押した瞬間に (描画を待たず) ref でアドレスごとに二度押しを止める。
//   - Circle の応答が分からない (時間切れ・5xx・照合の不一致) ときは、新しい署名で引き出し直させない。受け付けられて
//     いた場合も 10 分で失効して残高に戻るので、10 分待って読み直してもらう。
//   - attestation (10 分有効) は画面の state にだけ持つ。受け取りの取引に失敗したら、失効までは同じ attestation で
//     再送できる。送れるのは引き出し元のアカウントだけ (途中でアカウントが変わったら、元に戻すよう案内する)。
//     再読み込みで失われても、未使用の attestation は失効後に残高へ戻る (資金は失われない)。
//   - 署名・attestation は console にも Sentry にも出さない。

import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type Address, type Hex } from 'viem';
import { useAccount, usePublicClient, useSwitchChain, useWalletClient } from 'wagmi';
import { isNonDelegatedContractCode } from '@/lib/accountCode';
import { chainForSlug } from '@/lib/chains';
import {
  ArcPayoutError,
  arcPayoutChain,
  fetchArcPayoutFee,
  readArcPayoutBalance,
  requestArcPayout,
  sendArcPayoutMint,
  type ArcPayoutAttestation,
  type ArcPayoutBalance,
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
  | { code: 'circle_rejected'; status: number }
  | { code: 'circle_unknown' }
  | { code: 'account_changed' }
  | { code: 'below_fee' | 'balance_unavailable' | 'attestation_expired' | 'mint_reverted' | 'failed' };

export type ArcPayoutFlow =
  | { phase: 'idle' }
  | { phase: ArcPayoutStep }
  | { phase: 'done'; value: bigint; txHash: Hex }
  // pending があれば、失効までは受け取りの取引だけを再送できる。retryAfter までは引き出し直させない。
  | { phase: 'failed'; failure: ArcPayoutFailure; pending?: ArcPayoutAttestation; retryAfter?: number };

/** step = 失敗したときに進んでいた段階。依頼の途中で通信が切れたら、受け付けられた可能性がある。 */
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

  const [flow, setFlow] = useState<ArcPayoutFlow>({ phase: 'idle' });
  const inflight = useRef(new Set<string>());
  const owner = useRef<Address | undefined>(address);

  // アカウントが変わったら途中の表示を捨てる。ただし受け取りを待つ attestation は、元のアカウントに戻したときに
  // 再送できるよう残す (再送は引き出し元のアカウントだけ)。
  useEffect(() => {
    owner.current = address;
    setFlow((current) => (current.phase === 'failed' && current.pending ? current : { phase: 'idle' }));
  }, [address]);

  const refresh = useCallback(
    (who: Address) => void queryClient.invalidateQueries({ queryKey: ['arcPayout', who] }),
    [queryClient],
  );

  const finish = useCallback(async (from: Address, pending: ArcPayoutAttestation) => {
    if (!walletClient || !arcClient) return;
    const step = (phase: ArcPayoutStep) => { if (owner.current === from) setFlow({ phase }); };
    try {
      const txHash = await sendArcPayoutMint(pending, { walletClient, publicClient: arcClient, switchChainAsync, onStep: step });
      if (owner.current === from) setFlow({ phase: 'done', value: pending.value, txHash });
    } catch (err) {
      // 失効した attestation は再送させない (残高に戻るのを待つ)。それ以外は失効まで同じ attestation で再送できる。
      const failure = arcPayoutFailureOf(err, undefined);
      setFlow({ phase: 'failed', failure, ...(failure.code === 'attestation_expired' ? {} : { pending }) });
    } finally {
      refresh(from);
    }
  }, [arcClient, refresh, switchChainAsync, walletClient]);

  const withdraw = useCallback(async () => {
    if (!address || !walletClient || !arcClient || inflight.current.has(address)) return;
    if (flow.phase === 'failed' && flow.retryAfter !== undefined && Date.now() < flow.retryAfter) return;
    const from = address;
    inflight.current.add(from);
    let last: ArcPayoutStep | undefined;
    const step = (phase: ArcPayoutStep) => {
      last = phase;
      if (owner.current === from) setFlow({ phase });
    };
    try {
      let pending: ArcPayoutAttestation;
      try {
        pending = await requestArcPayout(from, { walletClient, publicClient: arcClient, switchChainAsync, onStep: step });
      } catch (err) {
        const failure = arcPayoutFailureOf(err, last);
        if (owner.current === from) {
          setFlow({
            phase: 'failed',
            failure,
            ...(failure.code === 'circle_unknown' ? { retryAfter: Date.now() + ARC_PAYOUT_UNKNOWN_COOLDOWN_MS } : {}),
          });
        }
        refresh(from);
        return;
      }
      if (owner.current !== from) {
        // 署名の後にアカウントが変わった: 送らずに残し、元のアカウントに戻したら再送できるようにする。
        setFlow({ phase: 'failed', failure: { code: 'account_changed' }, pending });
        return;
      }
      await finish(from, pending);
    } finally {
      inflight.current.delete(from);
    }
  }, [address, arcClient, finish, flow, refresh, switchChainAsync, walletClient]);

  const retryMint = useCallback(async () => {
    if (!address || flow.phase !== 'failed' || !flow.pending) return;
    // 受け取りの取引を送れるのは引き出し元のアカウントだけ。
    if (flow.pending.depositor !== address || inflight.current.has(address)) return;
    inflight.current.add(address);
    try {
      await finish(address, flow.pending);
    } finally {
      inflight.current.delete(address);
    }
  }, [address, finish, flow]);

  return {
    address,
    status,
    flow,
    withdraw,
    retryMint,
    reload: () => (address ? refresh(address) : undefined),
    walletReady: !!walletClient,
    arcChainId: arc.id,
  };
}
