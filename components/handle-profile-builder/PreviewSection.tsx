'use client';

// 右カラム: ライブプレビュー (常時) + 編集中 handle の 開く/コピー/QR/X + 公開ボタンの帯 (PC)。desktop は sticky。
// 状態は持たない — 表示する config/profile・編集中の handle・コピー済み表示・QR の開閉・公開ボタンの帯の
// 置き場 (HandleClaimPanel が portal する) は親の HandleProfileBuilder が持つ。

import { Eye } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { isArcTipEnabled } from '@/lib/env';
import { HandleProfileView } from '@/components/HandleProfile';
import { methodMetaLabel } from '@/components/ReceiveMethodPicker';
import { SectionCard } from '@/components/SectionCard';
import type { HandleProfile, HandleReceiveMethod, HandleTipConfig } from '@/lib/handle';

export function PreviewSection({
  hydrated,
  previewBg,
  previewDark,
  previewConfig,
  profile,
  usdcArc,
  capableMethods,
  previewWithChain,
  editingHandle,
  publicHandleUrl,
  xShareHref,
  linkCopy,
  onShowQr,
  desktopBarRef,
}: {
  hydrated: boolean;
  previewBg: string | undefined;
  previewDark: boolean;
  previewConfig: HandleTipConfig;
  profile: HandleProfile;
  /** 下書きが USDC (Arc) を選んでいるか (Arc が無効の間はプレビューに注記を出す)。 */
  usdcArc: boolean;
  capableMethods: HandleReceiveMethod[];
  previewWithChain: boolean;
  editingHandle: string | null;
  publicHandleUrl: string;
  xShareHref: string;
  linkCopy: { copied: boolean; copy: (value: string) => Promise<boolean> };
  onShowQr: () => void;
  /** 公開ボタンの帯 (PC) を描く場所。HandleClaimPanel がここへ portal する。 */
  desktopBarRef: (el: HTMLDivElement | null) => void;
}) {
  const t = useTranslations('HandleProfile');
  const tb = useTranslations('HandleProfileBuilder');
  const tc = useTranslations('HandleClaim');
  return (
    <aside className="mt-6 min-w-0 self-start [&_#step-4-heading]:scroll-mt-16 lg:mt-0 lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:overflow-y-auto">
      <SectionCard title={t('stepPreviewTitle')} headingId="step-4-heading" icon={Eye}>
        {hydrated && (
          <div
            data-testid="handle-preview-frame"
            className="mx-auto max-w-[360px] overflow-hidden rounded-[2rem] border-[6px] border-slate-900 bg-white shadow-xl ring-1 ring-black/5"
          >
            {/* MobileOrderBuilder と同じ枠内スクロール契約。長いリンク集でもアクション行は
                フレーム外に残り、プレビューだけを max-height 内で操作できる。 */}
            <div
              data-testid="handle-preview-scroll"
              className={`max-h-[46vh] overflow-y-auto p-4 ${
                previewBg ? '' : 'bg-slate-50'
              }`}
              style={previewBg ? { background: previewBg } : undefined}
            >
              <div
                className={`mx-auto max-w-xs rounded-xl p-4 shadow-sm ${
                  previewBg ? '' : 'bg-white'
                }`}
                style={previewBg ? { background: previewBg } : undefined}
              >
                <HandleProfileView config={previewConfig} profile={profile} />
                {usdcArc && !isArcTipEnabled() && (
                  <p className="mt-2 text-center text-xs text-amber-700">{tb('arcInactive')}</p>
                )}
                {capableMethods.length > 0 && (
                  <div className="mt-4 flex flex-col gap-2">
                    {capableMethods.length > 1 && (
                      <p
                        className={`text-center text-xs font-semibold ${
                          previewDark ? 'text-slate-300' : 'text-slate-500'
                        }`}
                      >
                        {t('selectCurrencyChain')}
                      </p>
                    )}
                    {capableMethods.map((m, i) => (
                      <span
                        key={i}
                        className={`flex flex-col items-center rounded-lg border px-3 py-2 text-center text-sm font-semibold ${
                          previewDark
                            ? 'border-white/15 text-slate-200'
                            : 'border-slate-200 text-slate-600'
                        }`}
                      >
                        {capableMethods.length > 1 ? (
                          methodMetaLabel(m, t('crossChain'), { withChain: previewWithChain })
                        ) : (
                          <>
                            <span>♡ {t('supportHeading')}</span>
                            <span
                              className={`text-xs font-medium ${
                                previewDark ? 'text-slate-300' : 'text-slate-500'
                              }`}
                            >
                              {methodMetaLabel(m, t('crossChain'), { withChain: previewWithChain })}
                            </span>
                          </>
                        )}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* プレビュー対象 (編集中 handle) のアクション行。新規未公開時は handle が無いので非表示。 */}
        {editingHandle && (
          <div className="mt-4 flex flex-wrap gap-1.5">
            <a
              href={publicHandleUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-md border border-slate-200 px-2 py-1 text-xs font-semibold text-slate-600 hover:border-brand hover:text-brand"
            >
              {tc('open')}
            </a>
            <button
              type="button"
              onClick={() =>
                void linkCopy.copy(publicHandleUrl)
              }
              className="rounded-md bg-slate-900 px-2 py-1 text-xs font-semibold text-white hover:bg-slate-700"
            >
              {linkCopy.copied ? tc('copied') : tc('copy')}
            </button>
            <button
              type="button"
              onClick={onShowQr}
              className="rounded-md border border-slate-200 px-2 py-1 text-xs font-semibold text-slate-600 hover:border-brand hover:text-brand"
            >
              {tc('showQr')}
            </button>
            <a
              href={xShareHref}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-md border border-slate-200 px-2 py-1 text-xs font-semibold text-slate-600 hover:border-brand hover:text-brand"
            >
              {t('shareOnX')}
            </a>
          </div>
        )}
        {/* 公開ボタンの帯 (PC)。スマホは画面下のバー。どちらも HandleClaimPanel が同じ公開処理で描く。 */}
        <div ref={desktopBarRef} className="mt-4 hidden border-t border-slate-100 pt-4 lg:block" />
      </SectionCard>
    </aside>
  );
}
