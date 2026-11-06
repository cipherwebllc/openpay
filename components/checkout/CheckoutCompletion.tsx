'use client';

// /checkout (CheckoutForm) の支払い完了の枠: 見出し・説明・結果の行 (ガスレスの UserOp/Tx/ブロック・relay の Tx・通常決済の
// 店舗送金/手数料/ブロック・受付番号)・「お店に知らせる / 注文を送る」・「注文状況を見る」・電子レシート (支払い控え)・
// success_url への移動の案内と「今すぐ確認ページへ」・「ホームへ戻る」。CheckoutForm から切り出した表示だけの部品
// (第 9 回レビュー F-04・Q11)。枠を出すか (completed と経路の data)・経路ごとにどの行を出すか・受付番号の出どころ
// (注文の束縛・受注の控え・URL・読み直した画面では URL の番号を出さない)・リンクと移動の案内を出すかと文言 (秒数)・ホームへ
// 戻るを出すか、と押したときに呼ぶ処理 (success_url への移動・ホームへの移動・音の解錠) は CheckoutForm が決めて、出すなら
// 値・出さないなら null で渡す。ここは受け取った値を描くだけで、状態機械・決済の制御には触れない (掟 12・15)。
// 要素の形 (経路ごとの Fragment・条件つきの行・手数料の行の入れ子・枠の子の並び) は切り出し前の JSX と同じ (描き直しで
// 行や案内の DOM を使い続ける)。描画は tests/components/CheckoutCompletion.test.tsx が状態ごとに固定する。

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { ResultRow } from '../ResultRow';
import { NotifyShopButton, type NotifyShopData } from '../NotifyShopButton';
import { PayerReceiptCompletion } from '../PayerReceiptCompletion';

type Props = {
  /** ガスレス (Pimlico) の結果の行 (UserOp・Tx・ブロック)。ガスレスの経路で結果があるときだけ。null なら出さない。 */
  gasless: { userOpHash: string; txHash: string; blockNumber: string } | null;
  /** relay の Tx の行 (relay は UserOp・ブロックを持たない)。relay の経路で成功して Tx Hash があるときだけ。null なら出さない。 */
  relayTxHash: string | null;
  /**
   * 通常決済の結果の行 (店舗送金・手数料・ブロック)。通常決済の経路で結果があるときだけ。null なら出さない。
   * feeTxHash は手数料の Tx があるときだけ (null なら手数料の行を出さない = 利用料 0)。
   */
  standard: { merchantTxHash: string; feeTxHash: string | null; blockNumber: string } | null;
  /** 受付番号の行。null なら出さない。 */
  orderId: string | null;
  /** 遠隔の注文の「お店に知らせる / 注文を送る」の中身 (大きな完了画面と同じもの)。無ければ出さない。 */
  notifyData: NotifyShopData | undefined;
  /** 「注文状況を見る」のリンク先 (お渡し準備完了通知)。null なら出さない。 */
  orderStatusHref: string | null;
  /** 「注文状況を見る」を押したとき (CheckoutForm が音を解錠する処理を渡す)。 */
  onOrderStatusClick: () => void;
  /** 電子レシートを引く候補 (txHash / userOpHash)。 */
  receiptCandidateIds: Array<string | null | undefined>;
  /** success_url への移動の案内 (「N 秒後に…」/「移動しています…」)。null なら案内と「今すぐ確認ページへ」を出さない。 */
  redirectNotice: string | null;
  /** 「今すぐ確認ページへ」を押したとき (CheckoutForm の success_url への移動)。 */
  onRedirectNow: () => void;
  /** 「ホームへ戻る」を出す (読み直した画面か、success_url が無い)。 */
  showReturnHome: boolean;
  /** 「ホームへ戻る」を押したとき。 */
  onReturnHome: () => void;
};

export function CheckoutCompletion({
  gasless,
  relayTxHash,
  standard,
  orderId,
  notifyData,
  orderStatusHref,
  onOrderStatusClick,
  receiptCandidateIds,
  redirectNotice,
  onRedirectNow,
  showReturnHome,
  onReturnHome,
}: Props) {
  const t = useTranslations('CheckoutForm');

  return (
    <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">
      <p className="font-semibold">{t('successTitle')}</p>
      <p className="mt-1 text-xs">{t('successBody')}</p>
      <dl className="mt-3 space-y-1 text-xs">
        {gasless !== null && (
          <>
            <ResultRow
              label={t('successUserOp')}
              value={gasless.userOpHash}
              copyable
            />
            <ResultRow
              label={t('successTx')}
              value={gasless.txHash}
              copyable
            />
            <ResultRow
              label={t('successBlock')}
              value={gasless.blockNumber}
            />
          </>
        )}
        {/* relay は userOp/block を持たないため Tx Hash のみ表示 (Explorer は overlay 側)。 */}
        {relayTxHash !== null && (
          <ResultRow
            label={t('successTx')}
            value={relayTxHash}
            copyable
          />
        )}
        {standard !== null && (
          <>
            <ResultRow
              label={t('standardMerchantTxLabel')}
              value={standard.merchantTxHash}
              copyable
            />
            {standard.feeTxHash !== null && (
              <ResultRow
                label={t('standardFeeTxLabel')}
                value={standard.feeTxHash}
                copyable
              />
            )}
            <ResultRow
              label={t('successBlock')}
              value={standard.blockNumber}
            />
          </>
        )}
        {orderId !== null && (
          <ResultRow label={t('orderIdLabel')} value={orderId} />
        )}
      </dl>

      {/* 遠隔の注文: 大きな完了画面を閉じた後も、注文を送る / お店に知らせるボタンを残す。 */}
      {notifyData && (
        <div className="mt-4">
          <NotifyShopButton {...notifyData} tone="panel" />
        </div>
      )}

      {/* お渡し準備完了通知: 顧客が注文状況を追えるリンク。click は user gesture ＝ ここで AudioContext を解錠
          (iOS 自動再生対策・解錠の処理は CheckoutForm が渡す)。 */}
      {orderStatusHref !== null && (
        <Link
          href={orderStatusHref}
          prefetch={false}
          onClick={onOrderStatusClick}
          className="mt-4 flex items-center justify-center rounded-xl border border-brand/30 bg-brand/5 px-4 py-3 text-sm font-semibold text-brand transition hover:bg-brand/10"
        >
          {t('viewOrderStatus')}
        </Link>
      )}

      {/* 顧客向け電子レシート (支払い控え) を完了画面にも埋め込む。 */}
      <div className="mt-4">
        <PayerReceiptCompletion candidateIds={receiptCandidateIds} />
      </div>

      {redirectNotice !== null && (
        <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs">
            {redirectNotice}
          </p>
          <button
            type="button"
            onClick={onRedirectNow}
            className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700"
          >
            {t('redirectNowButton')}
          </button>
        </div>
      )}
      {showReturnHome && (
        <button
          type="button"
          onClick={onReturnHome}
          className="mt-4 inline-block rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700"
        >
          {t('returnHomeButton')}
        </button>
      )}
    </div>
  );
}
