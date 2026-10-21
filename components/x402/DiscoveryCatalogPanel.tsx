'use client';

// 公開カタログ (誰でも閲覧)。/api/discovery の JPYC 出品と server が渡す USDC 商品を 1 つの一覧に並べ、
// 検索・通貨/種類チップ・ページングを持つ。wagmi / SIWE / 出品者専用の部品に依存しない。

import { useMemo, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { formatUnits } from 'viem';
import { useQuery } from '@tanstack/react-query';
import { Boxes, Search } from 'lucide-react';
import { tokyoDateKey } from '@/lib/shopTime';
import { FIRST_PARTY_SUMMARY_JA } from '@/lib/x402/catalogSummaryJa';
import { X402_DEMO_PATH } from '@/lib/x402/demoPath';
import { AGENTIC_MARKET_URL, type UsdcCatalogItem } from '@/lib/x402/usdcCatalog';
import { isHttpsUrl, type DiscoveryDisplay } from './discoveryDisplay';
import type { CatalogCurrency, CatalogEntry, DiscoveryItem } from './discoveryTypes';

const EMPTY_DISCOVERY_ITEMS: DiscoveryItem[] = [];
const CARD_CLASS =
  'rounded-2xl bg-white p-4 shadow-card ring-1 ring-slate-200/70 transition hover:shadow-card-hover';
/** カタログの初期表示件数。超える分は「さらに N 件を表示」で開く (モバイルの全長を抑える)。 */
const CATALOG_PAGE_SIZE = 8;
const DAY_MS = 24 * 60 * 60 * 1_000;

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

/** USDC でも買えるか (USDC 商品・JPYC 出品の USDC 併売 (dual)・公式の双子)。 */
function payableInUsdc(e: CatalogEntry): boolean {
  return e.kind === 'usdc' || Boolean(e.item.usdc) || Boolean(e.usdcTwin);
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

  // 公式の 1 JPYC デモは人間向けの一覧から外す (「2円で試す」節が受け持つ・/api/discovery と 402 は不変)。
  // 先頭が「hello を解錠するだけのデモ」だと何が買えるストアかが伝わらないため (2026-10-21 磨き上げ)。
  const items = useMemo(
    () =>
      (catalogQuery.data ?? EMPTY_DISCOVERY_ITEMS).filter(
        (item) => !(item.official === true && new URL(item.resource).pathname === X402_DEMO_PATH),
      ),
    [catalogQuery.data],
  );
  const loading = catalogQuery.isFetching;
  // JPYC (動的) と USDC (静的) を 1 つの一覧に。JPYC は server 順
  // (公式 → 検証済の第三者 → 未検証の第三者・各 tier 内の順序は維持) を保ち、その後に USDC を並べる。
  // 公式の双子 (同じ商品の JPYC 面と USDC 面) は JPYC のカードにまとめる。JPYC 面が取れない
  // (/api/discovery の失敗・非表示) ときは USDC 単独のカードのまま出す。
  const entries = useMemo<CatalogEntry[]>(() => {
    const twinByJpycPath = new Map(
      usdcItems.flatMap((u) => (u.jpycTwinPath ? [[u.jpycTwinPath, u] as const] : [])),
    );
    const jpycEntries = items.map((item, index) => {
      const usdcTwin =
        item.official === true ? twinByJpycPath.get(new URL(item.resource).pathname) : undefined;
      return {
        kind: 'jpyc' as const,
        // 同一 URL の重複登録 (別販売者・同一販売者の二重登録) でも key が衝突しないよう index を含める。
        key: `jpyc:${index}:${item.resource}`,
        category: item.category.trim().toLowerCase(),
        // USDC でも買える出品 (dual・双子) は "usdc" のテキスト検索でも見つかるようにする。
        // 公式商品は日本語の要約でも見つかるようにする (カードに出る文で探せないと迷う)。
        searchText: [
          item.title ?? '',
          item.description,
          item.resource,
          item.official === true ? (FIRST_PARTY_SUMMARY_JA[new URL(item.resource).pathname] ?? '') : '',
          item.usdc || usdcTwin ? 'usdc' : '',
          usdcTwin ? `${usdcTwin.title} ${usdcTwin.resource}` : '',
        ]
          .join(' ')
          .toLowerCase(),
        item,
        usdcTwin,
      };
    });
    const folded = new Set(jpycEntries.flatMap((e) => (e.usdcTwin ? [e.usdcTwin.resource] : [])));
    return [
      ...jpycEntries,
      ...usdcItems
        .filter((item) => !folded.has(item.resource))
        .map((item) => ({
          kind: 'usdc' as const,
          key: `usdc:${item.resource}`,
          category: item.category,
          searchText: [
            item.title,
            item.description,
            item.resource,
            FIRST_PARTY_SUMMARY_JA[new URL(item.resource).pathname] ?? '',
          ]
            .join(' ')
            .toLowerCase(),
          item,
        })),
    ];
  }, [items, usdcItems]);
  // 通貨の切り替えは USDC で買える商品があるときだけ出す (無ければ絞り込みなし)。
  // USDC でも買える JPYC 出品 (dual・双子) は両方の通貨に数え、両方の絞り込みに出る。
  const usdcCount = entries.filter(payableInUsdc).length;
  const showCurrencyChips = usdcCount > 0 && items.length > 0;
  const currencyCounts = { jpyc: items.length, usdc: usdcCount };
  const effectiveCurrency: CatalogCurrency = showCurrencyChips ? catalogCurrency : 'all';
  const currencyEntries = useMemo(
    () =>
      effectiveCurrency === 'all'
        ? entries
        : entries.filter((e) => (effectiveCurrency === 'jpyc' ? e.kind === 'jpyc' : payableInUsdc(e))),
    [effectiveCurrency, entries],
  );
  const visibleEntries = useMemo(() => {
    const search = catalogSearch.trim().toLowerCase();
    return search === ''
      ? currencyEntries
      : currencyEntries.filter((entry) => entry.searchText.includes(search));
  }, [catalogSearch, currencyEntries]);
  // 表示上限は絞り込み条件ごとに持つ (条件が変わったら初期件数に戻る)。effect ではなく key 照合で導出。
  const filterKey = `${catalogSearch.trim().toLowerCase()}|${effectiveCurrency}`;
  const [catalogShown, setCatalogShown] = useState<{ key: string; limit: number } | null>(null);
  const catalogLimit = catalogShown?.key === filterKey ? catalogShown.limit : CATALOG_PAGE_SIZE;
  const pagedEntries = visibleEntries.slice(0, catalogLimit);
  const hiddenCount = visibleEntries.length - pagedEntries.length;

  return {
    loading, entries, showCurrencyChips, currencyCounts, effectiveCurrency, visibleEntries,
    filterKey, catalogLimit, pagedEntries, hiddenCount, catalogSearch, setCatalogSearch,
    setCatalogCurrency, setCatalogShown,
  };
}

export type DiscoveryCatalog = ReturnType<typeof useDiscoveryCatalog>;

export function DiscoveryCatalogPanel({
  catalog,
  display,
  usdcArc,
}: {
  catalog: DiscoveryCatalog;
  display: DiscoveryDisplay;
  usdcArc: boolean;
}) {
  const t = useTranslations('Facilitator');
  const {
    loading, entries, showCurrencyChips, currencyCounts, effectiveCurrency, visibleEntries,
    filterKey, catalogLimit, pagedEntries, hiddenCount, catalogSearch, setCatalogSearch,
    setCatalogCurrency, setCatalogShown,
  } = catalog;
  const locale = useLocale();
  const { cardHead, urlChip } = display;
  // 公式商品の日本語の要約 (表示専用)。英語ページと第三者の出品は原文のまま。
  const summaryFor = (url: string) =>
    locale === 'ja' ? FIRST_PARTY_SUMMARY_JA[new URL(url).pathname] : undefined;
  const usdcRail = usdcArc ? t('pillUsdcArc') : t('pillUsdc');

  return (
    <>
      {/* 公開カタログ */}
      <section>
        {/* 見出しは件数だけ。発見面 (/api/discovery・Bazaar) と購入ガードは開発者向けなので
            「エージェントから使う」節 (DiscoveryExamples) に置く (2026-10-21 磨き上げ)。 */}
        <h3 className="flex items-baseline gap-2 text-base font-bold text-slate-900">
          {t('catalogTitle')}
          {!loading && entries.length > 0 && (
            <span className="text-sm font-semibold tabular-nums text-slate-500">{entries.length}</span>
          )}
        </h3>
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
            {/* 通貨の切り替え 1 行 (すべて / JPYC / USDC)。種類 (api / data) の絞り込みは件数が少なく
                カードのアイコンで足りるので外した (2026-10-21 磨き上げ)。USDC 商品が無い環境では出さない。 */}
            {showCurrencyChips && (
              <div className="flex rounded-xl bg-slate-100 p-1">
                {(
                  [
                    ['all', t('catalogCategoryAll'), entries.length],
                    ['jpyc', t('currencyJpyc'), currencyCounts.jpyc],
                    ['usdc', t('currencyUsdc'), currencyCounts.usdc],
                  ] as const
                ).map(([value, label, count]) => {
                  const active = effectiveCurrency === value;
                  return (
                    <button
                      key={value}
                      type="button"
                      onClick={() => setCatalogCurrency(value)}
                      aria-pressed={active}
                      className={`inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-semibold transition ${
                        active
                          ? 'bg-white text-slate-900 shadow-sm ring-1 ring-slate-200'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      {label}
                      {/* 件数は文字の太さで控えめにし、色は AA (4.5:1) を保つ (slate-500 は slate-100 の上で不足)。 */}
                      <span className={`text-xs font-normal tabular-nums ${active ? 'text-slate-500' : 'text-slate-600'}`}>
                        {count}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}
        {loading ? (
          // カードと同じ形の骨組み (読み込み後にレイアウトが跳ねないように)。
          <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2" aria-hidden>
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="flex gap-3 rounded-2xl bg-white p-4 ring-1 ring-slate-200/70">
                <div className="h-9 w-9 shrink-0 animate-pulse rounded-xl bg-slate-100" />
                <div className="min-w-0 flex-1 space-y-2">
                  <div className="h-4 w-2/3 animate-pulse rounded bg-slate-100" />
                  <div className="h-3 w-full animate-pulse rounded bg-slate-100" />
                  <div className="h-3 w-4/5 animate-pulse rounded bg-slate-100" />
                  <div className="h-7 w-1/2 animate-pulse rounded-lg bg-slate-100" />
                </div>
              </div>
            ))}
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
            {/* 行き止まりにしない: 検索語と通貨の絞り込みを 1 回で戻す。 */}
            <button
              type="button"
              onClick={() => {
                setCatalogSearch('');
                setCatalogCurrency('all');
              }}
              className="mt-1 text-sm font-semibold text-brand hover:text-brand-dark hover:underline"
            >
              {t('catalogClearFilters')}
            </button>
          </div>
        ) : (
          // items-start: 「詳しく」を開いたカードに隣のカードの高さを揃えない (空白の塊を作らない)。
          <ul className="mt-4 grid grid-cols-1 items-start gap-3 sm:grid-cols-2">
            {pagedEntries.map((entry) => {
              if (entry.kind === 'usdc') {
                const u = entry.item;
                return (
                  <li key={entry.key} className={CARD_CLASS}>
                    {cardHead({
                      category: u.category,
                      title: u.title,
                      description: u.description,
                      url: u.resource,
                      copyKey: `cat-${entry.key}`,
                      summary: summaryFor(u.resource),
                      priceNode: (
                        <div className="shrink-0 text-right">
                          <div className="text-[15px] font-bold tabular-nums text-slate-900">
                            {t('payUsdc', { amount: u.priceUsd })}
                          </div>
                          <div className="text-[11px] text-slate-500">{t('usdcNoFee')}</div>
                        </div>
                      ),
                      detailLines: [
                        <span key="network">
                          {usdcArc ? t('usdcNetworkMetaArc') : t('usdcNetworkMeta')}
                          <span aria-hidden className="mx-1.5 text-slate-300">·</span>
                          <a
                            href={AGENTIC_MARKET_URL}
                            target="_blank"
                            rel="noreferrer noopener"
                            className="font-medium text-brand hover:text-brand-dark hover:underline"
                          >
                            {t('bazaarListed')}
                          </a>
                        </span>,
                      ],
                    })}
                  </li>
                );
              }
              const item = entry.item;
              const twin = entry.usdcTwin;
              const usdcPrice = item.usdc?.priceUsd ?? twin?.priceUsd;
              // USDC で絞っているときは、双子のカードのコピー先も USDC 面にする。
              const primaryUrl = effectiveCurrency === 'usdc' && twin ? twin.resource : item.resource;
              const feeAtomic = feeAtomicOf(item);
              const verifiedDays = verifiedDaysAgo(item.verifiedAt, Date.now());
              const updatedDate = isoDate(item.updatedAt);
              const docsUrl = item.docsUrl && isHttpsUrl(item.docsUrl) ? item.docsUrl : null;
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
              const dates = [
                verifiedDays !== null ? (
                  <time key="verified" dateTime={item.verifiedAt ?? undefined}>
                    {verifiedDays === 0
                      ? t('verifiedTodayMeta')
                      : t('verifiedMeta', { days: verifiedDays })}
                  </time>
                ) : null,
                updatedDate !== null ? (
                  <time key="updated" dateTime={item.updatedAt}>
                    {t('updatedMeta', { date: updatedDate })}
                  </time>
                ) : null,
              ].filter(Boolean);
              return (
                <li key={entry.key} className={CARD_CLASS}>
                  {cardHead({
                    category: item.category,
                    // 価格は通貨ごとに「金額 + その通貨の注記」を常に組で出す (JPYC = 手数料の内訳・USDC = 上乗せなし)。
                    // 買い手の意思決定基準は合計 (2026-07-31 user 裁定): 主役の通貨は合計を太字、もう一方は「または」で細字。
                    // USDC で絞っているときだけ USDC を主役にする。fee 不明 (非 JPYC 等) は内訳を出さず価格だけ。
                    priceNode: (() => {
                      const jpycBreakdown =
                        total && fee ? t('feeBreakdown', { price: item.priceJpyc, fee }) : null;
                      const usdcFirst = effectiveCurrency === 'usdc' && usdcPrice;
                      const sub = 'text-[11px] tabular-nums text-slate-500';
                      return usdcFirst ? (
                        <div className="shrink-0 text-right">
                          <div className="text-[15px] font-bold tabular-nums text-slate-900">
                            {t('payUsdc', { amount: usdcPrice })}
                          </div>
                          <div className={sub}>{t('usdcNoFee')}</div>
                          <div className="mt-0.5 text-[11px] font-semibold tabular-nums text-slate-600">
                            {t('jpycAltMeta', { total: total ?? item.priceJpyc })}
                          </div>
                          {jpycBreakdown && <div className={sub}>{jpycBreakdown}</div>}
                        </div>
                      ) : (
                        <div className="shrink-0 text-right">
                          <div className="text-[15px] font-bold tabular-nums text-slate-900">
                            {total ?? item.priceJpyc} JPYC
                          </div>
                          {jpycBreakdown && <div className={sub}>{jpycBreakdown}</div>}
                          {usdcPrice && (
                            <>
                              <div className="mt-0.5 text-[11px] font-semibold tabular-nums text-sky-700">
                                {t('usdcAltMeta', { price: usdcPrice })}
                              </div>
                              <div className={sub}>{t('usdcNoFee')}</div>
                            </>
                          )}
                        </div>
                      );
                    })(),
                    title: item.title,
                    usdc: item.usdc,
                    license: item.license,
                    description: item.description,
                    trigger: item.trigger,
                    url: primaryUrl,
                    copyKey: `cat-${entry.key}`,
                    official: item.official === true,
                    summary: item.official === true ? summaryFor(item.resource) : undefined,
                    docsUrl,
                    fullUrlInDetails: !twin,
                    detailLines: [
                      // 双子は通貨ごとに URL が違うので、両方をコピーできる形で並べる。
                      ...(twin
                        ? [
                            <span key="rails" className="flex flex-col gap-1.5">
                              {(
                                [
                                  ['jpyc', t('pillJpyc'), item.resource],
                                  ['usdc', usdcRail, twin.resource],
                                ] as const
                              ).map(([rail, label, url]) => (
                                <span key={rail} className="flex min-w-0 flex-col items-start gap-1">
                                  <span className="text-slate-500">{label}</span>
                                  {urlChip(`cat-${entry.key}-${rail}`, url)}
                                </span>
                              ))}
                            </span>,
                          ]
                        : []),
                      ...(dates.length > 0
                        ? [
                            <span key="dates" className="flex flex-wrap gap-x-3">
                              {dates}
                            </span>,
                          ]
                        : []),
                    ],
                  })}
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
        {/* 利用料の脚注 (JPYC は買い手上乗せ 1%・最低 1 JPYC / USDC は上乗せなし)。開示 SoT は LP・法務。
            一覧の前に割り込ませず、一覧の後に 1 行で置く。 */}
        {!loading && entries.length > 0 && (
          <p className="mt-4 text-xs leading-relaxed text-slate-500">
            {showCurrencyChips
              ? usdcArc
                ? t('catalogFeeNoteBothArc')
                : t('catalogFeeNoteBoth')
              : t('catalogFeeNoteJpyc')}
          </p>
        )}
      </section>
    </>
  );
}
