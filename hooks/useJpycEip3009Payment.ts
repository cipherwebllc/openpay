'use client';

// JPYC ガスレス (EIP-3009) の client hook。顧客が EIP-712 署名 (eth_signTypedData_v4・委任不要・
// 任意の injected wallet で可) → /api/relay/jpyc が relayer 経由で submit + gas 負担 → {txHash}。
// 2 モード (server と同じ forwarderConfig で判定):
//   recover (forwarder 設定あり): receiveWithAuthorization(to=forwarder) に署名 → forwarder が
//     amount→店舗 + gas相当→feeReceiver に分割。gas 相当額を JPYC で回収 (立替+回収)。
//   free (forwarder なし): transferWithAuthorization(to=merchant) に署名 → OpenPay がガス負担。
// flag/relay 未構成時は呼び出し元が resolveJpycGaslessProvider で 7702 経路を選ぶ。詳細は
// memory:jpyc-eip3009 / gasless-legal-jp。

import { useCallback, useEffect, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useAccount, usePublicClient, useWalletClient } from 'wagmi';
import type { Address, Hex } from 'viem';
import {
  AUTHORIZATION_VALIDITY_WINDOW_SEC,
  buildTransferWithAuthorizationTypedData,
  randomAuthorizationNonce,
} from '@/lib/jpycEip3009';
import type { ForwarderSettleParams } from '@/lib/relay/forwarderIntent';
import { jpycForwarderFor } from '@/lib/relay/forwarderConfig';
import { recoverFeeValue } from '@/lib/relay/recoverFee';
import {
  mobileOrderFeeValue,
  type MobileOrderFeeKind,
} from '@/lib/mobileOrderFee';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { isUserRejection } from '@/lib/walletErrors';
import type { GasMode } from '@/lib/fee';
import type { TokenDeployment } from '@/lib/tokens';
import {
  isRelayIpRateLimitedError,
  isRelayResponseUnknownError,
  RelayIpRateLimitedError,
  RelayResponseUnknownError,
} from '@/lib/relay/relayResponseError';

export type JpycEip3009Params = {
  merchant: Address;
  value: bigint; // 請求額 (bill amount)
  // recover モードで gas 相当額を顧客上乗せ(customer) / 店主吸収(merchant) のどちらにするか。
  gasMode?: GasMode;
  // モバイル注文システム利用料の種別 (present のとき feeValue は recoverFeeValue ではなく
  // mobileOrderFeeValue(value, feeKind) で算出する)。CheckoutForm が flag ON + モバイル注文の
  // ときだけ渡す。不在 = 従来の gas-recovery 料金 (/pay・/checkout・チップ)。
  feeKind?: MobileOrderFeeKind;
};
// success=false は「relay は成立したが tx が on-chain で revert」(B2 と同じ表示方針)。
// pending=true は「broadcast 済だが未確定」(receipt timeout / authorizationState 既使用)。
// 重要: pending は throw せず result で返す。throw だと form が standard へ fallback でき
// 二重支払いになる。txHash は pending (既使用) では null になりうる。
export type JpycEip3009Result = {
  txHash: Hex | null;
  success: boolean;
  pending?: boolean;
};

export type JpycRelayRecoveryState = 'auto' | 'exhausted' | null;

type RetainedRelayPayload = {
  payload: Record<string, unknown>;
  // false→true のみ許す単調 latch。on-chain success/revert が証明されたときだけ ref ごと破棄する。
  ambiguous: boolean;
};

type RelayResponse = {
  ok?: boolean;
  txHash?: Hex | null;
  reverted?: boolean;
  pending?: boolean;
  error?: string;
  retryAfter?: number;
};

type RelayStatusResponse =
  | { ok: true; state: 'settled'; txHash: Hex | null }
  | { ok: true; state: 'unused' }
  | { ok: true; state: 'indeterminate' };

const RECOVERY_BACKOFF_MS = [3_000, 6_000, 12_000, 24_000, 45_000] as const;
const RECOVERY_FETCH_TIMEOUT_MS = 10_000;
const RECOVERY_DEADLINE_MS = 90_000;

function isRelayResponse(value: unknown): value is RelayResponse {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTxHash(value: unknown): value is Hex {
  return typeof value === 'string' && value.length > 0;
}

function isStrictTxHash(value: unknown): value is Hex {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);
}

