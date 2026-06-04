'use client';

// 決済用 QR を全画面モーダルで提示するためのコンポーネント (決済QR / レジ 共通)。
// 店員が金額の誤入力を確認した上で、お客様にスマホ/タブレット画面を見せやすく
// するのが狙い。入力画面では即時に QR を出さず「QRコードを表示する」ボタン経由で
// 開く。a11y / ESC / focus の作法は SuccessOverlay に倣う。
//
// 状態は持たず props で受ける (labels-as-props)。印刷はポスター部に print: クラスを
// 持たせ、モーダルの chrome (header / ボタン) は print:hidden で隠す。

import { useEffect, useRef, type RefObject } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { Printer, X } from 'lucide-react';

export type QrPreviewModalLabels = {
  title: string;
  close: string;
  eyebrow: string;
  /** 印刷ボタン文言。onPrint とセット (省略時は印刷ボタンを出さない)。 */
  print?: string;
  copy: string;
  copied: string;
  downloadSvg?: string;
  downloadPng?: string;
};

export type QrPreviewEip681 = {
  uri: string;
  copied: boolean;
  onCopy: () => void;
  title: string;
  badge: string;
  description: string;
  copy: string;
  copiedLabel: string;
};

export function QrPreviewModal({
  open,
  onClose,
  labels,
  qrValue,
  qrRef,
  storeName,
  amountText,
  payModeBadge,
  note,
  chainText,
  receiverShort,
  copied,
  onCopy,
  onPrint,
  onDownloadSvg,
  onDownloadPng,
  eip681,
}: {
  open: boolean;
  onClose: () => void;
  labels: QrPreviewModalLabels;
  qrValue: string;
  qrRef: RefObject<HTMLDivElement | null>;
  storeName: string;
  amountText: string;
  payModeBadge?: { text: string; tone: 'gasless' | 'standard' };
  note?: string;
  chainText: string;
  receiverShort?: string;
  copied: boolean;
  onCopy: () => void;
  onPrint?: () => void;
  onDownloadSvg?: () => void;
  onDownloadPng?: () => void;
  eip681?: QrPreviewEip681;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);

  // ESC で閉じる + dialog に focus (a11y・SuccessOverlay と同様)。
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    dialogRef.current?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={labels.title}
      tabIndex={-1}
      className={`fixed inset-0 z-50 flex flex-col items-center overflow-y-auto bg-slate-900/70 px-4 py-8 ${
        // 印刷対応 (QR) はポスターを全画面印刷。印刷非対応 (レジ) はモーダルごと
        // 印刷対象外にして背後のカートとの重なり (bleed) を防ぐ。
        onPrint ? 'print:static print:bg-white print:p-0' : 'print:hidden'
      }`}
    >
      <div className="relative w-full max-w-md rounded-2xl bg-white p-5 shadow-xl print:static print:max-w-none print:rounded-none print:p-0 print:shadow-none">
        {/* header: タイトル + × 閉じる (印刷では隠す) */}
        <div className="mb-4 flex items-center justify-between gap-3 print:hidden">
          <h2 className="text-base font-semibold text-slate-800">
            {labels.title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-semibold text-slate-700 hover:border-slate-400"
          >
            <X className="h-4 w-4" aria-hidden />
            {labels.close}
          </button>
        </div>

        {/* ポスター調プレビュー (印刷対象。print: で全画面に展開) */}
        <section className="rounded-2xl border border-slate-200 bg-white p-5 print:fixed print:inset-0 print:z-50 print:flex print:min-h-screen print:flex-col print:items-center print:justify-center print:border-0 print:p-10">
          <div className="mx-auto flex max-w-sm flex-col items-center text-center">
            <p className="text-xs font-semibold uppercase tracking-wider text-slate-500 print:text-base">
              {labels.eyebrow}
            </p>
            <h3 className="mt-2 text-2xl font-bold text-slate-900 print:text-5xl">
              {storeName}
            </h3>
            <p className="mt-2 text-sm text-slate-500 print:text-xl">
              {amountText}
            </p>
            {payModeBadge && (
              <p
                className={`mt-3 inline-block rounded-full border px-3 py-1 text-xs font-semibold print:px-4 print:py-1.5 print:text-base ${
                  payModeBadge.tone === 'gasless'
                    ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                    : 'border-amber-200 bg-amber-50 text-amber-700'
                }`}
              >
                {payModeBadge.text}
              </p>
            )}
            <div
              ref={qrRef}
              className="mt-5 rounded-2xl border border-slate-200 bg-white p-4 print:mt-10 print:p-8"
            >
              <QRCodeSVG value={qrValue} size={260} includeMargin level="M" />
            </div>
            {note && (
              <p className="mt-4 text-sm font-medium text-slate-700 print:text-xl">
                {note}
              </p>
            )}
            <p className="mt-3 font-mono text-xs text-slate-500 print:text-base">
              {chainText}
            </p>
            {receiverShort && (
              <p className="mt-1 break-all font-mono text-[10px] text-slate-400 print:max-w-2xl print:text-sm">
                {receiverShort}
              </p>
            )}
          </div>
        </section>

        {/* URL 表示 */}
        <div className="mt-4 w-full break-all rounded-lg bg-slate-50 px-3 py-2 font-mono text-xs text-slate-600 print:hidden">
          {qrValue}
        </div>

        {/* 操作ボタン (印刷では隠す)。Print が primary CTA、他は outline。 */}
        <div className="mt-4 flex flex-wrap justify-center gap-2 print:hidden">
          {onPrint && labels.print && (
            <button
              type="button"
              onClick={onPrint}
              className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand-dark"
            >
              <Printer className="h-4 w-4" aria-hidden />
              {labels.print}
            </button>
          )}
          <button
            type="button"
            onClick={onCopy}
            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:border-brand hover:text-brand-dark"
          >
            {copied ? labels.copied : labels.copy}
          </button>
          {onDownloadSvg && labels.downloadSvg && (
            <button
              type="button"
              onClick={onDownloadSvg}
              className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:border-brand hover:text-brand-dark"
            >
              {labels.downloadSvg}
            </button>
          )}
          {onDownloadPng && labels.downloadPng && (
            <button
              type="button"
              onClick={onDownloadPng}
              className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:border-brand hover:text-brand-dark"
            >
              {labels.downloadPng}
            </button>
          )}
        </div>

        {/* EIP-681 互換 QR (任意・EIP-7702 非対応 wallet 救済の fallback) */}
        {eip681 && (
          <details className="mt-4 rounded-2xl border border-dashed border-slate-300 bg-white print:hidden">
            <summary className="flex cursor-pointer items-center justify-between gap-3 px-4 py-3 text-sm font-semibold text-slate-800 marker:hidden">
              <span className="flex items-center gap-2">
                <span>{eip681.title}</span>
                <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-800">
                  {eip681.badge}
                </span>
              </span>
              <span className="text-slate-400" aria-hidden>
                ▼
              </span>
            </summary>
            <div className="flex flex-col items-center gap-3 border-t border-dashed border-slate-200 px-4 py-4">
              <p className="self-start text-xs text-slate-500">
                {eip681.description}
              </p>
              <QRCodeSVG value={eip681.uri} size={180} includeMargin level="M" />
              <div className="w-full break-all rounded-lg bg-slate-50 px-3 py-2 font-mono text-[11px] text-slate-600">
                {eip681.uri}
              </div>
              <button
                type="button"
                onClick={eip681.onCopy}
                className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:border-brand hover:text-brand-dark"
              >
                {eip681.copied ? eip681.copiedLabel : eip681.copy}
              </button>
            </div>
          </details>
        )}
      </div>
    </div>
  );
}
