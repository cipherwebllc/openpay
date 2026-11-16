'use client';

// 「お店の端末で送る」で端末が入金を確かめた支払いを、お店のブラウザの取引履歴 (localStorage `openpay:history:v1`) に
// 1 行書く (plans/shop-history-gap.md の P1)。server には何も送らない。
//
// 行の値は、払った側 (components/StoreDeviceCheckoutForm.tsx → hooks/usePaymentHistory.ts) が同じ支払いで書く行と
// 同じ値・同じ id (`batch-${txHash}`) にする (同じブラウザに両方が書いても appendHistory の id の重複落としで 1 行・
// tests/components/StoreDeviceSaleHistory.parity.test.tsx が両方を実際に作って欄ごとに比べる):
//   - 金額・お客様・受取先・チェーン = 端末が送った印 (DeviceSentMark)。端末が署名と照合し、receipt の Settled か
//     サーバの判定で入金を確かめた値。
//   - 利用料の欄 = 1 wei (仕組み上の最小単位)・gasMode = merchant (ガス代はお店の端末)・blockNumber は持たない。
//   - 明細・管理番号・税率・値引き・メモ = QR を出した時点の会計の写し (lib/storeDeviceSaleSnapshot.ts) を、お客様の
//     画面と同じ parser (parseCheckoutParams) で読んだ値。写しが無い・この支払いの会計と合わないときは、明細なしで
//     金額と tx だけの行にする。
//   - 店名 (URL の store) は行に入れない (払った側の行も storeName は空・店名はお客様の控えだけ)。
//   - 行の時刻 (ts) だけは払った側と違う (それぞれの端末の時刻)。
//
// 状態を見て呼ぶのは hooks/useStoreDeviceSaleHistory.ts (使うときだけ読み込む = /create の初期の chunk に入れない)。

import type { Hex } from 'viem';
import { slugForChain } from './chains';
import { buildCheckoutLineItems } from './checkoutLineItems';
import { appendHistory, buildHistoryEntry, type HistoryEntry } from './history';
import { STORE_DEVICE_FEE_WEI, storeDeviceChainConfig } from './storeDevicePayment';
import { readStoreDeviceSaleSnapshot } from './storeDeviceSaleSnapshot';
import type { DeviceSentMark } from './storeDeviceSend';
import { resolveDeployment } from './tokens';
import { calcCheckoutPayable, parseCheckoutParams, type CheckoutParams } from './url';

/**
 * 写し (QR に載せた /checkout の path) を、お客様の画面と同じ parser で読む。この支払い (mark) の会計でなければ null:
 * 金額・お客様・受取先は確かめ済みの印から書くが、写しは確かめていない手元の値なので、受け渡しの id・受取先・チェーン・
 * 請求額が印と合うときだけ明細に使う (別の会計の明細が、売上の行と会計 CSV の明細へ波及するのを断つ)。
 */
function saleCheckout(path: string | null, mark: DeviceSentMark, decimals: number): CheckoutParams | null {
  if (path === null) return null;
  const query = path.indexOf('?');
  if (query < 0) return null;
  const parsed = parseCheckoutParams(new URLSearchParams(path.slice(query + 1)));
  if (!parsed.ok) return null;
  const p = parsed.params;
  return p.handoffId === mark.handoffId &&
    p.to.toLowerCase() === mark.merchant.toLowerCase() &&
    p.chain === slugForChain(mark.chainId) &&
    calcCheckoutPayable(p, decimals).toString() === mark.amount
    ? p
    : null;
}

/**
 * 入金を確かめた支払い (mark) の、お店の取引履歴の行。txHash = 実際に成立した tx (端末が送った tx か、サーバの判定が
 * 見つけた tx)。snapshotPath = QR を出した時点の会計の写し (無ければ null)。このチェーンの値を引けないときは null。
 */
export function buildStoreDeviceSaleEntry(
  mark: DeviceSentMark,
  txHash: Hex,
  snapshotPath: string | null,
): HistoryEntry | null {
  const config = storeDeviceChainConfig(mark.chainId);
  const deployment = resolveDeployment('jpyc', mark.chainId);
  const chainSlug = slugForChain(mark.chainId);
  if (!config || !deployment || !chainSlug) return null;
  const amount = BigInt(mark.amount);
  const checkout = saleCheckout(snapshotPath, mark, deployment.decimals);
  // 行の時刻は、端末がこの支払いを送った時刻 (印の at)。再読み込みの後の「前回の送信」を後から確かめても、売上の
  // 日時が確かめた時刻へずれない (日付をまたぐと別の日の売上になる)。印の時刻が今より先・0 以下のときだけ今の時刻
  // (手元の保存値の壊れた時刻が、履歴の画面と CSV の日付へ波及するのを断つ)。
  const now = Date.now();
  const ts = mark.at > 0 && mark.at <= now ? mark.at : now;
  return buildHistoryEntry({
    ts,
    flow: 'batch',
    status: 'success',
    chainId: mark.chainId,
    chainSlug,
    asset: 'jpyc',
    tokenAddress: deployment.address,
    payMode: 'gasless',
    gasMode: 'merchant',
    merchant: mark.merchant,
    merchantAmount: amount,
    customer: mark.from,
    feeReceiver: config.feeReceiver,
    feeAmount: STORE_DEVICE_FEE_WEI,
    saleAmount: amount,
    networkFeeEquivalent: null,
    txHash,
    userOpHash: null,
    blockNumber: null,
    errorMessage: null,
    storeName: '',
    note: checkout?.description ?? '',
    productName: checkout ? checkout.items.map((it) => it.name).join(', ') : null,
    memo: checkout?.description ?? null,
    taxRate: checkout?.taxRate ?? null,
    taxCategory: checkout?.taxCategory ?? null,
    receiptNo: checkout?.receiptNo ?? null,
    lineItems: checkout
      ? buildCheckoutLineItems({
          items: checkout.items,
          discount: checkout.discount,
          token: 'jpyc',
          decimals: deployment.decimals,
          taxRate: checkout.taxRate,
          taxCategory: checkout.taxCategory,
        })
      : null,
  });
}

/**
 * 入金を確かめた支払いを、お店の取引履歴に 1 行書く。同じ tx の行が既にあれば増やさない (appendHistory が id で落とす)。
 * 行を作れなかった (このチェーンの値を引けない) ときは false。
 */
export function recordStoreDeviceSale(mark: DeviceSentMark, txHash: Hex): boolean {
  const entry = buildStoreDeviceSaleEntry(mark, txHash, readStoreDeviceSaleSnapshot(mark.handoffId));
  if (!entry) return false;
  appendHistory(entry);
  return true;
}
