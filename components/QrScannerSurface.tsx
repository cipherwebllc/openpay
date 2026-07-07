'use client';

// /scan の中核 UI。video → qr-scanner で decode → onScanned に raw 文字列を渡す。
//
// 各 state (idle / starting / scanning / permission-denied / no-camera / error)
// で表示が変わるが、URL 手入力 fallback は camera 拒否/不在/エラーのいずれでも
// 開かれ、keyboard-only / kiosk 端末からも /scan の deep-link 機能を完全に使える。

import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQrScanner, type DecodeResult } from '@/hooks/useQrScanner';

export type QrScannerSurfaceProps = {
  // decode 成功 / 手入力 fallback どちらでも呼ばれる統一 callback。
  onScanned: (raw: string) => void;
};

export function QrScannerSurface({ onScanned }: QrScannerSurfaceProps) {
  const t = useTranslations('Scan');
  const videoRef = useRef<HTMLVideoElement>(null);
  const { state, start } = useQrScanner(videoRef, (r: DecodeResult) =>
    onScanned(r.data),
  );

  const [manualUrl, setManualUrl] = useState('');
  const isScanning = state.status === 'scanning';
  const fallbackActive =
    state.status === 'permission-denied' ||
    state.status === 'no-camera' ||
    state.status === 'error';

  function handleManualSubmit(e: React.FormEvent) {
    e.preventDefault();
    const v = manualUrl.trim();
    if (v.length === 0) return;
    onScanned(v);
  }

  async function handlePaste() {
    // Clipboard 読取は user gesture かつ HTTPS 必須。失敗時は input 空のまま
    // (フォーカスを動かさず手入力に倒す)。
    if (!navigator.clipboard?.readText) return;
    const text = await navigator.clipboard.readText().catch(() => '');
    if (text) setManualUrl(text.trim());
  }

  return (
    <div className="space-y-3">
      <div
        className="relative overflow-hidden rounded-3xl bg-slate-900 shadow-lift ring-1 ring-slate-800"
      >
        {/* video は常に mount する。idle / fallback では h-0 で論理的に隠す
            (display:none だと iOS Safari で getUserMedia が失敗する既知 quirk)。 */}
        <video
          ref={videoRef}
          className={`block w-full ${
            isScanning ? 'aspect-square object-cover' : 'h-0'
          }`}
          autoPlay
          playsInline
          muted
        />
        {/* ビューファインダーの四隅フレーム (QR を「ここに合わせる」アフォーダンス)。
            scanning 中は映像上で白、idle ではブランド色で枠を示す。 */}
        <CornerFrame scanning={isScanning} />
        {/* スキャンライン (読み取り中のみ・映像上を上下に往復する光の線)。
            prefers-reduced-motion では非表示にする。 */}
        {isScanning && (
          <span
            aria-hidden
            data-testid="scan-line"
            className="animate-scanline pointer-events-none absolute inset-x-4 h-[2px] -translate-y-1/2 rounded-full bg-gradient-to-r from-transparent via-white/90 to-transparent shadow-[0_0_8px_2px_rgba(255,255,255,0.45)] motion-reduce:hidden"
          />
        )}
        {!isScanning && (
          <div className="flex min-h-[17rem] flex-col items-center justify-center gap-3 px-6 py-8 text-center">
            <span className="flex h-16 w-16 items-center justify-center rounded-full bg-white/10 ring-1 ring-white/15">
              <CameraIcon />
            </span>
            <p className="max-w-[16rem] text-balance text-sm leading-relaxed text-slate-300">{t('cameraIdleHint')}</p>
            {state.status === 'idle' && (
              <button
                type="button"
                onClick={() => {
                  void start();
                }}
                className="rounded-xl bg-white px-6 py-2.5 text-sm font-semibold text-slate-900 shadow-sm transition-all hover:-translate-y-0.5 hover:bg-slate-100 hover:shadow-card-hover focus:outline-none focus:ring-2 focus:ring-white/60 active:translate-y-0"
              >
                {t('startCameraButton')}
              </button>
            )}
            {state.status === 'starting' && (
              <p className="text-xs text-slate-400">{t('cameraStarting')}</p>
            )}
            {state.status === 'permission-denied' && (
              <StatusBox
                tone="amber"
                title={t('permissionDeniedTitle')}
                body={t('permissionDeniedBody')}
              />
            )}
            {state.status === 'no-camera' && (
              <StatusBox
                tone="amber"
                title={t('noCameraTitle')}
                body={t('noCameraBody')}
              />
            )}
            {state.status === 'error' && (
              <StatusBox
                tone="red"
                title={t('genericErrorTitle')}
                body={state.error.message}
                bodyMono
              />
            )}
          </div>
        )}
      </div>

      {/* URL 手入力 fallback — fallback active 時は強調表示、scanning 時も
          畳まれた状態で残しておく (慣れたユーザが click だけで URL を試せる動線) */}
      <details
        className={`rounded-xl text-sm ring-1 ${
          fallbackActive
            ? 'bg-white ring-amber-300 shadow-sm'
            : 'bg-slate-100/70 ring-slate-200/60'
        }`}
        open={fallbackActive}
      >
        <summary
          className={`cursor-pointer px-4 py-2.5 font-medium ${
            fallbackActive ? 'text-amber-900' : 'text-slate-500'
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
              onClick={() => {
                void handlePaste();
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

function StatusBox({
  tone,
  title,
  body,
  bodyMono = false,
}: {
  tone: 'amber' | 'red';
  title: string;
  body: string;
  bodyMono?: boolean;
}) {
  const classes =
    tone === 'amber'
      ? 'bg-amber-50 text-amber-900'
      : 'bg-red-50 text-red-800';
  return (
    <div className={`rounded-lg px-4 py-3 text-left text-xs ${classes}`}>
      <p className="font-semibold">{title}</p>
      <p className={`mt-1 ${bodyMono ? 'font-mono' : ''}`}>{body}</p>
    </div>
  );
}

// QR スキャナのビューファインダー四隅フレーム (4 つの L 字)。idle=ブランド色 / scanning=白。
function CornerFrame({ scanning }: { scanning: boolean }) {
  const color = scanning ? 'border-white/85' : 'border-white/45';
  const base = 'pointer-events-none absolute h-7 w-7';
  return (
    <>
      <span className={`${base} left-3 top-3 rounded-tl-xl border-l-[3px] border-t-[3px] ${color}`} aria-hidden />
      <span className={`${base} right-3 top-3 rounded-tr-xl border-r-[3px] border-t-[3px] ${color}`} aria-hidden />
      <span className={`${base} bottom-3 left-3 rounded-bl-xl border-b-[3px] border-l-[3px] ${color}`} aria-hidden />
      <span className={`${base} bottom-3 right-3 rounded-br-xl border-b-[3px] border-r-[3px] ${color}`} aria-hidden />
    </>
  );
}

function CameraIcon() {
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
      className="text-white/90"
      aria-hidden
    >
      <rect x="3" y="6" width="18" height="13" rx="2" />
      <circle cx="12" cy="12.5" r="3.5" />
      <path d="M9 6l1.5-2h3L15 6" />
    </svg>
  );
}
