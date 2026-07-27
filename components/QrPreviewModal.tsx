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
import { CircleCheck, Eye, Printer, ScanLine, X } from 'lucide-react';
import NextImage from 'next/image';
import { TokenLogo, ChainLogo } from '@/components/AssetLogo';
import { QR_CENTER_MARK, QR_CENTER_MARK_RATIO } from '@/lib/qrCenterMark';
import type { TokenSymbol } from '@/lib/tokens';
import type { ChainSlug } from '@/lib/chains';

// QR の描画サイズと、中央マークの一辺 (読取性のため比率は QR_CENTER_MARK_RATIO を上限)。
const QR_SIZE = 260;
const QR_MARK_SIZE = Math.round(QR_SIZE * QR_CENTER_MARK_RATIO);

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
  /** 「この QR は端末内で生成 (通信不要)」の安心表示 (任意)。圏外の現場でも
   *  QR の生成・提示ができることを店員に伝える。印刷ポスターには出さない。 */
  localGenNote?: string;
  /** ポスター読者 (顧客) 向け 3 ステップ行の文言 (①スキャン ②確認 ③完了)。
   *  asset 指定 + 3 つ揃ったときのみポスターに描画 (印刷でも表示)。 */
  step1?: string;
  step2?: string;
  step3?: string;
};

// トークン / チェーンをポスターで「読まずに分かる」形で見せるための情報
// (labels-as-props 流儀)。省略時はポスターは従来表示 (chain は mono テキスト) のまま
// = 他の呼び出し元 (レジ) 非破壊。chainSlug は public/chains/{slug}.svg と一致させる。
export type QrPreviewAsset = {
  tokenSymbol: TokenSymbol;
  chainSlug: string;
  chainLabel: string;
};

