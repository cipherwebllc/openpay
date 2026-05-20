'use client';

// PWA install を促す hint バナー。
//
// 表示条件:
//   - standalone モード (= 既に home screen から起動) のときは非表示
//   - iOS Safari: 共有 → ホームに追加 の手順テキスト
//   - Android Chrome 系: beforeinstallprompt event を受領済なら native prompt 呼出ボタン
//   - その他 (PC など): 軽い hint のみ
//
// platform 判定は UserAgent ベース。UA は spoof 可能だが install 不可な環境で
// ボタン押してもエラーにならないようにフォールバックは hint テキスト共通。

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { usePwaDisplayMode } from '@/hooks/usePwaDisplayMode';

// beforeinstallprompt event の Chrome 拡張型 (W3C draft、TS lib に未含)。
type BeforeInstallPromptEvent = Event & {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
};

type Platform = 'ios' | 'android' | 'other';

function detectPlatform(): Platform {
  if (typeof navigator === 'undefined') return 'other';
  const ua = navigator.userAgent;
  // iPad は iPadOS 13+ で「Mac 風 UA」を返すので UA だけでは見分け不可。
  // navigator.maxTouchPoints が iPadOS 公式推奨の判別シグナル (Safari/iPadOS では
  // 5 を返し、純デスクトップ Mac では 0)。`'ontouchend' in document` は
  // GlobalEventHandlers 由来で多くの環境で常に true を返すため当てにならない。
  const maxTouch = navigator.maxTouchPoints ?? 0;
  const isIpad = /Macintosh/.test(ua) && maxTouch > 1;
  if (/iPhone|iPod/.test(ua) || isIpad) return 'ios';
  if (/Android/i.test(ua)) return 'android';
  return 'other';
}

export function PwaInstallHint() {
  const t = useTranslations('Scan');
  const { isStandalone } = usePwaDisplayMode();
  // SSR では 'other' に倒れ、hydrate 時に真の platform に再評価される (ユーザ
  // にとって install 不可の "other" を一瞬出すのは無害 + click で flicker しない)。
  const [platform] = useState<Platform>(detectPlatform);
  const [deferredPrompt, setDeferredPrompt] =
    useState<BeforeInstallPromptEvent | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
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

  async function handleAndroidInstall() {
    // button は {platform === 'android' && deferredPrompt} の guard 配下でのみ描画
    // されるため、本関数は必ず非 null state で呼ばれる。non-null 断言は閉路の不変条件。
    const prompt = deferredPrompt!;
    await prompt.prompt();
    const choice = await prompt.userChoice;
    // 受諾でも拒否でも prompt は 1 度しか使えない仕様。消費後は null に戻す。
    setDeferredPrompt(null);
    if (choice.outcome === 'accepted') setDismissed(true);
  }

  return (
    <div className="rounded-2xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1">
          <p className="font-semibold">{t('installHintTitle')}</p>
          {platform === 'ios' && (
            <ol className="mt-2 list-decimal space-y-1 pl-5 text-xs leading-relaxed">
              <li>{t('installHintIosStep1')}</li>
              <li>{t('installHintIosStep2')}</li>
              <li>{t('installHintIosStep3')}</li>
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
          onClick={() => setDismissed(true)}
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
