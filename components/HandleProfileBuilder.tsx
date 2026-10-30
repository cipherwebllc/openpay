'use client';

// 「プロフ」タブ: @handle の link-in-bio ページを組み立てるビルダー。受取先 + 受取方法
// (JPYC Polygon / JPYC Kaia) + 見た目 (名前/色/金額プリセット) + プロフィール
// (bio/avatar/SNSアイコン/links) を編集し、SIWE で取得/更新 (HandleClaimPanel)。
// USDC は Base か Arc のどちらか 1 つを選ぶ (2026-08-17 Base 復活・2026-09-17 Arc 追加+排他化:
// 両方公開すると公開ページに同種の受取ボタンが 2 つ並ぶため)。旧レコードで両方持つ場合は
// 明示通知して選び直させる (黙って落とさない)。
// レイアウトは他タブ (チップ/レジ) と同じ 2 カラム: 左=編集・右=ライブプレビュー+公開
// (lg で sticky 追従)。下書きは useHandleProfileDraft (localStorage・チップタブとは分離)。
// flag OFF で何も描画しない。
// 状態 (下書き・編集中の handle・公開の基準・シートの開閉・公開ボタンの帯の置き場・並べ替え) はすべてここが持ち、
// 各節の描画は components/handle-profile-builder/* に分けている (各節は props で受け取って描画と操作の中継だけを行う)。

import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { AtSign } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useAccount } from 'wagmi';
import { getAddress, isAddress, type Address } from 'viem';
import { env, isArcTipEnabled } from '@/lib/env';
import { resolveTipCapability } from '@/lib/url/tip';
import { HandleClaimPanel } from '@/components/HandleClaimPanel';
import { LinkQrModal } from '@/components/LinkQrModal';
import { SectionCard } from '@/components/SectionCard';
import { needsChainDisambiguation } from '@/components/ReceiveMethodPicker';
import {
  useHandleProfileDraft,
  DEFAULT_PROFILE_DRAFT,
  isPristineProfileDraft,
  sameProfileDraft,
} from '@/hooks/useHandleProfileDraft';
import {
  handlePreviewBackground,
} from '@/lib/handleTheme';
import { useOrigin } from '@/hooks/useOrigin';
import { getPublicHandleUrl } from '@/lib/publicHandleUrl';
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard';
import { useResolveAddress } from '@/hooks/useResolveAddress';
import { isLikelyName } from '@/lib/nameDetection';
import { useDragReorderList } from '@/hooks/useDragReorderList';
import { COLOR_PATTERN, sanitizeUrl } from '@/lib/url';
import type { HandleTipConfig, HandleProfile } from '@/lib/handle';
import {
  buildPublishMethods,
  buildPublishPayload,
  buildPublishProfile,
  EMPTY_HANDLE_PUBLISH_BASELINE,
  formatPublishedRelativeTime,
  handlePublishBaselineReducer,
  hasDroppedProfileUrl,
  hasUnpublishedHandleChanges,
  type PublishedHandleSnapshot,
} from '@/lib/handlePublish';
import { draftFromPublished } from './handle-profile-builder/draft';
import { HandleMiniPreview } from './handle-profile-builder/MiniPreview';
import { PreviewSection } from './handle-profile-builder/PreviewSection';
import { ProfileSection } from './handle-profile-builder/ProfileSection';
import { PublishedStatus } from './handle-profile-builder/PublishedStatus';
import { ReceiveSection, ReceiveSettingsSheet } from './handle-profile-builder/ReceiveSection';

