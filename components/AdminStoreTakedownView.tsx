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

type ItemResult =
  | 'stopped'
  | 'alreadyStopped'
  | 'unknown'
  | 'signIn'
  | 'forbidden'
  | 'rateLimited'
  | 'notFound'
  | 'failed';

// 店のページの URL (https://open-pay.jp/ja/@name?product=…)・@name・name のどれからでも店の名前を取る。
// URL はパスの @ で始まる区切りだけを見る (クエリの @ は拾わない・%40 は戻す)。
// 形の確かめと正規化の本体は公開の API (/api/store/listings の handle = normalizeHandle) に任せる。
// lib/handle の facade は読み込まない (この画面の client の bundle が 240 → 283 kB に増えた・2026-11-25)。
// ここで行うのは decodeHandleSegment・normalizeHandle (lib/handle/normalize.ts) と同じ数行だけ。
function decodeSegment(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function normalizeName(raw: string): string {
  return raw.trim().replace(/^@+/, '').toLowerCase();
}

export function handleFromInput(raw: string): string {
  const s = raw.trim();
  if (/^https?:\/\//i.test(s)) {
    let path: string;
    try {
      path = new URL(s).pathname;
    } catch {
      return '';
    }
    const segment = path
      .split('/')
      .map(decodeSegment)
      .find((part) => part.startsWith('@'));
    return segment ? normalizeName(segment) : '';
  }
  return normalizeName(s);
}

function resultForStatus(status: number, body: unknown): ItemResult {
  if (status === 200) {
    // 止めたと言えるのは、API の成功の本文 (ok: true) を読めたときだけ。本文を読めなかった 200 は、止まったか
    // 分からない (止める API は同じ ID で何度送っても同じ結果なので、押し直してもらえばよい)。
    if (typeof body !== 'object' || body === null || (body as { ok?: unknown }).ok !== true) return 'unknown';
    return (body as { alreadyPurged?: unknown }).alreadyPurged === true ? 'alreadyStopped' : 'stopped';
  }
  if (status === 401) return 'signIn';
  if (status === 403) return 'forbidden';
  if (status === 429) return 'rateLimited';
  if (status === 404) return 'notFound';
  // 503 (storage_unavailable) は API が「完了を確かめられなかった」と言う応答 (DEPLOY_CHECKLIST §16.10)。
  if (status === 503) return 'unknown';
  return 'failed';
}

export function AdminStoreTakedownView() {
  const t = useTranslations('AdminStore');
  const { isConnected } = useAccount();
  const { isSignedIn, isSigningIn, mismatch, signIn, signInError, refreshSession } = useSiweSession();

  const [shopInput, setShopInput] = useState('');
  const [listings, setListings] = useState<Listing[] | null>(null);
  const [shownHandle, setShownHandle] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<Record<string, ItemResult>>({});
  // この画面で止めたと分かった商品 (表示し直しても消さない)。公開の一覧は CDN に少し残ることがあるので、
  // 読み直しても並ぶことがある。もう一度選べないようにする。
  const [doneIds, setDoneIds] = useState<Set<string>>(new Set());

  const heading = (
    <div className="mb-4">
      <h2 className="text-xl font-bold text-slate-900">{t('title')}</h2>
      <p className="mt-1 text-sm text-slate-600">{t('intro')}</p>
    </div>
  );

  const resultEntries = Object.entries(results);
  // 結果の欄は、サインインが切れて下のサインインの分岐に入っても出す (「サインインし直して」の案内を消さない)。
  const resultsPanel =
    resultEntries.length > 0 ? (
      <div className="mb-4 rounded-xl border border-slate-200 bg-white p-4">
        <p className="mb-2 text-sm font-semibold text-slate-900">{t('resultsTitle')}</p>
        <ul className="space-y-1 text-sm">
          {resultEntries.map(([id, result]) => (
            <li key={id} className="break-all">
              <span className="font-mono text-xs text-slate-600">{id}</span>{' '}
              <span
                className={
                  result === 'stopped' || result === 'alreadyStopped' ? 'text-emerald-700' : 'text-red-600'
                }
              >
                {t(`result.${result}`)}
              </span>
            </li>
          ))}
        </ul>
      </div>
    ) : null;

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
        {resultsPanel}
        {mismatch && <p className="mb-2 text-xs text-red-600">{t('mismatch')}</p>}
        <button
          type="button"
          // 署名の失敗 (断った場合を含む) は握りつぶし、エラーの文は signInError で出す (WalletBadge と同じ)。
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

  // 一覧の読み込みは同時に 1 本だけ: 「商品を表示」は読み込み中と止めている間は押せず、止めたあとの読み直しは
  // 止めている間 (running) の中で待つ。なので前の店や前の読み直しの応答が、後から画面を戻すことはない。
  async function load(handle: string) {
    setLoading(true);
    setLoadError(false);
    let items: Listing[] | null = null;
    try {
      const res = await fetch(
        `/api/store/listings?handle=${encodeURIComponent(handle)}&limit=100&locale=ja`,
        { cache: 'no-store' },
      );
      const json = (await res.json().catch(() => null)) as { ok?: boolean; items?: Listing[] } | null;
      if (res.ok && json?.ok && Array.isArray(json.items)) items = json.items;
    } catch {
      items = null;
    }
    if (items) {
      setListings(items);
      setShownHandle(handle);
    } else {
      setListings(null);
      setLoadError(true);
    }
    setLoading(false);
  }

  async function show() {
    const handle = handleFromInput(shopInput);
    if (!handle) return;
    // 前の店の一覧は読み込みの前に消す (読み込み中に前の店の商品を選んで止められないように)。
    setListings(null);
    setShownHandle('');
    setSelected(new Set());
    setResults({});
    setConfirming(false);
    await load(handle);
  }

  // 選び直したら確かめを閉じる (確かめで見せた件数と、止める商品をずらさない)。
  function toggle(id: string) {
    setConfirming(false);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const isDone = (id: string) => doneIds.has(id);
  const selectable = (listings ?? []).filter((item) => !isDone(item.id));
  // 止める対象は、いま表示している店の一覧の中で選ばれているものだけ。
  const targets = selectable.filter((item) => selected.has(item.id));

  async function stopSelected() {
    const ids = targets.map((item) => item.id);
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
        // 送ったあとに通信が切れた場合は、止まったかどうか分からない。
        result = 'unknown';
      }
      next[id] = result;
      setResults((prev) => ({ ...prev, ...next }));
      if (result === 'stopped' || result === 'alreadyStopped') setDoneIds((prev) => new Set(prev).add(id));
      // サインインが切れたら、画面のサインインの状態を読み直して、サインインのボタンを出す。
      if (result === 'signIn') void refreshSession();
      // サインイン切れ・権限なし・上限は、残りを送っても同じ答えなので止める (押し直してもらう)。
      if (result === 'signIn' || result === 'forbidden' || result === 'rateLimited') break;
    }
    setSelected(new Set());
    // 止めた商品は数分のうちに公開の一覧から消える (一覧はキャッシュされる)。止まったか分からない商品を選び直せる
    // ように、同じ店の一覧を読み直す。読み直しが終わるまでは、次の操作 (止める・別の店の表示) をできないままにする。
    if (shownHandle) await load(shownHandle);
    setRunning(false);
  }

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

      {resultsPanel}

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
                        checked={selected.has(item.id) && !isDone(item.id)}
                        onChange={() => toggle(item.id)}
                        disabled={running || isDone(item.id)}
                      />
                      <span className="min-w-0 flex-1 text-sm">
                        <span className="block font-semibold text-slate-900">{item.title}</span>
                        <span className="block font-mono text-xs text-slate-600 break-all">{item.id}</span>
                        <span className="block text-xs text-slate-600">
                          {t('price', { total: item.totalJpyc })}
                        </span>
                        {isDone(item.id) && (
                          <span className="block text-xs font-semibold text-emerald-700">{t('doneRow')}</span>
                        )}
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
                  onClick={() => {
                    setConfirming(false);
                    setSelected(new Set(selectable.map((item) => item.id)));
                  }}
                  disabled={running || selectable.length === 0}
                  className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700 disabled:opacity-50"
                >
                  {t('selectAll')}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirming(true)}
                  disabled={running || targets.length === 0}
                  className="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
                >
                  {running ? t('stopping') : t('stopSelected', { count: targets.length })}
                </button>
              </div>
              {confirming && (
                <div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3">
                  <p className="text-sm text-red-800">{t('confirmText', { count: targets.length })}</p>
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
