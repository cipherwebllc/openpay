'use client';

// /scan の中核 UI。<video> を canvas に流して qr-scanner が QR を decode する。
//
// 状態:
//   - idle: 「カメラを起動」ボタンを表示 (user gesture が必要なため自動 start 禁止)
//   - starting: 「準備中…」スピナー
//   - scanning: video preview + アウトラインハイライト (qr-scanner が描画)
//   - permission-denied: 拒否時の手順 illustration + 「URL を貼り付け」fallback
//   - no-camera: 「この端末にカメラがありません」+ URL 貼付 fallback
//   - error: 一般 error message + URL 貼付 fallback
//
// URL 手入力 (fallback): camera が拒否 / 不在の場合でも /scan の deep-link
// 機能 (parse → router.push) を完全に利用できるようにする。これにより
// keyboard-only / kiosk 端末でも動作。

import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQrScanner, type DecodeResult } from '@/hooks/useQrScanner';

export type QrScannerSurfaceProps = {
  // decode 成功 / fallback の URL 手入力どちらでも呼ばれる統一 callback。
  onScanned: (raw: string) => void;
};

export function QrScannerSurface({ onScanned }: QrScannerSurfaceProps) {
  const t = useTranslations('Scan');
  const videoRef = useRef<HTMLVideoElement>(null);
  const { state, start } = useQrScanner(videoRef, (r: DecodeResult) =>
    onScanned(r.data),
  );

  const [manualUrl, setManualUrl] = useState('');
  const status = state.status;
  const fallbackActive =
    status === 'permission-denied' ||
    status === 'no-camera' ||
    status === 'error';

  function handleManualSubmit(e: React.FormEvent) {
    e.preventDefault();
    const v = manualUrl.trim();
    if (v.length === 0) return;
    onScanned(v);
  }

  return (
    <div className="space-y-3">
      <div
        // video は status に関係なく常に mount する (useRef を start 時に
        // 確実に参照できるようにする)。idle / fallback では非表示にして
        // CSS で隠す (display:none だと iOS Safari で getUserMedia が失敗する
        // 既知 quirk があるので visibility:hidden + size:0 で論理的に同等)。
        className={`relative overflow-hidden rounded-2xl border ${
          status === 'scanning'
            ? 'border-slate-300 bg-slate-900'
            : 'border-dashed border-slate-300 bg-slate-50'
        }`}
      >
        <video
          ref={videoRef}
          className={`block w-full ${
            status === 'scanning' ? 'aspect-square object-cover' : 'h-0'
          }`}
          // autoplay / playsInline は iOS Safari で inline 再生を可能にする必須属性
          autoPlay
          playsInline
          muted
        />
        {status !== 'scanning' && (
          <div className="flex flex-col items-center gap-3 px-6 py-10 text-center">
            <CameraIcon />
            <p className="text-sm text-slate-600">{t('cameraIdleHint')}</p>
            {status === 'idle' && (
              <button
                type="button"
                onClick={() => {
                  void start();
                }}
                className="rounded-lg bg-brand px-5 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-brand-dark focus:outline-none focus:ring-2 focus:ring-brand"
              >
                {t('startCameraButton')}
              </button>
            )}
            {status === 'starting' && (
              <p className="text-xs text-slate-500">{t('cameraStarting')}</p>
            )}
            {status === 'permission-denied' && (
              <div className="rounded-lg bg-amber-50 px-4 py-3 text-left text-xs text-amber-900">
                <p className="font-semibold">{t('permissionDeniedTitle')}</p>
                <p className="mt-1">{t('permissionDeniedBody')}</p>
              </div>
            )}
            {status === 'no-camera' && (
              <div className="rounded-lg bg-amber-50 px-4 py-3 text-left text-xs text-amber-900">
                <p className="font-semibold">{t('noCameraTitle')}</p>
                <p className="mt-1">{t('noCameraBody')}</p>
              </div>
            )}
            {status === 'error' && state.status === 'error' && (
              <div className="rounded-lg bg-red-50 px-4 py-3 text-left text-xs text-red-800">
                <p className="font-semibold">{t('genericErrorTitle')}</p>
                <p className="mt-1 font-mono">{state.error.message}</p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* URL 手入力 fallback — fallback active 時は強調表示、scanning 時も
          畳まれた状態で残しておく (慣れたユーザが click だけで URL を試せる動線) */}
      <details
        className={`rounded-xl border bg-white text-sm ${
          fallbackActive
            ? 'border-amber-300 shadow-sm'
            : 'border-dashed border-slate-300'
        }`}
        open={fallbackActive}
      >
        <summary
          className={`cursor-pointer px-4 py-2.5 font-medium ${
            fallbackActive ? 'text-amber-900' : 'text-slate-600'
          }`}
        >
          {t('manualUrlSummary')}
        </summary>
        <form onSubmit={handleManualSubmit} className="space-y-2 px-4 pb-4">
          <label className="block text-xs text-slate-500" htmlFor="scan-manual-url">
            {t('manualUrlLabel')}
          </label>
          <input
            id="scan-manual-url"
            // type=text を使う (type=url は HTML5 form validation で非 URL を
            // 拒否し submit が無効化される、scanner の raw は非 URL も流れ得るため
            // parser 側で kind=unknown へ落として赤 banner を出す UX が走らなくなる)。
            // 仮想キーボードは inputMode=url で URL レイアウトに固定。
            type="text"
            inputMode="url"
            value={manualUrl}
            onChange={(e) => setManualUrl(e.target.value)}
            placeholder="https://open-pay.jp/pay?to=0x..."
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-xs focus:border-brand focus:outline-none"
          />
          <div className="flex flex-wrap gap-2">
            <button
              type="submit"
              disabled={manualUrl.trim().length === 0}
              className="rounded-lg bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-700 disabled:opacity-40"
            >
              {t('manualUrlSubmit')}
            </button>
            <button
              type="button"
              onClick={async () => {
                // Clipboard 読取は user gesture かつ HTTPS 必須。
                // 失敗時は input 空のまま (フォーカスを動かさず手入力に倒す)。
                if (!navigator.clipboard?.readText) return;
                const text = await navigator.clipboard
                  .readText()
                  .catch(() => '');
                if (text) setManualUrl(text.trim());
              }}
              className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:border-brand hover:text-brand-dark"
            >
              {t('manualUrlPaste')}
            </button>
          </div>
        </form>
      </details>
    </div>
  );
}

function CameraIcon() {
  // 内製 SVG — 外部 icon ライブラリへ依存しない (bundle 影響ゼロ)。
  return (
    <svg
      width="44"
      height="44"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="text-slate-400"
      aria-hidden
    >
      <rect x="3" y="6" width="18" height="13" rx="2" />
      <circle cx="12" cy="12.5" r="3.5" />
      <path d="M9 6l1.5-2h3L15 6" />
    </svg>
  );
}
