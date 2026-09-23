'use client';

// x402 facilitator の最小 UI: 公開カタログ (discovery) の閲覧 + 加盟店の登録/編集/削除 (SIWE)。
// カタログは /api/discovery を fetch して列挙 (誰でも閲覧)。owner は SIWE サインイン後、自分の登録を
// /api/facilitator/resources で管理する (GET=一覧 / POST=登録 / [id] PATCH=編集 / [id] DELETE=無効化)。
// 本コンポーネントは env.enableX402Facilitator が ON のページからのみマウントされる。

import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { useAccount } from 'wagmi';
import { formatUnits } from 'viem';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  Boxes,
  Check,
  Code2,
  Copy,
  ChevronDown,
  Database,
  FileText,
  Pencil,
  Plus,
  Search,
  Trash2,
  Wallet,
  CheckCircle2,
  AlertTriangle,
  Sparkles,
  ShieldCheck,
} from 'lucide-react';
import { useSiweSession } from '@/hooks/useSiweSession';
import { ConnectButton } from '@/components/ConnectButton';
import { Field } from '@/components/Field';
import { env } from '@/lib/env';
import { splitDisplayTitle } from '@/lib/x402/displayTitle';
import { shortAddress } from '@/lib/format';
import { AGENTIC_MARKET_URL, X402_LIST_URL, type UsdcCatalogItem } from '@/lib/x402/usdcCatalog';
import { REVERIFY_AUTH_HIDE_THRESHOLD } from '@/lib/x402/reverifyThresholds';
import type { MonitorFreshness } from '@/lib/directory/monitorFreshness';

// カテゴリー文字列 → 視覚アイコン (api / data / mcp / content)。未知は汎用 (Code2)。
function categoryIcon(category: string) {
  const c = category.toLowerCase();
  if (c.includes('data')) return Database;
  if (c.includes('mcp')) return Boxes;
  if (c.includes('content') || c.includes('doc') || c.includes('text')) return FileText;
  return Code2;
}

type DiscoveryItem = {
  title?: string;
  resource: string;
  description: string;
  /** 「いつ・何のために買うか」(英語・任意)。未設定なら表示しない。 */
  trigger?: string;
  category: string;
  priceJpyc: string;
  docsUrl?: string;
  license?: string;
  updatedAt?: string;
  verifiedAt?: string | null;
  official?: boolean;
  /** dual-rail の USDC/Base 面 (表示用・リレー点灯中のみ server が返す)。 */
  usdc?: { priceUsd: string; serviceName?: string };
  accepts: Array<{ payTo?: string; extra?: { openpay?: { feeValue?: string } } }>;
};

const EMPTY_DISCOVERY_ITEMS: DiscoveryItem[] = [];
/** カタログの初期表示件数。超える分は「さらに N 件を表示」で開く (モバイルの全長を抑える)。 */
const CATALOG_PAGE_SIZE = 8;
const EMPTY_USDC_ITEMS: UsdcCatalogItem[] = [];

/** カタログの通貨フィルタ。JPYC = /api/discovery (Polygon・facilitator) / USDC = Base・標準 x402。 */
type CatalogCurrency = 'all' | 'jpyc' | 'usdc';

/** JPYC と USDC を同じ一覧に並べるための共通形。 */
type CatalogEntry =
  | { kind: 'jpyc'; key: string; category: string; searchText: string; item: DiscoveryItem }
  | { kind: 'usdc'; key: string; category: string; searchText: string; item: UsdcCatalogItem };

type RegisteredResource = {
  title?: string;
  trigger?: string;
  url: string;
  description: string;
  priceJpyc: string;
  category: string;
  docsUrl?: string;
  license?: string;
};

// owner 一覧 (GET /api/facilitator/resources) の要素。編集に id + payTo が要る。
type OwnedResource = {
  title?: string;
  trigger?: string;
  id: string;
  url: string;
  description: string;
  priceJpyc: string;
  category: string;
  payTo: string;
  docsUrl?: string;
  license?: string;
  paywallSnippet?: string;
  hidden?: boolean;
  /** 定期再検証の状態。authFailures は 401/403/別ドメイン転送の連続回数 (欠落 = 0)。 */
  verification?: { authFailures?: number };
  /** dual-rail の USDC/Base 面 (任意)。 */
  usdc?: { payTo: string; priceUsd: string; serviceName?: string };
};

// hidden の理由が「ゲートを確認できなかった」ではなく「再検証を締め出された」ケース。
// ゲートのスニペットを見せても直らない (出品側が probe を通す必要がある) ので文面を分ける。
function isAuthBlockedHide(resource: OwnedResource): boolean {
  return (
    (resource.verification?.authFailures ?? 0) >= REVERIFY_AUTH_HIDE_THRESHOLD
  );
}

const EMPTY_FORM = {
  url: '',
  description: '',
  priceJpyc: '',
  category: '',
  payTo: '',
  title: '',
  trigger: '',
  docsUrl: '',
  license: '',
  // dual-rail USDC 面 (NEXT_PUBLIC_ENABLE_X402_DUAL_RAIL 点灯時のみ UI に出る)。
  usdcEnabled: false,
  usdcPriceUsd: '',
  usdcPayTo: '',
  usdcServiceName: '',
};
const RESOURCE_DOCS_URL_MAX = 512;
const RESOURCE_LICENSE_MAX = 60;
const DAY_MS = 24 * 60 * 60 * 1_000;
const DEMO_RESOURCE_URL = 'https://open-pay.jp/api/paid/demo';
const CATALOG_CATEGORIES = ['api', 'data', 'mcp', 'content'] as const;
type CatalogCategory = (typeof CATALOG_CATEGORIES)[number];
const BUYER_SCRIPT_URL =
  'https://raw.githubusercontent.com/cipherwebllc/openpay/main/scripts/x402-buyer-example.mjs';
