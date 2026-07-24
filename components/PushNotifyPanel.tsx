'use client';

// /history の Web Push 着金通知パネル。SIWE ゲート (FreeeSyncPanel と同型) の下で
// Service Worker を登録し push を購読する。状態に応じて出し分ける:
//   flag OFF / VAPID 公開鍵なし → null (完全 inert)
//   未サインイン                → ウォレットログイン案内
//   iOS Safari 通常タブ (非 PWA) → 購読 UI を出さず A2HS hint (iOS は A2HS 済 PWA のみ push 可)
//   未対応ブラウザ               → 非対応メッセージ
//   permission denied           → ブロック中メッセージ
//   購読中/未購読                → 有効化/無効化トグル + 金額 opt-in
//
// SSR/hydration 安全: platform / 対応判定 / 購読状態は useEffect で mount 後に解決する
// (useState(detect) の lazy init は SSR='other'→client 実 UA で React #418 を踏む・PwaInstallHint と同型)。

import { useEffect, useState } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { useAccount } from 'wagmi';
import { env } from '@/lib/env';
import { useSiweSession } from '@/hooks/useSiweSession';
import { usePwaDisplayMode } from '@/hooks/usePwaDisplayMode';
import { detectMobilePlatform, type MobilePlatform } from '@/lib/walletDeepLink';
import { PwaInstallHint } from './PwaInstallHint';

// 金額 opt-in の選好を面/再訪をまたいで保持する (購読の真実点はサーバだが、UI の
// トグル初期値をユーザの直近選択に合わせるため)。
const INCLUDE_AMOUNT_KEY = 'openpay:pushIncludeAmount:v1';

// VAPID base64url 公開鍵を pushManager.subscribe が要求する Uint8Array に変換する。
function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(normalized);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

function pushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    typeof window.PushManager !== 'undefined' &&
    'Notification' in window
  );
}

