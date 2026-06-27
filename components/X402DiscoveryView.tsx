'use client';

// x402 facilitator の最小 UI: 公開カタログ (discovery) の閲覧 + 加盟店の登録/編集/削除 (SIWE)。
// カタログは /api/discovery を fetch して列挙 (誰でも閲覧)。owner は SIWE サインイン後、自分の登録を
// /api/facilitator/resources で管理する (GET=一覧 / POST=登録 / [id] PATCH=編集 / [id] DELETE=無効化)。
// 本コンポーネントは env.enableX402Facilitator が ON のページからのみマウントされる。

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useAccount } from 'wagmi';
import { useSiweSession } from '@/hooks/useSiweSession';

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
      void loadCatalog();
      void loadOwned();
    } catch {
      setError('error');
    } finally {
      setSubmitting(false);
    }
  }, [form, editId, loadCatalog, loadOwned]);

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
    'w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none';

  return (
    <div className="space-y-8">
      {/* 加盟店登録 / 編集 */}
      <section className="rounded-2xl border border-slate-200 bg-white p-5">
        <h3 className="text-base font-bold text-slate-900">
          {editId ? t('editTitle') : t('registerTitle')}
        </h3>
        <p className="mt-1 text-sm text-slate-500">{t('registerSubtitle')}</p>

        {!isConnected ? (
          <p className="mt-3 text-sm text-amber-700">{t('connectPrompt')}</p>
        ) : !isSignedIn ? (
          <button
            type="button"
            onClick={() => void signIn(t('signInStatement'))}
            disabled={isSigningIn}
            className="mt-3 rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
          >
            {isSigningIn ? t('signingIn') : t('signInCta')}
          </button>
        ) : (
          <div className="mt-4 space-y-3">
            <p className="text-xs text-slate-500">
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
            <p className="text-xs text-slate-400">{t('formPayToHint')}</p>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => void onSubmit()}
                disabled={submitting}
                className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
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
                  className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-600 hover:border-slate-400 disabled:opacity-50"
                >
                  {t('cancelCta')}
                </button>
              )}
            </div>
            {error && <p className="text-sm text-red-600">{t('errorGeneric', { reason: error })}</p>}
            {notice === 'updated' && <p className="text-sm text-emerald-700">{t('updated')}</p>}
            {notice === 'deleted' && <p className="text-sm text-emerald-700">{t('deleted')}</p>}
            {created && (
              <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3">
                <p className="text-sm font-medium text-emerald-800">{t('created')}</p>
                <p className="mt-1 text-xs text-slate-500">{t('snippetTitle')}</p>
                <pre className="mt-1 overflow-x-auto rounded bg-slate-900 p-3 text-xs text-slate-100">
                  {created.paywallSnippet}
                </pre>
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
              <li key={r.id} className="rounded-xl border border-slate-200 bg-white p-4">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
                    {r.category}
                  </span>
                  <span className="text-sm font-bold text-slate-900">{r.priceJpyc} JPYC</span>
                </div>
                <p className="mt-2 text-sm text-slate-700">{r.description}</p>
                <p className="mt-1 break-all font-mono text-xs text-slate-400">{r.url}</p>
                {confirmDeleteId === r.id ? (
                  <div className="mt-3 flex items-center gap-3">
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
                  <div className="mt-3 flex items-center gap-3">
                    <button
                      type="button"
                      onClick={() => onEdit(r)}
                      className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:border-slate-500"
                    >
                      {t('editCta')}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setConfirmDeleteId(r.id);
                        setNotice(null);
                      }}
                      className="rounded-lg border border-red-200 px-3 py-1.5 text-xs font-medium text-red-600 hover:border-red-400"
                    >
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
          <p className="mt-4 text-sm text-slate-400">{t('loading')}</p>
        ) : items.length === 0 ? (
          <p className="mt-4 text-sm text-slate-400">{t('catalogEmpty')}</p>
        ) : (
          <ul className="mt-4 space-y-3">
            {items.map((item) => {
              const fee = feeJpycOf(item);
              return (
                <li
                  key={item.resource}
                  className="rounded-xl border border-slate-200 bg-white p-4"
                >
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
                      {item.category}
                    </span>
                    <span className="text-sm font-bold text-slate-900">
                      {item.priceJpyc} JPYC
                      {fee && (
                        <span className="ml-1 text-xs font-normal text-slate-400">
                          {t('feeNote', { fee })}
                        </span>
                      )}
                    </span>
                  </div>
                  <p className="mt-2 text-sm text-slate-700">{item.description}</p>
                  <p className="mt-1 break-all font-mono text-xs text-slate-400">
                    {item.resource}
                  </p>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
