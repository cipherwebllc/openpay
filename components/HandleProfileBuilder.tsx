'use client';

// 「プロフ」タブ: @handle の link-in-bio ページを組み立てるビルダー。受取先 + 受取方法
// (JPYC Polygon / JPYC Kaia) + 見た目 (名前/色/金額プリセット) + プロフィール
// (bio/avatar/SNSアイコン/links) を編集し、SIWE で取得/更新 (HandleClaimPanel)。
// USDC (cross-chain) は着金チェーンを選べず Base 固定になるためビルダーから提供終了 —
// 必要ならチップタブで個別に作成しリンク集へ追加する。既存レコードの usdc method は
// 公開ページでは引き続き描画されるが、ビルダーで更新すると外れる (編集時に明示)。
// レイアウトは他タブ (チップ/レジ) と同じ 2 カラム: 左=編集・右=ライブプレビュー+公開
// (lg で sticky 追従)。下書きは useHandleProfileDraft (localStorage・チップタブとは分離)。
// flag OFF で何も描画しない。

import { useMemo, useReducer, useRef, useState } from 'react';
import { AtSign, Eye, UserRound, Wallet } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useAccount } from 'wagmi';
import { getAddress, isAddress, type Address } from 'viem';
import { env } from '@/lib/env';
import { AddressInput } from '@/components/AddressInput';
import { HandleClaimPanel } from '@/components/HandleClaimPanel';
import { HandleProfileView } from '@/components/HandleProfile';
import { HandleThemePicker } from '@/components/HandleThemePicker';
import { LinkQrModal } from '@/components/LinkQrModal';
import { ReorderableRow } from '@/components/ReorderableRow';
import { SocialIcon } from '@/components/SocialIconLinks';
import { StepCard } from '@/components/StepCard';
import { methodLabel, methodMetaLabel } from '@/components/ReceiveMethodPicker';
import {
  useHandleProfileDraft,
  DEFAULT_PROFILE_DRAFT,
} from '@/hooks/useHandleProfileDraft';
import {
  handlePreviewBackground,
} from '@/lib/handleTheme';
import { useOrigin } from '@/hooks/useOrigin';
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard';
import { useDragReorderList } from '@/hooks/useDragReorderList';
import { COLOR_PATTERN } from '@/lib/url';
import {
  MAX_BIO_LEN,
  MAX_PROFILE_LINKS,
  MAX_SOCIAL_LINKS,
  type HandleReceiveMethod,
  type HandleTipConfig,
  type HandleProfile,
} from '@/lib/handle';
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

function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <label className="block">
      <span className="text-sm font-medium text-slate-700">{label}</span>
      <div className="mt-1">{children}</div>
      {hint && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
    </label>
  );
}

const inputClass =
  'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-brand focus:outline-none';

