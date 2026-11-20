'use client';

// 「何度でも使える」リンクの「サイトにボタンを設置」(お店だけに表示の欄の折りたたみ・2026-11-20 運営者の裁定)。
// 固定価格の商品を売るお店が、自分のサイトの商品ページに「JPYCで支払う」ボタンを置く。リンクは注文リンクと同じ URL
// (buildOrderLink の url) をそのまま使い、作り方は変えない。
// - WordPress: ボタン用の URL (= 注文リンク) をコピーし、ボタンのブロックのリンク先に貼ってもらう。
// - HTML: 単一の <a> のボタン (lib/orderLinkSiteButton.ts) をコピーする。見本はコピーする HTML と同じ文字列で描く
//   (見本と貼ったボタンの見た目をそろえる・自前で作った文字列で、URL と文字は実体参照化済み)。
// コピーできない環境やコピーに失敗したときも、読み取り専用の欄から手で写せる (欄は focus で全選択)。
// サイトに置くと誰でもリンクを見られ、お客様は金額を書き換えられるので、届いた額と「入金を確かめる」への導線を欄の中にも出す。
// ここでのコピーは「リンクを送った」ことにしない (番号の無いリンクで、注文の画面の「コピーしました」とは別)。

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle, Check, ChevronDown, Copy } from 'lucide-react';
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard';
import { groupAmountDigits } from '@/lib/amount';
import { chainForSlug } from '@/lib/chains';
import type { OrderLinkChainAmount } from '@/lib/orderLink';
import { orderLinkSiteButtonHtml } from '@/lib/orderLinkSiteButton';
import { ORDER_LINK_PILL_GROUP, orderLinkPillClass } from './pills';

const KINDS = ['wordpress', 'html'] as const;
type Kind = (typeof KINDS)[number];
/** 最後にコピーを試した値と結果。表示中の値と同じときだけ出す (リンクが作り直されたら消える)。 */
type CopyAttempt = { kind: Kind; value: string; ok: boolean };

const COPY_BUTTON =
  'inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-white px-4 text-sm font-semibold text-brand ring-1 ring-slate-200 hover:bg-slate-50 hover:text-brand-dark';
const READONLY_FIELD = 'w-full scroll-mb-44 rounded-xl bg-white px-3 font-mono text-xs text-slate-700 ring-1 ring-slate-200';
const URL_FIELD_ID = 'order-link-site-button-url';
const HTML_FIELD_ID = 'order-link-site-button-html';