const DEMO_CURL = `curl -i ${DEMO_RESOURCE_URL}`;
// 設定に鍵は入れない (`0x...` のプレースホルダ鍵は MCP が起動時に拒否する)。鍵は wallet_init が
// 利用者のマシン上で作る。版固定は lib/agentSetup.ts の AGENT_MCP_SPEC と同値 — client bundle に
// 引き込まないため直書きし、一致は tests/components/X402DiscoveryView.test.tsx が検査する。
const MCP_CONFIG_SNIPPET = JSON.stringify(
  {
    mcpServers: {
      'openpay-x402': {
        command: 'npx',
        args: ['-y', 'openpay-x402-mcp@0.17'],
        env: { SIGNER_MODE: 'keystore' },
      },
    },
  },
  null,
  2,
);

const BUYER_SCRIPT_COMMAND = [
  `curl -fsSL ${BUYER_SCRIPT_URL} -o x402-buyer-example.mjs`,
  `BUYER_PRIVATE_KEY=0x... RESOURCE_URL=${DEMO_RESOURCE_URL} node x402-buyer-example.mjs`,
].join('\n');

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function isoDate(value: string | undefined): string | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString().slice(0, 10) : null;
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

function PaywallSnippet({
  snippet,
  copyKey,
  copied,
  onCopy,
  title,
  copyLabel,
  copiedLabel,
}: {
  snippet: string;
  copyKey: string;
  copied: boolean;
  onCopy: (key: string, text: string) => void;
  title: string;
  copyLabel: string;
  copiedLabel: string;
}) {
  return (
    <div className="mt-2">
      <p className="text-xs text-slate-500">{title}</p>
      <div className="relative mt-1">
        <pre className="max-h-72 overflow-auto rounded-lg bg-slate-900 p-3 pr-28 text-xs leading-relaxed text-slate-100">
          {snippet}
        </pre>
        <button
          type="button"
          onClick={() => onCopy(copyKey, snippet)}
          className="absolute right-2 top-2 inline-flex items-center gap-1.5 rounded-md bg-slate-800 px-2 py-1.5 text-xs font-medium text-slate-100 transition hover:bg-slate-700"
        >
          {copied ? (
            <Check className="h-3.5 w-3.5 text-emerald-400" aria-hidden />
          ) : (
            <Copy className="h-3.5 w-3.5" aria-hidden />
          )}
          <span>{copied ? copiedLabel : copyLabel}</span>
        </button>
      </div>
    </div>
  );
}