export function HandleProfileBuilder() {
  const t = useTranslations('HandleProfile');
  const tc = useTranslations('HandleClaim');
  const locale = useLocale();
  const { settings: draft, setSettings, hydrated } = useHandleProfileDraft();
  const { address: connected } = useAccount();
  const origin = useOrigin();
  const linkCopy = useCopyToClipboard();
  const [resolved, setResolved] = useState<Address | null>(null);
  // ④ プレビュー下の QR モーダル開閉 (編集中 handle のフル URL を提示)。
  const [showQr, setShowQr] = useState(false);
  // 編集中レコードが旧 USDC (cross-chain) method を持つか。更新で外れることを明示する。
  const [editedHadUsdc, setEditedHadUsdc] = useState(false);
  // どの @handle を編集中か (null = 新規作成)。「編集」でフォームが黙って書き換わるのが
  // 混乱源だったため、ヘッダのバッジ + パネルのバナーで対象を常時明示する。
  const [editingHandle, setEditingHandle] = useState<string | null>(null);
  // 編集に入る直前の下書き (未公開の新規入力)。編集をやめたら丸ごと復元し、確認なしの
  // 上書きで作業が消えるのを防ぐ。新規作成モード (editingHandle===null) の間だけ撮る。
  const preEditDraftRef = useRef<typeof draft | null>(null);
  const headingRef = useRef<HTMLDivElement>(null);
  const [publishBaseline, dispatchPublishBaseline] = useReducer(
    handlePublishBaselineReducer,
    EMPTY_HANDLE_PUBLISH_BASELINE,
  );
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
    () => buildPublishMethods(draft, env.enableJpycAvalanche),
    [draft],
  );

  // 受取方法トグルの選択肢。Avalanche はチップの JPYC_CHAINS と同思想で
  // env.enableJpycAvalanche=ON のときだけ表示 (既定 OFF=非表示で完全 inert)。実際に受取可能か
  // (forwarder 設定で gasless 成立) は公開ページ/publish 時の parseTipParams が判定する。
  const methodOptions: Array<
    ['jpycPolygon' | 'jpycKaia' | 'jpycAvalanche', HandleReceiveMethod]
  > = [
    ['jpycPolygon', { token: 'jpyc', chain: 'polygon' }],
    ['jpycKaia', { token: 'jpyc', chain: 'kaia' }],
  ];
  if (env.enableJpycAvalanche) {
    methodOptions.push(['jpycAvalanche', { token: 'jpyc', chain: 'avalanche' }]);
  }

  // 受取先: 生 0x アドレスは**入力値を最優先**で採用する。AddressInput は ENS 名以外で
  // onResolved を再発火しないため、「接続ウォレットを使う」/編集 prefill で resolved に入った
  // 旧アドレスが、その後に手入力した別アドレスを上書きしてしまう (誤送金) のを防ぐ。
  // ENS 名 (= isAddress 偽) のときだけ AddressInput が解決した resolved を使う。
  const effectiveReceiver = useMemo<Address | null>(() => {
    const raw = draft.to.trim();
    if (isAddress(raw)) return getAddress(raw);
    return resolved;
  }, [draft.to, resolved]);

  // publish 送信と dirty 比較の単一情報源。旧 Builder のインライン trim/filter は
  // lib/handlePublish.ts へ移し、request body の形とキー順を保っている。
  const publishPayload = useMemo(
    () =>
      buildPublishPayload(draft, {
        receiver: effectiveReceiver,
        enableJpycAvalanche: env.enableJpycAvalanche,
      }),
    [draft, effectiveReceiver],
  );
  const config = publishPayload?.config ?? null;
  // 受取先が未確定でも profile preview は描画するため、profile だけは同じ canonical helper で作る。
  const profile = useMemo(() => buildPublishProfile(draft), [draft]);
  const hasInsecure = useMemo(() => hasDroppedProfileUrl(draft), [draft]);
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

  if (!env.enableHandles) return null;

  const update = (patch: Partial<typeof draft>) =>
    setSettings((s) => ({ ...s, ...patch }));

  // 「注目」は最大 1 本。ある行を ON にしたら他行は自動 OFF (単一 enforce)。同じ行の再クリックで OFF。
  const setFeatured = (index: number, on: boolean) =>
    update({
      links: draft.links.map((l, j) => ({ ...l, featured: on && j === index })),
    });

  // テーマピッカーのミニプレビュー用アクセント (無効色は既定ブルー)。
  const pickerAccent = colorValid ? draft.color : '#2563eb';
  // ライブプレビューカードの地色 (clean は undefined = 従来の白)。night は暗背景。
  const previewBg = handlePreviewBackground(pickerAccent, draft.theme);
  const previewDark = draft.theme === 'night';

  // 並べ替えハンドル/▲▼ の i18n ラベル (socials/links 共通・既存キーを流用)。
  const reorderLabels = {
    dragToReorder: t('dragToReorder'),
    moveUp: t('moveUp'),
    moveDown: t('moveDown'),
  };

  const onUseConnected = () => {
    if (connected && isAddress(connected)) {
      update({ to: connected });
      setResolved(getAddress(connected));
    }
  };

  // 編集をやめて新規作成へ。編集前の下書きがあれば復元 (作業を消さない)。スナップショットが
  // 無い (= 直接新規作成中に呼ばれた等) ときだけ既定へ (受取先は使い回せるので保持)。
  const onStopEditing = () => {
    setEditingHandle(null);
    setEditedHadUsdc(false);
    dispatchPublishBaseline({ type: 'discarded' });
    const snapshot = preEditDraftRef.current;
    preEditDraftRef.current = null;
    if (snapshot) {
      setResolved(isAddress(snapshot.to) ? getAddress(snapshot.to) : null);
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
    // パネル (右カラム/モバイルは下部) から押すとフォームの書き換わりが見えないため、
    // フォーム先頭へスクロールして「いま編集している」ことを視覚的に伝える。
    headingRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    const loadedReceiver = isAddress(c.to) ? getAddress(c.to) : null;
    setResolved(loadedReceiver);
    // 旧レコードの USDC method はビルダーで編集できない → 更新で外れることを明示する。
    setEditedHadUsdc(c.methods.some((m) => m.token === 'usdc'));
    // 編集対象レコードに無いフィールドは「前の下書き値」(s.*) ではなく **builder 既定**へ戻す。
    // でないと別プロフィールの色/プリセットが update 時にこの handle へ混入する。
    const loadedDraft: typeof draft = {
      ...draft,
      to: c.to,
      name: c.name ?? '',
      color:
        c.color && COLOR_PATTERN.test(c.color)
          ? c.color
          : DEFAULT_PROFILE_DRAFT.color,
      jpycPolygon: c.methods.some((m) => m.token === 'jpyc' && m.chain === 'polygon'),
      jpycKaia: c.methods.some((m) => m.token === 'jpyc' && m.chain === 'kaia'),
      jpycAvalanche: c.methods.some(
        (m) => m.token === 'jpyc' && m.chain === 'avalanche',
      ),
      presetsJpyc: c.presets?.jpyc ?? DEFAULT_PROFILE_DRAFT.presetsJpyc,
      bio: p?.bio ?? '',
      avatar: p?.avatar ?? '',
      socials: p?.socials ?? [],
      links: p?.links ?? [],
      theme: p?.theme ?? DEFAULT_PROFILE_DRAFT.theme,
    };
    setSettings(() => loadedDraft);
    const loadedPayload = buildPublishPayload(loadedDraft, {
      receiver: loadedReceiver,
      enableJpycAvalanche: env.enableJpycAvalanche,
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
  const previewConfig: HandleTipConfig = config ?? {
    to: effectiveReceiver ?? '',
    name: draft.name.trim() || undefined,
    color: colorValid ? draft.color : undefined,
    methods,
  };
  const publicHandleUrl = editingHandle
    ? origin
      ? `${origin}/@${editingHandle}`
      : `/@${editingHandle}`
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
      <div ref={headingRef} className="scroll-mt-4">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-lg font-semibold text-slate-800">{t('builderHeading')}</h2>
          {editingHandle && (
            <span
              data-testid="published-status"
              className="inline-flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-800 ring-1 ring-emerald-200"
            >
              <span>{tc('publishedStatus', { handle: editingHandle })}</span>
              <span aria-hidden>・</span>
              {relativeUpdatedAt ? (
                <span>
                  {tc('lastUpdated')}{' '}
                  <time dateTime={relativeUpdatedAt.dateTime}>
                    {relativeUpdatedAt.label}
                  </time>
                </span>
              ) : (
                <span>{tc('lastUpdatedUnknown')}</span>
              )}
              {isDirty && (
                <span className="rounded-full bg-amber-100 px-2 py-0.5 text-amber-800 ring-1 ring-amber-200">
                  {tc('unpublishedChanges')}
                </span>
              )}
              <button
                type="button"
                onClick={onStopEditing}
                className="text-emerald-700 underline hover:text-emerald-950"
              >
                {tc('stopEditing')}
              </button>
            </span>
          )}
        </div>
        <p className="mt-1 text-sm text-slate-500">{t('builderSubheading')}</p>
      </div>

      {/* 2カラム: 左=① 恒久リンク / ② 受取先 / ③ プロフィール (page scroll)、
          右=④ プレビュー (lg で sticky 追従)。 */}
      <div className="lg:grid lg:grid-cols-[1fr_minmax(300px,360px)] lg:items-start lg:gap-6">
        <div className="min-w-0 space-y-5">
          {/* ① 恒久リンク (@handle) */}
          <StepCard step={1} icon={AtSign} title={t('stepHandleTitle')}>
            <HandleClaimPanel
              payload={publishPayload}
              onEdit={onEditExisting}
              editingHandle={editingHandle}
              expectedUpdatedAt={activeBaseline?.updatedAt}
              isDirty={isDirty}
              onStopEditing={onStopEditing}
              onPublished={(snapshot: PublishedHandleSnapshot) => {
                setEditingHandle(snapshot.handle);
                dispatchPublishBaseline({ type: 'published', snapshot });
                // 公開後のレコードは builder 製 = USDC method を含まないため、旧レコード由来の
                // 「USDC 提供終了」通知は以後 stale (更新で外れる、はもう外れた後)。
                setEditedHadUsdc(false);
              }}
            />
          </StepCard>

          {/* ② 受取先 (AddressInput + 接続ウォレット + 受取方法) */}
          <StepCard step={2} icon={Wallet} title={t('stepReceiverTitle')}>
            <div className="space-y-4">
              <Field label={t('receiverLabel')} hint={t('receiverHint')}>
                <AddressInput
                  value={draft.to}
                  onChange={(v) => update({ to: v })}
                  onResolved={setResolved}
                />
                {connected && (
                  <button
                    type="button"
                    onClick={onUseConnected}
                    className="mt-1.5 text-xs font-medium text-brand hover:underline"
                  >
                    {t('useConnectedWallet')}
                  </button>
                )}
              </Field>

              <fieldset>
                <legend className="text-sm font-medium text-slate-700">{t('methodsLabel')}</legend>
                <div className="mt-1 space-y-1.5">
                  {methodOptions.map(([key, method]) => (
                    <label key={key} className="flex cursor-pointer items-center gap-2 text-sm text-slate-700">
                      <input
                        type="checkbox"
                        checked={draft[key]}
                        onChange={(e) => update({ [key]: e.target.checked } as Partial<typeof draft>)}
                      />
                      {methodLabel(method, t('crossChain'))}
                    </label>
                  ))}
                </div>
                {methods.length === 0 && (
                  <p className="mt-1 text-xs text-red-600">{t('atLeastOneMethod')}</p>
                )}
                {editedHadUsdc && (
                  <p className="mt-1 text-xs text-amber-700">{t('usdcDiscontinued')}</p>
                )}
              </fieldset>
            </div>
          </StepCard>

          {/* ③ プロフィール (表示名・テーマ色 + bio/avatar/SNS/links) */}
          <StepCard step={3} icon={UserRound} title={t('stepProfileTitle')}>
            <div className="space-y-4">
              <Field label={t('nameLabel')}>
                <input
                  type="text"
                  value={draft.name}
                  maxLength={60}
                  onChange={(e) => update({ name: e.target.value })}
                  className={inputClass}
                />
              </Field>
              {/* interactive なタイル群なので Field (=<label>) では包まない。 */}
              <HandleThemePicker
                accent={pickerAccent}
                selected={draft.theme}
                onSelect={(theme) => update({ theme })}
                label={t('themeLabel')}
                hint={t('themeHint')}
              />
              <Field label={t('colorLabel')}>
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    value={colorValid ? draft.color : '#2563eb'}
                    onChange={(e) => update({ color: e.target.value })}
                    className="h-9 w-12 rounded border border-slate-300"
                  />
                  <input
                    type="text"
                    value={draft.color}
                    onChange={(e) => update({ color: e.target.value })}
                    placeholder="#2563eb"
                    className={inputClass}
                  />
                </div>
              </Field>
              <Field
                label={t('bioLabel')}
                hint={`${draft.bio.trim().length}/${MAX_BIO_LEN}`}
              >
                <textarea
                  value={draft.bio}
                  maxLength={MAX_BIO_LEN}
                  rows={2}
                  onChange={(e) => update({ bio: e.target.value })}
                  className={inputClass}
                />
              </Field>
              <Field label={t('avatarLabel')} hint={t('avatarHint')}>
                <input
                  type="url"
                  value={draft.avatar}
                  placeholder="https://"
                  onChange={(e) => update({ avatar: e.target.value })}
                  className={inputClass}
                />
              </Field>
              {/* SNS アイコンリンク (URL のみ・アイコンはドメイン自動判定) */}
              <Field label={t('socialsLabel')} hint={t('socialsHint')}>
                <div className="space-y-2">
                  {draft.socials.map((s, i) => (
                    <ReorderableRow
                      key={i}
                      {...socialsReorder.rowProps(i, draft.socials.length)}
                      labels={reorderLabels}
                    >
                      <span className="shrink-0 text-slate-500">
                        <SocialIcon url={s.trim()} className="h-5 w-5" />
                      </span>
                      <input
                        type="url"
                        value={s}
                        placeholder="https://x.com/yourname"
                        onChange={(e) => {
                          const next = [...draft.socials];
                          next[i] = e.target.value;
                          update({ socials: next });
                        }}
                        className={inputClass}
                      />
                      <button
                        type="button"
                        onClick={() =>
                          update({ socials: draft.socials.filter((_, j) => j !== i) })
                        }
                        className="rounded-md border border-slate-200 px-2 text-sm text-slate-500 hover:text-red-600"
                        aria-label={t('removeSocial')}
                      >
                        ×
                      </button>
                    </ReorderableRow>
                  ))}
                  {draft.socials.length < MAX_SOCIAL_LINKS && (
                    <button
                      type="button"
                      onClick={() => update({ socials: [...draft.socials, ''] })}
                      className="text-xs font-medium text-brand hover:underline"
                    >
                      ＋ {t('addSocial')}
                    </button>
                  )}
                </div>
                </Field>
                <Field label={t('linksLabel')} hint={t('httpsOnlyHint')}>
                  <div className="space-y-2">
                    {draft.links.map((l, i) => (
                      <ReorderableRow
                        key={i}
                        {...linksReorder.rowProps(i, draft.links.length)}
                        labels={reorderLabels}
                      >
                        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                          <input
                            type="text"
                            value={l.emoji ?? ''}
                            placeholder="🌐"
                            aria-label={t('emojiAria')}
                            maxLength={8}
                            onChange={(e) => {
                              const next = [...draft.links];
                              next[i] = { ...next[i], emoji: e.target.value };
                              update({ links: next });
                            }}
                            className="w-12 shrink-0 rounded-lg border border-slate-300 bg-white px-2 py-2 text-center text-sm focus:border-brand focus:outline-none"
                          />
                          <input
                            type="text"
                            value={l.label}
                            placeholder={t('linkLabelPlaceholder')}
                            maxLength={40}
                            onChange={(e) => {
                              const next = [...draft.links];
                              next[i] = { ...next[i], label: e.target.value };
                              update({ links: next });
                            }}
                            className={`${inputClass} min-w-[6rem] flex-[2]`}
                          />
                          <input
                            type="url"
                            value={l.url}
                            placeholder="https://"
                            onChange={(e) => {
                              const next = [...draft.links];
                              next[i] = { ...next[i], url: e.target.value };
                              update({ links: next });
                            }}
                            className={`${inputClass} min-w-[8rem] flex-[3]`}
                          />
                          <button
                            type="button"
                            onClick={() => setFeatured(i, !l.featured)}
                            aria-pressed={!!l.featured}
                            className={`shrink-0 rounded-lg border px-2 py-1.5 text-xs font-semibold transition ${
                              l.featured
                                ? 'border-brand bg-brand/10 text-brand'
                                : 'border-slate-200 text-slate-500 hover:border-slate-300'
                            }`}
                          >
                            {l.featured ? '★' : '☆'} {t('featuredToggle')}
                          </button>
                          <button
                            type="button"
                            onClick={() => update({ links: draft.links.filter((_, j) => j !== i) })}
                            className="shrink-0 rounded-md border border-slate-200 px-2 text-sm text-slate-500 hover:text-red-600"
                            aria-label={t('removeLink')}
                          >
                            ×
                          </button>
                        </div>
                      </ReorderableRow>
                    ))}
                    {draft.links.length < MAX_PROFILE_LINKS && (
                      <button
                        type="button"
                        onClick={() => update({ links: [...draft.links, { label: '', url: '' }] })}
                        className="text-xs font-medium text-brand hover:underline"
                      >
                        ＋ {t('addLink')}
                      </button>
                    )}
                  </div>
                </Field>
                {hasInsecure && (
                  <p className="text-xs text-amber-700">{t('insecureDropped')}</p>
                )}
            </div>
          </StepCard>
        </div>

        {/* 右カラム: ④ ライブプレビュー (常時) + 編集中 handle の 開く/コピー/QR/X。desktop は sticky。 */}
        <aside className="mt-6 min-w-0 self-start lg:mt-0 lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:overflow-y-auto">
          <StepCard step={4} icon={Eye} title={t('stepPreviewTitle')}>
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
                    {methods.length > 0 && (
                      <div className="mt-4 flex flex-col gap-2">
                        {methods.length > 1 && (
                          <p
                            className={`text-center text-xs font-semibold ${
                              previewDark ? 'text-slate-300' : 'text-slate-500'
                            }`}
                          >
                            {t('selectCurrencyChain')}
                          </p>
                        )}
                        {methods.map((m, i) => (
                          <span
                            key={i}
                            className={`flex flex-col items-center rounded-lg border px-3 py-2 text-center text-sm font-semibold ${
                              previewDark
                                ? 'border-white/15 text-slate-200'
                                : 'border-slate-200 text-slate-600'
                            }`}
                          >
                            {methods.length > 1 ? (
                              methodMetaLabel(m, t('crossChain'))
                            ) : (
                              <>
                                <span>♡ {t('supportHeading')}</span>
                                <span
                                  className={`text-xs font-medium ${
                                    previewDark ? 'text-slate-300' : 'text-slate-500'
                                  }`}
                                >
                                  {methodMetaLabel(m, t('crossChain'))}
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
                  onClick={() => setShowQr(true)}
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
          </StepCard>
        </aside>
      </div>

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
