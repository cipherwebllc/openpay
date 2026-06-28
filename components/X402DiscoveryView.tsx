'use client';

// x402 facilitator の最小 UI: 公開カタログ (discovery) の閲覧 + 加盟店の登録/編集/削除 (SIWE)。
// カタログは /api/discovery を fetch して列挙 (誰でも閲覧)。owner は SIWE サインイン後、自分の登録を
// /api/facilitator/resources で管理する (GET=一覧 / POST=登録 / [id] PATCH=編集 / [id] DELETE=無効化)。
// 本コンポーネントは env.enableX402Facilitator が ON のページからのみマウントされる。

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { useAccount } from 'wagmi';
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
};

const EMPTY_FORM = { url: '', description: '', priceJpyc: '', category: '', payTo: '' };

function feeJpycOf(item: DiscoveryItem): string | null {
  const fv = item.accepts[0]?.extra?.openpay?.feeValue;
  if (!fv) return null;
  try {
    return (BigInt(fv) / 10n ** 18n).toString();
  } catch {
    return null;
  }
}

export function X402DiscoveryView() {
  const t = useTranslations('Facilitator');
  const { address, isConnected } = useAccount();
  const { isSignedIn, signIn, isSigningIn } = useSiweSession();

  const [items, setItems] = useState<DiscoveryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [owned, setOwned] = useState<OwnedResource[]>([]);

  const [form, setForm] = useState(EMPTY_FORM);
  const [editId, setEditId] = useState<string | null>(null); // 非 null = 編集中 (PATCH)
  const [submitting, setSubmitting] = useState(false);
  const [created, setCreated] = useState<{
    resource: RegisteredResource;
    paywallSnippet: string;
  } | null>(null);
  const [notice, setNotice] = useState<'updated' | 'deleted' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
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

  const loadCatalog = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/discovery', { cache: 'no-store' });
      if (res.ok) {
        const body = (await res.json()) as { items?: DiscoveryItem[] };
        setItems(body.items ?? []);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  // owner の登録一覧 (SIWE 時のみ・編集/削除の対象)。未サインインは空。
  const loadOwned = useCallback(async () => {
    if (!isSignedIn) {
      setOwned([]);
      return;
    }
    const res = await fetch('/api/facilitator/resources', { cache: 'no-store' });
    if (res.ok) {
      const body = (await res.json()) as { resources?: OwnedResource[] };
      setOwned(body.resources ?? []);
    }
  }, [isSignedIn]);

  useEffect(() => {
    void loadCatalog();
  }, [loadCatalog]);
  useEffect(() => {
    void loadOwned();
  }, [loadOwned]);

  // 登録 (editId 無し → POST) / 編集 (editId 有り → PATCH) を出し分ける。
  const onSubmit = useCallback(async () => {
    setError(null);
    setNotice(null);
    setSubmitting(true);
    try {
      const payload = {
        url: form.url,
        description: form.description,
        priceJpyc: form.priceJpyc,
        category: form.category,
        ...(form.payTo ? { payTo: form.payTo } : {}),
        // 新規登録のみ正当性表明を送る (サーバは POST でのみ必須・編集では無視)。
        ...(editId ? {} : { attested }),
      };
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
        setError(body.error ?? 'error');
        return;
      }
      if (editId) {
        setNotice('updated');
        setCreated(null);
      } else {
        setCreated({
          resource: body.resource,
          paywallSnippet: body.paywallSnippet ?? '',
        });
      }
      setForm(EMPTY_FORM);
      setEditId(null);
      setAttested(false);
      void loadCatalog();
      void loadOwned();
    } catch {
      setError('error');
    } finally {
      setSubmitting(false);
    }
  }, [form, editId, attested, loadCatalog, loadOwned]);

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

  const onDelete = useCallback(
    async (id: string) => {
      setError(null);
      setNotice(null);
      const res = await fetch(`/api/facilitator/resources/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? 'error');
        return;
      }
      setConfirmDeleteId(null);
      if (editId === id) onCancelEdit(); // 編集中の掲載を消したらフォームも閉じる
      setNotice('deleted');
      void loadCatalog();
      void loadOwned();
    },
    [editId, onCancelEdit, loadCatalog, loadOwned],
  );

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
                onClick={() => void onSubmit()}
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
                {confirmDeleteId === r.id ? (
                  <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-slate-100 pt-3">
                    <span className="text-sm text-slate-600">{t('deleteConfirm')}</span>
                    <button
                      type="button"
                      onClick={() => void onDelete(r.id)}
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
              const fee = feeJpycOf(item);
              let total: string | null = null;
              try {
                if (fee) total = (BigInt(item.priceJpyc) + BigInt(fee)).toString();
              } catch {
                total = null;
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
    </div>
  );
}
