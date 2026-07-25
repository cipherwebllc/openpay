// 「署名安心 UX」(plans/sign-reassurance-ux.md) の照合表データを組み立てる純関数。
//
// 本質: 照合表に出す各値は、hook (useJpycEip3009Payment) が実際に署名する payload と
// **同一ソース**でなければならない。OpenPay 側で別計算して表示すると、ウォレットに出る
// 生の数字 (value の 18 桁表記など) と乖離し「お店が言う額とウォレットが言う額が違う」
// という最悪の不信を生む。よって amountAtomic は hook が署名する `value` の `.toString()`
// と完全一致させる (tests/lib/signPreview.test.ts でフェンス)。
//
// スコープ:
//   - free   (P1): JPYC relay free mode。to=merchant・signedTotal=value (上乗せなし)。
//   - recover (P4): JPYC relay recover mode。to=forwarder・signedTotal=merchantValue+feeValue。
//                   customer モードではウォレットが「表示額 + 手数料」を出すため (例 1000 円
//                   決済 → ウォレットは 1002 JPYC)、照合表でこの内訳を必ず説明する (本質)。

import { formatUnits, type Address } from 'viem';
import { AUTHORIZATION_VALIDITY_WINDOW_SEC } from './jpycEip3009';
import {
  mobileOrderFeeValue,
  type MobileOrderFeeKind,
} from './mobileOrderFee';
import { jpycForwarderFor } from './relay/forwarderConfig';
import { recoverFeeValue } from './relay/recoverFee';
import type { GasMode } from './fee';

export type JpycRelaySignPreview = {
  // 人間可読の金額 (formatUnits(value, decimals))。安心パネルの本文・バッジ表示用。
  amountHuman: string;
  // 表示シンボル (例: "JPYC")。
  symbol: string;
  // ウォレットの署名画面に出る生の数字 (value.toString())。照合表の value 欄に出し、
  // 顧客がウォレット表示と突合できるようにする (= 本物のセキュリティ教育)。
  amountAtomic: string;
  // 受取アドレス。hook の mutate に渡す merchant と同一値 (照合表の to 欄に全文表示)。
  to: Address;
  // 店舗名 (任意・QR の store param 由来)。署名待ちオーバーレイの送金先表示に使う。
  storeName?: string;
  // 署名の有効分数 = AUTHORIZATION_VALIDITY_WINDOW_SEC / 60。失効説明に使う。
  expiresInMin: number;
  // token の小数桁数 (照合表の value 欄で「内部表記 (N 桁)」と正確に説明するため)。
  // JPYC=18 が基本だが FX 換算 QR で USDC 6 桁になっても正確に出せるよう preview に持つ。
  decimals: number;
};

// 署名 payload と同一ソース (value/merchant) からプレビューを導出する。表示用に再計算
// しない (乖離をゼロにする)。decimals/displaySymbol は deployment から渡す (FX 換算 QR で
// USDC 6 桁になっても自動対応)。
export function buildJpycRelaySignPreview(args: {
  value: bigint;
  merchant: Address;
  storeName?: string;
  decimals: number;
  displaySymbol: string;
}): JpycRelaySignPreview {
  return {
    amountHuman: formatUnits(args.value, args.decimals),
    symbol: args.displaySymbol,
    amountAtomic: args.value.toString(),
    to: args.merchant,
    storeName: args.storeName,
    expiresInMin: AUTHORIZATION_VALIDITY_WINDOW_SEC / 60,
    decimals: args.decimals,
  };
}

// recover (forwarder) モードの照合表プレビュー。free と異なり署名は receiveWithAuthorization
// で to=forwarder・value=merchantValue+feeValue になる。ウォレットが出す生の数字 (signedTotal)
// は customer モードでは「表示額 + 手数料」(= value + fee) で、表示価格より大きくなる。この
// 内訳を 照合表で説明することが本質 (恐怖除去の核)。
//
// 計算は hook (useJpycEip3009Payment の recover 分岐) と **同一ソース**:
//   feeValue      = feeKind ? mobileOrderFeeValue(value, feeKind) : recoverFeeValue(value)
//   merchantValue = gasMode==='merchant' ? value - feeValue : value
//   signedTotal   = merchantValue + feeValue
//     → customer: value + fee (ウォレット表示が表示価格より大きい)
//     → merchant: value      (ウォレット表示 = 表示価格・手数料は受取から内枠で吸収)
// forwarder 未設定 (free モード chain) なら null を返す → 呼び出し元 (form) は recover
// パネルを出さず free 経路へ倒す (testnet 等の forwarder 無し chain での安全側)。
export type JpycRecoverSignPreview = {
  kind: 'jpyc-recover';
  // 表示価格 (bill amount = value) の人間可読額。安心パネルの「お支払い」表示用。
  amountHuman: string;
  // 手数料 (feeValue) の人間可読額。customer モードで「+ 手数料 {fee}」と内訳に出す。
  feeHuman: string;
  // ウォレットに出る生の数字 (signedTotal) の人間可読額。customer=value+fee / merchant=value。
  totalHuman: string;
  // ウォレットに出る生の数字 (signedTotal.toString())。照合表の value 欄で突合用に出す。
  totalAtomic: string;
  // 受取店舗アドレス (forwarder が同一 tx 内で振り分ける先)。awaiting 表示の送金先補足に使う。
  merchant: Address;
  // 署名の to (= forwarder)。照合表の to 欄に「決済コントラクト」として全文表示する。
  forwarder: Address;
  // 店舗名 (任意・QR の store param 由来)。署名待ちオーバーレイの送金先表示に使う。
  storeName?: string;
  // 手数料の負担者。customer=お客様上乗せ / merchant=店舗吸収。バッジ/照合表の文言分岐に使う。
  gasMode: GasMode;
  // 署名の有効分数 = AUTHORIZATION_VALIDITY_WINDOW_SEC / 60。free と同一定数を再利用。
  expiresInMin: number;
  // token の小数桁数 (照合表の value 欄で「内部表記 (N 桁)」と正確に説明するため)。
  decimals: number;
  // 表示シンボル (例: "JPYC")。
  symbol: string;
};

export function buildJpycRecoverSignPreview(args: {
  value: bigint;
  merchant: Address;
  storeName?: string;
  decimals: number;
  displaySymbol: string;
  chainId: number;
  gasMode: GasMode;
  feeKind?: MobileOrderFeeKind;
}): JpycRecoverSignPreview | null {
  const forwarder = jpycForwarderFor(args.chainId);
  if (forwarder === null) return null;

  const feeValue = args.feeKind
    ? mobileOrderFeeValue(args.value, args.feeKind)
    : recoverFeeValue(args.value, args.gasMode, args.chainId);
  const merchantValue =
    args.gasMode === 'merchant' ? args.value - feeValue : args.value;
  const signedTotal = merchantValue + feeValue;

  return {
    kind: 'jpyc-recover',
    amountHuman: formatUnits(args.value, args.decimals),
    feeHuman: formatUnits(feeValue, args.decimals),
    totalHuman: formatUnits(signedTotal, args.decimals),
    totalAtomic: signedTotal.toString(),
    merchant: args.merchant,
    forwarder,
    storeName: args.storeName,
    gasMode: args.gasMode,
    expiresInMin: AUTHORIZATION_VALIDITY_WINDOW_SEC / 60,
    decimals: args.decimals,
    symbol: args.displaySymbol,
  };
}
