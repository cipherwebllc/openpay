'use client';

import {
  useEffect,
  useRef,
  type Dispatch,
  type SetStateAction,
} from 'react';
import { useTranslations } from 'next-intl';
import { QrCode as QrCodeIcon } from 'lucide-react';
import type { TokenDeployment } from '@/lib/tokens';
import type { Mode } from './QrAmountSection';

// QR を出せない理由 (未入力の項目) のキー。受取先 → 金額の順に 1 つだけ出す (受取先が無いのが初めての店の本当の壁・
// 2026-10 磨き上げ P5)。
export function qrNotReadyKey(
  amountValid: boolean,
  receiverValid: boolean,
): 'amount' | 'receiver' | null {
  if (!receiverValid) return 'receiver';
  if (!amountValid) return 'amount';
  return null;
}

// 会計パネル (PC の右列・2026-10 磨き上げ P2): 請求金額と「QRコードを表示する」。レジの右列 (会計サマリー) と
// 同じ型。押せないときは理由を 1 行で出す。スマホは下部の会計バーが担うので出さない。
// モーダルの開閉状態・payUrl の導出・モーダル本体は QrGenerator に残す。
export function QrPreviewSection({
  payUrl,
  receiverValid,
  amountValid,
  amountText,
  fiatHint,
  sampleAmount,
  setAmount,
  setQrModalOpen,
  showQrBlocked,
  secondaryAction,
}: {
  payUrl: string;
  receiverValid: boolean;
  amountValid: boolean;
  /** 表示する請求金額 (例「1,000 JPYC」・据え置きは「金額はお客様が入力」)。未入力は null。 */
  amountText: string | null;
  fiatHint: string | null;
  /** 受取先は済んだが金額が空のとき、試しに入れる金額 (例 '1000')。 */
  sampleAmount: string;
  setAmount: Dispatch<SetStateAction<string>>;
  setQrModalOpen: Dispatch<SetStateAction<boolean>>;
  /** 「QRコードを表示する」を押せない理由 (お店がガス代を肩代わりして送るで使えない会計など)。省略時は今のまま。 */
  showQrBlocked?: string;
  /** 補助の操作 (例: お店負担の QR を作れなかったときの「通常の QR を出す」)。省略時は今のまま。 */
  secondaryAction?: { label: string; onClick: () => void };
}) {
  const t = useTranslations('QrGenerator');
  const notReadyKey = payUrl ? null : qrNotReadyKey(amountValid, receiverValid);
  const notReady = notReadyKey ? t(`notReady.${notReadyKey}`) : null;
  const disabled = !payUrl || showQrBlocked !== undefined;
  return (
    <aside className="flex flex-col print:hidden lg:sticky lg:top-20">
      {/* お店負担で押せない理由と「通常の QR を出す」(1 か所だけ・お店負担を選んでいないときは何も出さない)。
          スマホは本文の流れの中 (下部の会計バーには理由を書く場所が無い)、PC は会計パネルの下。 */}
      {/* どちらも QR の会計 (payUrl) があるときだけ (金額を消した後に押すと、次の入力で QR が勝手に開くのを防ぐ)。 */}
      {payUrl && (showQrBlocked || secondaryAction) && (
        <div className="space-y-3 lg:order-last lg:mt-3">
          {showQrBlocked && (
            <p role="status" className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900">
              {showQrBlocked}
            </p>
          )}
          {secondaryAction && (
            <button
              type="button"
              onClick={secondaryAction.onClick}
              className="w-full rounded-xl border border-slate-300 bg-white px-5 py-3 text-sm font-semibold text-slate-700 hover:border-brand hover:text-brand-dark"
            >
              {secondaryAction.label}
            </button>
          )}
        </div>
      )}
      <div className="hidden rounded-2xl bg-white p-5 shadow-card ring-1 ring-slate-200/70 lg:block">
        <p className="text-xs font-medium text-slate-500">{t('bottomAmountLabel')}</p>
        <p
          className={`mt-1 break-all text-3xl font-bold tabular-nums tracking-tight ${
            amountText ? 'text-slate-900' : 'text-slate-300'
          }`}
        >
          {amountText ?? '—'}
        </p>
        {fiatHint && <p className="mt-0.5 text-sm font-medium text-slate-500">{fiatHint}</p>}
        {/* 店員が金額を確かめてから、全画面の QR をお客様に見せる (対面の流れ)。 */}
        <button
          type="button"
          onClick={() => setQrModalOpen(true)}
          disabled={disabled}
          className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-brand px-5 py-4 text-base font-bold text-white shadow-card transition-[transform,box-shadow] hover:-translate-y-0.5 hover:bg-brand-dark hover:shadow-card-hover active:translate-y-0 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400 disabled:shadow-none disabled:hover:translate-y-0"
        >
          <QrCodeIcon className="h-5 w-5" aria-hidden />
          {t('showQr')}
        </button>
        {notReady && (
          <p className="mt-3 text-center text-xs text-slate-500">{notReady}</p>
        )}
        {/* 受取先は済んだが金額が空 → サンプル金額ワンタップで最初の QR を試せる。 */}
        {!payUrl && receiverValid && !amountValid && (
          <button
            type="button"
            onClick={() => setAmount(sampleAmount)}
            className="mx-auto mt-2 block text-xs font-semibold text-brand hover:underline"
          >
            {t('qrEmptyState.trySample', { amount: sampleAmount })}
          </button>
        )}
      </div>
    </aside>
  );
}

