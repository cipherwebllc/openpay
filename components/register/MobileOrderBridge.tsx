'use client';

// レジの商品 → モバイル注文への橋 (2026-10 磨き上げ P4)。レジの商品はそのままモバイル注文のメニュー
// (MobileOrderBuilder が useProductPresets を読む) なので、「このメニューでモバイル注文も」と気づける 1 枚を出す。
// PC は商品カードの中、スマホはご注文の後ろ (商品 → ご注文の流れの間に挟まない)。
// × で閉じたらこの端末では出さない。レジは ssr:false のタブなので、localStorage は初回の描画で読む (閉じた人に一瞬出さない)。

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { ArrowRight, Smartphone, X } from 'lucide-react';

const DISMISS_KEY = 'openpay:register:mobile-order-bridge:dismissed:v1';

function readDismissed(): boolean {
  try {
    return window.localStorage.getItem(DISMISS_KEY) === '1';
  } catch {
    // localStorage が使えない環境 (プライベートモード等) では毎回出す (レジの操作は妨げない)。
    return false;
  }
}

// 閉じたかどうか (この端末で 1 度閉じたら出さない)。スマホとPCで置き場所が違うので RegisterMode が持ち、両方に渡す。
export function useMobileOrderBridgeDismissed(): [boolean, () => void] {
  const [dismissed, setDismissed] = useState(readDismissed);
  const dismiss = () => {
    try {
      window.localStorage.setItem(DISMISS_KEY, '1');
    } catch {
      // 保存できなくても、この表示では閉じる (次に開いたときにまた出るだけ)。
    }
    setDismissed(true);
  };
  return [dismissed, dismiss];
}

export function MobileOrderBridge({
  onStart,
  onDismiss,
  className = '',
}: {
  onStart: () => void;
  onDismiss: () => void;
  className?: string;
}) {
  const t = useTranslations('RegisterMode.mobileOrderBridge');
  // 会計の流れ (商品 → 注文) を切らない場所に置き、2 行に収める (説明の文はモバイル注文タブと商品の編集シートに任せる)。
  return (
    <div className={`flex items-center gap-3 rounded-xl bg-brand/5 px-3 py-2.5 ring-1 ring-brand/15 ${className}`}>
      <Smartphone className="h-5 w-5 flex-none text-brand" aria-hidden />
      <div className="min-w-0 flex-1">
        {/* 折り返すときは「、」の後で (語の途中・1 文字だけの行で折らない)。 */}
        <p className="break-keep text-xs font-semibold text-slate-800">
          {t.rich('title', { wbr: () => <wbr /> })}
        </p>
        <button
          type="button"
          onClick={onStart}
          className="mt-0.5 inline-flex items-center gap-1 text-xs font-semibold text-brand hover:underline"
        >
          {t('cta')}
          <ArrowRight className="h-3.5 w-3.5" aria-hidden />
        </button>
      </div>
      <button
        type="button"
        onClick={onDismiss}
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-slate-500 hover:bg-white hover:text-slate-700"
      >
        <X className="h-4 w-4" aria-hidden />
        <span className="sr-only">{t('dismiss')}</span>
      </button>
    </div>
  );
}
