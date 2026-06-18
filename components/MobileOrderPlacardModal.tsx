'use client';

// モバイルオーダーの「卓上プラカード」。@handle 店舗 URL (open-pay.jp/@handle) の QR を、
// 店頭・テーブルにそのまま置ける体裁で提示し、そのまま印刷できる。QR は端末内生成
// (qrcode.react) なので通信不要。
//
// 印刷の難所: このモーダルは fixed inset-0 オーバーレイで、背後に長い /create ビルダー
// ページがある。visibility:hidden で隠す方式 (受領レシートと同型) だと、(1) 隠した背景の
// 高さが残って複数ページになり、(2) fixed 要素はブラウザが各印刷ページに繰り返し描画する
// ため、同じプラカードが N ページに複製されてしまう (実機で確認済み)。
// そこで印刷専用のポスター複製を document.body 直下へ portal し、印刷時 (body に
// openpay-printing-placard が付いている間) は body 直下の他要素 (= アプリ本体・モーダル) を
// app/globals.css の @media print で display:none する。これで背景の高さも fixed 繰り返しも
// 消え、ポスター 1 枚だけが印刷される。body クラスは印刷ボタン押下〜afterprint の間だけ付与
// するので通常の印刷には影響しない。
//
// a11y: 開いたら閉じるボタンへフォーカス・ESC / 背景クリックで閉じる・Tab はダイアログ内の
// ボタン (閉じる/印刷/コピー) を循環 (背後へ抜けない)・閉じたら元の要素へフォーカス復元。
// 状態は印刷フラグのみ・他は labels-as-props で受ける (i18n は呼び出し側)。

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { QRCodeSVG } from 'qrcode.react';
import { Printer, X } from 'lucide-react';

const PRINT_BODY_CLASS = 'openpay-printing-placard';

export type MobileOrderPlacardLabels = {
  /** モーダル見出し (画面のみ・aria-label 兼用)。 */
  dialogTitle: string;
  /** ブランド見出し (例: "OpenPay モバイルオーダー")。 */
  eyebrow: string;
  /** 店名の下の説明 (固定文・例: "券売機のようにスマホで注文できます")。 */
  subtitle: string;
  /** QR 直下の操作文 (例: "QR を読み取って注文")。 */
  scanNote: string;
  /** 支払い手段の明示 (例: "お支払いは JPYC のみ")。モバイル注文は JPYC 専用なので常に表示。 */
  payNote: string;
  /** 受取チェーンの前置きラベル (お客様目線で "対応ネットワーク")。 */
  chainsLabel: string;
  print: string;
  copy: string;
  copied: string;
  close: string;
};