// モバイル下部固定 会計バー (2026-10 磨き上げ P2): 常に出す (押せないときは未入力の項目を金額の位置に出す)。
// 下のナビと 1 枚に見えるよう、同じ半透明の白・影なし・境目は細い線だけ (user 裁定: ナビは残して一体化)。
export function QrMobileBar({
  payUrl,
  amount,
  mode,
  deployment,
  amountLabelText,
  notReady,
  fiatHint,
  setQrModalOpen,
  showQrBlocked,
}: {
  payUrl: string;
  amount: string;
  mode: Mode;
  deployment: TokenDeployment;
  amountLabelText: string;
  /** 押せない理由 (未入力の項目)。null = 入力は揃っている。 */
  notReady: string | null;
  fiatHint: string | null;
  setQrModalOpen: Dispatch<SetStateAction<boolean>>;
  /** 「QRコードを表示する」を押せない理由 (理由は本文側に出す)。省略時は今のまま。 */
  showQrBlocked?: string;
}) {
  const t = useTranslations('QrGenerator');
  const bottomBarRef = useRef<HTMLDivElement>(null);
  const ready = Boolean(payUrl);
  // WebKit (モバイル Safari・SNS アプリ内ブラウザ) では position:sticky な下部バーの子テキストを
  // JS で書き換えても合成レイヤーが再ラスタライズされず古い表示が残ることがある (RegisterMode
  // と同根)。表示金額/通貨/モード/押せるかが変わるたび transform を 1 フレーム
  // 入れて再描画を強制する (金額を先に入力し、後から受取先が確定する場合も含む)。
  useEffect(() => {
    const el = bottomBarRef.current;
    if (!el) return;
    el.style.transform = 'translateZ(0)';
    const id = requestAnimationFrame(() => {
      if (el) el.style.transform = '';
    });
    return () => cancelAnimationFrame(id);
  }, [ready, amount, mode, deployment.displaySymbol, notReady]);
  return (
    <div
      ref={bottomBarRef}
      className="sticky bottom-14 z-20 -mx-4 flex items-center gap-3 border-t border-slate-200/70 bg-white/85 px-4 py-2.5 backdrop-blur-md supports-[backdrop-filter]:bg-white/75 md:bottom-0 lg:hidden print:hidden"
    >
      <div className="min-w-0 flex-1">
        <div className="text-[11px] text-slate-500">
          {t('bottomAmountLabel')}
        </div>
        {ready ? (
          <div className="flex items-baseline gap-2">
            <span className="truncate text-lg font-bold tabular-nums text-slate-900">
              {amountLabelText}
            </span>
            {fiatHint && (
              <span className="shrink-0 text-xs font-medium text-slate-500">
                {fiatHint}
              </span>
            )}
          </div>
        ) : (
          <div className="truncate text-sm font-medium text-slate-500">{notReady}</div>
        )}
      </div>
      <button
        type="button"
        onClick={() => setQrModalOpen(true)}
        disabled={!ready || showQrBlocked !== undefined}
        className="inline-flex shrink-0 items-center justify-center gap-2 rounded-xl bg-brand px-4 py-3 text-base font-bold text-white transition-transform hover:bg-brand-dark active:scale-[0.98] disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400"
      >
        <QrCodeIcon className="h-5 w-5" aria-hidden />
        {t('showQr')}
      </button>
    </div>
  );
}
