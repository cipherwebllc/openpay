'use client';

// x402 facilitator の最小 UI: 公開カタログ (discovery) の閲覧 + 加盟店の登録/編集/削除 (SIWE)。
// カタログは /api/discovery を fetch して列挙 (誰でも閲覧)。owner は SIWE サインイン後、自分の登録を
// /api/facilitator/resources で管理する (GET=一覧 / POST=登録 / [id] PATCH=編集 / [id] DELETE=無効化)。
// 本コンポーネントは env.enableX402Facilitator が ON のページからのみマウントされる。

import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { useAccount } from 'wagmi';
import { formatUnits } from 'viem';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
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
} from 'lucide-react';
import { useSiweSession } from '@/hooks/useSiweSession';
import { ConnectButton } from '@/components/ConnectButton';
import { Field } from '@/components/Field';

// カテゴリー文字列 → 視覚アイコン (api / data / mcp / content)。未知は汎用 (Code2)。
function categoryIcon(category: string) {
  const c = category.toLowerCase();
  if (c.includes('data')) return Database;
  if (c.includes('mcp')) return Boxes;
  if (c.includes('content') || c.includes('doc') || c.includes('text')) return FileText;
  return Code2;
}

type DiscoveryItem = {
  resource: string;
  description: string;
  category: string;
  priceJpyc: string;
  docsUrl?: string;
  license?: string;
  updatedAt?: string;
  verifiedAt?: string | null;
  accepts: Array<{ extra?: { openpay?: { feeValue?: string } } }>;
};

const EMPTY_DISCOVERY_ITEMS: DiscoveryItem[] = [];

type RegisteredResource = {
  url: string;
  description: string;
  priceJpyc: string;
  category: string;
  docsUrl?: string;
  license?: string;
};

// owner 一覧 (GET /api/facilitator/resources) の要素。編集に id + payTo が要る。
type OwnedResource = {
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
};

const EMPTY_FORM = {
  url: '',
  description: '',
  priceJpyc: '',
  category: '',
  payTo: '',
  docsUrl: '',
  license: '',
};
const RESOURCE_DOCS_URL_MAX = 512;
const RESOURCE_LICENSE_MAX = 60;
const DAY_MS = 24 * 60 * 60 * 1_000;
const DEMO_RESOURCE_URL = 'https://open-pay.jp/api/paid/demo';
const CATALOG_CATEGORIES = ['api', 'data', 'mcp', 'content'] as const;
type CatalogCategory = (typeof CATALOG_CATEGORIES)[number];
const FIRST_PARTY_RESOURCE_URLS = new Set([
  DEMO_RESOURCE_URL,
  'https://open-pay.jp/api/paid/stores',
  'https://open-pay.jp/api/paid/japan-web3-directory',
  'https://open-pay.jp/api/paid/japan-web3-directory/search',
  'https://open-pay.jp/api/paid/jpyc-shops/search',
]);
const BUYER_SCRIPT_URL =
  'https://raw.githubusercontent.com/cipherwebllc/openpay/main/scripts/x402-buyer-example.mjs';