function isRelayStatusResponse(value: unknown): value is RelayStatusResponse {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  if (body.ok !== true) return false;
  if (body.state === 'unused' || body.state === 'indeterminate') return true;
  return (
    body.state === 'settled' &&
    (body.txHash === null || isStrictTxHash(body.txHash))
  );
}

function retryAfterSeconds(res: Response, body: RelayResponse): number | null {
  const raw = body.retryAfter ?? res.headers.get('retry-after');
  if (raw === null || raw === undefined || raw === '') return null;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds) : null;
}

async function postRelayPayload(
  payload: Record<string, unknown>,
): Promise<JpycEip3009Result> {
  let res: Response;
  try {
    res = await fetch('/api/relay/jpyc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {
    // POST が server に届いた後で応答だけ失われた可能性がある。通常エラーへ倒すと
    // standard fallback / 新署名が二重送金へ波及するため、専用の曖昧状態にする。
    throw new RelayResponseUnknownError();
  }

  let parsedBody: unknown;
  try {
    parsedBody = await res.json();
  } catch {
    // body 読取失敗も broadcast 前を証明できないため、再送可能な server error にしない。
    throw new RelayResponseUnknownError();
  }
  if (!isRelayResponse(parsedBody)) throw new RelayResponseUnknownError();
  const body = parsedBody;

  if (res.ok && body.ok === true && isTxHash(body.txHash)) {
    return { txHash: body.txHash, success: true };
  }
  // relay は成立したが tx が revert (残高変動等)。success:false で記録/表示 (B2 方針)。
  if (body.reverted === true && isTxHash(body.txHash)) {
    return { txHash: body.txHash, success: false };
  }
  // 202: broadcast 済だが未確定。throw せず pending を返す (form は standard へ fallback
  // してはならない = 二重支払い防止)。txHash は既使用ケースで null になりうる。
  if (
    res.status === 202 &&
    body.pending === true &&
    (body.txHash === undefined || body.txHash === null || isTxHash(body.txHash))
  ) {
    return { txHash: body.txHash ?? null, success: false, pending: true };
  }
  // 早期 IP limiter は冪等チェックより前に返る。同じ authorization の応答喪失後再送も
  // 429 になりうるため、通常の構造化 error より先に専用状態へ分類する。
  if (!res.ok && res.status === 429 && body.error === 'ip_rate_limited') {
    throw new RelayIpRateLimitedError(retryAfterSeconds(res, body));
  }
  // その他の non-2xx + 構造化 {error:string} は server が broadcast 前に確定させた従来の
  // fallback-safe error。2xx 不完全 envelope / 非構造化 non-2xx は未送信を証明できない。
  if (!res.ok && typeof body.error === 'string') throw new Error(body.error);
  throw new RelayResponseUnknownError();
}

export function useJpycEip3009Payment(deployment: TokenDeployment) {
  const { data: walletClient } = useWalletClient();
  const { address, chainId } = useAccount();
  const publicClient = usePublicClient({ chainId: deployment.chainId });

  // mutation variables は金額等の入力値しか持たないため、署名済 payload と ambiguity latch を
  // 単一 ref で保持する。一度 ambiguous になった payload は on-chain success/revert が証明されるまで
  // 破棄せず、通常 mutate の再呼出でも同じ payload だけを POST して新署名を構造的に封鎖する。
  const retainedPayloadRef = useRef<RetainedRelayPayload | null>(null);
  const [recoveryState, setRecoveryState] =
    useState<JpycRelayRecoveryState>(null);
  const mountedRef = useRef(true);
  const recoveryPromiseRef = useRef<Promise<JpycEip3009Result> | null>(null);
  const recoverySleepRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recoveryWakeRef = useRef<(() => void) | null>(null);
  const recoveryFetchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const recoveryAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (recoverySleepRef.current !== null) {
        clearTimeout(recoverySleepRef.current);
      }
      recoveryWakeRef.current?.();
      recoveryWakeRef.current = null;
      if (recoveryFetchTimeoutRef.current !== null) {
        clearTimeout(recoveryFetchTimeoutRef.current);
      }
      recoveryAbortRef.current?.abort();
    };
  }, []);

  const setRecoveryStateIfMounted = (state: JpycRelayRecoveryState) => {
    if (mountedRef.current) setRecoveryState(state);
  };

  const resolveAmbiguousPayload = (
    retained: RetainedRelayPayload,
  ): Promise<JpycEip3009Result> => {
    const existing = recoveryPromiseRef.current;
    if (existing) return existing;

    const run = (async (): Promise<JpycEip3009Result> => {
      setRecoveryStateIfMounted('auto');
      const deadline = Date.now() + RECOVERY_DEADLINE_MS;
      let consecutiveUnused = 0;

      for (const delayMs of RECOVERY_BACKOFF_MS) {
        await new Promise<void>((resolve, reject) => {
          recoveryWakeRef.current = resolve;
          recoverySleepRef.current = setTimeout(() => {
            recoverySleepRef.current = null;
            recoveryWakeRef.current = null;
            if (mountedRef.current) resolve();
            else reject(new RelayResponseUnknownError());
          }, delayMs);
        });
        if (!mountedRef.current) throw new RelayResponseUnknownError();
        if (Date.now() > deadline) break;

        const controller = new AbortController();
        recoveryAbortRef.current = controller;
        const remainingMs = Math.max(1, deadline - Date.now());
        recoveryFetchTimeoutRef.current = setTimeout(
          () => controller.abort(),
          Math.min(RECOVERY_FETCH_TIMEOUT_MS, remainingMs),
        );

        let status: RelayStatusResponse | null = null;
        try {
          const response = await fetch('/api/relay/jpyc/status', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(retained.payload),
            signal: controller.signal,
          });
          const body: unknown = await response.json();
          if (response.ok && isRelayStatusResponse(body)) status = body;
        } catch {
          // status の fetch/RPC/KV 障害は送金結果を変えない。deadline まで同じ intent の read を続ける。
        } finally {
          if (recoveryFetchTimeoutRef.current !== null) {
            clearTimeout(recoveryFetchTimeoutRef.current);
            recoveryFetchTimeoutRef.current = null;
          }
          recoveryAbortRef.current = null;
        }

        if (!mountedRef.current) throw new RelayResponseUnknownError();
        if (!status || status.state === 'indeterminate') {
          consecutiveUnused = 0;
          continue;
        }
        if (status.state === 'unused') {
          consecutiveUnused++;
          const validBefore = Number(retained.payload.validBefore);
          if (
            consecutiveUnused >= 2 &&
            Number.isFinite(validBefore) &&
            Math.floor(Date.now() / 1000) >= validBefore
          ) {
            retainedPayloadRef.current = null;
            setRecoveryStateIfMounted(null);
            throw new Error('relay_unused');
          }
          continue;
        }

        consecutiveUnused = 0;
        if (status.txHash === null || !publicClient) continue;
        try {
          const receipt = await publicClient.waitForTransactionReceipt({
            hash: status.txHash,
            confirmations: 1,
            timeout: Math.max(1, Math.min(RECOVERY_FETCH_TIMEOUT_MS, deadline - Date.now())),
          });
          retainedPayloadRef.current = null;
          setRecoveryStateIfMounted(null);
          return {
            txHash: status.txHash,
            success: receipt.status === 'success',
          };
        } catch {
          // txHash は確定していても receipt RPC が一時的に読めない場合がある。deadline まで再照会する。
        }
      }

      setRecoveryStateIfMounted('exhausted');
      throw new RelayResponseUnknownError();
    })();

    recoveryPromiseRef.current = run;
    void run.finally(() => {
      if (recoveryPromiseRef.current === run) recoveryPromiseRef.current = null;
    }).catch(() => undefined);
    return run;
  };

  const mutation = useMutation<JpycEip3009Result, Error, JpycEip3009Params>({
    mutationFn: async ({ merchant, value, gasMode = 'customer', feeKind }) => {
      // 専用 retry だけでなく、呼出側が誤って通常 mutate を再度呼んでも、未解決 payload が
      // ある間は必ず同一 payload を再 POST して再署名を構造的に封鎖する。
      const retained = retainedPayloadRef.current;
      if (retained) {
        if (retained.ambiguous) return resolveAmbiguousPayload(retained);
        try {
          const result = await postRelayPayload(retained.payload);
          // txHash 付き success / reverted は on-chain の確定結果。非 ambiguous な D1 retry の
          // pending も従来どおり保持を終える。
          retainedPayloadRef.current = null;
          setRecoveryState(null);
          return result;
        } catch (error) {
          if (retained.ambiguous || isRelayResponseUnknownError(error)) {
            // ambiguity は単調 latch。後続 400/429/再 unknown で解除すると、着金済みなのに
            // standard fallback / 新署名へ流れて二重払いになるため、同一 payload を保持し続ける。
            retainedPayloadRef.current = {
              payload: retained.payload,
              ambiguous: true,
            };
            setRecoveryState('exhausted');
          } else if (!isRelayIpRateLimitedError(error)) {
            retainedPayloadRef.current = null;
          }
          throw error;
        }
      }

      if (!walletClient || !address || chainId === undefined) {
        throw new Error('wallet_not_connected');
      }
      const from = address as Address;
      const nowSec = Math.floor(Date.now() / 1000);
      const validBefore = BigInt(nowSec + AUTHORIZATION_VALIDITY_WINDOW_SEC);
      const forwarder = jpycForwarderFor(chainId);

      // 「署名安心 UX」(plans/sign-reassurance-ux.md §5) の計測: 署名要求の前後と拒否/失敗
      // をログ化し、拒否率ファネル (Sentry) を取れるようにする。free/recover の 2 経路で
      // signTypedData を呼ぶため共通化する (署名内容は各 typed を渡すだけで不変)。catch は
      // 分類のための必要な制御フローで、必ず rethrow する (挙動不変・防御的握り潰しではない)。
      const signWithLogging = async (typed: Parameters<
        NonNullable<typeof walletClient>['signTypedData']
      >[0]): Promise<Hex> => {
        logger.info('payment.sign_requested', {
          path: 'jpyc-relay',
          chainId,
          mode: forwarder ? 'recover' : 'free',
        });
        try {
          const signature = (await walletClient.signTypedData(typed)) as Hex;
          logger.info('payment.sign_completed', { path: 'jpyc-relay', chainId });
          return signature;
        } catch (err) {
          if (isUserRejection(err)) {
            logger.info('payment.sign_rejected', {
              path: 'jpyc-relay',
              chainId,
              mode: forwarder ? 'recover' : 'free',
            });
          } else {
            logger.warn('payment.sign_failed', {
              path: 'jpyc-relay',
              chainId,
              mode: forwarder ? 'recover' : 'free',
              error: err,
            });
          }
          throw err;
        }
      };

      let payload: Record<string, unknown>;
      if (forwarder) {
        // recover: per-tx 手数料を JPYC 回収。決済 (merchant) は店舗が受取から吸収、
        // チップ (customer) はチッパーが上乗せ。料金スケジュールは gasMode で選択される:
        // merchant = max(ガスフロア, billAmount × bps/10000)・customer = フロアのみ (bps 無視)。
        // bps=0 (既定) ではいずれもフロア (= 固定 2 JPYC) になり従来挙動と一致。server も同じ
        // payload gasMode で同式再計算し一致を強制する (nonce にコミットされるため client/server
        // がずれると署名検証が失敗する)。
        // モバイル注文システム利用料 (feeKind present) は経路非依存の一律 % (mobileOrderFeeValue)。
        // それ以外 (/pay・/checkout・チップ) は従来の gas-recovery (recoverFeeValue)。server も
        // 同じ feeKind 有無で同式再計算し feeValue 一致を強制する (nonce にコミットされるため
        // client/server が決定論的に一致する必要がある → KV/handle 非依存の純関数で算出)。
        const feeValue = feeKind
          ? mobileOrderFeeValue(value, feeKind)
          : recoverFeeValue(value, gasMode, chainId);
        const merchantValue = gasMode === 'merchant' ? value - feeValue : value;
        if (merchantValue <= 0n) throw new Error('amount_too_small');
        const params: ForwarderSettleParams = {
          from,
          merchant,
          merchantValue,
          feeReceiver: env.feeReceiver as Address,
          feeValue,
          validAfter: 0n,
          validBefore,
          intentSalt: randomAuthorizationNonce(),
        };
        // recover 専用の intent 構築は lazy import (initial /pay バンドルに encodeAbiParameters
        // 等を載せない・予算節約)。recover 決済が実行された時のみ chunk を読み込む。
        const { buildReceiveWithAuthorizationTypedData } = await import(
          '@/lib/relay/forwarderIntent'
        );
        const typed = buildReceiveWithAuthorizationTypedData(
          params,
          chainId,
          deployment.address,
          forwarder,
        );
        const signature = await signWithLogging({
          account: address,
          domain: typed.domain,
          types: typed.types,
          primaryType: typed.primaryType,
          message: typed.message,
        });
        payload = {
          chainId,
          from,
          merchant,
          merchantValue: merchantValue.toString(),
          feeValue: feeValue.toString(),
          // gasMode は server が billAmount を (merchantValue, feeValue) から再構成し
          // expectedFee を求めるための検証ヒント (署名対象ではない)。誤った gasMode は
          // expectedFee が署名済 feeValue と食い違い fee_value_mismatch で安全に弾かれる。
          gasMode,
          // feeKind present のとき server は recoverFeeValue ではなく mobileOrderFeeValue で
          // expectedFee を再計算する (定数表から → client 申告の率は信用しない)。署名対象では
          // ないが、誤りは expectedFee 不一致で安全に弾かれる。
          ...(feeKind ? { feeKind } : {}),
          validAfter: '0',
          validBefore: validBefore.toString(),
          intentSalt: params.intentSalt,
          signature,
        };
      } else {
        // free: 直接 transferWithAuthorization。OpenPay がガス負担 (回収しない)。
        // ⚠️ モバイル注文システム利用料 (feeKind) は free 経路では分割できない (単一 transfer・fee 機構
        // 無し)。ここで素通りさせると「ガスレスなら手数料無料」の穴になる (経路非依存に反する) ため、
        // feeKind があるのに forwarder 未設定の chain では明示的に失敗させ、呼出側 (CheckoutForm) が
        // standard 経路 (2-tx で手数料を分割可能) へ fallback できるようにする。本番のモバイル注文
        // 対象 chain は全て forwarder 設定済なので、これは構成漏れ chain 専用のセーフティネット。
        if (feeKind) throw new Error('mobile_fee_requires_recover');
        const auth = {
          from,
          to: merchant,
          value,
          validAfter: 0n,
          validBefore,
          nonce: randomAuthorizationNonce(),
        };
        const typed = buildTransferWithAuthorizationTypedData(
          auth,
          chainId,
          deployment.address,
        );
        const signature = await signWithLogging({
          account: address,
          domain: typed.domain,
          types: typed.types,
          primaryType: typed.primaryType,
          message: typed.message,
        });
        payload = {
          chainId,
          from,
          to: merchant,
          value: value.toString(),
          validAfter: '0',
          validBefore: validBefore.toString(),
          nonce: auth.nonce,
          signature,
        };
      }

      try {
        return await postRelayPayload(payload);
      } catch (error) {
        if (isRelayResponseUnknownError(error)) {
          const retained = { payload, ambiguous: true };
          retainedPayloadRef.current = retained;
          return resolveAmbiguousPayload(retained);
        } else if (isRelayIpRateLimitedError(error)) {
          retainedPayloadRef.current = { payload, ambiguous: false };
        } else {
          retainedPayloadRef.current = null;
        }
        throw error;
      }
    },
  });

  const mutationIsPending = mutation.isPending;
  const mutationVariables = mutation.variables;
  const mutate = mutation.mutate;

  const retryRelay = useCallback(() => {
    if (
      !retainedPayloadRef.current ||
      retainedPayloadRef.current.ambiguous ||
      !mutationVariables ||
      mutationIsPending
    ) {
      return;
    }
    mutate(mutationVariables);
  }, [mutate, mutationIsPending, mutationVariables]);

  const retrySamePayload = useCallback(() => {
    if (
      !retainedPayloadRef.current?.ambiguous ||
      !mutationVariables ||
      mutationIsPending
    ) {
      return;
    }
    mutate(mutationVariables);
  }, [mutate, mutationIsPending, mutationVariables]);

  return { ...mutation, recoveryState, retryRelay, retrySamePayload };
}
