'use client';

// x402 facilitator の最小 UI: 公開カタログ (discovery) の閲覧 + 加盟店の登録/編集/削除 (SIWE)。
// カタログは /api/discovery を fetch して列挙 (誰でも閲覧)。owner は SIWE サインイン後、自分の登録を
// /api/facilitator/resources で管理する (GET=一覧 / POST=登録 / [id] PATCH=編集 / [id] DELETE=無効化)。
// 本コンポーネントは env.enableX402Facilitator が ON のページからのみマウントされる。

import { useCallback, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { useAccount } from 'wagmi';
import { formatUnits } from 'viem';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Boxes,
  Check,
  Code2,
  Copy,
  Database,
  FileText,
  Pencil,
  Plus,
  Trash2,
  Wallet,
  CheckCircle2,
} from 'lucide-react';
import { useSiweSession } from '@/hooks/useSiweSession';

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
  accepts: Array<{ extra?: { openpay?: { feeValue?: string } } }>;
};

type RegisteredResource = {
  url: string;
  description: string;
  priceJpyc: string;
  category: string;
};

// owner 一覧 (GET /api/facilitator/resources) の要素。編集に id + payTo が要る。
type OwnedResource = {
  id: string;
  url: string;
  description: string;
  priceJpyc: string;
  category: string;
  payTo: string;
  paywallSnippet?: string;
};

const EMPTY_FORM = { url: '', description: '', priceJpyc: '', category: '', payTo: '' };
const DEMO_RESOURCE_URL = 'https://open-pay.jp/api/paid/demo';
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

function feeAtomicOf(item: DiscoveryItem): bigint | null {
  const fv = item.accepts[0]?.extra?.openpay?.feeValue;
  if (!fv) return null;
  try {
    return BigInt(fv);
  } catch {
    return null;
  }
}

