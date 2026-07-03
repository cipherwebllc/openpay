'use client';

// PWA install を促す hint バナー。standalone モードでは非表示。
// iOS Safari: 手順テキスト / Android Chrome: beforeinstallprompt 経由で native
// install ボタン / その他: 軽い hint のみ。UA spoof でもどの分岐も無害な fallback。

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { usePwaDisplayMode } from '@/hooks/usePwaDisplayMode';
import { detectMobilePlatform, type MobilePlatform } from '@/lib/walletDeepLink';

// beforeinstallprompt event の Chrome 拡張型 (W3C draft、TS lib に未含)。
type BeforeInstallPromptEvent = Event & {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
};

type Platform = MobilePlatform;

// dismiss を全面 (/scan・/create・/history) で共有する localStorage キー。一度閉じたら
// どの面でも再表示しない (訪問毎の再提示スパムを解消)。AlphaNotice の DISMISS_KEY と同型。
const DISMISS_KEY = 'openpay:pwaInstallHint:v1';

type PwaInstallHintProps = {
  // 面ごとに文言を差し替えるための任意 override。省略時は Scan namespace の
  // 現行文言 (= /scan 挙動不変)。
  title?: string;
  iosStep3?: string;
};

export function PwaInstallHint({ title, iosStep3 }: PwaInstallHintProps = {}) {
  const t = useTranslations('Scan');
  const { isStandalone } = usePwaDisplayMode();
  // SSR / 初回 client render では 'other' に倒し、useEffect で真の platform に
  // 切替える。useState(detectPlatform) で lazy init すると SSR は 'other'、
  // hydrate 時は実 UA から 'ios'/'android' を返してしまい React hydration error
  // #418 (HTML mismatch) を発生させる本物バグだった (mobile-safari e2e で発覚)。
  const [platform, setPlatform] = useState<Platform>('other');
  const [deferredPrompt, setDeferredPrompt] =
    useState<BeforeInstallPromptEvent | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    setPlatform(detectMobilePlatform());
    // 過去に閉じた利用者は mount 後に隠す (SSR/初回 render は表示に倒し hydration 安全)。
    try {
      if (localStorage.getItem(DISMISS_KEY) === '1') setDismissed(true);
    } catch {
      /* localStorage 不可環境では表示のまま */
    }
    function onBeforeInstall(e: Event) {
      // Chrome の自動 prompt を抑制し、ユーザのボタン操作に紐付ける。
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
    }
    function onInstalled() {
      // install 完了で hint を畳む (display-mode change の hook 経由でも畳まれるが、
      // PWA が manifest を再 fetch する前に local state を倒すための保険)。
      setDismissed(true);
    }
    window.addEventListener('beforeinstallprompt', onBeforeInstall);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstall);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  if (isStandalone || dismissed) return null;

  function persistDismiss() {
    try {
      localStorage.setItem(DISMISS_KEY, '1');
    } catch {
      /* noop */
    }
    setDismissed(true);
  }

  async function handleAndroidInstall() {
    // button は {platform === 'android' && deferredPrompt} の guard 配下でのみ描画
    // されるため、本関数は必ず非 null state で呼ばれる。non-null 断言は閉路の不変条件。
    const prompt = deferredPrompt!;
    await prompt.prompt();
    const choice = await prompt.userChoice;
    // 受諾でも拒否でも prompt は 1 度しか使えない仕様。消費後は null に戻す。
    setDeferredPrompt(null);
    if (choice.outcome === 'accepted') persistDismiss();
  }

  return (
    <div className="rounded-2xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1">
          <p className="font-semibold">{title ?? t('installHintTitle')}</p>
          {platform === 'ios' && (
            <ol className="mt-2 list-decimal space-y-1 pl-5 text-xs leading-relaxed">
              <li>{t('installHintIosStep1')}</li>
              <li>{t('installHintIosStep2')}</li>
              <li>{iosStep3 ?? t('installHintIosStep3')}</li>
            </ol>
          )}
          {platform === 'android' && (
            <p className="mt-1 text-xs">
              {deferredPrompt
                ? t('installHintAndroidPromptable')
                : t('installHintAndroidManual')}
            </p>
          )}
          {platform === 'other' && (
            <p className="mt-1 text-xs">{t('installHintOther')}</p>
          )}
        </div>
        <button
          type="button"
          onClick={persistDismiss}
          aria-label={t('installHintDismiss')}
          className="rounded-md border border-blue-200 bg-white px-2 py-1 text-xs font-medium text-blue-700 hover:bg-blue-100"
        >
          ×
        </button>
      </div>
      {platform === 'android' && deferredPrompt && (
        <button
          type="button"
          onClick={() => {
            void handleAndroidInstall();
          }}
          className="mt-3 rounded-lg bg-blue-600 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-700"
        >
          {t('installHintAndroidButton')}
        </button>
      )}
    </div>
  );
}
