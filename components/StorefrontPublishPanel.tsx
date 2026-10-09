'use client';

// モバイルオーダーのメニューを @handle に公開し、open-pay.jp/@handle を固定店舗 URL にする。
// 店舗固有部分 (chain/mode/feePayer/menu) のみ送り、identity (受取先/店名/アイコン/SNS) は
// @handle プロフィールの設定が使われる (lib/handle.handleStorefrontConfig が合成)。SIWE 必須・
// 所有者のみ (既存 /api/handle を流用)。NEXT_PUBLIC_ENABLE_HANDLES OFF では何も描画しない。
//
// react-query を使うため、親 (MobileOrderBuilder) は env.enableHandles でこのパネルの**マウント自体**
// をゲートする (handles OFF の単体テストで QueryClient を要求しないため)。

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLocale, useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { env } from '@/lib/env';
import { MobileOrderPlacardModal } from '@/components/MobileOrderPlacardModal';
import { useSiweSession } from '@/hooks/useSiweSession';
import { SignInGate } from '@/components/SignInGate';
import { useOrigin } from '@/hooks/useOrigin';
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard';
import type { HandleTipConfig } from '@/lib/handle';
import {
  JPYC_CHAIN_LABEL,
  storefrontPartsEquivalent,
  type StorefrontParts,
} from '@/lib/mobileOrder';
import { formatPublishedRelativeTime } from '@/lib/handlePublish';
import { shortAddress } from '@/lib/format';
import type { Address } from 'viem';
import { MY_HANDLES_ROOT_KEY, fetchMyHandles, myHandlesQueryKey, type MineResponse } from '@/lib/handleMine';

async function fetchJson(url: string, init?: RequestInit) {
  const res = await fetch(url, init);
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: res.ok, status: res.status, json };
}