// 店員が QR を提示している間の「着金検知ヒント」表示 (任意)。watching=監視中、
// received=おおよその着金を検知。あくまで advisory (正本は Explorer / 履歴)。
// 印刷ポスターには出さない (print:hidden)。prop 省略時は何も描画しない。
export type QrPreviewPaymentStatus = {
  state: 'watching' | 'received';
  text: string;
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
  asset,
  copied,
  onCopy,
  onPrint,
  onDownloadSvg,
  onDownloadPng,
  eip681,
  paymentStatus,
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
  asset?: QrPreviewAsset;
  copied: boolean;
  onCopy: () => void;
  onPrint?: () => void;
  onDownloadSvg?: () => void;
  onDownloadPng?: () => void;
  eip681?: QrPreviewEip681;
  paymentStatus?: QrPreviewPaymentStatus;
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

        {/* ポスター調プレビュー (印刷対象。print: で全画面に展開)。
            print-color-adjust:exact でブランド色 / バッジが白抜けせず印刷される。 */}
        <section className="rounded-2xl border border-slate-200 bg-white p-5 [print-color-adjust:exact] print:fixed print:inset-0 print:z-50 print:flex print:min-h-screen print:flex-col print:items-center print:justify-center print:border-0 print:p-10 print:[print-color-adjust:exact]">
          <div className="mx-auto flex max-w-sm flex-col items-center text-center">
            <p className="text-xs font-semibold uppercase tracking-wider text-slate-500 print:text-base">
              {labels.eyebrow}
            </p>
            {/* break-keep: 「お支払いはこちら」等の 1 字孤立折返しを防ぐ。print はトークン行/
                3ステップ追加後も A4 1 枚に収まるサイズに抑える (5xl だと上下が溢れて欠ける)。 */}
            <h3 className="mt-2 break-keep text-2xl font-bold text-slate-900 print:text-4xl">
              {storeName}
            </h3>
            {/* 金額ヒーロー: 顧客が最初に確認するのは「いくら払うか」なので、token ロゴ +
                金額を最大の要素にする (従来は小さな灰色行 + 別行のトークン名で、金額が
                埋もれていた)。amountText は symbol を含む (例「500 JPYC」) ため、
                トークン名を別途重ねて出さない。 */}
            <div className="mt-3 flex items-center justify-center gap-2.5 print:mt-4 print:gap-4">
              {asset && (
                <TokenLogo
                  symbol={asset.tokenSymbol}
                  size={36}
                  alt=""
                  className="h-9 w-9 shrink-0 print:h-14 print:w-14"
                />
              )}
              <p className="break-keep text-3xl font-bold tracking-tight text-slate-900 print:text-5xl">
                {amountText}
              </p>
            </div>
            {/* チェーン + 決済モードを 1 行に束ねる (どちらも「どう払うか」の属性で、
                別行に散らすと視線が余計に往復する)。asset 未指定の呼び出し元は従来どおり
                mono テキストで chain を出す。 */}
            <div className="mt-3 flex flex-wrap items-center justify-center gap-2 print:mt-4 print:gap-3">
              {asset ? (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-300 bg-slate-50 px-3 py-1 text-xs font-semibold text-slate-700 print:px-4 print:py-1.5 print:text-lg">
                  <ChainLogo
                    slug={asset.chainSlug as ChainSlug}
                    size={16}
                    alt=""
                    className="h-4 w-4 shrink-0 print:h-6 print:w-6"
                  />
                  {asset.chainLabel}
                </span>
              ) : (
                <span className="font-mono text-xs text-slate-500 print:text-base">
                  {chainText}
                </span>
              )}
              {payModeBadge && (
                <span
                  className={`inline-block rounded-full border px-3 py-1 text-xs font-semibold print:px-4 print:py-1.5 print:text-lg ${
                    payModeBadge.tone === 'gasless'
                      ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                      : 'border-amber-200 bg-amber-50 text-amber-700'
                  }`}
                >
                  {payModeBadge.text}
                </span>
              )}
            </div>
            <div
              ref={qrRef}
              className="mt-5 rounded-2xl border border-slate-200 bg-white p-4 print:mt-6 print:p-6"
            >
              {/* 中央に OpenPay マークを置く (ブランド認知 + 「読んでよい QR か」の判断材料)。
                  マークで欠ける分の冗長性を確保するため level は 'H' (30% 誤り訂正) 固定。
                  マークは data URI (lib/qrCenterMark) — 外部参照だと PNG 保存で消える。 */}
              <QRCodeSVG
                value={qrValue}
                size={QR_SIZE}
                includeMargin
                level="H"
                imageSettings={{
                  src: QR_CENTER_MARK,
                  height: QR_MARK_SIZE,
                  width: QR_MARK_SIZE,
                  excavate: true,
                }}
              />
            </div>
            {note && (
              <p className="mt-4 text-sm font-medium text-slate-700 print:text-xl">
                {note}
              </p>
            )}
            {/* 3 ステップ行 (asset + step 文言が揃ったとき・印刷でも表示)。
                ポスターの読者 = 顧客が初見で操作を理解できるように番号 + アイコン + 短文。 */}
            {asset && labels.step1 && labels.step2 && labels.step3 && (
              <ol className="mt-5 flex w-full max-w-xs flex-col gap-2 text-left print:mt-6 print:max-w-md">
                {[
                  { n: 1, Icon: ScanLine, text: labels.step1 },
                  { n: 2, Icon: Eye, text: labels.step2 },
                  { n: 3, Icon: CircleCheck, text: labels.step3 },
                ].map(({ n, Icon, text }) => (
                  <li
                    key={n}
                    className="flex items-center gap-2.5 print:gap-3"
                  >
                    <span className="flex h-6 w-6 flex-none items-center justify-center rounded-full border border-slate-900 text-xs font-bold text-slate-900 print:h-8 print:w-8 print:text-base">
                      {n}
                    </span>
                    <Icon
                      className="h-4 w-4 flex-none text-slate-500 print:h-5 print:w-5"
                      aria-hidden
                    />
                    <span className="text-sm font-medium text-slate-700 print:text-lg">
                      {text}
                    </span>
                  </li>
                ))}
              </ol>
            )}
            {receiverShort && (
              <p className="mt-1 break-all font-mono text-[10px] text-slate-500 print:max-w-2xl print:text-sm">
                {receiverShort}
              </p>
            )}
            {/* 圏外の現場向け安心表示。QR の生成・提示は端末内で完結し通信不要。
                印刷ポスターには不要なので print:hidden。 */}
            {labels.localGenNote && (
              <p className="mt-3 text-xs text-slate-500 print:hidden">
                {labels.localGenNote}
              </p>
            )}
            {/* 着金検知ヒント (任意・advisory)。watching=監視中 (淡い slate + 脈打つドット)、
                received=検知 (emerald + ✓)。印刷ポスターには出さない。prop 省略時は非描画。 */}
            {paymentStatus &&
              (paymentStatus.state === 'received' ? (
                <p
                  role="status"
                  aria-live="polite"
                  className="mt-3 inline-flex items-center gap-1.5 text-sm font-semibold text-emerald-600 print:hidden"
                >
                  <CircleCheck className="h-4 w-4 flex-none" aria-hidden />
                  {paymentStatus.text}
                </p>
              ) : (
                <p
                  role="status"
                  aria-live="polite"
                  className="mt-3 inline-flex items-center gap-1.5 text-xs text-slate-500 print:hidden"
                >
                  <span
                    aria-hidden
                    className="inline-block h-2 w-2 flex-none animate-pulse rounded-full bg-slate-400"
                  />
                  {paymentStatus.text}
                </p>
              ))}
            {/* フッター OpenPay ロゴ (asset 指定時のみ・ブランド信頼)。印刷でも残す。 */}
            {asset && (
              <NextImage
                src="/logo.svg"
                alt="OpenPay"
                width={205}
                height={48}
                className="mt-6 h-4 w-auto opacity-70 print:mt-10 print:h-7"
              />
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