export function HandleProfileBuilder({
  onPublishedHandleChange,
}: {
  onPublishedHandleChange?: (handle: string | null) => void;
}) {
  const t = useTranslations('HandleProfile');
  const tb = useTranslations('HandleProfileBuilder');
  const tc = useTranslations('HandleClaim');
  const locale = useLocale();
  const { settings: draft, setSettings, hydrated } = useHandleProfileDraft();
  const { address: connected } = useAccount();
  const origin = useOrigin();
  const linkCopy = useCopyToClipboard();
  // ④ プレビュー下の QR モーダル開閉 (編集中 handle のフル URL を提示)。
  const [showQr, setShowQr] = useState(false);
  // どの @handle を編集中か (null = 新規作成)。「編集」でフォームが黙って書き換わるのが
  // 混乱源だったため、ヘッダのバッジ + パネルのバナーで対象を常時明示する。
  const [editingHandle, setEditingHandleState] = useState<string | null>(null);
  // 同じ値を ref にも持つ。自動で編集に入るときは子 (HandleClaimPanel) の effect が先に onEdit を呼び、同じ描画の
  // 親の effect は古い editingHandle (null) を見てしまう。受取先の自動補完と入力欄の切り替えはこの ref を実行時に
  // 読み、読み込んだ公開中の受取先を接続中のウォレットで上書きしない (公開中の着金先が黙って変わる事故を断つ)。
  const editingRef = useRef<string | null>(null);
  const setEditingHandle = (handle: string | null) => {
    editingRef.current = handle;
    setEditingHandleState(handle);
  };
  // 編集に入る直前の下書き (未公開の新規入力)。編集をやめたら丸ごと復元し、確認なしの
  // 上書きで作業が消えるのを防ぐ。新規作成モード (editingHandle===null) の間だけ撮る。
  const preEditDraftRef = useRef<typeof draft | null>(null);
  const headingRef = useRef<HTMLDivElement>(null);
  const [publishBaseline, dispatchPublishBaseline] = useReducer(
    handlePublishBaselineReducer,
    EMPTY_HANDLE_PUBLISH_BASELINE,
  );

  useEffect(() => {
    // 接続 wallet が変わった後に旧 owner の handle を商品共有へ渡し続ける波及を断つ。
    // 新 wallet で公開済み handle を明示選択 / 公開するまでは共有導線を隠す。
    onPublishedHandleChange?.(null);
  }, [connected, onPublishedHandleChange]);

  // SNS / リンクのドラッグ並べ替え (HTML5 DnD)。list ごとに 1 インスタンス — 各々が独自の
  // dragIndex を持つため drag はそのリスト内へ自然にスコープされる (別リストへは落とせない)。
  const socialsReorder = useDragReorderList(draft.socials, (socials) =>
    setSettings((s) => ({ ...s, socials })),
  );
  const linksReorder = useDragReorderList(draft.links, (links) =>
    setSettings((s) => ({ ...s, links })),
  );

  const colorValid = COLOR_PATTERN.test(draft.color);

  const methods = useMemo(
    () => buildPublishMethods(draft, {
      enableJpycAvalanche: env.enableJpycAvalanche,
      arcTip: isArcTipEnabled(),
    }),
    [draft],
  );

  // 受取先: 生 0x アドレスは**入力値を最優先**で採用する (前に解決した別のアドレスで上書きしない・誤送金防止)。
  // ENS 名のときは、受け取りの設定シート (その中の AddressInput) を開いていなくても名前を解決しておき、この解決結果
  // だけを使う (シートの AddressInput も同じ query を見る)。シートから受け取った解決値を別に持つと、閉じた後の
  // 再解決が届かず古いアドレスのまま公開される (着金先のずれ)。
  const toName = draft.to.trim();
  const ens = useResolveAddress(isLikelyName(toName) ? toName : '');
  const effectiveReceiver = useMemo<Address | null>(() => {
    const raw = draft.to.trim();
    if (isAddress(raw)) return getAddress(raw);
    // 再解決に失敗しても react-query は前回の解決結果を残すので、失敗中は使わない (古い着金先で公開しない)。
    return ens.error ? null : ens.data?.address ?? null;
  }, [draft.to, ens.data, ens.error]);

  // publish 送信と dirty 比較の単一情報源。旧 Builder のインライン trim/filter は
  // lib/handlePublish.ts へ移し、request body の形とキー順を保っている。
  const publishPayload = useMemo(
    () =>
      buildPublishPayload(draft, {
        receiver: effectiveReceiver,
        enableJpycAvalanche: env.enableJpycAvalanche,
        arcTip: isArcTipEnabled(),
      }),
    [draft, effectiveReceiver],
  );
  const config = publishPayload?.config ?? null;
  // 受取先が未確定でも profile preview は描画するため、profile だけは同じ canonical helper で作る。
  const profile = useMemo(() => buildPublishProfile(draft), [draft]);
  const hasInsecure = useMemo(() => hasDroppedProfileUrl(draft), [draft]);
  // 不正 URL が server で省略扱いになり旧値を保持するため、保存成功の誤表示へ波及させない。
  const invalidThanksUrl = !!draft.thanksUrl?.trim() && !sanitizeUrl(draft.thanksUrl);
  const callbackUrlError = invalidThanksUrl ? tb('callbackUrlInvalid') : undefined;
  const isDirty = hasUnpublishedHandleChanges(
    publishBaseline,
    editingHandle,
    publishPayload,
  );
  const activeBaseline =
    publishBaseline.baseline?.handle === editingHandle
      ? publishBaseline.baseline
      : null;
  const relativeUpdatedAt = formatPublishedRelativeTime(
    activeBaseline?.updatedAt,
    locale,
  );

  const inactivePublishedArc = !isArcTipEnabled() &&
    !!activeBaseline?.payload.config.methods.some((m) => m.chain === 'arc');
  const capableMethods = methods.filter((m) => resolveTipCapability(m.token, m.chain).ok);
  const previewWithChain = needsChainDisambiguation(capableMethods);

  // 受け取り (受取先・受け取る方法) の設定シートと、公開ボタンの帯を描く場所 (スマホの下部バー・PC のプレビュー下)。
  const [receiveOpen, setReceiveOpen] = useState(false);
  const [mobileBarSlot, setMobileBarSlot] = useState<HTMLDivElement | null>(null);
  const [desktopBarSlot, setDesktopBarSlot] = useState<HTMLDivElement | null>(null);

  // 受取先が空なら接続中のウォレットで 1 回だけ埋める (user 裁定 A)。ウォレットを切り替えても追いかけない
  // (公開中の @handle の着金先が黙って変わる事故を防ぐ)・編集中は触らない・消した人には入れ直さない。
  // 一度でも受取先が入っていたら (保存済み・手入力・公開中の読み込み) 自分で決めた人なので、以後は埋めない。
  const autoFilledTo = useRef(false);
  useEffect(() => {
    if (autoFilledTo.current || !hydrated) return;
    // 編集中に読み込んだ公開中の受取先も「入っていた」に数える (編集をやめて空の下書きに戻っても埋めない)。
    if (draft.to.trim() !== '') {
      autoFilledTo.current = true;
      return;
    }
    if (editingRef.current !== null || !connected || !isAddress(connected)) return;
    autoFilledTo.current = true;
    setSettings((s) => ({ ...s, to: connected }));
  }, [hydrated, editingHandle, draft.to, connected, setSettings]);

  // 受取先が未設定のときは、公開に欠かせないので受け取りカードの中に入力欄を直接出す (決済QR と同じ型)。読み込み後に
  // 未設定だったら出し、入力の途中で消さない (シートで受取先を決めて閉じたら要約に戻す)。シートを開いている間は
  // 切り替えない (シートの入力欄を空にした瞬間に欄が裏へ移り、focus を失って打ち直せなくなるため)。
  const [receiverInline, setReceiverInline] = useState(false);
  useEffect(() => {
    if (hydrated && !receiveOpen && draft.to.trim() === '' && editingRef.current === null) setReceiverInline(true);
  }, [hydrated, receiveOpen, draft.to, editingHandle]);

  // 戻ってきた人: 持っている @handle (1 つだけのとき) の編集に自動で入ってよいか。この端末の下書きがまだ既定のまま
  // か、公開中の内容から組み直した下書きとすべての項目で同じ (前に編集へ入った後の再読み込み・タブを戻ったとき)
  // なら、入っても失うものが無い。公開に載らない入力途中の値 (空の URL のリンク行・ENS 名の受取先) も比べるので、
  // それが残っている下書きでは入らない (受取先の解決を待たずに決まる)。
  const canAutoEdit = hydrated && editingHandle === null
    ? (c: HandleTipConfig, p?: HandleProfile) =>
      isPristineProfileDraft(draft, connected) || sameProfileDraft(draftFromPublished(c, p), draft)
    : undefined;

  if (!env.enableHandles) return null;

  const update = (patch: Partial<typeof draft>) =>
    setSettings((s) => ({ ...s, ...patch }));

  // テーマピッカーのミニプレビュー用アクセント (無効色は既定ブルー)。
  const pickerAccent = colorValid ? draft.color : '#2563eb';
  // ライブプレビューカードの地色 (clean は undefined = 従来の白)。night は暗背景。
  const previewBg = handlePreviewBackground(pickerAccent, draft.theme);
  const previewDark = draft.theme === 'night';

  const onUseConnected = () => {
    if (connected && isAddress(connected)) {
      update({ to: connected });
    }
  };

  // 編集をやめて新規作成へ。編集前の下書きがあれば復元 (作業を消さない)。スナップショットが
  // 無い (= 直接新規作成中に呼ばれた等) ときだけ既定へ (受取先は使い回せるので保持)。
  const onStopEditing = () => {
    setEditingHandle(null);
    onPublishedHandleChange?.(null);
    dispatchPublishBaseline({ type: 'discarded' });
    const snapshot = preEditDraftRef.current;
    preEditDraftRef.current = null;
    if (snapshot) {
      setSettings(() => snapshot);
    } else {
      setSettings((s) => ({ ...DEFAULT_PROFILE_DRAFT, to: s.to }));
    }
  };

  const onEditExisting = (
    handle: string,
    c: HandleTipConfig,
    p?: HandleProfile,
    updatedAt?: number,
  ) => {
    // 新規作成モードから編集に入る初回のみ、現在の下書きを退避 (編集→別編集の連続では
    // 退避済みの「編集前」を保ったまま上書きしない)。
    if (editingHandle === null) preEditDraftRef.current = draft;
    setEditingHandle(handle);
    onPublishedHandleChange?.(handle);
    // パネル (右カラム/モバイルは下部) から押すとフォームの書き換わりが見えないため、
    // フォーム先頭へスクロールして「いま編集している」ことを視覚的に伝える。
    headingRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    const loadedReceiver = isAddress(c.to) ? getAddress(c.to) : null;
    // 公開中の受取先を読み込んだので、受け取りのカードは入力欄ではなく要約に戻す。
    if (c.to.trim()) setReceiverInline(false);
    const loadedDraft = draftFromPublished(c, p);
    setSettings(() => loadedDraft);
    const loadedPayload = buildPublishPayload(loadedDraft, {
      receiver: loadedReceiver,
      enableJpycAvalanche: env.enableJpycAvalanche,
      arcTip: isArcTipEnabled(),
    });
    if (loadedPayload && typeof updatedAt === 'number') {
      dispatchPublishBaseline({
        type: 'loaded',
        snapshot: { handle, payload: loadedPayload, updatedAt },
      });
    } else {
      dispatchPublishBaseline({ type: 'discarded' });
    }
  };

  // プレビューは受取先が未確定でも常時表示 (config が組めない間は draft から見た目だけ組む)。
  const previewConfig: HandleTipConfig = config ? {
    ...config,
    methods: capableMethods,
    message: config.message ?? undefined,
    thanks: config.thanks ?? undefined,
    thanksUrl: config.thanksUrl ?? undefined,
  } : {
    to: effectiveReceiver ?? '',
    name: draft.name.trim() || undefined,
    color: colorValid ? draft.color : undefined,
    methods: capableMethods,
  };

  const publicHandleUrl = editingHandle
    ? getPublicHandleUrl(origin, editingHandle)
    : '';
  const publishedName = activeBaseline?.payload.config.name;
  const xShareText = editingHandle
    ? publishedName
      ? t('shareTextNamed', { name: publishedName, handle: editingHandle })
      : t('shareTextGeneric', { handle: editingHandle })
    : '';
  const xShareHref =
    editingHandle && publicHandleUrl
      ? `https://twitter.com/intent/tweet?text=${encodeURIComponent(xShareText)}&url=${encodeURIComponent(publicHandleUrl)}`
      : '';

  return (
    <div className="space-y-6">
      {/* 2 カラム: 左 = あなたのページ (取得・公開) / 受け取り / プロフィール (page scroll)、
          右 = プレビュー (lg で sticky 追従・公開ボタンの帯つき)。番号付き手順は使わない (user 裁定 C)。 */}
      <div className="lg:grid lg:grid-cols-[1fr_minmax(300px,360px)] lg:items-start lg:gap-6">
        <div className="min-w-0 space-y-5 lg:[&>section:first-of-type]:mt-0">
          {/* 上のミニプレビューは、この端末で手を入れ始めたか編集中のときだけ (何も触っていない新規の状態で
              ダミーの「@handle」「H」を貼り付けない)。 */}
          {hydrated && (!isPristineProfileDraft(draft, connected) || editingHandle !== null) && (
            <HandleMiniPreview
              draftName={draft.name}
              editingHandle={editingHandle}
              font={draft.font}
              previewBg={previewBg}
              previewDark={previewDark}
              pickerAccent={pickerAccent}
              cover={profile.cover}
              avatar={profile.avatar}
            />
          )}
          {/* あなたのページ: 取得・公開 (取得済みの一覧・編集・削除・新しい @handle)。編集中は公開状態を見出しの下に。 */}
          <div ref={headingRef} className="scroll-mt-4">
            <SectionCard title={t('pageHeading')} headingId="handle-page-heading" icon={AtSign}>
              {editingHandle ? (
                <PublishedStatus
                  handle={editingHandle}
                  relativeUpdatedAt={relativeUpdatedAt}
                  isDirty={isDirty}
                  onStopEditing={onStopEditing}
                />
              ) : null}
              <HandleClaimPanel
                payload={publishPayload}
                publishBlockedReason={inactivePublishedArc ? tb('arcPublishDisabled') : callbackUrlError}
                onEdit={onEditExisting}
                editingHandle={editingHandle}
                expectedUpdatedAt={activeBaseline?.updatedAt}
                isDirty={isDirty}
                onStopEditing={onStopEditing}
                canAutoEdit={canAutoEdit}
                barSlots={[mobileBarSlot, desktopBarSlot]}
                onPublished={(snapshot: PublishedHandleSnapshot) => {
                  setEditingHandle(snapshot.handle);
                  onPublishedHandleChange?.(snapshot.handle);
                  dispatchPublishBaseline({ type: 'published', snapshot });
                }}
              />
            </SectionCard>
          </div>

          {/* 受け取り: 受取先と受け取る方法は一度決めたら変えないので、要約 + 「設定」(シート)。 */}
          <ReceiveSection
            draft={draft}
            update={update}
            connected={connected}
            onUseConnected={onUseConnected}
            effectiveReceiver={effectiveReceiver}
            methods={methods}
            receiverInline={receiverInline}
            receiveOpen={receiveOpen}
            onOpenSettings={() => setReceiveOpen(true)}
          />
          <ReceiveSettingsSheet
            draft={draft}
            update={update}
            connected={connected}
            onUseConnected={onUseConnected}
            methods={methods}
            open={receiveOpen}
            onClose={() => {
              setReceiveOpen(false);
              // シートで受取先を決めたら、受け取りカードの欄は要約に戻す (同じ欄を 2 か所に出さない)。
              if (effectiveReceiver) setReceiverInline(false);
            }}
          />

          {/* プロフィール: 表示名・ひとこと・アバターは常に。見た目・SNS・リンク・高度な設定は任意なので畳む。 */}
          <ProfileSection
            draft={draft}
            update={update}
            colorValid={colorValid}
            pickerAccent={pickerAccent}
            socialsReorder={socialsReorder}
            linksReorder={linksReorder}
            hasInsecure={hasInsecure}
            invalidThanksUrl={invalidThanksUrl}
            callbackUrlError={callbackUrlError}
          />
        </div>

        <PreviewSection
          hydrated={hydrated}
          previewBg={previewBg}
          previewDark={previewDark}
          previewConfig={previewConfig}
          profile={profile}
          usdcArc={draft.usdcArc}
          capableMethods={capableMethods}
          previewWithChain={previewWithChain}
          editingHandle={editingHandle}
          publicHandleUrl={publicHandleUrl}
          xShareHref={xShareHref}
          linkCopy={linkCopy}
          onShowQr={() => setShowQr(true)}
          desktopBarRef={setDesktopBarSlot}
        />
      </div>

      {/* スマホの公開ボタンの帯 (決済QR・レジの会計バーと同じ見た目・sticky)。 */}
      <div
        ref={setMobileBarSlot}
        className="sticky bottom-14 z-20 -mx-4 border-t border-slate-200/70 bg-white/85 px-4 py-2.5 backdrop-blur-md supports-[backdrop-filter]:bg-white/75 md:bottom-0 lg:hidden print:hidden"
      />

      {/* 編集中 handle のリンク QR (一覧に常時並べると縦長で読みにくいためボタン経由)。 */}
      <LinkQrModal
        open={showQr && editingHandle !== null}
        value={
          editingHandle
            ? origin
              ? `${origin}/@${editingHandle}`
              : `/@${editingHandle}`
            : ''
        }
        title={editingHandle ? `@${editingHandle}` : ''}
        closeLabel={tc('qrClose')}
        onClose={() => setShowQr(false)}
      />
    </div>
  );
}