const DEMO_CURL = `curl -i ${DEMO_RESOURCE_URL}`;
const MCP_CONFIG_SNIPPET = JSON.stringify(
  {
    mcpServers: {
      'openpay-x402': {
        command: 'npx',
        args: ['-y', 'openpay-x402-mcp'],
        env: { BUYER_PRIVATE_KEY: '0x...' },
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
}: {
  maxResourcesPerMerchant: number;
  featured?: ReactNode;
}) {
  const t = useTranslations('Facilitator');
  const { address, isConnected } = useAccount();
  const { isSignedIn, signIn, isSigningIn } = useSiweSession();

  const [form, setForm] = useState(EMPTY_FORM);
  const [editId, setEditId] = useState<string | null>(null); // 非 null = 編集中 (PATCH)
  const [created, setCreated] = useState<{
    resource: RegisteredResource;
    paywallSnippet: string;
  } | null>(null);
  const [notice, setNotice] = useState<'updated' | 'deleted' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorSnippet, setErrorSnippet] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  // 登録時 1 回きりだったスニペット表示を owner 一覧から再表示するためのトグル。
  const [snippetOpenId, setSnippetOpenId] = useState<string | null>(null);
  // 出品の正当性表明 (新規登録のみ必須・編集では不要)。送信成功でリセット。
  const [attested, setAttested] = useState(false);
  // コピー済みフィードバック (key 単位・1.5s でリセット)。
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [catalogSearch, setCatalogSearch] = useState('');
  const [catalogCategory, setCatalogCategory] = useState<CatalogCategory | null>(null);
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
  const categoryCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of items) {
      const category = item.category.trim().toLowerCase();
      counts.set(category, (counts.get(category) ?? 0) + 1);
    }
    return counts;
  }, [items]);
  const availableCategories = CATALOG_CATEGORIES.filter(
    (category) => (categoryCounts.get(category) ?? 0) > 0,
  );
  const effectiveCatalogCategory =
    catalogCategory && availableCategories.includes(catalogCategory)
      ? catalogCategory
      : null;
  const visibleItems = useMemo(() => {
    const search = catalogSearch.trim().toLowerCase();
    return items.filter((item) => {
      if (
        effectiveCatalogCategory &&
        item.category.trim().toLowerCase() !== effectiveCatalogCategory
      ) {
        return false;
      }
      return (
        search === '' ||
        item.description.toLowerCase().includes(search) ||
        item.resource.toLowerCase().includes(search)
      );
    });
  }, [catalogSearch, effectiveCatalogCategory, items]);

  const onEdit = useCallback((r: OwnedResource) => {
    setEditId(r.id);
    setForm({
      url: r.url,
      description: r.description,
      priceJpyc: r.priceJpyc,
      category: r.category,
      payTo: r.payTo,
      docsUrl: r.docsUrl ?? '',
      license: r.license ?? '',
    });
    setCreated(null);
    setNotice(null);
    setError(null);
    setErrorSnippet('');
    setConfirmDeleteId(null);
    if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  const onCancelEdit = useCallback(() => {
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
        ...(form.docsUrl ? { docsUrl: form.docsUrl } : {}),
        ...(form.license ? { license: form.license } : {}),
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
    },
    onSuccess: (result) => {
      if (!result.ok) {
        setError(result.error);
        setErrorSnippet(result.paywallSnippet);
        return;
      }
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
      : error === 'gate_not_openpay'
        ? t('errorGateNotOpenPay')
        : error === 'attestation_required'
          ? t('errorAttestationRequired')
          : error === 'too_many_resources'
            ? t('errorTooManyResources', { limit: maxResourcesPerMerchant })
            : error
              ? t('errorGeneric', { reason: error })
              : null;

  // コピーボタン (URL / スニペット)。key 単位でコピー済みフィードバック。component ではなく関数で
  // 返すことで no-unstable-nested-components を避ける。
  const copyBtn = (k: string, text: string) => (
    <button
      type="button"
      onClick={() => copyText(k, text)}
      aria-label={copiedKey === k ? t('copied') : t('copy')}
      title={copiedKey === k ? t('copied') : t('copy')}
      className="shrink-0 rounded-md p-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
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

  // resource カード共通の頭部 (アイコン + カテゴリ + 価格 + 説明 + URL/コピー)。owned 一覧と公開カタログで
  // 共有する。priceNode は右肩の価格表示 (owned=価格のみ / catalog=価格+手数料+合計) を呼び元が差し込む。
  const cardHead = (opts: {
    category: string;
    priceNode: ReactNode;
    description: string;
    url: string;
    copyKey: string;
    official?: boolean;
  }) => {
    const Icon = categoryIcon(opts.category);
    const urlIsHttps = isHttpsUrl(opts.url);
    return (
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-slate-600">
              <Icon className="h-3 w-3 text-brand" aria-hidden />
              {opts.category}
            </span>
            <p className="min-w-0 text-sm font-bold leading-snug text-slate-900">
              {opts.description}
            </p>
            {opts.official && (
              <span className="shrink-0 rounded-full bg-brand/10 px-2 py-0.5 text-[10px] font-semibold text-brand-dark">
                {t('officialBadge')}
              </span>
            )}
          </div>
          <div className="mt-1 flex items-center gap-1.5">
            {urlIsHttps ? (
              <a
                href={opts.url}
                target="_blank"
                rel="noreferrer noopener"
                className="min-w-0 truncate font-mono text-xs text-slate-400 underline-offset-2 transition hover:text-brand hover:underline"
              >
                {opts.url}
              </a>
            ) : (
              <span className="min-w-0 truncate font-mono text-xs text-slate-400">
                {opts.url}
              </span>
            )}
            {copyBtn(opts.copyKey, opts.url)}
          </div>
        </div>
        {opts.priceNode}
      </div>
    );
  };

  return (
    <div className="space-y-6">
      {/* 出品: 加盟店登録 / 編集 */}
      <section className="rounded-2xl bg-white p-5 shadow-card ring-1 ring-slate-200/70 sm:p-6">
        <div className="flex items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand/10 text-brand">
            <Plus className="h-5 w-5" aria-hidden />
          </span>
          <div className="min-w-0">
            <h3 className="text-base font-bold text-slate-900">
              {editId ? t('editTitle') : t('registerTitle')}
            </h3>
            <p className="mt-0.5 text-sm leading-relaxed text-slate-500">
              {t('registerSubtitle')}
            </p>
            <p className="mt-2 text-xs leading-relaxed text-slate-500">
              {t('listingPolicySummary')}
            </p>
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
              <p className="inline-flex items-center gap-1.5 rounded-full bg-slate-50 px-2.5 py-1 font-mono text-xs text-slate-500">
                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" aria-hidden />
                {t('signedInAs', { address: address ?? '' })}
              </p>
              <p
                className={`text-xs font-semibold ${
                  atResourceLimit ? 'text-amber-700' : 'text-slate-500'
                }`}
              >
                {t('registrationCount', {
                  count: owned.length,
                  limit: maxResourcesPerMerchant,
                })}
              </p>
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
            <Field label={t('formDocsUrlLabel')}>
              <input
                type="url"
                className={inputCls}
                placeholder={t('formDocsUrl')}
                maxLength={RESOURCE_DOCS_URL_MAX}
                value={form.docsUrl}
                onChange={(e) => setForm((f) => ({ ...f, docsUrl: e.target.value }))}
              />
              <p className="mt-1.5 text-xs leading-relaxed text-slate-400">
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
              <p className="mt-1.5 text-xs leading-relaxed text-slate-400">
                {t('formLicenseHint')}
              </p>
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
                <input
                  className={inputCls}
                  placeholder={t('formCategory')}
                  value={form.category}
                  onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}
                />
              </Field>
            </div>
            <Field label={t('formPayToLabel')}>
              <input
                className={inputCls}
                placeholder={t('formPayTo')}
                value={form.payTo}
                onChange={(e) => setForm((f) => ({ ...f, payTo: e.target.value }))}
              />
              <p className="mt-1.5 text-xs leading-relaxed text-slate-400">
                {t('formPayToHint')}
              </p>
            </Field>

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
              <p className="text-[11px] text-slate-400">{t('attestRequired')}</p>
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
              <p className="inline-flex items-center gap-1.5 text-sm text-emerald-700">
                <CheckCircle2 className="h-4 w-4" aria-hidden />
                {t('updated')}
              </p>
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
      </section>

      {/* あなたの登録 (owner のみ・編集/削除) */}
      {isSignedIn && owned.length > 0 && (
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
                    <span className="shrink-0 text-sm font-bold text-slate-900">
                      {r.priceJpyc} JPYC
                    </span>
                  ),
                  description: r.description,
                  url: r.url,
                  copyKey: `owned-${r.id}`,
                })}
                {r.hidden === true && r.paywallSnippet ? (
                  <div className="mt-3 rounded-xl border border-amber-300 bg-amber-50 p-3">
                    <p className="inline-flex items-center gap-1.5 rounded-full bg-amber-200 px-2.5 py-1 text-xs font-bold text-amber-900">
                      <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
                      {t('requiresActionBadge')}
                    </p>
                    <p className="mt-2 text-sm leading-relaxed text-amber-900">
                      {t('requiresActionBody')}
                    </p>
                    <PaywallSnippet
                      snippet={r.paywallSnippet}
                      copyKey={`repair-snippet-${r.id}`}
                      copied={copiedKey === `repair-snippet-${r.id}`}
                      onCopy={copyText}
                      title={t('snippetTitle')}
                      copyLabel={t('copy')}
                      copiedLabel={t('copied')}
                    />
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
      )}

      {featured}

      {/* 公開カタログ */}
      <section>
        <h3 className="text-base font-bold text-slate-900">{t('catalogTitle')}</h3>
        <p className="mt-1 text-sm text-slate-500">{t('catalogSubtitle')}</p>
        {!loading && items.length > 0 && (
          <div className="mt-4 space-y-3 rounded-2xl bg-white p-3 shadow-card ring-1 ring-slate-200/70 sm:p-4">
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-slate-500">
                {t('catalogSearchLabel')}
              </span>
              <span className="relative block">
                <Search
                  className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
                  aria-hidden
                />
                <input
                  type="search"
                  value={catalogSearch}
                  onChange={(event) => setCatalogSearch(event.target.value)}
                  placeholder={t('catalogSearchPlaceholder')}
                  className="w-full rounded-lg border border-slate-300 bg-white py-2 pl-9 pr-3 text-sm text-slate-800 placeholder:text-slate-400 focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/15"
                />
              </span>
            </label>
            <div className="flex flex-wrap gap-1.5">
              <button
                type="button"
                onClick={() => setCatalogCategory(null)}
                aria-pressed={effectiveCatalogCategory === null}
                className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition ${
                  effectiveCatalogCategory === null
                    ? 'border-brand bg-brand text-white'
                    : 'border-slate-300 bg-white text-slate-600 hover:border-brand'
                }`}
              >
                {t('catalogCategoryAll')}
                <span className={effectiveCatalogCategory === null ? 'text-white/75' : 'text-slate-400'}>
                  {items.length}
                </span>
              </button>
              {availableCategories.map((category) => {
                const active = effectiveCatalogCategory === category;
                return (
                  <button
                    key={category}
                    type="button"
                    onClick={() => setCatalogCategory(category)}
                    aria-pressed={active}
                    className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition ${
                      active
                        ? 'border-brand bg-brand text-white'
                        : 'border-slate-300 bg-white text-slate-600 hover:border-brand'
                    }`}
                  >
                    {category}
                    <span className={active ? 'text-white/75' : 'text-slate-400'}>
                      {categoryCounts.get(category)}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
        {loading ? (
          <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2" aria-hidden>
            <div className="h-24 animate-pulse rounded-2xl bg-slate-100" />
            <div className="h-24 animate-pulse rounded-2xl bg-slate-100" />
          </div>
        ) : items.length === 0 ? (
          <div className="mt-4 flex flex-col items-center gap-2 rounded-2xl bg-white px-6 py-10 text-center shadow-card ring-1 ring-slate-200/70">
            <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-brand/5 text-brand">
              <Boxes className="h-6 w-6" aria-hidden />
            </span>
            <p className="mt-1 text-sm text-slate-500">{t('catalogEmpty')}</p>
          </div>
        ) : visibleItems.length === 0 ? (
          <div className="mt-4 flex flex-col items-center gap-2 rounded-2xl bg-white px-6 py-10 text-center shadow-card ring-1 ring-slate-200/70">
            <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-brand/5 text-brand">
              <Search className="h-6 w-6" aria-hidden />
            </span>
            <p className="mt-1 text-sm text-slate-500">{t('catalogNoResults')}</p>
          </div>
        ) : (
          <ul className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
            {visibleItems.map((item) => {
              const feeAtomic = feeAtomicOf(item);
              const verifiedDays = verifiedDaysAgo(item.verifiedAt, Date.now());
              const updatedDate = isoDate(item.updatedAt);
              const docsUrl = item.docsUrl && isHttpsUrl(item.docsUrl) ? item.docsUrl : null;
              const hasComparisonMeta =
                verifiedDays !== null || updatedDate !== null || Boolean(item.license) || docsUrl !== null;
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
                  key={item.resource}
                  className="group rounded-2xl bg-white p-4 shadow-card ring-1 ring-slate-200/70 transition hover:-translate-y-0.5 hover:shadow-card-hover"
                >
                  {cardHead({
                    category: item.category,
                    priceNode: (
                      <div className="shrink-0 text-right">
                        <div className="text-sm font-bold text-slate-900">
                          {item.priceJpyc} JPYC
                          {fee && (
                            <span className="ml-1 text-[11px] font-normal text-slate-400">
                              {t('feeNote', { fee })}
                            </span>
                          )}
                        </div>
                        {total && (
                          <div className="text-[11px] text-slate-400">
                            {t('payTotal', { total })}
                          </div>
                        )}
                      </div>
                    ),
                    description: item.description,
                    url: item.resource,
                    copyKey: `cat-${item.resource}`,
                    official: FIRST_PARTY_RESOURCE_URLS.has(item.resource),
                  })}
                  {hasComparisonMeta && (
                    <div className="mt-2 flex items-center divide-x divide-slate-200 overflow-x-auto whitespace-nowrap text-[11px] text-slate-500">
                      {verifiedDays !== null && (
                        <time dateTime={item.verifiedAt ?? undefined} className="pr-2">
                          {t('verifiedMeta', { days: verifiedDays })}
                        </time>
                      )}
                      {updatedDate !== null && (
                        <time dateTime={item.updatedAt} className="px-2">
                          {t('updatedMeta', { date: updatedDate })}
                        </time>
                      )}
                      {item.license && (
                        <span className="px-2">{t('licenseMeta', { license: item.license })}</span>
                      )}
                      {docsUrl && (
                        <a
                          href={docsUrl}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="px-2 font-medium text-brand hover:text-brand-dark hover:underline"
                        >
                          {t('docsLink')}
                        </a>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

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
              className="h-4 w-4 shrink-0 text-slate-400 transition group-open:rotate-180"
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
              className="h-4 w-4 shrink-0 text-slate-400 transition group-open:rotate-180"
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
          </div>
        </details>
      </section>
    </div>
  );
}
