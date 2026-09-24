'use client';

// 公開カタログと出品者パネルの両方が使う表示 helper (カード頭部・URL コピー・「続きを読む」の展開状態)。
// 公開カタログから import されるので wagmi / SIWE / 出品者専用の部品に依存しない。コピー済み表示と
// 展開状態は分割前と同じく全カードで 1 つを共有する (別カードをコピーすると前のコピー済み表示は消える)。

import { useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Activity, Boxes, Check, Code2, Copy, Database, FileText, Sparkles } from 'lucide-react';
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

  // コピーボタン (URL / スニペット)。key 単位でコピー済みフィードバック。component ではなく関数で
  // 返すことで no-unstable-nested-components を避ける。
  const copyBtn = (k: string, text: string) => (
    <button
      type="button"
      onClick={() => copyText(k, text)}
      aria-label={copiedKey === k ? t('copied') : t('copy')}
      title={copiedKey === k ? t('copied') : t('copy')}
      className="shrink-0 rounded-md p-1 text-slate-500 transition hover:bg-slate-100 hover:text-slate-700"
    >
      {copiedKey === k ? (
        <Check className="h-3.5 w-3.5 text-emerald-600" aria-hidden />
      ) : (
        <Copy className="h-3.5 w-3.5" aria-hidden />
      )}
    </button>
  );

  // resource カード共通の頭部 (アイコン + カテゴリ + 価格 + 説明 + URL/コピー)。owned 一覧と公開カタログで
  // 共有する。priceNode は右肩の価格表示 (owned=価格のみ / catalog=価格+手数料+合計) を呼び元が差し込む。
  const cardHead = (opts: {
    category: string;
    priceNode: ReactNode;
    /** 未指定の見出しは serviceName / description / URL から導出する。 */
    title?: string;
    usdc?: { serviceName?: string };
    license?: string;
    description: string;
    /** 購入トリガー (任意)。見出しの下に控えめに出す (JA ページで英文が主役にならないように)。 */
    trigger?: string;
    url: string;
    copyKey: string;
    official?: boolean;
    /** 通貨チップ (JPYC/USDC 混在時のみ)。 */
    currency?: 'jpyc' | 'usdc';
    /** dual (JPYC 出品の USDC 併売): JPYC チップの隣に USDC チップも出す。 */
    dualUsdc?: boolean;
  }) => {
    // 見出し = 名前 (無ければ description の先頭文)・本文 = 見出しと重複しない残り。
    const { title, body } = splitDisplayTitle({ ...opts, resource: opts.url });
    const expanded = expandedKeys.has(opts.copyKey);
    // 「続きを読む」は clamp で隠れ得る長文か、折りたたみ時に出さない利用条件があるカードだけ。
    const canExpand =
      title.length > 60 ||
      body.length > 120 ||
      (opts.trigger?.length ?? 0) > 120 ||
      Boolean(opts.license);
    const Icon = categoryIcon(opts.category);
    const urlIsHttps = isHttpsUrl(opts.url);
    // 更新型商品の「生きている」証拠 (最終イベント日・総件数)。該当商品にだけ出す。
    const freshness = freshnessFor(opts.url);
    // 階層: チップ行 + 価格 → 見出し → 補足 (トリガー / title があるときの説明) → URL。
    // 説明を価格の隣の狭い列に入れると英文が 1 語ずつ折り返して読めない (2 カラム時に実害)。
    return (
      <div>
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-slate-600">
              <Icon className="h-3 w-3 text-brand" aria-hidden />
              {opts.category}
            </span>
            {opts.currency && (
              <span
                className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold tracking-wide ${
                  opts.currency === 'usdc'
                    ? 'bg-sky-50 text-sky-700 ring-1 ring-sky-200'
                    : 'bg-amber-50 text-amber-700 ring-1 ring-amber-200'
                }`}
              >
                {opts.currency === 'usdc' ? 'USDC' : 'JPYC'}
              </span>
            )}
            {opts.dualUsdc && opts.currency !== 'usdc' && (
              <span className="shrink-0 rounded-full bg-sky-50 px-2 py-0.5 text-[10px] font-bold tracking-wide text-sky-700 ring-1 ring-sky-200">
                USDC
              </span>
            )}
            {opts.official && (
              <span className="shrink-0 rounded-full bg-brand/10 px-2 py-0.5 text-[10px] font-semibold text-brand-dark">
                {t('officialBadge')}
              </span>
            )}
          </div>
          {opts.priceNode}
        </div>
        <p
          className={`mt-2 text-sm font-bold leading-snug text-slate-900 ${expanded ? '' : 'line-clamp-2'}`}
        >
          {title}
        </p>
        {body && body !== title && (
          <p className={`mt-1 text-xs leading-relaxed text-slate-500 ${expanded ? '' : 'line-clamp-3'}`}>
            {body}
          </p>
        )}
        {opts.trigger && (
          <p className="mt-1 flex items-start gap-1.5 text-xs leading-relaxed text-slate-500">
            <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand" aria-hidden />
            <span className={expanded ? '' : 'line-clamp-2'}>{opts.trigger}</span>
          </p>
        )}
        {canExpand && (
          <button
            type="button"
            aria-expanded={expanded}
            className="mt-1 text-xs font-medium text-brand hover:text-brand-dark hover:underline"
            onClick={() => setExpandedKeys((keys) => {
              const next = new Set(keys);
              if (next.has(opts.copyKey)) next.delete(opts.copyKey);
              else next.add(opts.copyKey);
              return next;
            })}
          >
            {expanded ? t('readLess') : t('readMore')}
          </button>
        )}
        {freshness && (
          <p className="mt-1 flex items-center gap-1.5 text-xs leading-relaxed text-emerald-700">
            <Activity className="h-3.5 w-3.5 shrink-0" aria-hidden />
            <span>
              {t('monitorFreshness', {
                date: freshness.latestEventDate,
                count: freshness.totalEvents,
              })}
            </span>
          </p>
        )}
        <div className="mt-1.5 flex items-center gap-1.5">
          {urlIsHttps ? (
            <a
              href={opts.url}
              target="_blank"
              rel="noreferrer noopener"
              className="min-w-0 truncate font-mono text-xs text-slate-500 underline-offset-2 transition hover:text-brand hover:underline"
            >
              {opts.url}
            </a>
          ) : (
            <span className="min-w-0 truncate font-mono text-xs text-slate-500">
              {opts.url}
            </span>
          )}
          {copyBtn(opts.copyKey, opts.url)}
        </div>
      </div>
    );
  };

  return { copiedKey, copyText, expandedKeys, cardHead };
}

export type DiscoveryDisplay = ReturnType<typeof useDiscoveryDisplay>;
