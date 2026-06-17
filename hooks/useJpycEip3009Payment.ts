'use client';

// JPYC ガスレス (EIP-3009) の client hook。顧客が EIP-712 署名 (eth_signTypedData_v4・委任不要・
// 任意の injected wallet で可) → /api/relay/jpyc が relayer 経由で submit + gas 負担 → {txHash}。
// 2 モード (server と同じ forwarderConfig で判定):
//   recover (forwarder 設定あり): receiveWithAuthorization(to=forwarder) に署名 → forwarder が
//     amount→店舗 + gas相当→feeReceiver に分割。gas 相当額を JPYC で回収 (立替+回収)。
//   free (forwarder なし): transferWithAuthorization(to=merchant) に署名 → OpenPay がガス負担。
// flag/relay 未構成時は呼び出し元が resolveJpycGaslessProvider で 7702 経路を選ぶ。詳細は
// memory:jpyc-eip3009 / gasless-legal-jp。

import { useMutation } from '@tanstack/react-query';
import { useAccount, useWalletClient } from 'wagmi';
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

type RelayResponse = {
  ok?: boolean;
  txHash?: Hex | null;
  reverted?: boolean;
  pending?: boolean;
  error?: string;
};

export function useJpycEip3009Payment(deployment: TokenDeployment) {
  const { data: walletClient } = useWalletClient();
  const { address, chainId } = useAccount();

  return useMutation<JpycEip3009Result, Error, JpycEip3009Params>({
    mutationFn: async ({ merchant, value, gasMode = 'customer', feeKind }) => {
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

      const res = await fetch('/api/relay/jpyc', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });

      let body: RelayResponse = {};
      try {
        body = (await res.json()) as RelayResponse;
      } catch {
        /* non-JSON response */
      }

      if (res.ok && body.ok && body.txHash) {
        return { txHash: body.txHash, success: true };
      }
      // relay は成立したが tx が revert (残高変動等)。success:false で記録/表示 (B2 方針)。
      if (body.reverted && body.txHash) {
        return { txHash: body.txHash, success: false };
      }
      // 202: broadcast 済だが未確定。throw せず pending を返す (form は standard へ fallback
      // してはならない = 二重支払い防止)。txHash は既使用ケースで null になりうる。
      if (res.status === 202 && body.pending) {
        return { txHash: body.txHash ?? null, success: false, pending: true };
      }
      // それ以外は失敗。error code を message に載せ、form 側で i18n にマップする。
      throw new Error(body.error ?? `http_${res.status}`);
    },
  });
}
