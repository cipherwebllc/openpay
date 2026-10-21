'use client';

// 公開カタログと出品者パネルの両方が使う表示 helper (カード頭部・URL コピー・「続きを読む」の展開状態)。
// 公開カタログから import されるので wagmi / SIWE / 出品者専用の部品に依存しない。コピー済み表示と
// 展開状態は分割前と同じく全カードで 1 つを共有する (別カードをコピーすると前のコピー済み表示は消える)。

import { useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import {
  Activity,
  BadgeCheck,
  Boxes,
  Check,
  ChevronDown,
  Code2,
  Copy,
  Database,
  FileText,
  Sparkles,
} from 'lucide-react';
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard';
import { splitDisplayTitle } from '@/lib/x402/displayTitle';
import type { MonitorFreshness } from '@/lib/directory/monitorFreshness';

// カテゴリー文字列 → 視覚アイコン (api / data / mcp / content)。未知は汎用 (Code2)。
function categoryIcon(category: string) {
  const c = category.toLowerCase();
  if (c.includes('data')) return Database;
  if (c.includes('mcp')) return Boxes;
  if (c.includes('content') || c.includes('doc') || c.includes('text')) return FileText;
  return Code2;
}

/**
 * カードに出す短い URL。scheme を外し、path は最後の区切りだけ残す (open-pay.jp/…/search)。
 * 末尾で切ると同じ host の商品が全部「open-pay.jp/api/pa…」になり見分けられないため。
 * 不正 URL は生文字列のまま (owned 一覧の入力途中値)。
 */
function shortUrl(value: string): string {
  try {
    const url = new URL(value);
    const segments = url.pathname.split('/').filter(Boolean);
    if (segments.length === 0) return url.host;
    if (segments.length === 1) return `${url.host}/${segments[0]}`;
    return `${url.host}/…/${segments[segments.length - 1]}`;
  } catch {
    return value;
  }
}

export function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

// X402DiscoveryView が 1 回だけ呼ぶ。サインイン前後の節の並び替えで panel が再マウントされても
// コピー済み表示と展開状態を失わないよう、状態は panel ではなく呼び出し元 (facade) に置く。
export function useDiscoveryDisplay(
  freshnessByPath?: Readonly<Record<string, MonitorFreshness>>,
) {
  const t = useTranslations('Facilitator');
  // 絶対 URL のカードを path キーの鮮度表に引く (JPYC 面と USDC 面で同じ商品を指す)。
  const freshnessFor = (url: string): MonitorFreshness | undefined => {
    if (!freshnessByPath) return undefined;
    try {
      return freshnessByPath[new URL(url).pathname];
    } catch {
      return undefined; // 出品 URL が不正でもカード描画本体を巻き込まない (owned 一覧の入力途中値)
    }
  };
  // コピー済みフィードバック (key 単位・1.5s でリセット)。
  const { copied, copy } = useCopyToClipboard();
  const [lastCopiedKey, setCopiedKey] = useState<string | null>(null);
  const copiedKey = copied ? lastCopiedKey : null;
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(() => new Set());
  async function copyText(key: string, text: string) {
    if (await copy(text)) setCopiedKey(key);
  }

  // URL をコピーするチップ。表示は scheme を外した短い形・押すと全 URL をコピー。
  // a11y 名は可視テキスト (URL) を含める (掟 8)。component でなく関数で返し no-unstable-nested-components を避ける。
  const urlChip = (key: string, url: string) => {
    // コピー済みの判定は URL ごと: 同じカードでも通貨の切り替えでコピー先が変わったら、前の表示を持ち越さない。
    const chipKey = `${key}|${url}`;
    const copied = copiedKey === chipKey;
    return (
      <button
        type="button"
        onClick={() => copyText(chipKey, url)}
        title={url}
        className="inline-flex min-w-0 items-center gap-1.5 rounded-lg bg-slate-50 px-2.5 py-1.5 text-xs text-slate-600 ring-1 ring-inset ring-slate-200 transition hover:bg-slate-100 hover:text-slate-800"
      >
        {copied ? (
          <Check className="h-3.5 w-3.5 shrink-0 text-emerald-600" aria-hidden />
        ) : (
          <Copy className="h-3.5 w-3.5 shrink-0" aria-hidden />
        )}
        <span className="sr-only">{copied ? t('copied') : t('copy')} </span>
        <span className="truncate">{shortUrl(url)}</span>
      </button>
    );
  };

  // resource カード共通の本体 (公開カタログと出品者の一覧で共有)。常時表示は 5 要素に絞る:
  // 種類アイコン + 名前 (+公式) / 価格 (呼び元の priceNode) / 1〜2 行の要約 / URL のコピー + Docs / 「詳しく」。
  // トリガー・全 URL・利用条件・検証日などは「詳しく」を開いたときだけ (2026-10-21 磨き上げ・視覚的な疲れを減らす)。
  // 価格の内訳 (JPYC の手数料・USDC の上乗せなし) は priceNode 側で常時表示する (2026-07-31 user 裁定)。
  const cardHead = (opts: {
    category: string;
    priceNode: ReactNode;
    /** 未指定の見出しは serviceName / description / URL から導出する。 */
    title?: string;
    usdc?: { serviceName?: string };
    license?: string;
    description: string;
    /** 購入トリガー (任意)。「詳しく」の中に出す (JA ページで英文が主役にならないように)。 */
    trigger?: string;
    url: string;
    copyKey: string;
    official?: boolean;
    /** 常時表示の Docs リンク (https のみ・呼び元で検査済み)。 */
    docsUrl?: string | null;
    /** 「詳しく」の中に足す行 (検証日・支払い方法など)。 */
    detailLines?: ReactNode[];
    /** 本文の差し替え (公式商品の日本語の要約・lib/x402/catalogSummaryJa.ts)。 */
    summary?: string;
    /** false = 「詳しく」に全 URL の行を出さない (双子のように通貨ごとの URL を detailLines で出すとき)。 */
    fullUrlInDetails?: boolean;
    /** 見出しに続けて置く状態チップ (出品者の一覧の公開中 / 非表示)。 */
    badge?: ReactNode;
  }) => {
    // 見出し = 名前 (無ければ description の先頭文)・本文 = 見出しと重複しない残り (要約があればそれ)。
    const split = splitDisplayTitle({ ...opts, resource: opts.url });
    const title = split.title;
    const body = opts.summary ?? split.body;
    const expanded = expandedKeys.has(opts.copyKey);
    const Icon = categoryIcon(opts.category);
    const urlIsHttps = isHttpsUrl(opts.url);
    // 更新型商品の「生きている」証拠 (最終イベント日・総件数)。該当商品にだけ出す。
    const freshness = freshnessFor(opts.url);
    const detailLines = [
      ...(opts.trigger
        ? [
            <span key="trigger" className="flex items-start gap-1.5">
              <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand" aria-hidden />
              <span>{opts.trigger}</span>
            </span>,
          ]
        : []),
      ...(opts.fullUrlInDetails === false
        ? []
        : [
            urlIsHttps ? (
              <a
                key="url"
                href={opts.url}
                target="_blank"
                rel="noreferrer noopener"
                className="break-all font-mono text-slate-500 underline-offset-2 hover:text-brand hover:underline"
              >
                {opts.url}
              </a>
            ) : (
              <span key="url" className="break-all font-mono text-slate-500">
                {opts.url}
              </span>
            ),
          ]),
      ...(opts.license
        ? [<span key="license">{t('licenseMeta', { license: opts.license })}</span>]
        : []),
      ...(opts.detailLines ?? []),
    ];
    return (
      <div className="flex gap-3">
        <span
          aria-hidden
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-slate-100 text-slate-600"
        >
          <Icon className="h-[18px] w-[18px]" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <p
              className={`min-w-0 text-[15px] font-bold leading-snug text-slate-900 ${expanded ? '' : 'line-clamp-3'}`}
            >
              {title}
              {/* 状態・公式は見出しに続けて置く (別の行にすると全カードが 1 行ずつ高くなる)。間は通常の空白に
                  して、折り返したときに行頭で字下げされないようにする。 */}
              {opts.badge && (
                <>
                  {' '}
                  <span className="inline-block align-middle">{opts.badge}</span>
                </>
              )}
              {opts.official && (
                <>
                  {' '}
                <span className="inline-flex translate-y-[-1px] items-center gap-0.5 whitespace-nowrap align-middle text-[11px] font-semibold text-brand">
                  <BadgeCheck className="h-3.5 w-3.5" aria-hidden />
                  {t('officialBadge')}
                </span>
                </>
              )}
            </p>
            {opts.priceNode}
          </div>
          {body && body !== title && (
            <p
              className={`mt-1.5 text-[13px] leading-relaxed text-slate-600 ${expanded ? '' : 'line-clamp-2'}`}
            >
              {body}
            </p>
          )}
          {freshness && (
            <p className="mt-1.5 flex items-center gap-1.5 text-xs text-emerald-700">
              <Activity className="h-3.5 w-3.5 shrink-0" aria-hidden />
              <span>
                {t('monitorFreshness', {
                  date: freshness.latestEventDate,
                  count: freshness.totalEvents,
                })}
              </span>
            </p>
          )}
          <div className="mt-3 flex items-center gap-2">
            {/* URL のコピーが買い手 (エージェントの設定者) の主な操作。 */}
            {urlChip(opts.copyKey, opts.url)}
            {opts.docsUrl && (
              <a
                href={opts.docsUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="shrink-0 text-xs font-semibold text-brand hover:text-brand-dark hover:underline"
              >
                {t('docsLink')}
              </a>
            )}
            <button
              type="button"
              aria-expanded={expanded}
              className="ml-auto inline-flex shrink-0 items-center gap-0.5 text-xs font-semibold text-slate-500 hover:text-slate-800"
              onClick={() => setExpandedKeys((keys) => {
                const next = new Set(keys);
                if (next.has(opts.copyKey)) next.delete(opts.copyKey);
                else next.add(opts.copyKey);
                return next;
              })}
            >
              {expanded ? t('readLess') : t('detailsLabel')}
              <ChevronDown
                className={`h-3.5 w-3.5 transition ${expanded ? 'rotate-180' : ''}`}
                aria-hidden
              />
            </button>
          </div>
          {expanded && (
            <ul className="mt-3 space-y-1.5 border-t border-slate-100 pt-3 text-xs leading-relaxed text-slate-600">
              {detailLines.map((line, i) => (
                <li key={i}>{line}</li>
              ))}
            </ul>
          )}
        </div>
      </div>
    );
  };

  return { copiedKey, copyText, expandedKeys, cardHead, urlChip };
}

export type DiscoveryDisplay = ReturnType<typeof useDiscoveryDisplay>;