export function StorefrontPublishPanel({
  storefront,
  receiver,
  onGetHandle,
  onLoadStorefront,
  canAutoLoad = false,
  accepting,
  onToggleAccepting,
  barSlots = [],
  blockedReason,
}: {
  /** 公開する店舗固有部分。メニュー未充足など公開不可なら null (公開ボタンを無効化)。 */
  storefront: StorefrontParts | null;
  /** ビルダーの受取先 (検証済み Address・未確定なら null)。「公開を更新」時にこれが現 @handle の
   *  受取先 (config.to) と異なれば config.to を上書き更新する = ビルダーの受取先を権威化する。
   *  受取先は @handle 共通 (プロフのチップ等と同一アドレス) なので、更新は @handle 全体に及ぶ。 */
  receiver: Address | null;
  /** 「@handle を取得」導線 (create が profile タブへ切替)。 */
  onGetHandle?: () => void;
  /** 公開済み storefront をビルダー (下書き + 商品カタログ) へ読み込む (別端末での編集用)。
   *  受取先は @handle config.to を渡す。破壊的なので本パネルが確認を取ってから呼ぶ。 */
  onLoadStorefront?: (parts: StorefrontParts, receiver: string) => void;
  /** この端末の下書きとレジの商品がまだ手付かず (既定・見本のまま) なら true。公開中の店が 1 つだけなら
   *  確認なしで読み込む (戻ってきた店主に空の編集画面を見せない・失うものが無いときだけ)。 */
  canAutoLoad?: boolean;
  /** 注文の受付 (下書き)。渡されたときだけ状態カードに切替を出す。公開を更新するとお店のページに反映される。 */
  accepting?: boolean;
  onToggleAccepting?: () => void;
  /** 公開ボタンの帯を描く場所 (スマホ: ビルダーの末尾の sticky な枠 / PC: プレビューの下)。同じ公開処理を
   *  どこからでも押せるよう、この部品がそこへ描く。 */
  barSlots?: ReadonlyArray<HTMLElement | null>;
  /** 下書きに直すところがあり公開させないときの理由 (例: 値引きが範囲外)。無ければ従来どおり。 */
  blockedReason?: string;
}) {
  const t = useTranslations('MobileOrder');
  const locale = useLocale();
  const { isSignedIn, sessionAddress } = useSiweSession();
  const origin = useOrigin();
  const linkCopy = useCopyToClipboard();
  const qc = useQueryClient();
  const [selected, setSelected] = useState('');
  const [showQr, setShowQr] = useState(false);
  // 公開済み同意を handle ごとの既定値にし、ユーザーが変更した handle だけ上書きする。
  // handle 切替を effect で state 同期すると 1 render 古い同意を送るため、派生値で決める。
  const [agentListingOverrides, setAgentListingOverrides] = useState<
    Record<string, boolean>
  >({});
  // 公開中の @handle をビルダーへ読み込む前の確認 (下書き + 商品カタログを破壊的に上書きするため)。
  const [confirmLoad, setConfirmLoad] = useState(false);

  const mine = useQuery({
    // 取得と返り値の形は lib/handleMine.ts に 1 つ (他の画面・トップと同じ cache を共有する)。
    queryKey: myHandlesQueryKey(sessionAddress),
    enabled: env.enableHandles && isSignedIn,
    queryFn: fetchMyHandles,
  });

  const handles = useMemo(() => mine.data?.handles ?? [], [mine.data]);
  // 公開先を **派生** で決める (useEffect の 1 レンダ遅延を避け、初回描画で確定させる):
  // ユーザが選択済みでそれが一覧に在ればそれ、無ければ「店舗公開済み handle → 先頭」を既定に。
  const effectiveSelected =
    selected && handles.some((hh) => hh.handle === selected)
      ? selected
      : (handles.find((hh) => hh.storefront)?.handle ?? handles[0]?.handle ?? '');
  const selectedHandle = handles.find((hh) => hh.handle === effectiveSelected) ?? null;
  const selectedAgentListing = selectedHandle?.storefront?.agentListing === true;
  const agentListing = Object.prototype.hasOwnProperty.call(
    agentListingOverrides,
    effectiveSelected,
  )
    ? agentListingOverrides[effectiveSelected]
    : selectedAgentListing;
  const publishedStorefront = useMemo(() => {
    if (!storefront) return null;
    const next: StorefrontParts = { ...storefront };
    delete next.agentListing;
    // flag OFF は既存掲載状態を温存し、隠れた checkbox による opt-out を起こさない。
    // 新規店には selectedAgentListing が無いため、従来 payload のまま完全 inert。
    const shouldList = env.enableShopsApi ? agentListing : selectedAgentListing;
    if (shouldList) next.agentListing = true;
    return next;
  }, [agentListing, selectedAgentListing, storefront]);
  const receiverWillChange =
    !!receiver &&
    !!selectedHandle &&
    receiver.toLowerCase() !== selectedHandle.config.to.toLowerCase();
  // currentParts が公開可能なときだけ、API と同じ正規化を通した storefront + 既存警告と
  // 同条件の受取先差分を dirty とみなす。未公開 handle には比較 baseline が無いので付けない。
  const hasUnpublishedChanges = useMemo(
    () =>
      publishedStorefront !== null &&
      !!selectedHandle?.storefront &&
      (!storefrontPartsEquivalent(publishedStorefront, selectedHandle.storefront) ||
        receiverWillChange),
    [publishedStorefront, receiverWillChange, selectedHandle?.storefront],
  );
  const statusNow = Date.now();
  const relativePublishedAt = formatPublishedRelativeTime(
    selectedHandle?.updatedAt,
    locale,
    statusNow,
  );
  const relativePublishedLabel =
    relativePublishedAt &&
    typeof selectedHandle?.updatedAt === 'number' &&
    Math.abs(statusNow - selectedHandle.updatedAt) < 60_000
      ? t('publishStatusJustNow')
      : relativePublishedAt?.label;

  // 戻ってきた店主: この端末がまだ手付かずなら、公開中の店 (1 つだけのとき) を確認なしで読み込む。
  // セッションごとに 1 回だけ試す (12s の再取得や下書きの変化で何度も走らせない)。2 つ以上公開している
  // ときはどれを読むか店主が選ぶ (従来どおり「編集」から)。
  const autoLoadTried = useRef<string | null>(null);
  const [autoLoaded, setAutoLoaded] = useState(false);
  // 「読み込みました」は読み込んだ直後の確認。下書きに手を入れたら消す (状態カードを @handle と公開状態だけに戻す)。
  useEffect(() => {
    if (autoLoaded && hasUnpublishedChanges) setAutoLoaded(false);
  }, [autoLoaded, hasUnpublishedChanges]);
  useEffect(() => {
    // isSignedIn = セッションと接続中のウォレットが一致 (別のウォレットのセッション・キャッシュから読み込まない)。
    if (!canAutoLoad || !onLoadStorefront || !isSignedIn || !sessionAddress || !mine.isSuccess) return;
    if (autoLoadTried.current === sessionAddress) return;
    autoLoadTried.current = sessionAddress;
    const live = handles.filter((hh) => hh.storefront);
    if (live.length !== 1 || !live[0].storefront) return;
    setSelected(live[0].handle);
    onLoadStorefront(live[0].storefront, live[0].config.to);
    setAutoLoaded(true);
  }, [canAutoLoad, onLoadStorefront, isSignedIn, sessionAddress, mine.isSuccess, handles]);

  const publish = useMutation({
    mutationFn: async () => {
      if (!selectedHandle || !publishedStorefront) throw new Error('not_ready');
      // 受取先の権威化: ビルダーの受取先 (receiver) が有効かつ現 @handle の受取先 (config.to) と
      // 異なれば config.to を上書きして送る (= ビルダーで変更 → 公開更新でそのまま反映)。無効/空/同一
      // なら既存 config をそのまま維持し config.to を消さない。config は @handle 共通の単一受取
      // アドレスなので、この更新はチップ等を含む @handle 全体に及ぶ (UI で明示)。API 側で再検証。
      const nextConfig: HandleTipConfig =
        receiver &&
        receiver.toLowerCase() !== selectedHandle.config.to.toLowerCase()
          ? { ...selectedHandle.config, to: receiver }
          : selectedHandle.config;
      const { ok, status, json } = await fetchJson('/api/handle', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          handle: selectedHandle.handle,
          config: nextConfig,
          storefront: publishedStorefront,
          expectedUpdatedAt: selectedHandle.updatedAt,
        }),
      });
      if (!ok) throw new Error(typeof json.error === 'string' ? json.error : `http_${status}`);
      return {
        json,
        publishedHandle: selectedHandle.handle,
        publishedConfig: nextConfig,
        publishedStorefront,
      };
    },
    onSuccess: ({ json, publishedHandle, publishedConfig, publishedStorefront }) => {
      // POST が返した server timestamp と、実際に送った snapshot を同一 cache へ即反映する。
      // invalidate 後の GET でも同じ record に収束し、送信中に下書きを変えた場合は dirty が残る。
      const updatedAt = typeof json.updatedAt === 'number' ? json.updatedAt : undefined;
      qc.setQueryData<MineResponse>(myHandlesQueryKey(sessionAddress), (current) =>
        current
          ? {
              ...current,
              handles: current.handles.map((handle) =>
                handle.handle === publishedHandle
                  ? {
                      ...handle,
                      config: publishedConfig,
                      storefront: publishedStorefront,
                      updatedAt: updatedAt ?? handle.updatedAt,
                    }
                  : handle,
              ),
            }
          : current,
      );
      qc.invalidateQueries({ queryKey: MY_HANDLES_ROOT_KEY });
    },
  });

  if (!env.enableHandles) return null;

  const shopUrl = origin && effectiveSelected ? `${origin}/@${effectiveSelected}` : '';

  // 卓上プラカード (印刷用 QR) の表示情報。公開ページ (handleStorefrontConfig) と同じ優先順で
  // 解決する: builder 由来の storefront → 公開済み storefront → @handle config 名 → @handle。
  // チェーンは表示ラベル (Polygon/Kaia…) へ変換。受取先・着金は @handle 側が権威 (ここは表示専用)。
  const placardParts = storefront ?? selectedHandle?.storefront ?? null;
  const placardShopName =
    placardParts?.shopName?.trim() ||
    selectedHandle?.config?.name?.trim() ||
    (effectiveSelected ? `@${effectiveSelected}` : '');
  const placardChains = (
    placardParts?.chains ?? (placardParts?.chain ? [placardParts.chain] : [])
  ).map((c) => ({ slug: c, label: JPYC_CHAIN_LABEL[c] }));

  // 公開中の受付状態 (未設定は受付中)。下書きの切替が公開中と違うときだけ「公開を更新で反映」を出す。
  const publishedAccepting = selectedHandle?.storefront
    ? selectedHandle.storefront.acceptingOrders !== false
    : null;
  const canPublish =
    isSignedIn && !!storefront && !!selectedHandle && !publish.isPending && !blockedReason;
  const publishLabel = publish.isPending
    ? t('publishing')
    : selectedHandle?.storefront
      ? t('publishUpdateButton')
      : t('publishButton');
  // スマホの下部バー: 押せない理由を 1 行 (サインイン / @handle / メニュー)、押せるときは状態。
  const barReason = !isSignedIn
    ? t('barReasonSignIn')
    : mine.isLoading
      ? t('publishLoading')
      : mine.isError
        ? t('publishLoadError')
        : handles.length === 0
          ? t('barReasonNoHandle')
          : !storefront
            ? t('barReasonNoMenu')
            : (blockedReason ?? null);
  const barStatus = hasUnpublishedChanges
    ? t('publishStatusUnpublishedChanges')
    : selectedHandle?.storefront
      ? `${t('publishStatusLive')}${relativePublishedLabel ? ` · ${relativePublishedLabel}` : ''}`
      : t('publishStatusUnpublished');

  return (
    <>
      <section
        aria-labelledby="storefront-status-heading"
        className="rounded-2xl bg-white shadow-card ring-1 ring-slate-200/70"
      >
        <div className="px-5 py-4">
          <h2 id="storefront-status-heading" className="text-sm font-semibold text-slate-700">
            {t('statusHeading')}
          </h2>
          {!isSignedIn ? (
            <>
              <p className="mt-1 text-sm text-slate-500">{t('publishIntro')}</p>
              <SignInGate className="mt-3" statement={t('publishSignInStatement')} cta={t('publishSignIn')} />
            </>
          ) : mine.isLoading ? (
            <p className="mt-2 text-sm text-slate-500">{t('publishLoading')}</p>
          ) : mine.isError ? (
            <p className="mt-2 text-sm text-red-600">{t('publishLoadError')}</p>
          ) : handles.length === 0 ? (
            <>
              <p className="mt-1 text-sm text-slate-600">{t('publishNoHandle')}</p>
              {onGetHandle && (
                <button
                  type="button"
                  onClick={onGetHandle}
                  className="mt-3 inline-flex items-center justify-center rounded-xl bg-brand px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-dark"
                >
                  {t('publishGetHandle')}
                </button>
              )}
            </>
          ) : (
            <>
              <div className="mt-1 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
                {handles.length > 1 ? (
                  <select
                    value={effectiveSelected}
                    onChange={(e) => setSelected(e.target.value)}
                    aria-label={t('publishSelectHandle')}
                    className="min-w-0 max-w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold"
                  >
                    {handles.map((h) => (
                      <option key={h.handle} value={h.handle}>
                        @{h.handle}
                        {h.storefront ? ` ${t('publishAlready')}` : ''}
                      </option>
                    ))}
                  </select>
                ) : (
                  <p className="min-w-0 truncate text-lg font-bold text-slate-900">@{handles[0].handle}</p>
                )}
                <div
                  data-testid="storefront-publish-status"
                  className="flex flex-wrap items-center gap-2"
                >
                  {selectedHandle?.storefront ? (
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-800 ring-1 ring-emerald-200">
                      <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                      <span>{t('publishStatusLive')}</span>
                      <span aria-hidden>·</span>
                      {relativePublishedAt && relativePublishedLabel ? (
                        <time dateTime={relativePublishedAt.dateTime}>{relativePublishedLabel}</time>
                      ) : (
                        <span>{t('publishStatusUpdatedUnknown')}</span>
                      )}
                    </span>
                  ) : (
                    <span className="inline-flex items-center rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-600 ring-1 ring-slate-200">
                      {t('publishStatusUnpublished')}
                    </span>
                  )}
                  {hasUnpublishedChanges && (
                    <span className="inline-flex items-center rounded-full bg-amber-100 px-2.5 py-1 text-xs font-semibold text-amber-800 ring-1 ring-amber-200">
                      {t('publishStatusUnpublishedChanges')}
                    </span>
                  )}
                </div>
              </div>
              {/* 公開済み (今 publish した or 既に storefront あり) なら固定店舗 URL を常に提示
                  (コピー/開く/QR)。@handle が唯一の共有導線なので、再公開せずとも取り出せるように。 */}
              {(publish.isSuccess || selectedHandle?.storefront) && shopUrl && (
                <div className="mt-2">
                  {publish.isSuccess ? (
                    <p className="text-sm font-semibold text-emerald-700">{t('published')}</p>
                  ) : null}
                  <p className="break-all text-xs text-slate-500">{shopUrl}</p>
                  <div className="mt-1.5 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => void linkCopy.copy(shopUrl)}
                      className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:border-brand hover:text-brand-dark"
                    >
                      {linkCopy.copied ? t('copied') : t('copy')}
                    </button>
                    <a
                      href={shopUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:border-brand hover:text-brand-dark"
                    >
                      {t('openShop')}
                    </a>
                    <button
                      type="button"
                      onClick={() => setShowQr(true)}
                      className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:border-brand hover:text-brand-dark"
                    >
                      {t('showQr')}
                    </button>
                  </div>
                </div>
              )}
              {autoLoaded && !publish.isSuccess ? (
                <p className="mt-2 text-xs text-emerald-700">{t('autoLoaded')}</p>
              ) : null}
            </>
          )}
        </div>

        {/* 注文の受付 (開店=受付中 / 閉店=停止中)。停止中は公開ページの支払いを止める (不可逆決済の事故防止)。
            下書きの値なので、公開中と違うときだけ「公開を更新で反映」を出す。 */}
        {/* サインインして公開先の @handle が決まってから出す (それまでは押しても公開で反映できない下書きの値)。 */}
        {onToggleAccepting && accepting !== undefined && isSignedIn && !mine.isLoading && !mine.isError && selectedHandle && (
          <div className="border-t border-slate-100 px-5 py-3">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p id="storefront-accepting-label" className="text-sm font-medium text-slate-700">{t('acceptingLabel')}</p>
                <p className="mt-0.5 text-xs text-slate-500">{t('acceptingHint')}</p>
              </div>
              {/* 名前は「注文の受付 受付中」(見えている文字を含める・掟 8)。 */}
              <button
                type="button"
                role="switch"
                aria-checked={accepting}
                aria-labelledby="storefront-accepting-label storefront-accepting-state"
                onClick={onToggleAccepting}
                className={`shrink-0 rounded-full px-4 py-1.5 text-sm font-semibold transition ${
                  accepting ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-200 text-slate-500'
                }`}
              >
                <span id="storefront-accepting-state">{accepting ? t('acceptingOn') : t('acceptingOff')}</span>
              </button>
            </div>
            {publishedAccepting !== null && publishedAccepting !== accepting ? (
              <p className="mt-1.5 text-xs font-medium text-amber-700">{t('acceptingApplyNote')}</p>
            ) : null}
          </div>
        )}

        {isSignedIn && !mine.isLoading && !mine.isError && selectedHandle && (
          <div className="space-y-2 border-t border-slate-100 px-5 py-4">
            {/* 受取先は @handle 共通 (config.to)。公開更新でビルダーの受取先に同期する旨を明示し、
                現受取先と異なるときは「X→Y に更新」を目立たせる (誤送金トラップの回避)。 */}
            {receiverWillChange && receiver ? (
              <p className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                {t('publishReceiverWillChange', {
                  from: shortAddress(selectedHandle.config.to),
                  to: shortAddress(receiver),
                })}
              </p>
            ) : null}
            {env.enableShopsApi && (
              <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                <label className="flex items-start gap-2 text-sm font-medium text-slate-700">
                  <input
                    type="checkbox"
                    checked={agentListing}
                    onChange={(event) => {
                      const checked = event.target.checked;
                      setAgentListingOverrides((current) => ({
                        ...current,
                        [effectiveSelected]: checked,
                      }));
                    }}
                    className="mt-0.5"
                  />
                  <span>{t('agentListingLabel')}</span>
                </label>
                {/* 同意の詳細 (提供項目/解除方法) は折りたたみに格納する。常時展開だと右カラムが
                    縦長になり、サイド列とプレビューのスクロールバーが並走して見づらい (実報告)。
                    法的文言は一字不変で DOM に常在させる (フェンステストあり)。 */}
                <details className="mt-1 group">
                  <summary className="cursor-pointer list-none text-[11px] font-medium text-slate-500 hover:text-slate-700 [&::-webkit-details-marker]:hidden">
                    <span className="underline decoration-dotted underline-offset-2">
                      {t('agentListingConsentToggle')}
                    </span>
                  </summary>
                  <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
                    {t('agentListingConsent')}
                  </p>
                </details>
              </div>
            )}
            {/* 別端末で編集した内容を捨てて公開中に戻す (下書きが公開中と違う・この端末のメニューが空のとき)。
                破壊的なので確認を挟む。 */}
            {selectedHandle.storefront &&
              onLoadStorefront &&
              (hasUnpublishedChanges || !storefront) &&
              (confirmLoad ? (
                <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  <p>{t('editLoadConfirm')}</p>
                  <div className="mt-1 flex gap-3">
                    <button
                      type="button"
                      onClick={() => {
                        if (!selectedHandle?.storefront) return;
                        onLoadStorefront(selectedHandle.storefront, selectedHandle.config.to);
                        setConfirmLoad(false);
                      }}
                      className="font-semibold text-amber-900 hover:underline"
                    >
                      {t('editLoadConfirmYes')}
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmLoad(false)}
                      className="text-amber-700 hover:underline"
                    >
                      {t('editLoadCancel')}
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmLoad(true)}
                  className="text-xs font-medium text-slate-500 underline underline-offset-2 hover:text-slate-700"
                >
                  {t('editLoadButton')}
                </button>
              ))}
            {/* 公開ボタンは帯 (スマホは画面下・PC はプレビューの下) から押す (同じ処理)。 */}
            {!storefront && <p className="text-xs text-amber-700">{t('publishNeedMenu')}</p>}
            {publish.isError && <p className="text-xs text-red-600">{t('publishError')}</p>}
          </div>
        )}
      </section>

      {/* スマホの下部バー: いちばん大事な「公開」を編集中いつでも押せるように (決済QR・レジの会計バーと同じ
          見た目・同じ公開処理)。常に出し、押せないときは理由を 1 行。 */}
      {barSlots.map((slot, i) =>
        slot ? (
          <span key={i} hidden>
            {createPortal(
            <div className="flex items-center gap-3">
              <div className="min-w-0 flex-1">
                {blockedReason ? (
                  // 下書きに直すところ (値引きが範囲外など) があるときは、前の公開の失敗より先にそれを出す
                  // (押せない理由が見えないまま古いエラーだけが残らないように)。
                  <p className="truncate text-sm font-medium text-slate-500">{barReason ?? blockedReason}</p>
                ) : publish.isError && !publish.isPending ? (
                  // 帯から押して失敗したとき、画面の上のカードの文言だけでは気づけないので帯にも出す。
                  <p role="alert" className="line-clamp-2 text-sm font-medium text-red-600">{t('publishError')}</p>
                ) : barReason ? (
                  <p className="truncate text-sm font-medium text-slate-500">{barReason}</p>
                ) : receiverWillChange && receiver && selectedHandle ? (
                  // 受取先が変わる公開は、押す場所 (帯) で気づけるように。全文の注意は状態カードにも出す。
                  <>
                    <p className="truncate text-[11px] font-semibold text-amber-700">{t('barReceiverWillChange')}</p>
                    <p className="truncate font-mono text-xs text-amber-900">
                      {shortAddress(selectedHandle.config.to)} → {shortAddress(receiver)}
                    </p>
                  </>
                ) : (
                  <>
                    <p className="truncate text-[11px] text-slate-500">@{effectiveSelected}</p>
                    <p className="truncate text-sm font-semibold text-slate-900">{barStatus}</p>
                  </>
                )}
              </div>
              <button
                type="button"
                disabled={!canPublish}
                onClick={() => publish.mutate()}
                className="inline-flex shrink-0 items-center justify-center rounded-xl bg-brand px-5 py-3 text-base font-bold text-white transition-transform hover:bg-brand-dark active:scale-[0.98] disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400"
              >
                {publishLabel}
              </button>
            </div>,
            slot,
            )}
          </span>
        ) : null,
      )}

      <MobileOrderPlacardModal
        open={showQr && shopUrl !== ''}
        onClose={() => setShowQr(false)}
        url={shopUrl}
        shopName={placardShopName}
        tagline={placardParts?.tagline}
        avatar={placardParts?.avatar ?? selectedHandle?.profile?.avatar}
        chains={placardChains}
        copied={linkCopy.copied}
        onCopy={() => void linkCopy.copy(shopUrl)}
        labels={{
          dialogTitle: t('placardTitle'),
          eyebrow: t('placardEyebrow'),
          subtitle: t('placardSubtitle'),
          scanNote: t('placardScan'),
          payNote: t('placardPay'),
          chainsLabel: t('placardChains'),
          print: t('placardPrint'),
          copy: t('copy'),
          copied: t('copied'),
          close: t('qrClose'),
        }}
      />
    </>
  );
}