export function MobileOrderPlacardModal({
  open,
  onClose,
  url,
  shopName,
  tagline,
  avatar,
  chains,
  labels,
  copied,
  onCopy,
}: {
  open: boolean;
  onClose: () => void;
  /** QR にエンコードするフル店舗 URL (本文にも表示)。 */
  url: string;
  shopName: string;
  /** 店の「ひとこと」(任意・店名の直下に表示)。 */
  tagline?: string;
  /** 店舗アバター画像 URL (任意・https)。 */
  avatar?: string;
  /** 表示用チェーンラベル配列 (例: ['Polygon', 'Kaia'])。空なら受取行を出さない。 */
  chains: string[];
  labels: MobileOrderPlacardLabels;
  copied: boolean;
  onCopy: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  // 印刷中だけ印刷専用ポスターを body 直下へ portal する (画面では hidden)。
  const [printing, setPrinting] = useState(false);
  // onClose を ref 経由で読む (inline arrow の identity 変化で effect が再実行され
  // returnFocus を上書きするのを防ぐ・LinkQrModal と同じ理由)。
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    returnFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onCloseRef.current();
        return;
      }
      // フォーカストラップ: ダイアログ内のボタン (閉じる/印刷/コピー) を循環させ、
      // aria-modal の背後へ Tab で抜けないようにする。
      if (e.key === 'Tab' && dialogRef.current) {
        const focusables = dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled])',
        );
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      returnFocusRef.current?.focus?.();
      returnFocusRef.current = null;
    };
  }, [open]);

  // 印刷フロー: printing=true で印刷ポスターが DOM に commit された後 (effect は commit 後に
  // 走る) に body マーカーを付けて window.print()。afterprint で解除する。発火しないブラウザや
  // モーダルクローズに備え、effect の cleanup でも必ずマーカーを剥がす (残留すると次回の通常
  // 印刷まで body 直下が隠れてしまう)。
  useEffect(() => {
    if (!printing) return;
    document.body.classList.add(PRINT_BODY_CLASS);
    const cleanup = () => {
      document.body.classList.remove(PRINT_BODY_CLASS);
      window.removeEventListener('afterprint', cleanup);
      setPrinting(false);
    };
    window.addEventListener('afterprint', cleanup);
    window.print();
    return () => {
      document.body.classList.remove(PRINT_BODY_CLASS);
      window.removeEventListener('afterprint', cleanup);
    };
  }, [printing]);

  if (!open) return null;

  // ポスター本体 (画面のモーダルと印刷 portal で共有する単一の描画)。
  const poster = (
    <div className="mx-auto flex max-w-sm flex-col items-center text-center">
      {/* ブランド見出し: OpenPay モバイルオーダー (両側に細い罫線) */}
      <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-brand print:gap-4 print:text-lg">
        <span aria-hidden className="h-px w-6 bg-brand/40 print:w-12" />
        {labels.eyebrow}
        <span aria-hidden className="h-px w-6 bg-brand/40 print:w-12" />
      </p>

      {avatar && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={avatar}
          alt=""
          className="mt-4 h-16 w-16 rounded-full object-cover print:mt-6 print:h-28 print:w-28"
        />
      )}

      <h3 className="mt-3 text-2xl font-bold text-slate-900 print:mt-6 print:text-5xl">
        {shopName}
      </h3>
      {tagline && <p className="mt-1 text-sm text-slate-500 print:text-2xl">{tagline}</p>}
      <p className="mt-2 text-sm font-medium text-slate-600 print:mt-3 print:text-2xl">
        {labels.subtitle}
      </p>

      <div className="mt-5 rounded-2xl border border-slate-200 bg-white p-4 print:mt-10 print:p-8">
        <QRCodeSVG value={url} size={240} includeMargin level="M" />
      </div>
      <p className="mt-4 text-base font-semibold text-slate-800 print:mt-6 print:text-3xl">
        {labels.scanNote}
      </p>
      <p className="mt-1 text-sm font-semibold text-brand-dark print:text-2xl">
        {labels.payNote}
      </p>

      {chains.length > 0 && (
        <p className="mt-3 text-xs font-medium text-slate-500 print:mt-4 print:text-xl">
          {labels.chainsLabel}：{chains.join(' ・ ')}
        </p>
      )}
      <p className="mt-1 break-all font-mono text-[11px] text-slate-400 print:text-base">
        {url}
      </p>
    </div>
  );

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={labels.dialogTitle}
      className="fixed inset-0 z-50 flex flex-col items-center overflow-y-auto bg-slate-900/70 px-4 py-8"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-md rounded-2xl bg-white p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* header: タイトル + × 閉じる */}
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="text-base font-semibold text-slate-800">{labels.dialogTitle}</h2>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-semibold text-slate-700 hover:border-slate-400"
          >
            <X className="h-4 w-4" aria-hidden />
            {labels.close}
          </button>
        </div>

        {/* 画面プレビュー (印刷は下の portal が担う。印刷時はこのモーダルごと display:none)。 */}
        <section className="rounded-2xl border border-slate-200 bg-white p-6">{poster}</section>

        {/* 操作ボタン。印刷が primary CTA。 */}
        <div className="mt-4 flex flex-wrap justify-center gap-2">
          <button
            type="button"
            onClick={() => setPrinting(true)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand-dark"
          >
            <Printer className="h-4 w-4" aria-hidden />
            {labels.print}
          </button>
          <button
            type="button"
            onClick={onCopy}
            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:border-brand hover:text-brand-dark"
          >
            {copied ? labels.copied : labels.copy}
          </button>
        </div>
      </div>

      {/* 印刷専用ポスター: body 直下へ portal。画面では hidden、印刷時のみ表示 (globals.css が
          印刷時に body 直下の他要素を display:none にするので、これだけが 1 枚で印刷される)。 */}
      {printing &&
        typeof document !== 'undefined' &&
        createPortal(
          <div className="placard-print-root hidden print:flex print:min-h-screen print:flex-col print:items-center print:justify-center print:p-10">
            {poster}
          </div>,
          document.body,
        )}
    </div>
  );
}
