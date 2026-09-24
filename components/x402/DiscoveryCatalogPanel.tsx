'use client';

// 公開カタログ (誰でも閲覧)。/api/discovery の JPYC 出品と server が渡す USDC 商品を 1 つの一覧に並べ、
// 検索・通貨/種類チップ・ページングを持つ。wagmi / SIWE / 出品者専用の部品に依存しない。

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { formatUnits } from 'viem';
import { useQuery } from '@tanstack/react-query';
import { Boxes, CheckCircle2, ChevronDown, Search, ShieldCheck } from 'lucide-react';
import { tokyoDateKey } from '@/lib/shopTime';
import { AGENTIC_MARKET_URL, X402_LIST_URL, type UsdcCatalogItem } from '@/lib/x402/usdcCatalog';
import { isHttpsUrl, type DiscoveryDisplay } from './discoveryDisplay';
import type { CatalogCurrency, CatalogEntry, DiscoveryItem } from './discoveryTypes';

const EMPTY_DISCOVERY_ITEMS: DiscoveryItem[] = [];
/** カタログの初期表示件数。超える分は「さらに N 件を表示」で開く (モバイルの全長を抑える)。 */
const CATALOG_PAGE_SIZE = 8;
const DAY_MS = 24 * 60 * 60 * 1_000;
const CATALOG_CATEGORIES = ['api', 'data', 'mcp', 'content'] as const;
type CatalogCategory = (typeof CATALOG_CATEGORIES)[number];

function isoDate(value: string | undefined): string | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? tokyoDateKey(timestamp) : null;
}

function verifiedDaysAgo(value: string | null | undefined, now: number): number | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(0, Math.floor((now - timestamp) / DAY_MS));
}

function feeAtomicOf(item: DiscoveryItem): bigint | null {
  const fv = item.accepts[0]?.extra?.openpay?.feeValue;
  if (!fv) return null;
  try {
    return BigInt(fv);
  } catch {
    return null;
  }
}