export function OrderLinkSiteButton({
  url,
  receive,
  byChain,
  canCopy,
}: {
  /** 注文リンク (buildOrderLink の url)。 */
  url: string;
  /** お店に届く額 (主のチェーン)。 */
  receive: string;
  /** チェーンごとの届く額 (最低額がチェーンで違うことがある)。 */
  byChain: readonly OrderLinkChainAmount[];
  canCopy: boolean;
}) {
  const t = useTranslations('OrderLinkBuilder');
  const copier = useCopyToClipboard();
  const [kind, setKind] = useState<Kind>('wordpress');
  const [attempt, setAttempt] = useState<CopyAttempt | null>(null);
  // 1 度コピーに失敗したら、URL の欄を出したままにする (注文の画面のリンクの欄と同じ)。
  const [urlFieldOpen, setUrlFieldOpen] = useState(false);
  const urlRef = useRef<HTMLInputElement>(null);
  const htmlRef = useRef<HTMLTextAreaElement>(null);

  const label = t('siteButton.label');
  const html = orderLinkSiteButtonHtml(url, label);
  const value = kind === 'wordpress' ? url : html;
  const shown = attempt !== null && attempt.kind === kind && attempt.value === value ? attempt : null;

  const copy = async () => {
    const copying = { kind, value };
    const ok = await copier.copy(value);
    if (!ok && copying.kind === 'wordpress') setUrlFieldOpen(true);
    setAttempt({ ...copying, ok });
  };
  useEffect(() => {
    // コピーできなかったら、手で写せる欄へ案内する (欄は focus で全選択になる)。試すたびに 1 回だけ (切り替えで戻っても動かさない)。
    // 結果が届く前に設置のしかたを切り替えていたら、その欄は描かれていない (ref が空) ので動かさない。
    if (attempt === null || attempt.ok) return;
    (attempt.kind === 'wordpress' ? urlRef.current : htmlRef.current)?.focus();
  }, [attempt]);

  const sameReceive = byChain.every((entry) => entry.receive === receive);
  // コピーのボタンと、その直下の結果 (表示中の値をコピーした結果だけ)。結果の欄は読み上げのため空でも残す (空なら高さを取らない)。
  const copyAction = (text: string) =>
    canCopy && (
      <div>
        <button type="button" onClick={() => void copy()} className={COPY_BUTTON}>
          <Copy className="h-4 w-4" aria-hidden />
          {text}
        </button>
        <p role="status" className="mt-1.5 text-sm font-medium empty:hidden">
          {shown === null ? null : shown.ok ? (
            <span className="inline-flex items-center gap-1.5 text-emerald-700">
              <Check className="h-4 w-4 flex-none" aria-hidden />
              {t('copied')}
            </span>
          ) : (
            <span className="text-rose-700">{t('copyFailed')}</span>
          )}
        </p>
      </div>
    );

  return (
    <details className="group/site rounded-xl bg-white ring-1 ring-slate-200">
      <summary className="flex h-11 cursor-pointer list-none items-center justify-between px-3 text-sm font-medium text-slate-700 [&::-webkit-details-marker]:hidden">
        {t('siteButton.title')}
        <ChevronDown
          className="h-4 w-4 text-slate-500 transition-transform group-open/site:rotate-180 motion-reduce:transition-none"
          aria-hidden
        />
      </summary>
      <div className="space-y-3 border-t border-slate-100 px-3 pb-3 pt-3">
        <fieldset>
          <legend className="sr-only">{t('siteButton.kindLabel')}</legend>
          <div className={`${ORDER_LINK_PILL_GROUP} grid-cols-2`}>
            {KINDS.map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={kind === option}
                onClick={() => setKind(option)}
                className={orderLinkPillClass(kind === option)}
              >
                {t(`siteButton.kinds.${option}`)}
              </button>
            ))}
          </div>
        </fieldset>

        {kind === 'wordpress' ? (
          <>
            <p className="text-xs leading-relaxed text-slate-600">{t('siteButton.wordpressHint', { label })}</p>
            {copyAction(t('siteButton.copyUrl'))}
            {(!canCopy || urlFieldOpen) && (
              <div>
                <label htmlFor={URL_FIELD_ID} className="mb-1 block text-xs font-medium text-slate-600">
                  {t('siteButton.urlLabel')}
                </label>
                <input
                  ref={urlRef}
                  id={URL_FIELD_ID}
                  readOnly
                  value={url}
                  onFocus={(event) => event.target.select()}
                  className={`h-11 ${READONLY_FIELD}`}
                />
              </div>
            )}
          </>
        ) : (
          <>
            <div>
              <p className="mb-1 text-xs font-medium text-slate-600">{t('siteButton.previewLabel')}</p>
              {/* コピーする HTML と同じ文字列をそのまま描く。中身は orderLinkSiteButtonHtml が作った <a> 1 つだけ。
                  flex にしない (<a> が block になり、貼った先の inline-block と幅が変わる)。 */}
              <div
                data-site-button-preview=""
                className="rounded-lg bg-slate-50 px-3 py-4 text-center ring-1 ring-slate-200"
                dangerouslySetInnerHTML={{ __html: html }}
              />
            </div>
            <p className="text-xs leading-relaxed text-slate-600">{t('siteButton.htmlHint')}</p>
            {copyAction(t('siteButton.copyHtml'))}
            <div>
              <label htmlFor={HTML_FIELD_ID} className="mb-1 block text-xs font-medium text-slate-600">
                {t('siteButton.htmlLabel')}
              </label>
              <textarea
                ref={htmlRef}
                id={HTML_FIELD_ID}
                readOnly
                rows={4}
                value={html}
                onFocus={(event) => event.target.select()}
                className={`block resize-none py-2 leading-relaxed ${READONLY_FIELD}`}
              />
            </div>
          </>
        )}

        <p className="text-xs leading-relaxed text-slate-600">{t('siteButton.update')}</p>

        <div className="flex gap-2">
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-none text-amber-600" aria-hidden />
          <div className="min-w-0">
            {/* 届く額は、お店だけに表示の欄の「届いてから発送」と同じ (チェーンで違えばチェーンごと)。 */}
            {sameReceive ? (
              <p className="text-sm font-semibold text-slate-800">
                {t('cautionTitle', { amount: groupAmountDigits(receive) })}
              </p>
            ) : (
              <>
                <p className="text-sm font-semibold text-slate-800">{t('cautionTitleVaries')}</p>
                <ul className="mt-0.5 text-sm font-semibold text-slate-800">
                  {byChain.map((entry) => (
                    <li key={entry.chain}>
                      {t('cautionChainAmount', {
                        chain: chainForSlug(entry.chain).name,
                        amount: groupAmountDigits(entry.receive),
                      })}
                    </li>
                  ))}
                </ul>
              </>
            )}
            <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs leading-relaxed text-slate-600">
              <li>{t('cautionEditable')}</li>
              <li>{t('siteButton.public')}</li>
              <li>
                {t.rich('siteButton.verify', {
                  link: (chunks) => (
                    <a
                      href="#order-link-verify-heading"
                      className="font-medium text-brand underline underline-offset-2 hover:text-brand-dark"
                    >
                      {chunks}
                    </a>
                  ),
                })}
              </li>
            </ul>
          </div>
        </div>
      </div>
    </details>
  );
}