export function PushNotifyPanel() {
  const t = useTranslations('PushNotify');
  const locale = useLocale();
  const pushLocale = locale === 'en' ? 'en' : 'ja';
  // signIn をパネル内蔵にする: ヘッダの SIWE ボタンは他 flag (freee/a1/Pro/CSV パス) 依存で
  // 出ない構成があり、「サインインしてください」だけ出して導線が無い不到達 (CsvPassPaywall の
  // 教訓と同型) になるため、ここで完結させる。文言は WalletBadge と同じ Nav.siweStatement。
  const { isSignedIn, signIn, isSigningIn } = useSiweSession();
  const { isConnected } = useAccount();
  const tNav = useTranslations('Nav');
  const [signInFailed, setSignInFailed] = useState(false);
  const { isStandalone } = usePwaDisplayMode();

  const [mounted, setMounted] = useState(false);
  const [platform, setPlatform] = useState<MobilePlatform>('other');
  const [supported, setSupported] = useState(false);
  const [permission, setPermission] =
    useState<NotificationPermission>('default');
  const [subscribed, setSubscribed] = useState(false);
  const [includeAmount, setIncludeAmount] = useState(false);
  // テスト通知の送信状態 (idle/sending/sent/failed)。rate limit (429) も failed 表示に倒す。
  const [testState, setTestState] = useState<
    'idle' | 'sending' | 'sent' | 'failed'
  >('idle');

  async function sendTest() {
    setTestState('sending');
    try {
      const res = await fetch('/api/push/test', { method: 'POST' });
      const json = (await res.json().catch(() => null)) as {
        ok?: boolean;
        sent?: number;
      } | null;
      setTestState(res.ok && json?.ok && (json.sent ?? 0) > 0 ? 'sent' : 'failed');
    } catch {
      setTestState('failed');
    }
  }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    setMounted(true);
    setPlatform(detectMobilePlatform());
    const ok = pushSupported();
    setSupported(ok);
    if (!ok) return;
    setPermission(Notification.permission);
    try {
      if (localStorage.getItem(INCLUDE_AMOUNT_KEY) === '1') setIncludeAmount(true);
    } catch {
      /* localStorage 不可環境では既定 false */
    }
    // 既存購読があれば「有効」状態から始める (別端末では未購読=既定 false)。
    void navigator.serviceWorker
      .getRegistration()
      .then((reg) => reg?.pushManager.getSubscription())
      .then((sub) => setSubscribed(!!sub))
      .catch(() => undefined);
  }, []);

  // flag OFF / 公開鍵なしは完全 inert (SSR/client 同一で null → hydration 安全)。
  if (!env.enablePushNotify || !env.pushVapidPublicKey) return null;

  async function enable() {
    setBusy(true);
    setError(false);
    try {
      const reg = await navigator.serviceWorker.register('/sw.js');
      const perm = await Notification.requestPermission();
      setPermission(perm);
      if (perm !== 'granted') {
        setBusy(false);
        return;
      }
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(env.pushVapidPublicKey),
      });
      const res = await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          subscription: sub.toJSON(),
          locale: pushLocale,
          includeAmount,
        }),
      });
      if (!res.ok) throw new Error('subscribe_failed');
      setSubscribed(true);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    setBusy(true);
    setError(false);
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = await reg?.pushManager.getSubscription();
      if (sub) {
        await fetch('/api/push/subscribe', {
          method: 'DELETE',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ endpoint: sub.endpoint }),
        });
        await sub.unsubscribe();
      }
      setSubscribed(false);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  // 金額 opt-in の変更。購読中なら同 endpoint へ再 POST (upsert で上書き)。
  async function changeIncludeAmount(next: boolean) {
    setIncludeAmount(next);
    try {
      localStorage.setItem(INCLUDE_AMOUNT_KEY, next ? '1' : '0');
    } catch {
      /* noop */
    }
    if (!subscribed) return;
    setBusy(true);
    setError(false);
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = await reg?.pushManager.getSubscription();
      if (sub) {
        const res = await fetch('/api/push/subscribe', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            subscription: sub.toJSON(),
            locale: pushLocale,
            includeAmount: next,
          }),
        });
        if (!res.ok) throw new Error('subscribe_failed');
      }
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4">
      <h3 className="text-sm font-bold text-slate-900">{t('title')}</h3>
      <p className="mt-1 text-xs text-slate-500">{t('description')}</p>
      {renderBody()}
    </section>
  );

  function renderBody() {
    if (!isSignedIn) {
      return (
        <div className="mt-2">
          <p className="text-xs text-slate-500">{t('signInRequired')}</p>
          {/* 接続済みならその場で SIWE サインイン (未接続はヘッダの「接続」から)。
              user reject 等の失敗は握りつぶして再試行可能なエラー行のみ出す。 */}
          {isConnected && (
            <button
              type="button"
              disabled={isSigningIn}
              onClick={() => {
                setSignInFailed(false);
                void signIn(tNav('siweStatement')).catch(() =>
                  setSignInFailed(true),
                );
              }}
              className="mt-2 rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-dark disabled:opacity-60"
            >
              {t('signInCta')}
            </button>
          )}
          {signInFailed && (
            <p className="mt-2 text-xs text-red-600">{t('error')}</p>
          )}
        </div>
      );
    }
    // mount 前は platform/対応判定が未確定なので何も出さない (SSR/client 一致)。
    if (!mounted) return null;
    // iOS Safari 通常タブ: A2HS 済 PWA でないと push 不可 → 購読 UI でなく hint を出す。
    if (platform === 'ios' && !isStandalone) {
      return (
        <div className="mt-2">
          <PwaInstallHint
            title={t('iosInstallHintTitle')}
            iosStep3={t('iosInstallHintStep3')}
          />
        </div>
      );
    }
    if (!supported) {
      return <p className="mt-2 text-xs text-slate-500">{t('unsupported')}</p>;
    }
    if (permission === 'denied') {
      return <p className="mt-2 text-xs text-amber-700">{t('denied')}</p>;
    }

    return (
      <div className="mt-3 space-y-3">
        {subscribed ? (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-xs font-medium text-emerald-700">
                {t('enabledStatus')}
              </span>
              {/* テスト通知: 着金なしで「この端末に届く」を確認できる (server 側 1 分 1 回)。 */}
              <button
                type="button"
                disabled={busy || testState === 'sending'}
                onClick={() => void sendTest()}
                className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:border-slate-400 disabled:opacity-50"
              >
                {t('testCta')}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void disable()}
                className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:border-slate-400 disabled:opacity-50"
              >
                {t('disableCta')}
              </button>
            </div>
            {testState === 'sent' && (
              <p className="text-[11px] text-emerald-700">{t('testSent')}</p>
            )}
            {testState === 'failed' && (
              <p className="text-[11px] text-red-600">{t('testFailed')}</p>
            )}
          </div>
        ) : (
          <button
            type="button"
            disabled={busy}
            onClick={() => void enable()}
            className="rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-dark disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t('enableCta')}
          </button>
        )}

        <label className="flex items-start gap-2 text-xs text-slate-700">
          <input
            type="checkbox"
            checked={includeAmount}
            disabled={busy}
            onChange={(e) => void changeIncludeAmount(e.target.checked)}
            className="mt-0.5"
          />
          <span>
            {t('includeAmountLabel')}
            <span className="mt-0.5 block text-[11px] text-slate-500">
              {t('includeAmountNote')}
            </span>
          </span>
        </label>

        {error && <p className="text-[11px] text-red-600">{t('error')}</p>}
      </div>
    );
  }
}
