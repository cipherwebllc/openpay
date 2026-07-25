'use client';

// 店員が決済 QR を提示している間 (QrPreviewModal が開いている間) に、受取先
// アドレスのトークン残高をオンチェーンでポーリングし、モーダルを開いた瞬間の
// 残高を baseline として記録、おおよそ請求額ぶん残高が増えたら「着金を確認した」
// と判定する advisory なヒント。
//
// ⚠️ これは「何かが着金した」ことを店員の目の前で素早く示すための検知ヒントに
// すぎない。THIS 取引が完了した保証ではない (同一アドレスへの無関係な並行着金でも
// 発火しうる)。正本はオンチェーン Explorer / /history。誤検知を許容できる用途
// (対面でレジ横の安心表示) に限る。
//
// 残高取得は useErc20BalanceAndChain と同じく wagmi useReadContract +
// erc20Abi('balanceOf') を再利用する。

import { useRef } from 'react';
import { useReadContract } from 'wagmi';
import { erc20Abi } from 'viem';

export type IncomingPaymentStatus = 'idle' | 'watching' | 'received';

// 呼び出し元が実決済経路の手数料控除後となる店舗期待純受取額を渡す。その 98% を
// advisory な着金判定の閾値にし、RPC 更新タイミング等の微差を許容する。整数除算は
// 切り上げるため、正の期待額に対する閾値は最低 1 atomic unit となり、0 着金では発火しない。
const THRESHOLD_NUMERATOR = 98n;
const THRESHOLD_DENOMINATOR = 100n;

export function useIncomingPaymentWatch(params: {
  receiver: `0x${string}` | null;
  tokenAddress: `0x${string}`;
  chainId: number;
  expectedAmountWei: bigint; // 実決済経路で店舗が受け取る期待純額
  enabled: boolean; // 固定額 QR のモーダル提示中だけ true
}): { status: IncomingPaymentStatus; receivedWei: bigint } {
  const { receiver, tokenAddress, chainId, expectedAmountWei, enabled } =
    params;

  // この watch を実際に有効化する条件。受取先と正の請求額が揃って初めて意味を持つ。
  const watchActive = enabled && !!receiver && expectedAmountWei > 0n;

  const balanceQuery = useReadContract({
    address: tokenAddress,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: receiver ? [receiver] : undefined,
    chainId,
    query: {
      enabled: watchActive,
      // 6 秒間隔で残高をポーリング。背面 (タブ非アクティブ) では止めて RPC 浪費を防ぐ。
      refetchInterval: 6000,
      refetchIntervalInBackground: false,
    },
  });

  const currentBalance = balanceQuery.data;

  // 「いま監視している QR」の identity。enabled の false→true 再立ち上がり /
  // receiver / 請求額 のいずれかが変わると別 QR とみなし baseline を取り直す。
  // disabled (watchActive=false) は null を key にして、再有効化を必ず立ち上がり
  // エッジとして扱う。
  const watchKey = watchActive
    ? `${receiver}:${expectedAmountWei.toString()}`
    : null;

  // baseline (この QR を監視し始めた瞬間の残高) と、それが属する watchKey。
  // effect ではなく render 中に同期リセットするのは、receiver/金額の差し替えと
  // 同じ render で古い baseline を使って誤検知するのを防ぐため (ref reset を
  // effect に置くと再 render が走らず古い値で 1 フレーム判定してしまう)。
  const baselineRef = useRef<bigint | null>(null);
  const keyRef = useRef<string | null>(null);

  // watchKey が変わったら baseline を破棄 (新しい QR = 新規 watch)。
  if (keyRef.current !== watchKey) {
    keyRef.current = watchKey;
    baselineRef.current = null;
  }

  // baseline 未確定かつ watch 有効で、残高を初めて取得できたら baseline に固定する。
  // 以降のポーリングでは上書きしない (delta 計測の基準点を保つ)。
  if (watchActive && baselineRef.current === null && currentBalance !== undefined) {
    baselineRef.current = currentBalance;
  }

  if (!watchActive) {
    return { status: 'idle', receivedWei: 0n };
  }

  const baseline = baselineRef.current;
  // baseline か現在残高がまだ無い (初回フェッチ前) なら監視中。
  if (baseline === null || currentBalance === undefined) {
    return { status: 'watching', receivedWei: 0n };
  }

  const delta = currentBalance - baseline;
  const receivedWei = delta > 0n ? delta : 0n;
  const threshold =
    (expectedAmountWei * THRESHOLD_NUMERATOR +
      (THRESHOLD_DENOMINATOR - 1n)) /
    THRESHOLD_DENOMINATOR;

  if (delta > 0n && delta >= threshold) {
    return { status: 'received', receivedWei };
  }
  return { status: 'watching', receivedWei };
}