export function X402DiscoveryView() {
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
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  // 登録時 1 回きりだったスニペット表示を owner 一覧から再表示するためのトグル。
  const [snippetOpenId, setSnippetOpenId] = useState<string | null>(null);
  // 出品の正当性表明 (新規登録のみ必須・編集では不要)。送信成功でリセット。
  const [attested, setAttested] = useState(false);
  // コピー済みフィードバック (key 単位・1.5s でリセット)。
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
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

  const items = catalogQuery.data ?? [];
  const loading = catalogQuery.isFetching;
  const owned = ownedQuery.data ?? [];

  const onEdit = useCallback((r: OwnedResource) => {
    setEditId(r.id);
    setForm({
      url: r.url,
      description: r.description,
      priceJpyc: r.priceJpyc,
      category: r.category,
      payTo: r.payTo,
    });
    setCreated(null);
    setNotice(null);
    setError(null);
    setConfirmDeleteId(null);
    if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  const onCancelEdit = useCallback(() => {
    setEditId(null);
    setForm(EMPTY_FORM);
    setError(null);
  }, []);

  // 登録 (editId 無し → POST) / 編集 (editId 有り → PATCH) を出し分ける。成功後は catalog / owned を
  // invalidate して再取得する (従来の void loadCatalog(); void loadOwned(); の置換)。fetch/parse の
  // 例外・!ok・resource 欠落はいずれも {ok:false} を返し、従来と同じエラー文言 (error コード) を出す。
  const submitMutation = useMutation({
    mutationFn: async (): Promise<
      | { ok: true; wasEdit: boolean; resource: RegisteredResource; paywallSnippet: string }
      | { ok: false; error: string }
    > => {
      const payload = {
        url: form.url,
        description: form.description,
        priceJpyc: form.priceJpyc,
        category: form.category,
        ...(form.payTo ? { payTo: form.payTo } : {}),
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
          return { ok: false, error: body.error ?? 'error' };
        }
        return {
          ok: true,
          wasEdit: Boolean(editId),
          resource: body.resource,
          paywallSnippet: body.paywallSnippet ?? '',
        };
      } catch {
        return { ok: false, error: 'error' };
      }
    },
    onMutate: () => {
      setError(null);
      setNotice(null);
    },
    onSuccess: (result) => {
      if (!result.ok) {
        setError(result.error);
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

  // エラー key → 親切な文言 (モデレーション / 表明は専用文言、他は汎用)。
  const errorMsg =
    error === 'resource_not_gated'
      ? t('errorNotGated')
      : error === 'attestation_required'
        ? t('errorAttestationRequired')
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
  }) => {
    const Icon = categoryIcon(opts.category);
    return (
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand/5 text-brand">
          <Icon className="h-5 w-5" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <span className="text-[11px] font-medium uppercase tracking-wide text-slate-400">
              {opts.category}
            </span>
            {opts.priceNode}
          </div>
          <p className="mt-0.5 text-sm font-medium text-slate-800">{opts.description}</p>
          <div className="mt-1 flex items-center gap-1.5">
            <span className="min-w-0 truncate font-mono text-xs text-slate-400">{opts.url}</span>
            {copyBtn(opts.copyKey, opts.url)}
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-6">
      {/* 出品: 加盟店登録 / 編集 */}
      <section className="rounded-2xl border border-slate-200/70 bg-white p-5 shadow-card sm:p-6">
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
          </div>
        </div>

        {!isConnected ? (
          <div className="mt-4 flex items-start gap-2 rounded-xl bg-amber-50 px-3 py-2.5 text-sm text-amber-800">
            <Wallet className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <span>{t('connectPrompt')}</span>
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
            <p className="inline-flex items-center gap-1.5 rounded-full bg-slate-50 px-2.5 py-1 font-mono text-xs text-slate-500">
              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" aria-hidden />
              {t('signedInAs', { address: address ?? '' })}
            </p>
            <input
              className={inputCls}
              placeholder={t('formUrl')}
              value={form.url}
              onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))}
            />
            <input
              className={inputCls}
              placeholder={t('formDescription')}
              value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
            />
            <div className="flex gap-3">
              <input
                className={inputCls}
                inputMode="numeric"
                placeholder={t('formPrice')}
                value={form.priceJpyc}
                onChange={(e) => setForm((f) => ({ ...f, priceJpyc: e.target.value }))}
              />
              <input
                className={inputCls}
                placeholder={t('formCategory')}
                value={form.category}
                onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}
              />
            </div>
            <input
              className={inputCls}
              placeholder={t('formPayTo')}
              value={form.payTo}
              onChange={(e) => setForm((f) => ({ ...f, payTo: e.target.value }))}
            />
            <p className="text-xs leading-relaxed text-slate-400">{t('formPayToHint')}</p>

            {/* 出品の正当性表明 (新規登録のみ・必須)。サーバ側でも attested を強制する。 */}
            {!editId && (
              <label className="flex cursor-pointer items-start gap-2.5 rounded-xl border border-slate-200/70 bg-slate-50/60 px-3 py-2.5">
                <input
                  type="checkbox"
                  checked={attested}
                  onChange={(e) => setAttested(e.target.checked)}
                  className="mt-0.5 h-4 w-4 shrink-0 rounded border-slate-300 text-brand focus:ring-brand/30"
                />
                <span className="text-xs leading-relaxed text-slate-600">{t('attestLabel')}</span>
              </label>
            )}

            <div className="flex items-center gap-3 pt-1">
              <button
                type="button"
                onClick={() => submitMutation.mutate()}
                disabled={submitting || (!editId && !attested)}
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
            {!editId && !attested && !submitting && (
              <p className="text-[11px] text-slate-400">{t('attestRequired')}</p>
            )}
            {errorMsg && (
              <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{errorMsg}</p>
            )}
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
                <p className="mt-2 text-xs text-slate-500">{t('snippetTitle')}</p>
                <div className="relative mt-1">
                  <pre className="overflow-x-auto rounded-lg bg-slate-900 p-3 pr-10 text-xs leading-relaxed text-slate-100">
                    {created.paywallSnippet}
                  </pre>
                  <button
                    type="button"
                    onClick={() => copyText('snippet', created.paywallSnippet)}
                    aria-label={copiedKey === 'snippet' ? t('copied') : t('copy')}
                    className="absolute right-2 top-2 rounded-md bg-slate-800 p-1.5 text-slate-300 transition hover:bg-slate-700 hover:text-white"
                  >
                    {copiedKey === 'snippet' ? (
                      <Check className="h-3.5 w-3.5 text-emerald-400" aria-hidden />
                    ) : (
                      <Copy className="h-3.5 w-3.5" aria-hidden />
                    )}
                  </button>
                </div>
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
                className="rounded-2xl border border-slate-200/70 bg-white p-4 shadow-card"
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
                {snippetOpenId === r.id && r.paywallSnippet ? (
                  <div className="relative mt-3 border-t border-slate-100 pt-3">
                    <pre className="max-h-72 overflow-auto rounded-lg bg-slate-900 p-3 pr-10 text-xs leading-relaxed text-slate-100">
                      {r.paywallSnippet}
                    </pre>
                    <button
                      type="button"
                      onClick={() => copyText(`owned-snippet-${r.id}`, r.paywallSnippet ?? '')}
                      className="absolute right-2 top-5 rounded-md bg-slate-700 p-1.5 text-slate-200 hover:bg-slate-600"
                      aria-label={copiedKey === `owned-snippet-${r.id}` ? t('copied') : t('copy')}
                    >
                      {copiedKey === `owned-snippet-${r.id}` ? (
                        <Check className="h-3.5 w-3.5 text-emerald-400" aria-hidden />
                      ) : (
                        <Copy className="h-3.5 w-3.5" aria-hidden />
                      )}
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
                      className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                    >
                      {t('showSnippet')}
                    </button>
                    <button
                      type="button"
                      onClick={() => onEdit(r)}
                      className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-700 transition hover:border-brand hover:text-brand-dark"
                    >
                      <Pencil className="h-3 w-3" aria-hidden />
                      {t('editCta')}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setConfirmDeleteId(r.id);
                        setNotice(null);
                      }}
                      className="inline-flex items-center gap-1 rounded-lg border border-red-200 px-3 py-1.5 text-xs font-medium text-red-600 transition hover:border-red-400"
                    >
                      <Trash2 className="h-3 w-3" aria-hidden />
                      {t('deleteCta')}
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* 公開カタログ */}
      <section>
        <h3 className="text-base font-bold text-slate-900">{t('catalogTitle')}</h3>
        <p className="mt-1 text-sm text-slate-500">{t('catalogSubtitle')}</p>
        {loading ? (
          <div className="mt-4 space-y-3" aria-hidden>
            <div className="h-24 animate-pulse rounded-2xl bg-slate-100" />
            <div className="h-24 animate-pulse rounded-2xl bg-slate-100" />
          </div>
        ) : items.length === 0 ? (
          <div className="mt-4 flex flex-col items-center gap-2 rounded-2xl border border-dashed border-slate-300 bg-white px-6 py-10 text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-brand/5 text-brand">
              <Boxes className="h-6 w-6" aria-hidden />
            </span>
            <p className="mt-1 text-sm text-slate-500">{t('catalogEmpty')}</p>
          </div>
        ) : (
          <ul className="mt-4 space-y-3">
            {items.map((item) => {
              const feeAtomic = feeAtomicOf(item);
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
                  className="group rounded-2xl border border-slate-200/70 bg-white p-4 shadow-card transition hover:-translate-y-0.5 hover:shadow-card-hover"
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
                  })}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* 1 JPYC の first-party demo。長い buyer script は raw を参照し、ページには最小コマンドだけ載せる。 */}
      <section>
        <details className="rounded-2xl border border-slate-200/70 bg-white p-4 shadow-card">
          <summary className="flex cursor-pointer list-none items-start gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-emerald-50 text-emerald-700">
              <Code2 className="h-5 w-5" aria-hidden />
            </span>
            <span className="min-w-0">
              <span className="block text-base font-bold text-slate-900">
                {t('tryTitle')}
              </span>
              <span className="mt-0.5 block text-sm leading-relaxed text-slate-500">
                {t('trySubtitle')}
              </span>
            </span>
          </summary>

          <div className="mt-4 space-y-4 border-t border-slate-100 pt-4">
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
        <details className="rounded-2xl border border-slate-200/70 bg-white p-4 shadow-card">
          <summary className="flex cursor-pointer list-none items-start gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-blue-50 text-blue-700">
              <Boxes className="h-5 w-5" aria-hidden />
            </span>
            <span className="min-w-0">
              <span className="block text-base font-bold text-slate-900">
                {t('mcpTitle')}
              </span>
              <span className="mt-0.5 block text-sm leading-relaxed text-slate-500">
                {t('mcpSubtitle')}
              </span>
            </span>
          </summary>

          <div className="mt-4 space-y-3 border-t border-slate-100 pt-4">
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
            <p className="text-xs leading-relaxed text-slate-500">{t('mcpNote')}</p>
          </div>
        </details>
      </section>
    </div>
  );
}