// 取得・検索語・絞り込み・表示件数。X402DiscoveryView が 1 回だけ呼ぶ (サインイン前後の節の並び替えで
// panel が再マウントされても検索語・フィルタ・表示件数を失わないよう、状態は呼び出し元に置く)。
export function useDiscoveryCatalog(usdcItems: readonly UsdcCatalogItem[]) {
  const [catalogSearch, setCatalogSearch] = useState('');
  const [catalogCategory, setCatalogCategory] = useState<CatalogCategory | null>(null);
  const [catalogCurrency, setCatalogCurrency] = useState<CatalogCurrency>('all');

  // 公開カタログ (誰でも閲覧)。/api/discovery を react-query で取得。loading には isFetching を使い、
  // 初回だけでなく mutation 後の invalidate による再取得中もスケルトンを出す (従来 loadCatalog が毎回
  // setLoading(true) していた挙動を保持)。!ok は throw して直前の data を保持する (従来 setItems しない挙動)。
  const catalogQuery = useQuery({
    queryKey: ['x402', 'discovery'],
    queryFn: async () => {
      const res = await fetch('/api/discovery', { cache: 'no-store' });
      if (!res.ok) throw new Error(`http_${res.status}`);
      const body = (await res.json()) as { items?: DiscoveryItem[] };
      return body.items ?? [];
    },
    retry: false,
  });

  const items = catalogQuery.data ?? EMPTY_DISCOVERY_ITEMS;
  const loading = catalogQuery.isFetching;
  // JPYC (動的) と USDC (静的) を 1 つの一覧に。JPYC は server 順
  // (公式 → 検証済の第三者 → 未検証の第三者・各 tier 内の順序は維持) を保ち、その後に USDC を並べる。
  const entries = useMemo<CatalogEntry[]>(
    () => [
      ...items.map((item, index) => ({
        kind: 'jpyc' as const,
        // 同一 URL の重複登録 (別販売者・同一販売者の二重登録) でも key が衝突しないよう index を含める。
        key: `jpyc:${index}:${item.resource}`,
        category: item.category.trim().toLowerCase(),
        // dual (USDC 併売) 出品は "usdc" のテキスト検索でも見つかるようにする。
        searchText: `${item.description} ${item.resource}${item.usdc ? ' usdc' : ''}`.toLowerCase(),
        item,
      })),
      ...usdcItems.map((item) => ({
        kind: 'usdc' as const,
        key: `usdc:${item.resource}`,
        category: item.category,
        searchText: `${item.title} ${item.description} ${item.resource}`.toLowerCase(),
        item,
      })),
    ],
    [items, usdcItems],
  );
  // 通貨チップは USDC で買える商品があるときだけ出す (無ければ従来どおりカテゴリのみ)。
  // dual (JPYC 出品の USDC 併売) は両方の通貨フィルタにマッチし、USDC 側の件数にも数える。
  const dualCount = useMemo(() => items.filter((i) => i.usdc).length, [items]);
  const showCurrencyChips = (usdcItems.length > 0 || dualCount > 0) && items.length > 0;
  const currencyCounts = { jpyc: items.length, usdc: usdcItems.length + dualCount };
  const effectiveCurrency: CatalogCurrency = showCurrencyChips ? catalogCurrency : 'all';
  const currencyEntries = useMemo(
    () =>
      effectiveCurrency === 'all'
        ? entries
        : entries.filter(
            (e) =>
              e.kind === effectiveCurrency ||
              (effectiveCurrency === 'usdc' && e.kind === 'jpyc' && Boolean(e.item.usdc)),
          ),
    [effectiveCurrency, entries],
  );
  const categoryCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const entry of currencyEntries) {
      counts.set(entry.category, (counts.get(entry.category) ?? 0) + 1);
    }
    return counts;
  }, [currencyEntries]);
  const availableCategories = CATALOG_CATEGORIES.filter(
    (category) => (categoryCounts.get(category) ?? 0) > 0,
  );
  const effectiveCatalogCategory =
    catalogCategory && availableCategories.includes(catalogCategory)
      ? catalogCategory
      : null;
  const visibleEntries = useMemo(() => {
    const search = catalogSearch.trim().toLowerCase();
    return currencyEntries.filter((entry) => {
      if (effectiveCatalogCategory && entry.category !== effectiveCatalogCategory) return false;
      return search === '' || entry.searchText.includes(search);
    });
  }, [catalogSearch, effectiveCatalogCategory, currencyEntries]);
  // 表示上限は絞り込み条件ごとに持つ (条件が変わったら初期件数に戻る)。effect ではなく key 照合で導出。
  const filterKey = `${catalogSearch.trim().toLowerCase()}|${effectiveCurrency}|${effectiveCatalogCategory ?? ''}`;
  const [catalogShown, setCatalogShown] = useState<{ key: string; limit: number } | null>(null);
  const catalogLimit = catalogShown?.key === filterKey ? catalogShown.limit : CATALOG_PAGE_SIZE;
  const pagedEntries = visibleEntries.slice(0, catalogLimit);
  const hiddenCount = visibleEntries.length - pagedEntries.length;

  return {
    loading, entries, showCurrencyChips, currencyCounts, effectiveCurrency, currencyEntries,
    categoryCounts, availableCategories, effectiveCatalogCategory, visibleEntries, filterKey,
    catalogLimit, pagedEntries, hiddenCount, catalogSearch, setCatalogSearch, setCatalogCategory,
    setCatalogCurrency, setCatalogShown,
  };
}

export type DiscoveryCatalog = ReturnType<typeof useDiscoveryCatalog>;

