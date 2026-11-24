'use client';

// 運営 (OpenPay 自社) 専用: 店の商品の販売を止める (takedown) 画面。DevTools にコードを貼る運用
// (DEPLOY_CHECKLIST §16.10) は運営者が使えなかった (2026-11-24・試験の出品 5 件) ので、同じ API をボタンにした。
// 流れ: SIWE サインイン → 店の URL か @名前で公開中の商品を出す (/api/store/listings・公開の API) → 選んで止める
// (POST /api/admin/store/products/[id]/takedown を 1 件ずつ)。認可は API 側 (SIWE + ADMIN_WALLETS) が決め、
// client は秘密を持たない。止めると元に戻せない (復元の API はない) ので、押す前に件数と「元に戻せません」を出す。

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useAccount } from 'wagmi';
import { useSiweSession } from '@/hooks/useSiweSession';

type Listing = {
  id: string;
  title: string;
  desc?: string;
  imageUrl?: string;
  totalJpyc: string;
  handle: string;
};

type ItemResult = 'stopped' | 'alreadyStopped' | 'signIn' | 'forbidden' | 'rateLimited' | 'notFound' | 'failed';

// 店のページの URL (https://open-pay.jp/ja/@name?product=…)・@name・name のどれからでも @ の後ろの名前を取る。
// 形の確かめは公開の API (/api/store/listings の handle) に任せる。
export function handleFromInput(raw: string): string {
  const s = raw.trim();
  const at = s.match(/@([^/?#\s]+)/);
  if (at) return at[1];
  return s.replace(/^@/, '');
}

function resultForStatus(status: number, body: unknown): ItemResult {
  if (status === 200) {
    return typeof body === 'object' && body !== null && (body as { alreadyPurged?: unknown }).alreadyPurged === true
      ? 'alreadyStopped'
      : 'stopped';
  }
  if (status === 401) return 'signIn';
  if (status === 403) return 'forbidden';
  if (status === 429) return 'rateLimited';
  if (status === 404) return 'notFound';
  return 'failed';
}

export function AdminStoreTakedownView() {
  const t = useTranslations('AdminStore');
  const { isConnected } = useAccount();
  const { isSignedIn, isSigningIn, mismatch, signIn, signInError } = useSiweSession();

  const [shopInput, setShopInput] = useState('');
  const [listings, setListings] = useState<Listing[] | null>(null);
  const [shownHandle, setShownHandle] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<Record<string, ItemResult>>({});

  const heading = (
    <div className="mb-4">
      <h2 className="text-xl font-bold text-slate-900">{t('title')}</h2>
      <p className="mt-1 text-sm text-slate-600">{t('intro')}</p>
    </div>
  );

  if (!isConnected) {
    return (
      <section>
        {heading}
        <p className="text-sm text-slate-600">{t('connectRequired')}</p>
      </section>
    );
  }

  if (!isSignedIn) {
    return (
      <section>
        {heading}
        {mismatch && <p className="mb-2 text-xs text-red-600">{t('mismatch')}</p>}
        <button
          type="button"
          onClick={() => void signIn(t('signInStatement')).catch(() => undefined)}
          disabled={isSigningIn}
          className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          {isSigningIn ? t('signingIn') : t('signIn')}
        </button>
        {signInError && <p className="mt-2 text-xs text-red-600">{t('signInError')}</p>}
      </section>
    );
  }

  async function load(handle: string) {
    setLoading(true);
    setLoadError(false);
    try {
      const res = await fetch(
        `/api/store/listings?handle=${encodeURIComponent(handle)}&limit=50&locale=ja`,
        { cache: 'no-store' },
      );
      const json = (await res.json().catch(() => null)) as { ok?: boolean; items?: Listing[] } | null;
      if (!res.ok || !json?.ok || !Array.isArray(json.items)) throw new Error('load_failed');
      setListings(json.items);
      setShownHandle(handle);
    } catch {
      setListings(null);
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }

  async function show() {
    const handle = handleFromInput(shopInput);
    if (!handle) return;
    setSelected(new Set());
    setResults({});
    setConfirming(false);
    await load(handle);
  }

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function stopSelected() {
    const ids = [...selected];
    setConfirming(false);
    setRunning(true);
    const next: Record<string, ItemResult> = {};
    for (const id of ids) {
      let result: ItemResult;
      try {
        const res = await fetch(`/api/admin/store/products/${encodeURIComponent(id)}/takedown`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
        });
        result = resultForStatus(res.status, await res.json().catch(() => null));
      } catch {
        result = 'failed';
      }
      next[id] = result;
      setResults({ ...next });
      // サインイン切れ・権限なし・上限は、残りを送っても同じ答えなので止める (押し直してもらう)。
      if (result === 'signIn' || result === 'forbidden' || result === 'rateLimited') break;
    }
    setRunning(false);
    setSelected(new Set());
    // 止めた商品は公開の一覧から消えるので、読み直して確かめられるようにする。
    if (shownHandle) await load(shownHandle);
  }

  const resultEntries = Object.entries(results);

  return (
    <section>
      {heading}

      <form
        className="mb-4 flex flex-col gap-2 sm:flex-row"
        onSubmit={(e) => {
          e.preventDefault();
          void show();
        }}
      >
        <label className="flex-1 text-sm text-slate-700">
          <span className="mb-1 block font-semibold">{t('shopLabel')}</span>
          <input
            type="text"
            value={shopInput}
            onChange={(e) => setShopInput(e.target.value)}
            placeholder={t('shopPlaceholder')}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            autoComplete="off"
          />
        </label>
        <button
          type="submit"
          disabled={loading || running || !handleFromInput(shopInput)}
          className="self-end rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          {loading ? t('loading') : t('show')}
        </button>
      </form>

      {loadError && <p className="mb-4 text-sm text-red-600">{t('loadError')}</p>}

      {resultEntries.length > 0 && (
        <div className="mb-4 rounded-xl border border-slate-200 bg-white p-4">
          <p className="mb-2 text-sm font-semibold text-slate-900">{t('resultsTitle')}</p>
          <ul className="space-y-1 text-sm">
            {resultEntries.map(([id, result]) => (
              <li key={id} className="break-all">
                <span className="font-mono text-xs text-slate-600">{id}</span>{' '}
                <span
                  className={
                    result === 'stopped' || result === 'alreadyStopped'
                      ? 'text-emerald-700'
                      : 'text-red-600'
                  }
                >
                  {t(`result.${result}`)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {listings !== null && (
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <p className="mb-2 text-sm font-semibold text-slate-900">
            {t('listingsTitle', { handle: shownHandle, count: listings.length })}
          </p>
          {listings.length === 0 ? (
            <p className="text-sm text-slate-600">{t('noListings')}</p>
          ) : (
            <>
              <ul className="mb-4 divide-y divide-slate-100">
                {listings.map((item) => (
                  <li key={item.id} className="py-2">
                    <label className="flex items-start gap-3">
                      <input
                        type="checkbox"
                        className="mt-1 h-5 w-5"
                        checked={selected.has(item.id)}
                        onChange={() => toggle(item.id)}
                        disabled={running}
                      />
                      <span className="min-w-0 flex-1 text-sm">
                        <span className="block font-semibold text-slate-900">{item.title}</span>
                        <span className="block font-mono text-xs text-slate-600 break-all">{item.id}</span>
                        <span className="block text-xs text-slate-600">
                          {t('price', { total: item.totalJpyc })}
                        </span>
                        {item.desc && (
                          <span className="block text-xs text-slate-600 break-all">{item.desc.slice(0, 120)}</span>
                        )}
                        {item.imageUrl && (
                          <span className="block text-xs text-slate-600 break-all">
                            {t('imageUrl', { url: item.imageUrl })}
                          </span>
                        )}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => setSelected(new Set(listings.map((item) => item.id)))}
                  disabled={running}
                  className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700 disabled:opacity-50"
                >
                  {t('selectAll')}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirming(true)}
                  disabled={running || selected.size === 0}
                  className="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
                >
                  {running ? t('stopping') : t('stopSelected', { count: selected.size })}
                </button>
              </div>
              {confirming && (
                <div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3">
                  <p className="text-sm text-red-800">{t('confirmText', { count: selected.size })}</p>
                  <div className="mt-2 flex gap-2">
                    <button
                      type="button"
                      onClick={() => void stopSelected()}
                      className="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white"
                    >
                      {t('confirmStop')}
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirming(false)}
                      className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm text-slate-700"
                    >
                      {t('cancel')}
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}
