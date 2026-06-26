'use client';

// x402 facilitator の最小 UI: 公開カタログ (discovery) の閲覧 + 加盟店登録 (SIWE)。
// カタログは /api/discovery を fetch して列挙 (誰でも閲覧)。登録は接続ウォレットで SIWE サインイン →
// /api/facilitator/resources へ POST。運営者も同じ導線で自社 resource を seed 登録する。
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

  const [form, setForm] = useState({
    url: '',
    description: '',
    priceJpyc: '',
    category: '',
    payTo: '',
  });
  const [submitting, setSubmitting] = useState(false);
  const [created, setCreated] = useState<{
    resource: RegisteredResource;
    paywallSnippet: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  useEffect(() => {
    void loadCatalog();
  }, [loadCatalog]);

  const onSubmit = useCallback(async () => {
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch('/api/facilitator/resources', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          url: form.url,
          description: form.description,
          priceJpyc: form.priceJpyc,
          category: form.category,
          ...(form.payTo ? { payTo: form.payTo } : {}),
        }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        resource?: RegisteredResource;
        paywallSnippet?: string;
        error?: string;
      };
      if (!res.ok || !body.resource || !body.paywallSnippet) {
        setError(body.error ?? 'error');
        return;
      }
      setCreated({ resource: body.resource, paywallSnippet: body.paywallSnippet });
      setForm({ url: '', description: '', priceJpyc: '', category: '', payTo: '' });
      void loadCatalog();
    } catch {
      setError('error');
    } finally {
      setSubmitting(false);
    }
  }, [form, loadCatalog]);

  const inputCls =
    'w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none';

  return (
    <div className="space-y-8">
      {/* 加盟店登録 */}
      <section className="rounded-2xl border border-slate-200 bg-white p-5">
        <h3 className="text-base font-bold text-slate-900">{t('registerTitle')}</h3>
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
            <button
              type="button"
              onClick={() => void onSubmit()}
              disabled={submitting}
              className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              {submitting ? t('submitting') : t('submitCta')}
            </button>
            {error && <p className="text-sm text-red-600">{t('errorGeneric', { reason: error })}</p>}
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