export function DiscoveryCatalogPanel({
  catalog,
  display,
  usdcItems,
  usdcArc,
}: {
  catalog: DiscoveryCatalog;
  display: DiscoveryDisplay;
  usdcItems: readonly UsdcCatalogItem[];
  usdcArc: boolean;
}) {
  const t = useTranslations('Facilitator');
  const {
    loading, entries, showCurrencyChips, currencyCounts, effectiveCurrency, currencyEntries,
    categoryCounts, availableCategories, effectiveCatalogCategory, visibleEntries, filterKey,
    catalogLimit, pagedEntries, hiddenCount, catalogSearch, setCatalogSearch, setCatalogCategory,
    setCatalogCurrency, setCatalogShown,
  } = catalog;
  const { cardHead, expandedKeys } = display;

  // フィルタチップ (通貨 / 種類で共用)。component でなく関数で返し no-unstable-nested-components を避ける。
  const chip = (opts: {
    key?: string;
    label: string;
    count: number;
    active: boolean;
    onClick: () => void;
    tone?: 'primary' | 'secondary';
  }) => {
    const secondary = opts.tone === 'secondary';
    return (
      <button
        key={opts.key ?? opts.label}
        type="button"
        onClick={opts.onClick}
        aria-pressed={opts.active}
        className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition ${
          opts.active
            ? secondary
              ? 'border-slate-800 bg-slate-800 text-white'
              : 'border-brand bg-brand text-white'
            : 'border-slate-300 bg-white text-slate-600 hover:border-brand'
        }`}
      >
        {opts.label}
        <span className={opts.active ? 'text-white/75' : 'text-slate-400'}>{opts.count}</span>
      </button>
    );
  };

  return (
    <>
      {/* 公開カタログ */}
      <section>
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <h3 className="text-base font-bold text-slate-900">{t('catalogTitle')}</h3>
          {/* 発見面: JPYC は /api/discovery、USDC は CDP Bazaar / agentic.market。1 行で済ませる。 */}
          <p className="text-xs text-slate-500">
            {t('catalogDiscoverPrefix')}
            <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[11px] text-slate-600">
              /api/discovery
            </code>
            {usdcItems.length > 0 && (
              <>
                {t('catalogDiscoverJoin')}
                <a
                  href={AGENTIC_MARKET_URL}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="font-medium text-brand underline-offset-2 hover:text-brand-dark hover:underline"
                >
                  {t('catalogDiscoverBazaar')}
                </a>
                {' / '}
                {/* OpenPay 自身の USDC データ API の掲載先 (2026-09-15 承認)。第三者出品の自動掲載先ではない。 */}
                <a
                  href={X402_LIST_URL}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="font-medium text-brand underline-offset-2 hover:text-brand-dark hover:underline"
                >
                  {t('catalogDiscoverX402List')}
                </a>
              </>
            )}
          </p>
        </div>
        {/* 自律購入の買い手が最初に知りたい「暴走しないか」を 1 行で答え、詳細は折りたたむ
            (実装済みの事実だけを書き、売り手のあらゆる挙動を防ぐ保証とは書かない)。 */}
        <details className="group mt-3 rounded-xl border border-slate-200 bg-slate-50/70">
          <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs text-slate-600">
            <ShieldCheck className="h-4 w-4 shrink-0 text-brand" aria-hidden />
            <span className="min-w-0 flex-1">
              <span className="font-semibold text-slate-800">{t('guardsTitle')}</span>
              <span className="ml-1.5 text-slate-500">{t('guardsSummary')}</span>
            </span>
            <ChevronDown
              className="h-3.5 w-3.5 shrink-0 text-slate-400 transition group-open:rotate-180"
              aria-hidden
            />
          </summary>
          <ul className="space-y-1 border-t border-slate-200/70 px-3 py-2.5">
            {[
              t('guardsLimit'),
              t('guardsMatch'),
              t('guardsResource'),
              t('guardsReceipt'),
              t('guardsUnlock'),
            ].map((line) => (
              <li
                key={line}
                className="flex items-start gap-1.5 text-xs leading-relaxed text-slate-700"
              >
                <CheckCircle2
                  className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600"
                  aria-hidden
                />
                <span>{line}</span>
              </li>
            ))}
            <li className="pt-1 text-[11px] leading-relaxed text-slate-500">{t('guardsNote')}</li>
          </ul>
        </details>
        {!loading && entries.length > 0 && (
          <div className="mt-4 space-y-2.5">
            <label className="relative block">
              <span className="sr-only">{t('catalogSearchLabel')}</span>
              <Search
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
                aria-hidden
              />
              <input
                type="search"
                value={catalogSearch}
                onChange={(event) => setCatalogSearch(event.target.value)}
                placeholder={t('catalogSearchPlaceholder')}
                className="w-full rounded-xl border border-slate-200 bg-white py-2.5 pl-9 pr-3 text-sm text-slate-800 shadow-card placeholder:text-slate-400 focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/15"
              />
            </label>
            {/* 1 行目 = 通貨 (すべて / JPYC / USDC)、2 行目 = 種類。USDC が無い環境は従来の 1 行
                (すべて + 種類)。「すべて」は常に 1 つだけ (2 つあると何の「すべて」か迷う)。 */}
            <div className="flex flex-wrap items-center gap-1.5">
              {chip({
                label: t('catalogCategoryAll'),
                count: showCurrencyChips ? entries.length : currencyEntries.length,
                active: showCurrencyChips
                  ? effectiveCurrency === 'all'
                  : effectiveCatalogCategory === null,
                onClick: () => {
                  setCatalogCurrency('all');
                  setCatalogCategory(null);
                },
              })}
              {showCurrencyChips &&
                (
                  [
                    ['jpyc', t('currencyJpyc'), currencyCounts.jpyc],
                    ['usdc', t('currencyUsdc'), currencyCounts.usdc],
                  ] as const
                ).map(([value, label, count]) =>
                  chip({
                    key: value,
                    label,
                    count,
                    active: effectiveCurrency === value,
                    onClick: () => {
                      setCatalogCurrency(value);
                      setCatalogCategory(null);
                    },
                  }),
                )}
              {!showCurrencyChips &&
                availableCategories.map((category) =>
                  chip({
                    key: category,
                    label: category,
                    count: categoryCounts.get(category) ?? 0,
                    active: effectiveCatalogCategory === category,
                    onClick: () => setCatalogCategory(category),
                  }),
                )}
            </div>
            {showCurrencyChips && availableCategories.length > 1 && (
              <div className="flex flex-wrap items-center gap-1.5">
                {availableCategories.map((category) => {
                  const active = effectiveCatalogCategory === category;
                  return chip({
                    key: category,
                    label: category,
                    count: categoryCounts.get(category) ?? 0,
                    active,
                    tone: 'secondary',
                    onClick: () => setCatalogCategory(active ? null : category),
                  });
                })}
              </div>
            )}
            {/* 利用料の脚注 (JPYC は買い手上乗せ 1%・最低 1 JPYC / USDC は上乗せなし)。開示 SoT は LP・法務。 */}
            <p className="text-[11px] leading-relaxed text-slate-500">
              {showCurrencyChips
                ? usdcArc
                  ? t('catalogFeeNoteBothArc')
                  : t('catalogFeeNoteBoth')
                : t('catalogFeeNoteJpyc')}
            </p>
          </div>
        )}
        {loading ? (
          <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2" aria-hidden>
            <div className="h-24 animate-pulse rounded-2xl bg-slate-100" />
            <div className="h-24 animate-pulse rounded-2xl bg-slate-100" />
          </div>
        ) : entries.length === 0 ? (
          <div className="mt-4 flex flex-col items-center gap-2 rounded-2xl bg-white px-6 py-10 text-center shadow-card ring-1 ring-slate-200/70">
            <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-brand/5 text-brand">
              <Boxes className="h-6 w-6" aria-hidden />
            </span>
            <p className="mt-1 text-sm text-slate-500">{t('catalogEmpty')}</p>
          </div>
        ) : visibleEntries.length === 0 ? (
          <div className="mt-4 flex flex-col items-center gap-2 rounded-2xl bg-white px-6 py-10 text-center shadow-card ring-1 ring-slate-200/70">
            <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-brand/5 text-brand">
              <Search className="h-6 w-6" aria-hidden />
            </span>
            <p className="mt-1 text-sm text-slate-500">{t('catalogNoResults')}</p>
          </div>
        ) : (
          <ul className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
            {pagedEntries.map((entry) => {
              if (entry.kind === 'usdc') {
                const u = entry.item;
                return (
                  <li
                    key={entry.key}
                    className="group rounded-2xl bg-white p-4 shadow-card ring-1 ring-slate-200/70 transition hover:-translate-y-0.5 hover:shadow-card-hover"
                  >
                    {cardHead({
                      category: u.category,
                      currency: 'usdc',
                      title: u.title,
                      description: u.description,
                      url: u.resource,
                      copyKey: `cat-${entry.key}`,
                      priceNode: (
                        <div className="shrink-0 text-right">
                          <div className="text-sm font-bold text-slate-900">
                            {t('payUsdc', { amount: u.priceUsd })}
                          </div>
                          <div className="text-[11px] text-slate-500">{t('usdcNoFee')}</div>
                        </div>
                      ),
                    })}
                    <div className="mt-2 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[11px] leading-relaxed text-slate-500">
                      <a
                        href={AGENTIC_MARKET_URL}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="shrink-0 font-medium text-brand hover:text-brand-dark hover:underline"
                      >
                        {t('bazaarListed')}
                      </a>
                      <span>{usdcArc ? t('usdcNetworkMetaArc') : t('usdcNetworkMeta')}</span>
                    </div>
                  </li>
                );
              }
              const item = entry.item;
              const feeAtomic = feeAtomicOf(item);
              const verifiedDays = verifiedDaysAgo(item.verifiedAt, Date.now());
              const updatedDate = isoDate(item.updatedAt);
              const docsUrl = item.docsUrl && isHttpsUrl(item.docsUrl) ? item.docsUrl : null;
              const hasComparisonMeta =
                verifiedDays !== null || updatedDate !== null || Boolean(item.license && expandedKeys.has(`cat-${entry.key}`)) || docsUrl !== null;
              // atomic JPYC → 表示 (小数あり)。1% 手数料は price/100 で端数が出るため、整数除算だと
              // 切り捨てて誤表示する → formatUnits で小数を保つ。合計も atomic で加算してから整形する。
              const fee = feeAtomic === null ? null : formatUnits(feeAtomic, 18);
              let total: string | null = null;
              if (feeAtomic !== null) {
                try {
                  total = formatUnits(BigInt(item.priceJpyc) * 10n ** 18n + feeAtomic, 18);
                } catch {
                  total = null;
                }
              }
              return (
                <li
                  key={entry.key}
                  className="group rounded-2xl bg-white p-4 shadow-card ring-1 ring-slate-200/70 transition hover:-translate-y-0.5 hover:shadow-card-hover"
                >
                  {cardHead({
                    category: item.category,
                    currency: showCurrencyChips ? 'jpyc' : undefined,
                    dualUsdc: Boolean(item.usdc),
                    priceNode: (
                      // 買い手の意思決定基準は合計 (2026-07-31 user 裁定): 合計を太字主役・
                      // 価格+手数料は細字の内訳。fee 不明 (非 JPYC 等) は従来の価格表示。
                      <div className="shrink-0 text-right">
                        {total ? (
                          <>
                            <div className="text-sm font-bold text-slate-900">
                              {t('payTotal', { total })}
                            </div>
                            <div className="text-[11px] text-slate-500">
                              {item.priceJpyc} JPYC
                              {fee && (
                                <span className="ml-1">
                                  {t('feeNote', { fee })}
                                </span>
                              )}
                            </div>
                          </>
                        ) : (
                          <div className="text-sm font-bold text-slate-900">
                            {item.priceJpyc} JPYC
                          </div>
                        )}
                        {item.usdc && (
                          <div className="text-[11px] font-semibold text-sky-700">
                            {t('usdcFaceMeta', { price: item.usdc.priceUsd })}
                          </div>
                        )}
                      </div>
                    ),
                    title: item.title,
                    usdc: item.usdc,
                    license: item.license,
                    description: item.description,
                    trigger: item.trigger,
                    url: item.resource,
                    copyKey: `cat-${entry.key}`,
                    official: item.official === true,
                  })}
                  {hasComparisonMeta && (
                    // 折り返し必須: nowrap+横スクロールだと利用条件の長文で Docs リンクが画面外に
                    // 隠れて実質不到達になる (本番実害)。区切りは wrap に耐える中点で表現する。
                    <div className="mt-2 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[11px] leading-relaxed text-slate-500">
                      {verifiedDays !== null && (
                        <time dateTime={item.verifiedAt ?? undefined} className="shrink-0">
                          {verifiedDays === 0
                            ? t('verifiedTodayMeta')
                            : t('verifiedMeta', { days: verifiedDays })}
                        </time>
                      )}
                      {updatedDate !== null && (
                        <time dateTime={item.updatedAt} className="shrink-0">
                          {t('updatedMeta', { date: updatedDate })}
                        </time>
                      )}
                      {docsUrl && (
                        <a
                          href={docsUrl}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="shrink-0 font-medium text-brand hover:text-brand-dark hover:underline"
                        >
                          {t('docsLink')}
                        </a>
                      )}
                      {item.license && expandedKeys.has(`cat-${entry.key}`) && (
                        <span className="min-w-0">
                          {t('licenseMeta', { license: item.license })}
                        </span>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {hiddenCount > 0 && (
          <div className="mt-4 flex justify-center">
            <button
              type="button"
              onClick={() => setCatalogShown({ key: filterKey, limit: catalogLimit + CATALOG_PAGE_SIZE })}
              className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition hover:border-brand hover:text-brand"
            >
              {t('catalogShowMore', { count: hiddenCount })}
            </button>
          </div>
        )}
      </section>
    </>
  );
}