export function X402DiscoveryView({
  maxResourcesPerMerchant,
  featured,
  usdcItems = EMPTY_USDC_ITEMS,
  usdcArc = false,
  freshnessByPath,
}: {
  maxResourcesPerMerchant: number;
  featured?: ReactNode;
  /** USDC (Base・標準 x402) 商品。server が静的に渡す (lib/x402/usdcCatalog)。 */
  usdcItems?: readonly UsdcCatalogItem[];
  /** first-party の USDC 商品が Arc (Circle Gateway) でも払えるとき true (表示専用・server が flag から渡す)。
   *  第三者出品の USDC 面 (dual-rail) は Base のみなので対象外。 */
  usdcArc?: boolean;
  /** 更新型商品の鮮度 (path キー)。server が静的に渡す (lib/directory/monitorFreshness)。 */
  freshnessByPath?: Readonly<Record<string, MonitorFreshness>>;
}) {
  const t = useTranslations('Facilitator');
  const locale = useLocale();
  // 絶対 URL のカードを path キーの鮮度表に引く (JPYC 面と USDC 面で同じ商品を指す)。
  const freshnessFor = (url: string): MonitorFreshness | undefined => {
    if (!freshnessByPath) return undefined;
    try {
      return freshnessByPath[new URL(url).pathname];
    } catch {
      return undefined; // 出品 URL が不正でもカード描画本体を巻き込まない (owned 一覧の入力途中値)
    }
  };
  const { address, isConnected } = useAccount();
  const { isSignedIn, signIn, isSigningIn } = useSiweSession();

  const [form, setForm] = useState(EMPTY_FORM);
  const [formOpen, setFormOpen] = useState<boolean | null>(null);
  const registrationRef = useRef<HTMLElement>(null);
  const [editId, setEditId] = useState<string | null>(null); // 非 null = 編集中 (PATCH)
  const [created, setCreated] = useState<{
    resource: RegisteredResource;
    paywallSnippet: string;
  } | null>(null);
  const [notice, setNotice] = useState<'updated' | 'deleted' | null>(null);
  // USDC 面つきで登録/更新した直後の「サーバーのゲート貼り替え」リマインダー。
  // 貼り替えるまで実サーバーの 402 は JPYC のみ = USDC では買えない (実運用で発覚した期待違い)。
  const [usdcReminder, setUsdcReminder] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorSnippet, setErrorSnippet] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  // 登録時 1 回きりだったスニペット表示を owner 一覧から再表示するためのトグル。
  const [snippetOpenId, setSnippetOpenId] = useState<string | null>(null);
  // 出品の正当性表明 (新規登録のみ必須・編集では不要)。送信成功でリセット。
  const [attested, setAttested] = useState(false);
  // コピー済みフィードバック (key 単位・1.5s でリセット)。
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(() => new Set());
  const [catalogSearch, setCatalogSearch] = useState('');
  const [catalogCategory, setCatalogCategory] = useState<CatalogCategory | null>(null);
  const [catalogCurrency, setCatalogCurrency] = useState<CatalogCurrency>('all');
  const copyText = useCallback((key: string, text: string) => {
    try {
      void navigator.clipboard?.writeText(text);
    } catch {
      /* clipboard 不可環境は無視 */
    }
    setCopiedKey(key);
    window.setTimeout(() => setCopiedKey((k) => (k === key ? null : k)), 1500);
  }, []);

  const queryClient = useQueryClient();

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

  // owner の登録一覧 (SIWE 時のみ・編集/削除の対象)。未サインインは enabled:false で取得せず owned は空。
  const ownedQuery = useQuery({
    queryKey: ['x402', 'owned', address],
    enabled: isSignedIn,
    queryFn: async () => {
      const res = await fetch('/api/facilitator/resources', { cache: 'no-store' });
      if (!res.ok) throw new Error(`http_${res.status}`);
      const body = (await res.json()) as { resources?: OwnedResource[] };
      return body.resources ?? [];
    },
    retry: false,
  });

  const items = catalogQuery.data ?? EMPTY_DISCOVERY_ITEMS;
  const loading = catalogQuery.isFetching;
  const owned = ownedQuery.data ?? [];
  const atResourceLimit = owned.length >= maxResourcesPerMerchant;
  // JPYC (動的) と USDC (静的) を 1 つの一覧に。並びは JPYC (first-party 先頭の server 順) → USDC。
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

  const onEdit = useCallback((r: OwnedResource) => {
    setEditId(r.id);
    setForm({
      url: r.url,
      description: r.description,
      priceJpyc: r.priceJpyc,
      category: r.category,
      payTo: r.payTo,
      title: r.title ?? '',
      trigger: r.trigger ?? '',
      docsUrl: r.docsUrl ?? '',
      license: r.license ?? '',
      usdcEnabled: Boolean(r.usdc),
      usdcPriceUsd: r.usdc?.priceUsd ?? '',
      usdcPayTo: r.usdc?.payTo ?? '',
      usdcServiceName: r.usdc?.serviceName ?? '',
    });
    setCreated(null);
    setNotice(null);
    setError(null);
    setErrorSnippet('');
    setConfirmDeleteId(null);
    setFormOpen(true);
    registrationRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, []);

  const onCancelEdit = useCallback(() => {
    setFormOpen(null);
    setEditId(null);
    setForm(EMPTY_FORM);
    setError(null);
    setErrorSnippet('');
  }, []);

  // 登録 (editId 無し → POST) / 編集 (editId 有り → PATCH) を出し分ける。成功後は catalog / owned を
  // invalidate して再取得する (従来の void loadCatalog(); void loadOwned(); の置換)。fetch/parse の
  // 例外・!ok・resource 欠落はいずれも {ok:false} を返し、従来と同じエラー文言 (error コード) を出す。
  const submitMutation = useMutation({
    mutationFn: async (): Promise<
      | { ok: true; wasEdit: boolean; resource: RegisteredResource; paywallSnippet: string }
      | { ok: false; error: string; paywallSnippet: string }
    > => {
      const payload = {
        url: form.url,
        description: form.description,
        priceJpyc: form.priceJpyc,
        category: form.category,
        ...(form.payTo ? { payTo: form.payTo } : {}),
        ...(form.title ? { title: form.title } : {}),
        ...(form.trigger ? { trigger: form.trigger } : {}),
        ...(form.docsUrl ? { docsUrl: form.docsUrl } : {}),
        ...(form.license ? { license: form.license } : {}),
        // USDC 面は checkbox ON のときだけ送る (OFF = 編集で面を外す)。UI flag ではなく
        // form 状態で判定 — flag OFF 中の編集でも既存の USDC 面 (prefill) を黙って消さない。
        ...(form.usdcEnabled
          ? {
              usdc: {
                priceUsd: form.usdcPriceUsd.trim(),
                ...(form.usdcPayTo.trim() ? { payTo: form.usdcPayTo.trim() } : {}),
                ...(form.usdcServiceName.trim()
                  ? { serviceName: form.usdcServiceName.trim() }
                  : {}),
              },
            }
          : {}),
        // 新規登録のみ正当性表明を送る (サーバは POST でのみ必須・編集では無視)。
        ...(editId ? {} : { attested }),
      };
      try {
        const res = editId
          ? await fetch(`/api/facilitator/resources/${editId}`, {
              method: 'PATCH',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(payload),
            })
          : await fetch('/api/facilitator/resources', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(payload),
            });
        const body = (await res.json().catch(() => ({}))) as {
          resource?: RegisteredResource;
          paywallSnippet?: string;
          error?: string;
        };
        if (!res.ok || !body.resource) {
          return {
            ok: false,
            error: body.error ?? 'error',
            paywallSnippet: body.paywallSnippet ?? '',
          };
        }
        return {
          ok: true,
          wasEdit: Boolean(editId),
          resource: body.resource,
          paywallSnippet: body.paywallSnippet ?? '',
        };
      } catch {
        return { ok: false, error: 'error', paywallSnippet: '' };
      }
    },
    onMutate: () => {
      setError(null);
      setErrorSnippet('');
      setNotice(null);
      setUsdcReminder(false);
    },
    onSuccess: (result) => {
      if (!result.ok) {
        setError(result.error);
        setErrorSnippet(result.paywallSnippet);
        return;
      }
      // 送信時点の form 状態で判定 (成功後は form がリセットされるため onSuccess 内で参照しない
      // ように submit 前の値を使う — mutationFn closure の form は submit 時のもの)。
      setUsdcReminder(form.usdcEnabled);
      if (result.wasEdit) {
        setNotice('updated');
        setCreated(null);
      } else {
        setCreated({
          resource: result.resource,
          paywallSnippet: result.paywallSnippet,
        });
      }
      setForm(EMPTY_FORM);
      setEditId(null);
      setAttested(false);
      setFormOpen(null);
      void queryClient.invalidateQueries({ queryKey: ['x402', 'discovery'] });
      void queryClient.invalidateQueries({ queryKey: ['x402', 'owned'] });
    },
  });
  const submitting = submitMutation.isPending;

  // 無効化 (DELETE)。!ok は {ok:false} を返しエラー文言を出す。fetch 例外は従来どおり握らず
  // (エラー表示なし・確認 UI も維持)。成功後は catalog / owned を invalidate して再取得する。
  const deleteMutation = useMutation({
    mutationFn: async (id: string): Promise<{ ok: boolean; error?: string }> => {
      const res = await fetch(`/api/facilitator/resources/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        return { ok: false, error: body.error ?? 'error' };
      }
      return { ok: true };
    },
    onMutate: () => {
      setError(null);
      setErrorSnippet('');
      setNotice(null);
    },
    onSuccess: (result, id) => {
      if (!result.ok) {
        setError(result.error ?? 'error');
        return;
      }
      setConfirmDeleteId(null);
      if (editId === id) onCancelEdit(); // 編集中の掲載を消したらフォームも閉じる
      setNotice('deleted');
      void queryClient.invalidateQueries({ queryKey: ['x402', 'discovery'] });
      void queryClient.invalidateQueries({ queryKey: ['x402', 'owned'] });
    },
  });

  const inputCls =
    'w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/15';
  const resourceActionCls =
    'inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-700 transition hover:border-brand hover:text-brand-dark';

  // エラー key → 親切な文言。resource_not_gated は 402 自体が返らない URL、gate_not_openpay は
  // 402 は返るが OpenPay JPYC 方式でない URL、と原因と直し方を分ける。
  const errorMsg =
    error === 'resource_not_gated'
      ? t('errorNotGated')
      : error === 'gate_not_openpay' && errorSnippet
        ? t('errorGateNotOpenPay')
        : error === 'attestation_required'
          ? t('errorAttestationRequired')
          : error === 'too_many_resources'
            ? t('errorTooManyResources', { limit: maxResourcesPerMerchant })
            : error === 'invalid_usdc_price'
              ? t('errorUsdcPrice')
              : error === 'invalid_usdc_pay_to'
                ? t('errorUsdcPayTo')
                : error
                  ? t('errorGeneric', { reason: error })
                  : null;
  const [mcpSdkNotePrefix, mcpSdkPackageName, mcpSdkNoteSuffix] = t(
    'mcpSdkNote',
  ).split(/(openpay-x402-sdk)/);

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

  const copyCodeBtn = (k: string, text: string) => (
    <button
      type="button"
      onClick={() => copyText(k, text)}
      className="inline-flex items-center gap-1.5 rounded-lg bg-slate-800 px-2.5 py-1.5 text-xs font-medium text-slate-100 transition hover:bg-slate-700"
    >
      {copiedKey === k ? (
        <Check className="h-3.5 w-3.5 text-emerald-400" aria-hidden />
      ) : (
        <Copy className="h-3.5 w-3.5" aria-hidden />
      )}
      <span>{copiedKey === k ? t('copied') : t('copy')}</span>
    </button>
  );

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

  // セクションの中身を変えず、閲覧者と売り手で並びだけを切り替える。
  const formCategories = ['api', 'data', 'mcp'];
  const legacyCategory = owned.find((resource) => resource.id === editId)?.category;
  if (legacyCategory && !formCategories.includes(legacyCategory)) {
    formCategories.push(legacyCategory);
  }
  const autoOpen = owned.length === 0 || editId !== null || created !== null || notice !== null;
  // owned>0 のときはフォーム全体を details に畳み、summary が見出しを兼ねる (内側の見出しは出さない)。
  const collapsible = owned.length > 0;
  const registrationContent = (
      <div>
        <div className="flex items-start gap-3">
          {!collapsible && (
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand/10 text-brand">
              <Plus className="h-5 w-5" aria-hidden />
            </span>
          )}
          <div className="min-w-0">
            {!collapsible && (
              <h3 className="text-base font-bold text-slate-900">
                {editId ? t('editTitle') : t('registerTitle')}
              </h3>
            )}
            <p className={`${collapsible ? '' : 'mt-0.5 '}text-sm leading-relaxed text-slate-500`}>
              {t('registerSubtitle')}
            </p>
            {/* 発見面の明示: USDC 併売の有無に合わせて掲載先を案内する。 */}
            <p className="mt-1.5 text-xs leading-relaxed text-slate-500">
              {env.enableX402DualRailUi
                ? t('listingDiscoveryNoteDualRail')
                : t('listingDiscoveryNote')}
            </p>
            {/* 出品の詳細手順+実売事例は /guide/sell が持つ (フォームは要点のみ)。 */}
            <Link
              href={`/${locale}/guide/sell`}
              prefetch={false}
              className="mt-1.5 inline-flex text-xs font-medium text-brand underline-offset-2 hover:text-brand-dark hover:underline"
            >
              {t('sellGuideCta')}
            </Link>
          </div>
        </div>

        {!isConnected ? (
          <div className="mt-4 flex flex-col gap-3 rounded-xl bg-slate-50 px-3 py-2.5 text-sm text-slate-600 sm:flex-row sm:items-center sm:justify-between">
            <p className="flex items-center gap-2">
              <Wallet className="h-4 w-4 shrink-0 text-slate-400" aria-hidden />
              <span>{t('connectPrompt')}</span>
            </p>
            <ConnectButton />
          </div>
        ) : !isSignedIn ? (
          <button
            type="button"
            onClick={() => void signIn(t('signInStatement'))}
            disabled={isSigningIn}
            className="mt-4 inline-flex items-center gap-2 rounded-xl bg-brand px-4 py-2.5 text-sm font-semibold text-white shadow-card transition hover:-translate-y-0.5 hover:bg-brand-dark hover:shadow-card-hover active:translate-y-0 disabled:opacity-50 disabled:hover:translate-y-0"
          >
            <Wallet className="h-4 w-4" aria-hidden />
            {isSigningIn ? t('signingIn') : t('signInCta')}
          </button>
        ) : (
          <div className="mt-4 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p
                title={address}
                className="inline-flex items-center gap-1.5 rounded-full bg-slate-50 px-2.5 py-1 font-mono text-xs text-slate-500"
              >
                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" aria-hidden />
                {t('signedInAs', { address: shortAddress(address ?? '') })}
              </p>
              {owned.length > 0 && (
                <p
                  className={`text-xs font-semibold ${
                    atResourceLimit ? 'text-amber-700' : 'text-slate-500'
                  }`}
                >
                  {owned.length >= maxResourcesPerMerchant * 0.8
                    ? t('registrationCount', { count: owned.length, limit: maxResourcesPerMerchant })
                    : t('registrationCountShort', { count: owned.length })}
                </p>
              )}
            </div>
            {atResourceLimit && !editId && (
              <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-800">
                {t('registrationLimitReached')}
              </p>
            )}
            <Field label={t('formUrlLabel')}>
              <input
                className={inputCls}
                placeholder={t('formUrl')}
                value={form.url}
                onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))}
              />
            </Field>
            <Field label={t('formDescriptionLabel')}>
              <input
                className={inputCls}
                placeholder={t('formDescription')}
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label={t('formPriceLabel')}>
                <input
                  className={inputCls}
                  inputMode="numeric"
                  placeholder={t('formPrice')}
                  value={form.priceJpyc}
                  onChange={(e) => setForm((f) => ({ ...f, priceJpyc: e.target.value }))}
                />
              </Field>
              <Field label={t('formCategoryLabel')}>
                <div className="flex flex-wrap gap-1.5">
                  {formCategories.map((category) => (
                    <button
                      key={category}
                      type="button"
                      aria-pressed={form.category === category}
                      onClick={() => setForm((f) => ({ ...f, category }))}
                      className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium transition ${
                        form.category === category
                          ? 'border-brand bg-brand text-white'
                          : 'border-slate-300 bg-white text-slate-600 hover:border-brand'
                      }`}
                    >
                      {category}
                    </button>
                  ))}
                </div>
              </Field>
            </div>
            <Field label={t('formPayToLabel')}>
              <input
                className={inputCls}
                placeholder={t('formPayTo')}
                value={form.payTo}
                onChange={(e) => setForm((f) => ({ ...f, payTo: e.target.value }))}
              />
              <p className="mt-1.5 text-xs leading-relaxed text-slate-500">
                {t('formPayToHint')}
              </p>
            </Field>
            {/* dual-rail USDC 面 (opt-in)。UI flag OFF でも既存面 (prefill) があれば出す —
                見えない状態で面を消させない。 */}
            {(env.enableX402DualRailUi || form.usdcEnabled) && (
              <div className="rounded-xl border border-sky-200/80 bg-sky-50/50 px-3 py-2.5">
                <label className="flex cursor-pointer items-center gap-2.5">
                  <input
                    type="checkbox"
                    checked={form.usdcEnabled}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, usdcEnabled: e.target.checked }))
                    }
                    className="h-4 w-4 shrink-0 rounded border-slate-300 text-brand focus:ring-brand/30"
                  />
                  <span className="text-xs font-semibold text-slate-700">
                    {t('formUsdcEnable')}
                  </span>
                </label>
                <p className="mt-1.5 pl-6 text-xs leading-relaxed text-slate-500">
                  {t('formUsdcHint')}
                </p>
                {form.usdcEnabled && (
                  <div className="mt-2.5 space-y-3 border-t border-sky-100 pt-3">
                    <Field label={t('formUsdcPriceLabel')}>
                      <input
                        className={inputCls}
                        inputMode="decimal"
                        placeholder={t('formUsdcPrice')}
                        value={form.usdcPriceUsd}
                        onChange={(e) =>
                          setForm((f) => ({ ...f, usdcPriceUsd: e.target.value }))
                        }
                      />
                      <p className="mt-1.5 text-xs leading-relaxed text-slate-500">
                        {t('formUsdcPriceHint')}
                      </p>
                    </Field>
                    <Field label={t('formUsdcPayToLabel')}>
                      <input
                        className={inputCls}
                        placeholder={t('formUsdcPayTo')}
                        value={form.usdcPayTo}
                        onChange={(e) =>
                          setForm((f) => ({ ...f, usdcPayTo: e.target.value }))
                        }
                      />
                      <p className="mt-1.5 text-xs leading-relaxed text-slate-500">
                        {t('formUsdcPayToHint')}
                      </p>
                    </Field>
                    <Field label={t('formUsdcServiceNameLabel')}>
                      <input
                        className={inputCls}
                        maxLength={60}
                        placeholder={t('formUsdcServiceName')}
                        value={form.usdcServiceName}
                        onChange={(e) =>
                          setForm((f) => ({ ...f, usdcServiceName: e.target.value }))
                        }
                      />
                    </Field>
                  </div>
                )}
              </div>
            )}
            {/* 任意項目は折りたたみ (既定で閉じる)。編集中か入力済みなら開いた状態で見せる。 */}
            <details
              className="group rounded-xl border border-slate-200/70"
              open={Boolean(editId || form.title || form.trigger || form.docsUrl || form.license)}
            >
              <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3 py-2.5 text-sm font-semibold text-slate-700">
                {t('formOptionalGroupTitle')}
                <ChevronDown
                  className="h-4 w-4 shrink-0 text-slate-400 transition group-open:rotate-180"
                  aria-hidden
                />
              </summary>
              <div className="space-y-3 border-t border-slate-100 px-3 py-3">
                <Field label={t('formTitleLabel')}>
                  <input
                    className={inputCls}
                    placeholder={t('formTitle')}
                    maxLength={60}
                    value={form.title}
                    onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
                  />
                  <p className="mt-1.5 text-xs leading-relaxed text-slate-500">
                    {t('formTitleHint')}
                  </p>
                </Field>
                <Field label={t('formTriggerLabel')}>
                  <input
                    className={inputCls}
                    placeholder={t('formTrigger')}
                    maxLength={200}
                    value={form.trigger}
                    onChange={(e) => setForm((f) => ({ ...f, trigger: e.target.value }))}
                  />
                  <p className="mt-1.5 text-xs leading-relaxed text-slate-500">
                    {t('formTriggerHint')}
                  </p>
                </Field>
                <Field label={t('formDocsUrlLabel')}>
                  <input
                    type="url"
                    className={inputCls}
                    placeholder={t('formDocsUrl')}
                    maxLength={RESOURCE_DOCS_URL_MAX}
                    value={form.docsUrl}
                    onChange={(e) => setForm((f) => ({ ...f, docsUrl: e.target.value }))}
                  />
                  <p className="mt-1.5 text-xs leading-relaxed text-slate-500">
                    {t('formDocsUrlHint')}
                  </p>
                </Field>
                <Field label={t('formLicenseLabel')}>
                  <input
                    className={inputCls}
                    placeholder={t('formLicense')}
                    maxLength={RESOURCE_LICENSE_MAX}
                    value={form.license}
                    onChange={(e) => setForm((f) => ({ ...f, license: e.target.value }))}
                  />
                  <p className="mt-1.5 text-xs leading-relaxed text-slate-500">
                    {t('formLicenseHint')}
                  </p>
                </Field>
              </div>
            </details>

            {/* 出品の正当性表明 (新規登録のみ・必須)。サーバ側でも attested を強制する。 */}
            {!editId && (
              <div className="rounded-xl border border-slate-200/70 bg-slate-50/60 px-3 py-2.5">
                <label className="flex cursor-pointer items-center gap-2.5">
                  <input
                    type="checkbox"
                    checked={attested}
                    onChange={(e) => setAttested(e.target.checked)}
                    className="h-4 w-4 shrink-0 rounded border-slate-300 text-brand focus:ring-brand/30"
                  />
                  <span className="text-xs font-medium text-slate-700">
                    {t('attestSummary')}
                  </span>
                </label>
                <details className="group mt-1.5 pl-6">
                  <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-xs font-medium text-slate-500 hover:text-slate-700">
                    {t('detailsLabel')}
                    <ChevronDown
                      className="h-3.5 w-3.5 transition group-open:rotate-180"
                      aria-hidden
                    />
                  </summary>
                  <p className="mt-1.5 text-xs leading-relaxed text-slate-600">
                    {t('listingPolicySummary')}
                  </p>
                  <p className="mt-1.5 text-xs leading-relaxed text-slate-600">
                    {t('attestLabel')}
                  </p>
                </details>
              </div>
            )}

            <div className="flex items-center gap-3 pt-1">
              <button
                type="button"
                onClick={() => submitMutation.mutate()}
                disabled={
                  submitting ||
                  (!editId && (ownedQuery.isPending || atResourceLimit || !attested))
                }
                className="inline-flex items-center gap-1.5 rounded-xl bg-brand px-4 py-2.5 text-sm font-semibold text-white shadow-card transition hover:-translate-y-0.5 hover:bg-brand-dark hover:shadow-card-hover active:translate-y-0 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0"
              >
                {submitting
                  ? editId
                    ? t('updating')
                    : t('submitting')
                  : editId
                    ? t('updateCta')
                    : t('submitCta')}
              </button>
              {editId && (
                <button
                  type="button"
                  onClick={onCancelEdit}
                  disabled={submitting}
                  className="rounded-xl border border-slate-300 px-4 py-2.5 text-sm font-medium text-slate-600 transition hover:border-slate-400 disabled:opacity-50"
                >
                  {t('cancelCta')}
                </button>
              )}
            </div>
            {!editId && !atResourceLimit && !attested && !submitting && (
              <p className="text-[11px] text-slate-500">{t('attestRequired')}</p>
            )}
            {errorMsg &&
              (error === 'gate_not_openpay' && errorSnippet ? (
                <div className="rounded-xl border border-red-200 bg-red-50 p-4">
                  <p className="text-sm leading-relaxed text-red-700">{errorMsg}</p>
                  <PaywallSnippet
                    snippet={errorSnippet}
                    copyKey="error-snippet"
                    copied={copiedKey === 'error-snippet'}
                    onCopy={copyText}
                    title={t('snippetTitle')}
                    copyLabel={t('copy')}
                    copiedLabel={t('copied')}
                  />
                </div>
              ) : (
                <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
                  {errorMsg}
                </p>
              ))}
            {notice === 'updated' && (
              <div className="space-y-2">
                <p className="inline-flex items-center gap-1.5 text-sm text-emerald-700">
                  <CheckCircle2 className="h-4 w-4" aria-hidden />
                  {t('updated')}
                </p>
                {usdcReminder && (
                  <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-900">
                    {t('usdcGateReminder')}
                  </p>
                )}
              </div>
            )}
            {notice === 'deleted' && (
              <p className="inline-flex items-center gap-1.5 text-sm text-emerald-700">
                <CheckCircle2 className="h-4 w-4" aria-hidden />
                {t('deleted')}
              </p>
            )}
            {created && (
              <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4">
                <p className="flex items-center gap-1.5 text-sm font-semibold text-emerald-800">
                  <CheckCircle2 className="h-4 w-4" aria-hidden />
                  {t('created')}
                </p>
                {usdcReminder && (
                  <p className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-900">
                    {t('usdcGateReminder')}
                  </p>
                )}
                <PaywallSnippet
                  snippet={created.paywallSnippet}
                  copyKey="snippet"
                  copied={copiedKey === 'snippet'}
                  onCopy={copyText}
                  title={t('snippetTitle')}
                  copyLabel={t('copy')}
                  copiedLabel={t('copied')}
                />
              </div>
            )}
          </div>
        )}
      </div>
  );

  const registrationSection = (
    <section ref={registrationRef} className="rounded-2xl bg-white p-5 shadow-card ring-1 ring-slate-200/70 sm:p-6">
      {collapsible ? (
        <details
          className="group/registration"
          open={formOpen ?? autoOpen}
          onToggle={(e) => setFormOpen(e.currentTarget.open)}
        >
          <summary className="flex cursor-pointer list-none items-center gap-3 text-base font-bold text-slate-900">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand/10 text-brand">
              <Plus className="h-5 w-5" aria-hidden />
            </span>
            {editId ? t('editTitle') : t('registerNewTitle')}
            <ChevronDown className="ml-auto h-4 w-4 shrink-0 transition group-open/registration:rotate-180" aria-hidden />
          </summary>
          <div className="mt-4">{registrationContent}</div>
        </details>
      ) : registrationContent}
    </section>
  );

  const ownedResourcesSection =
    isSignedIn && owned.length > 0 ? (
      <>
        {/* あなたの登録 (owner のみ・編集/削除) */}
        <section>
          <h3 className="text-base font-bold text-slate-900">{t('yourResourcesTitle')}</h3>
          <p className="mt-1 text-sm text-slate-500">{t('yourResourcesSubtitle')}</p>
          <ul className="mt-4 space-y-3">
            {owned.map((r) => (
              <li
                key={r.id}
                className="rounded-2xl bg-white p-4 shadow-card ring-1 ring-slate-200/70"
              >
                {cardHead({
                  category: r.category,
                  priceNode: (
                    <span className="shrink-0 text-right text-sm font-bold text-slate-900">
                      {r.priceJpyc} JPYC
                      {r.usdc && (
                        <span className="block text-[11px] font-semibold text-sky-700">
                          {t('usdcFaceMeta', { price: r.usdc.priceUsd })}
                        </span>
                      )}
                    </span>
                  ),
                  title: r.title,
                  trigger: r.trigger,
                  description: r.description,
                  usdc: r.usdc,
                  license: r.license,
                  url: r.url,
                  copyKey: `owned-${r.id}`,
                })}
                {(Boolean(r.license && expandedKeys.has(`owned-${r.id}`)) || Boolean(r.docsUrl && isHttpsUrl(r.docsUrl))) && (
                  <div className="mt-2 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[11px] leading-relaxed text-slate-500">
                    {r.docsUrl && isHttpsUrl(r.docsUrl) && (
                      <a
                        href={r.docsUrl}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="shrink-0 font-medium text-brand hover:text-brand-dark hover:underline"
                      >
                        {t('docsLink')}
                      </a>
                    )}
                    {r.license && expandedKeys.has(`owned-${r.id}`) && (
                      <span className="min-w-0">
                        {t('licenseMeta', { license: r.license })}
                      </span>
                    )}
                  </div>
                )}
                {r.hidden === true && (isAuthBlockedHide(r) || r.paywallSnippet) ? (
                  <div className="mt-3 rounded-xl border border-amber-300 bg-amber-50 p-3">
                    <p className="inline-flex items-center gap-1.5 rounded-full bg-amber-200 px-2.5 py-1 text-xs font-bold text-amber-900">
                      <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
                      {t('requiresActionBadge')}
                    </p>
                    <p className="mt-2 text-sm leading-relaxed text-amber-900">
                      {isAuthBlockedHide(r)
                        ? t('requiresActionAuthBody')
                        : t('requiresActionBody')}
                    </p>
                    {/* 締め出しが理由のときはゲートのスニペットを出しても直らない。 */}
                    {!isAuthBlockedHide(r) && r.paywallSnippet ? (
                      <PaywallSnippet
                        snippet={r.paywallSnippet}
                        copyKey={`repair-snippet-${r.id}`}
                        copied={copiedKey === `repair-snippet-${r.id}`}
                        onCopy={copyText}
                        title={t('snippetTitle')}
                        copyLabel={t('copy')}
                        copiedLabel={t('copied')}
                      />
                    ) : null}
                  </div>
                ) : null}
                {snippetOpenId === r.id && r.paywallSnippet ? (
                  <div className="relative mt-3 border-t border-slate-100 pt-3">
                    <pre className="max-h-72 overflow-auto rounded-lg bg-slate-900 p-3 pr-24 text-xs leading-relaxed text-slate-100">
                      {r.paywallSnippet}
                    </pre>
                    <button
                      type="button"
                      onClick={() => copyText(`owned-snippet-${r.id}`, r.paywallSnippet ?? '')}
                      className="absolute right-2 top-5 inline-flex items-center gap-1.5 rounded-md bg-slate-700 px-2 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-600"
                    >
                      {copiedKey === `owned-snippet-${r.id}` ? (
                        <Check className="h-3.5 w-3.5 text-emerald-400" aria-hidden />
                      ) : (
                        <Copy className="h-3.5 w-3.5" aria-hidden />
                      )}
                      <span>
                        {copiedKey === `owned-snippet-${r.id}` ? t('copied') : t('copy')}
                      </span>
                    </button>
                  </div>
                ) : null}
                {confirmDeleteId === r.id ? (
                  <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-slate-100 pt-3">
                    <span className="text-sm text-slate-600">{t('deleteConfirm')}</span>
                    <button
                      type="button"
                      onClick={() => deleteMutation.mutate(r.id)}
                      className="rounded-lg bg-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-700"
                    >
                      {t('deleteConfirmCta')}
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmDeleteId(null)}
                      className="text-xs font-medium text-slate-500 hover:underline"
                    >
                      {t('keepCta')}
                    </button>
                  </div>
                ) : (
                  <div className="mt-3 flex items-center gap-2 border-t border-slate-100 pt-3">
                    <button
                      type="button"
                      onClick={() => setSnippetOpenId(snippetOpenId === r.id ? null : r.id)}
                      className={resourceActionCls}
                    >
                      <Code2 className="h-3.5 w-3.5" aria-hidden />
                      {t('showSnippet')}
                    </button>
                    <button
                      type="button"
                      onClick={() => onEdit(r)}
                      className={resourceActionCls}
                    >
                      <Pencil className="h-3.5 w-3.5" aria-hidden />
                      {t('editCta')}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setConfirmDeleteId(r.id);
                        setNotice(null);
                      }}
                      className={`${resourceActionCls} border-red-200 text-red-600 hover:border-red-400 hover:text-red-700`}
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden />
                      {t('deleteCta')}
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>
      </>
    ) : null;

  const catalogSection = (
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

  const sellerMode = isSignedIn;

  return (
    <div className="space-y-6">
      {sellerMode ? (
        <>
          {ownedResourcesSection}
          {registrationSection}
          {featured}
          {catalogSection}
        </>
      ) : (
        <>
          {featured}
          {catalogSection}
          {registrationSection}
        </>
      )}

      {/* 1 JPYC の first-party demo。長い buyer script は raw を参照し、ページには最小コマンドだけ載せる。 */}
      <section>
        <details className="group overflow-hidden rounded-2xl bg-white shadow-card ring-1 ring-slate-200/70">
          <summary className="flex cursor-pointer list-none items-center gap-3 p-4 transition hover:bg-slate-50">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-slate-900 text-white">
              <Code2 className="h-5 w-5" aria-hidden />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-base font-bold text-slate-900">
                {t('tryTitle')}
              </span>
              <span className="mt-0.5 block text-sm leading-relaxed text-slate-500">
                {t('trySubtitle')}
              </span>
            </span>
            <ChevronDown
              className="h-4 w-4 shrink-0 text-slate-500 transition group-open:rotate-180"
              aria-hidden
            />
          </summary>

          <div className="space-y-4 border-t border-slate-100 p-4">
            <p className="text-sm leading-relaxed text-slate-600">{t('tryIntro')}</p>
            <ol className="space-y-3">
              <li className="flex gap-3">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-900 text-xs font-bold text-white">
                  1
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-slate-800">{t('tryStep1')}</p>
                  <div className="mt-2 rounded-xl bg-slate-950 p-3">
                    <div className="mb-2 flex items-center justify-between gap-3">
                      <span className="text-xs font-medium text-slate-400">
                        {t('tryCurlLabel')}
                      </span>
                      {copyCodeBtn('try-curl', DEMO_CURL)}
                    </div>
                    <pre className="overflow-x-auto text-xs leading-relaxed text-slate-100">
                      {DEMO_CURL}
                    </pre>
                  </div>
                </div>
              </li>
              <li className="flex gap-3">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-900 text-xs font-bold text-white">
                  2
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-slate-800">{t('tryStep2')}</p>
                  <div className="mt-2 rounded-xl bg-slate-950 p-3">
                    <div className="mb-2 flex items-center justify-between gap-3">
                      <a
                        href={BUYER_SCRIPT_URL}
                        target="_blank"
                        rel="noreferrer"
                        className="min-w-0 truncate text-xs font-medium text-sky-300 hover:text-sky-200"
                      >
                        {t('tryRawLink')}
                      </a>
                      {copyCodeBtn('try-script', BUYER_SCRIPT_COMMAND)}
                    </div>
                    <pre className="overflow-x-auto whitespace-pre-wrap text-xs leading-relaxed text-slate-100">
                      {BUYER_SCRIPT_COMMAND}
                    </pre>
                  </div>
                </div>
              </li>
              <li className="flex gap-3">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-900 text-xs font-bold text-white">
                  3
                </span>
                <p className="min-w-0 text-sm font-semibold leading-relaxed text-slate-800">
                  {t('tryStep3')}
                </p>
              </li>
            </ol>
          </div>
        </details>
      </section>

      {/* エージェント導線: npm 公開済みの買い手 MCP (openpay-x402-mcp)。設定 JSON を貼るだけ。 */}
      <section>
        <details className="group overflow-hidden rounded-2xl bg-white shadow-card ring-1 ring-slate-200/70">
          <summary className="flex cursor-pointer list-none items-center gap-3 p-4 transition hover:bg-slate-50">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-slate-900 text-white">
              <Boxes className="h-5 w-5" aria-hidden />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-base font-bold text-slate-900">
                {t('mcpTitle')}
              </span>
              <span className="mt-0.5 block text-sm leading-relaxed text-slate-500">
                {t('mcpSubtitle')}
              </span>
            </span>
            <ChevronDown
              className="h-4 w-4 shrink-0 text-slate-500 transition group-open:rotate-180"
              aria-hidden
            />
          </summary>

          <div className="space-y-3 border-t border-slate-100 p-4">
            <div className="rounded-xl bg-slate-950 p-3">
              <div className="mb-2 flex items-center justify-between gap-3">
                <a
                  href="https://www.npmjs.com/package/openpay-x402-mcp"
                  target="_blank"
                  rel="noreferrer"
                  className="min-w-0 truncate text-xs font-medium text-sky-300 hover:text-sky-200"
                >
                  openpay-x402-mcp
                </a>
                {copyCodeBtn('mcp-config', MCP_CONFIG_SNIPPET)}
              </div>
              <pre className="overflow-x-auto text-xs leading-relaxed text-slate-100">
                {MCP_CONFIG_SNIPPET}
              </pre>
            </div>
            <p className="text-xs leading-relaxed text-slate-600">
              {t('mcpWalletInit')}
            </p>
            <ul className="list-disc space-y-1.5 pl-5 text-xs leading-relaxed text-slate-600">
              <li>{t('mcpGuardPerCall')}</li>
              <li>{t('mcpGuardCumulative')}</li>
              <li>{t('mcpGuardDestinations')}</li>
            </ul>
            <a
              href="https://www.npmjs.com/package/openpay-x402-mcp"
              target="_blank"
              rel="noreferrer"
              className="inline-flex text-xs font-medium text-brand hover:text-brand-dark hover:underline"
            >
              {t('mcpMore')}
            </a>
            <p className="text-xs leading-relaxed text-slate-600">
              {mcpSdkNotePrefix}
              <a
                href="https://www.npmjs.com/package/openpay-x402-sdk"
                target="_blank"
                rel="noreferrer"
                className="font-medium text-brand hover:text-brand-dark hover:underline"
              >
                {mcpSdkPackageName}
              </a>
              {mcpSdkNoteSuffix}
            </p>
            {/* 初回セットアップ (ウォレット/Steward/ガード) の全手順は /guide/ai-pay へ。 */}
            <Link
              href={`/${locale}/guide/ai-pay`}
              prefetch={false}
              className="inline-flex text-xs font-medium text-brand underline-offset-2 hover:text-brand-dark hover:underline"
            >
              {t('aiPayGuideCta')}
            </Link>
          </div>
        </details>
      </section>
    </div>
  );
}
