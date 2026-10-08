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

import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { AtSign, Eye, Link2, Palette, Settings2, Share2, SlidersHorizontal, UserRound, Wallet } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { useAccount } from 'wagmi';
import { getAddress, isAddress, type Address } from 'viem';
import { env, isArcTipEnabled } from '@/lib/env';
import { resolveTipCapability } from '@/lib/url/tip';
import { AddressInput } from '@/components/AddressInput';
import { ExternalImage } from '@/components/ExternalImage';
import { HandleClaimPanel } from '@/components/HandleClaimPanel';
import { handleFontClass } from '@/components/handleFonts';
import { HandleProfileView } from '@/components/HandleProfile';
import { HandleThemePicker } from '@/components/HandleThemePicker';
import { LinkQrModal } from '@/components/LinkQrModal';
import { ReorderableRow } from '@/components/ReorderableRow';
import { SocialIcon } from '@/components/SocialIconLinks';
import { OptionalGroup } from '@/components/OptionalGroup';
import { SectionCard } from '@/components/SectionCard';
import { ShopSettingsSection, ShopSettingsSheet } from '@/components/ShopSettingsSheet';
import { shortAddress } from '@/lib/format';
import { methodLabel, methodMetaLabel, needsChainDisambiguation } from '@/components/ReceiveMethodPicker';
import {
  useHandleProfileDraft,
  DEFAULT_PROFILE_DRAFT,
  isPristineProfileDraft,
  sameProfileDraft,
  type HandleProfileDraft,
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
import {
  isHandleEmbedUrl,
  HANDLE_FONTS,
  HANDLE_LINK_LAYOUTS,
  MAX_LINK_IMAGE_URL_LEN,
  MAX_BIO_LEN,
  MAX_PROFILE_EMBEDS,
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

function FieldGroup({
  label,
  children,
  hint,
  hideLabel = false,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
  /** 見出しを目に見せない (任意のまとまりの見出しと同じ言葉を 2 回出さない・読み上げには残す)。 */
  hideLabel?: boolean;
}) {
  return (
    <fieldset className="block">
      <legend className={hideLabel ? 'sr-only' : 'text-sm font-medium text-slate-700'}>{label}</legend>
      <div className="mt-1">{children}</div>
      {hint && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
    </fieldset>
  );
}

const inputClass =
  'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-brand focus:outline-none';
const linkFieldLabelClass =
  'mb-1 block text-xs font-medium text-slate-600';

function MiniPreviewAvatar({ url, initial }: { url?: string; initial: string }) {
  const [failed, setFailed] = useState(false);
  return url && !failed ? (
    // 外部画像の読込失敗がプレビューの壊れ画像表示に波及しないよう頭文字へ戻す。
    <ExternalImage
      src={url}
      alt=""
      aria-hidden
      referrerPolicy="no-referrer"
      loading={undefined}
      decoding="async"
      className="h-full w-full object-cover"
      onError={() => setFailed(true)}
    />
  ) : <span aria-hidden>{initial}</span>;
}

function MiniPreviewCover({ url }: { url: string }) {
  const [failed, setFailed] = useState(false);
  // 外部画像の読込失敗がプレビューの壊れ画像表示に波及しないよう非表示にする。
  return failed ? null : (
    <ExternalImage
      src={url}
      alt=""
      aria-hidden
      referrerPolicy="no-referrer"
      loading={undefined}
      decoding="async"
      className="absolute inset-0 h-full w-full opacity-25 object-cover"
      onError={() => setFailed(true)}
    />
  );
}

function stripResolvedEmbedsForDraft(
  links: HandleProfile['links'],
): NonNullable<HandleProfile['links']> {
  return (links ?? []).map((link) => {
    if (link.kind === 'heading') return link;
    const draftLink = { ...link };
    delete draftLink.embedResolved;
    return draftLink;
  });
}

/** 公開中のレコードから下書きを組み直す (編集に入るとき・下書きが公開中と同じかを確かめるとき)。
 *  USDC は flag に依らず chain ごとに復元し、公開済み Arc を Base に置き換えない。
 *  編集対象レコードに無いフィールドは「前の下書き値」ではなく **builder 既定**へ戻す。
 *  でないと別プロフィールの色/プリセットが update 時にこの handle へ混入する。 */
function draftFromPublished(c: HandleTipConfig, p?: HandleProfile): HandleProfileDraft {
  return {
    to: c.to,
    name: c.name ?? '',
    message: c.message,
    thanks: c.thanks,
    thanksUrl: c.thanksUrl,
    webhook: c.webhook,
    color:
      c.color && COLOR_PATTERN.test(c.color)
        ? c.color
        : DEFAULT_PROFILE_DRAFT.color,
    jpycPolygon: c.methods.some((m) => m.token === 'jpyc' && m.chain === 'polygon'),
    jpycKaia: c.methods.some((m) => m.token === 'jpyc' && m.chain === 'kaia'),
    jpycAvalanche: c.methods.some(
      (m) => m.token === 'jpyc' && m.chain === 'avalanche',
    ),
    usdcBase: c.methods.some((m) => m.token === 'usdc' && m.chain === 'base'),
    usdcArc: c.methods.some((m) => m.token === 'usdc' && m.chain === 'arc'),
    presetsJpyc: c.presets?.jpyc ?? DEFAULT_PROFILE_DRAFT.presetsJpyc,
    bio: p?.bio ?? '',
    avatar: p?.avatar ?? '',
    cover: p?.cover ?? '',
    font: p?.font ?? DEFAULT_PROFILE_DRAFT.font,
    linkLayout: p?.linkLayout ?? DEFAULT_PROFILE_DRAFT.linkLayout,
    socials: p?.socials ?? [],
    links: stripResolvedEmbedsForDraft(p?.links),
    theme: p?.theme ?? DEFAULT_PROFILE_DRAFT.theme,
  };
}

export function HandleProfileBuilder({
  onPublishedHandleChange,
}: {
  onPublishedHandleChange?: (handle: string | null) => void;
}) {
  const t = useTranslations('HandleProfile');
  const tb = useTranslations('HandleProfileBuilder');
  const tt = useTranslations('TipEmbedGenerator');
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
  const embedCount = draft.links.reduce(
    (count, link) =>
      link.kind !== 'heading' &&
      link.embed === true &&
      isHandleEmbedUrl(link.url.trim())
        ? count + 1
        : count,
    0,
  );

  const methods = useMemo(
    () => buildPublishMethods(draft, {
      enableJpycAvalanche: env.enableJpycAvalanche,
      arcTip: isArcTipEnabled(),
    }),
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
  // USDC は Base か Arc の**どちらか 1 つ** (2026-09-17 user 裁定: 両方公開すると受取ボタンが 2 つ並ぶ)。
  // draft は従来の usdcBase / usdcArc の 2 boolean のまま (旧 draft 互換)・UI で排他にする。
  // 旧レコードで両方 true のときは 'both' として明示表示し、どちらかを選ぶまで黙って落とさない。
  const usdcChoice: 'none' | 'base' | 'arc' | 'both' =
    draft.usdcBase && draft.usdcArc ? 'both' : draft.usdcArc ? 'arc' : draft.usdcBase ? 'base' : 'none';
  const showArcChoice = isArcTipEnabled() || draft.usdcArc;
  const usdcChoices: Array<['none' | 'base' | 'arc', string]> = [
    ['none', tb('usdcNone')],
    // ビルダーの選択肢はチェーン名で区別する (受け取る側が選ぶ場所)。cross-chain 可否は
    // 公開時に buildPublishMethods が付け、送る側のボタンは「USDC · cross-chain」で統一。
    ['base', methodLabel({ token: 'usdc', chain: 'base' }, t('crossChain'))],
    ...(showArcChoice ? [['arc', methodLabel({ token: 'usdc', chain: 'arc' }, t('crossChain'))] as ['arc', string]] : []),
  ];

  // 受取先: 生 0x アドレスは**入力値を最優先**で採用する (前に解決した別のアドレスで上書きしない・誤送金防止)。
  // ENS 名のときは、受け取りの設定シート (その中の AddressInput) を開いていなくても名前を解決しておき、この解決結果
  // だけを使う (シートの AddressInput も同じ query を見る)。シートから受け取った解決値を別に持つと、閉じた後の
  // 再解決が届かず古いアドレスのまま公開される (着金先のずれ)。
  const toName = draft.to.trim();
  const ens = useResolveAddress(isLikelyName(toName) ? toName : '');
  const effectiveReceiver = useMemo<Address | null>(() => {
    const raw = draft.to.trim();
    if (isAddress(raw)) return getAddress(raw);
    return ens.data?.address ?? null;
  }, [draft.to, ens.data]);

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
  const invalidWebhook = !!draft.webhook?.trim() && !sanitizeUrl(draft.webhook);
  const callbackUrlError = invalidThanksUrl || invalidWebhook ? tb('callbackUrlInvalid') : undefined;
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

  // 任意のまとまりに入っている項目の数 (見出しの右に出す)。見た目は既定から変えたものを数える。
  const filledLook = [
    draft.theme !== DEFAULT_PROFILE_DRAFT.theme,
    draft.color !== DEFAULT_PROFILE_DRAFT.color,
    draft.font !== DEFAULT_PROFILE_DRAFT.font,
    draft.cover.trim() !== '',
  ].filter(Boolean).length;
  const filledSocials = draft.socials.filter((v) => v.trim()).length;
  const filledLinks = draft.links.filter((l) => l.kind !== 'heading' && l.url.trim()).length;
  const filledAdvanced = [draft.message, draft.thanks, draft.thanksUrl, draft.webhook].filter((v) => v?.trim()).length;
  const filledLabel = (count: number) => t('optionalFilled', { count });

  // 「注目」は最大 1 本。ある行を ON にしたら他行は自動 OFF (単一 enforce)。同じ行の再クリックで OFF。
  const setFeatured = (index: number, on: boolean) => {
    if (draft.links[index]?.kind === 'heading') return;
    update({
      links: draft.links.map((l, j) =>
        l.kind === 'heading' ? l : { ...l, featured: on && j === index },
      ),
    });
  };

  // テーマピッカーのミニプレビュー用アクセント (無効色は既定ブルー)。
  const pickerAccent = colorValid ? draft.color : '#2563eb';
  // ライブプレビューカードの地色 (clean は undefined = 従来の白)。night は暗背景。
  const previewBg = handlePreviewBackground(pickerAccent, draft.theme);
  const previewDark = draft.theme === 'night';
  const miniName = draft.name.trim() || `@${editingHandle ?? 'handle'}`;
  const miniAvatar = profile.avatar;
  const miniInitial = Array.from(draft.name.trim() || editingHandle || 'handle')[0].toUpperCase();

  // 並べ替えハンドル/▲▼ の i18n ラベル (socials/links 共通・既存キーを流用)。
  const reorderLabels = {
    dragToReorder: t('dragToReorder'),
    moveUp: t('moveUp'),
    moveDown: t('moveDown'),
  };

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
    webhook: config.webhook ?? undefined,
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
            // AppShell → AppHeader: h-8 + py-3 × 2 + border-b = 57px。
            // 外側は不透明の地 (白/濃紺) にして、半透明グラデーションのテーマ地色でも本文が透けないようにする。
            <div
              data-testid="handle-mini-preview"
              className={`sticky top-[57px] z-20 overflow-hidden rounded-xl shadow-sm ring-1 ring-black/10 lg:hidden ${
                previewDark ? 'bg-slate-900 text-slate-50' : 'bg-white text-slate-900'
              }`}
            >
              <div
                className={['relative flex h-14 items-center gap-3 px-3', handleFontClass(draft.font)].filter(Boolean).join(' ')}
                style={{ background: previewBg }}
              >
                {profile.cover && <MiniPreviewCover key={profile.cover} url={profile.cover} />}
                <div
                  className="relative z-10 flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full text-sm font-bold text-white ring-2 ring-white/30"
                  style={{ backgroundColor: pickerAccent }}
                >
                  <MiniPreviewAvatar key={miniAvatar ?? ''} url={miniAvatar} initial={miniInitial} />
                </div>
                <div className="relative z-10 min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">{miniName}</p>
                  {/* 表示名が空のときは 1 行目が @handle になるので、同じ文字列を 2 行目に重ねない。 */}
                  {draft.name.trim() !== '' && (
                    <p className={`truncate text-xs ${previewDark ? 'text-slate-300' : 'text-slate-600'}`}>
                      @{editingHandle ?? 'handle'}
                    </p>
                  )}
                </div>
                <a
                  href="#step-4-heading"
                  className="relative z-10 flex min-h-11 shrink-0 items-center rounded text-xs font-semibold underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                >
                  {t('miniPreviewJump')}
                </a>
              </div>
            </div>
          )}
          {/* あなたのページ: 取得・公開 (取得済みの一覧・編集・削除・新しい @handle)。編集中は公開状態を見出しの下に。 */}
          <div ref={headingRef} className="scroll-mt-4">
            <SectionCard title={t('pageHeading')} headingId="handle-page-heading" icon={AtSign}>
              {editingHandle ? (
                <div className="mb-3">
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
                </div>
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
          <SectionCard
            title={t('receiveHeading')}
            headingId="handle-receive-heading"
            icon={Wallet}
            action={
              <button
                type="button"
                onClick={() => setReceiveOpen(true)}
                className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 transition hover:border-brand hover:text-brand-dark"
              >
                <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden />
                {t('receiveEdit')}
              </button>
            }
          >
            {receiverInline ? (
              <Field label={t('receiverLabel')} hint={t('receiverHint')}>
                <AddressInput
                  value={draft.to}
                  onChange={(v) => update({ to: v })}
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
            ) : effectiveReceiver ? (
              <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
                <span className="font-mono text-slate-900">{shortAddress(effectiveReceiver)}</span>
                {connected && effectiveReceiver.toLowerCase() === connected.toLowerCase() ? (
                  <span className="text-xs text-emerald-700">{t('receiverIsWallet')}</span>
                ) : null}
              </p>
            ) : (
              <p className="text-sm font-medium text-amber-700">{t('receiverUnset')}</p>
            )}
            <p className="mt-1 text-xs text-slate-500">
              {methods.length > 0
                ? methods.map((m) => methodLabel(m, t('crossChain'))).join(' / ')
                : t('atLeastOneMethod')}
            </p>
          </SectionCard>
          <ShopSettingsSheet
            open={receiveOpen}
            onClose={() => {
              setReceiveOpen(false);
              // シートで受取先を決めたら、受け取りカードの欄は要約に戻す (同じ欄を 2 か所に出さない)。
              if (effectiveReceiver) setReceiverInline(false);
            }}
            title={t('receiveSettingsTitle')}
            doneLabel={t('receiveDone')}
          >
            <ShopSettingsSection title={t('receiveHeading')}>
              {/* 受取先の欄は未設定の間は受け取りカードに直接出している (同じ欄を 2 か所に出さない)。 */}
              {!receiverInline && (
                <Field label={t('receiverLabel')} hint={t('receiverHint')}>
                  <AddressInput
                    value={draft.to}
                    onChange={(v) => update({ to: v })}
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
              )}
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
                  <p className="mt-3 text-sm font-medium text-slate-700">{tb('usdcChainLabel')}</p>
                  {usdcChoice === 'both' && (
                    <p className="mt-1 text-xs text-amber-700">{tb('usdcBothPublished')}</p>
                  )}
                  <div role="radiogroup" aria-label={tb('usdcChainLabel')} className="mt-1 space-y-1.5">
                    {usdcChoices.map(([value, label]) => (
                      <label key={value} className="flex cursor-pointer items-center gap-2 text-sm text-slate-700">
                        <input
                          type="radio"
                          name="usdcChain"
                          value={value}
                          checked={usdcChoice === value}
                          disabled={value === 'arc' && !isArcTipEnabled()}
                          onChange={() => update({ usdcBase: value === 'base', usdcArc: value === 'arc' })}
                        />
                        {label}
                        {value === 'arc' && !isArcTipEnabled() && ` (${tb('arcInactive')})`}
                      </label>
                    ))}
                  </div>
                  {draft.usdcArc && (
                    <p className="mt-1 text-xs text-slate-500">{tb('usdcArcTipHint')}</p>
                  )}
                  {methods.length === 0 && (
                    <p className="mt-1 text-xs text-red-600">{t('atLeastOneMethod')}</p>
                  )}
                  {draft.usdcBase && (
                    <p className="mt-1 text-xs text-slate-500">{t('usdcTipHint')}</p>
                  )}
                </fieldset>
            </ShopSettingsSection>
          </ShopSettingsSheet>

          {/* プロフィール: 表示名・ひとこと・アバターは常に。見た目・SNS・リンク・高度な設定は任意なので畳む。 */}
          <SectionCard title={t('stepProfileTitle')} headingId="handle-profile-heading" icon={UserRound}>
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
              <OptionalGroup icon={Palette} title={t('groupLook')} filled={filledLook} filledLabel={filledLabel}>
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
                <fieldset>
                  <legend className="text-sm font-medium text-slate-700">{t('fontLabel')}</legend>
                  <div className="mt-1 grid grid-cols-3 gap-2">
                    {HANDLE_FONTS.map((font) => (
                      <label key={font} className={`relative flex cursor-pointer flex-col items-center gap-1 rounded-lg border p-1.5 transition ${draft.font === font ? 'border-brand ring-2 ring-brand/40' : 'border-slate-200 hover:border-slate-300'}`}>
                        <input type="radio" name="profile-font" value={font} checked={draft.font === font} onChange={() => update({ font })} className="peer sr-only" />
                        <span aria-hidden className={['flex h-9 w-full items-center justify-center rounded-md bg-slate-50 peer-focus-visible:ring-2 peer-focus-visible:ring-brand', handleFontClass(font)].filter(Boolean).join(' ')}>あア Aa</span>
                        <span className={`text-xs font-medium ${draft.font === font ? 'text-brand' : 'text-slate-600'}`}>{t(`fonts.${font}`)}</span>
                      </label>
                    ))}
                  </div>
                </fieldset>
                <Field label={t('coverLabel')} hint={t('coverHint')}>
                  <input
                    type="url"
                    value={draft.cover}
                    placeholder="https://"
                    onChange={(e) => update({ cover: e.target.value })}
                    className={inputClass}
                  />
                </Field>
                {/* 画像 URL の用意ガイドへの導線。Field の hint は label 内に描画されるため、
                    リンクは label の外に置く (label 内の <a> はクリック挙動が入力と衝突する)。 */}
                <p className="-mt-3 text-xs">
                  <Link
                    href={`/${locale}/guide/image-url`}
                    prefetch={false}
                    className="font-medium text-emerald-700 underline underline-offset-2 hover:text-emerald-900"
                  >
                    {t('imageGuideLink')}
                  </Link>
                </p>
              </OptionalGroup>
              <OptionalGroup icon={Share2} title={t('groupSns')} filled={filledSocials} filledLabel={filledLabel} groupId="handle-group-socials">
                {/* SNS アイコンリンク (URL のみ・アイコンはドメイン自動判定) */}
                <div role="group" aria-labelledby="handle-group-socials">
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
                    <p className="mt-1 text-xs text-slate-500">{t('socialsHint')}</p>
                  </div>
              </OptionalGroup>
              <OptionalGroup icon={Link2} title={t('groupLinks')} filled={filledLinks} filledLabel={filledLabel}>
                <FieldGroup label={t('linksLabel')} hint={t('httpsOnlyHint')} hideLabel>
                  <fieldset className="mb-3">
                    <legend className="text-sm font-medium text-slate-700">{t('linkLayoutLabel')}</legend>
                    <div className="mt-1 flex gap-2">
                      {HANDLE_LINK_LAYOUTS.map((linkLayout) => (
                        <label key={linkLayout} className={`flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border px-3 text-xs ${draft.linkLayout === linkLayout ? 'border-brand text-brand' : 'border-slate-200 text-slate-600'}`}>
                          <input type="radio" name="profile-link-layout" value={linkLayout} checked={draft.linkLayout === linkLayout} onChange={() => update({ linkLayout })} />
                          {t(`linkLayouts.${linkLayout}`)}
                        </label>
                      ))}
                    </div>
                  </fieldset>
                  <div className="space-y-2">
                    {draft.links.map((l, i) => (
                      <ReorderableRow
                        key={i}
                        {...linksReorder.rowProps(i, draft.links.length)}
                        labels={reorderLabels}
                      >
                        {l.kind === 'heading' ? (
                          <div className="flex min-w-0 flex-1 items-end gap-2">
                            <label className="min-w-[6rem] flex-1">
                              <span className={linkFieldLabelClass}>
                                {tb('headingLabel')}
                              </span>
                              <input
                                type="text"
                                value={l.label}
                                placeholder={tb('headingLabelPlaceholder')}
                                maxLength={40}
                                onChange={(e) => {
                                  const next = [...draft.links];
                                  next[i] = { ...l, label: e.target.value };
                                  update({ links: next });
                                }}
                                className={inputClass}
                              />
                            </label>
                            <button
                              type="button"
                              onClick={() =>
                                update({
                                  links: draft.links.filter((_, j) => j !== i),
                                })
                              }
                              className="shrink-0 rounded-md border border-slate-200 px-2 text-sm text-slate-500 hover:text-red-600"
                            >
                              {tb('removeHeading')}
                            </button>
                          </div>
                        ) : (
                          <div className="flex min-w-0 flex-1 flex-wrap items-end gap-2">
                            <label className="w-14 shrink-0">
                              <span className={linkFieldLabelClass}>
                                {t('emojiAria')}
                              </span>
                              <input
                                type="text"
                                value={l.emoji ?? ''}
                                placeholder="🌐"
                                maxLength={8}
                                onChange={(e) => {
                                  const next = [...draft.links];
                                  next[i] = { ...l, emoji: e.target.value };
                                  update({ links: next });
                                }}
                                className="w-full rounded-lg border border-slate-300 bg-white px-2 py-2 text-center text-sm focus:border-brand focus:outline-none"
                              />
                            </label>
                            <label className="min-w-[10rem] flex-[2]">
                              <span className={linkFieldLabelClass}>
                                {tb('imageUrlLabel')}
                              </span>
                              <input
                                type="url"
                                value={l.imageUrl ?? ''}
                                placeholder="https://"
                                maxLength={MAX_LINK_IMAGE_URL_LEN}
                                onChange={(e) => {
                                  const next = [...draft.links];
                                  next[i] = { ...l, imageUrl: e.target.value };
                                  update({ links: next });
                                }}
                                className={inputClass}
                              />
                            </label>
                            <label className="min-w-[6rem] flex-[2]">
                              <span className={linkFieldLabelClass}>
                                {tb('linkLabel')}
                              </span>
                              <input
                                type="text"
                                value={l.label}
                                placeholder={t('linkLabelPlaceholder')}
                                maxLength={40}
                                onChange={(e) => {
                                  const next = [...draft.links];
                                  next[i] = { ...l, label: e.target.value };
                                  update({ links: next });
                                }}
                                className={inputClass}
                              />
                            </label>
                            <label className="min-w-[8rem] flex-[3]">
                              <span className={linkFieldLabelClass}>
                                {tb('linkUrlLabel')}
                              </span>
                              <input
                                type="url"
                                value={l.url}
                                placeholder="https://"
                                onChange={(e) => {
                                  const next = [...draft.links];
                                  const nextLink = { ...l, url: e.target.value };
                                  // URL が非対応になったら、画面から消えた toggle の stale true が
                                  // publish を拒否する波及を断つためここで同時に外す。
                                  if (!isHandleEmbedUrl(e.target.value.trim())) {
                                    delete nextLink.embed;
                                  }
                                  next[i] = nextLink;
                                  update({ links: next });
                                }}
                                className={inputClass}
                              />
                            </label>
                            {isHandleEmbedUrl(l.url.trim()) && (
                              <label className="inline-flex min-h-6 shrink-0 cursor-pointer items-center gap-1.5 text-xs font-medium text-slate-600">
                                <input
                                  type="checkbox"
                                  checked={l.embed === true}
                                  disabled={
                                    l.embed !== true &&
                                    embedCount >= MAX_PROFILE_EMBEDS
                                  }
                                  onChange={(e) => {
                                    const next = [...draft.links];
                                    const nextLink = { ...l };
                                    if (e.target.checked) nextLink.embed = true;
                                    else delete nextLink.embed;
                                    next[i] = nextLink;
                                    update({ links: next });
                                  }}
                                />
                                <span>{tb('embedToggle')}</span>
                              </label>
                            )}
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
                        )}
                      </ReorderableRow>
                    ))}
                    {draft.links.length < MAX_PROFILE_LINKS && (
                      <div className="flex flex-wrap gap-x-4 gap-y-2">
                        <button
                          type="button"
                          onClick={() => update({ links: [...draft.links, { label: '', url: '' }] })}
                          className="text-xs font-medium text-brand hover:underline"
                        >
                          ＋ {t('addLink')}
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            update({
                              links: [
                                ...draft.links,
                                { kind: 'heading', label: '' },
                              ],
                            })
                          }
                          className="text-xs font-medium text-brand hover:underline"
                        >
                          ＋ {tb('addHeading')}
                        </button>
                      </div>
                    )}
                  </div>
                </FieldGroup>
                {/* 埋め込み対応サービスの一覧は常時表示から畳む (引き算 P2)。hint「https:// のみ」の直下。 */}
                <details className="text-xs leading-relaxed text-slate-500">
                  <summary className="cursor-pointer font-medium">
                    {t('embedServicesSummary')}
                  </summary>
                  <p className="mt-2">{t('embedServicesHint')}</p>
                </details>
                {hasInsecure && (
                  <p className="text-xs text-amber-700">{t('insecureDropped')}</p>
                )}
              </OptionalGroup>
              <OptionalGroup icon={Settings2} title={tt('advancedTitle')} filled={filledAdvanced} filledLabel={filledLabel}>
              <div className="space-y-4">
                {(['message', 'thanks'] as const).map((field) => (
                  <Field key={field} label={tt(`${field}Label`)}>
                    <textarea
                      value={draft[field] ?? ''}
                      onChange={(e) => update({ [field]: e.target.value })}
                      placeholder={tt(`${field}Placeholder`)}
                      maxLength={200}
                      rows={2}
                      className={inputClass}
                    />
                  </Field>
                ))}
                <Field label={tt('thanksUrlLabel')} hint={tt('thanksUrlHint')}>
                  <input
                    type="url"
                    value={draft.thanksUrl ?? ''}
                    aria-invalid={invalidThanksUrl || undefined}
                    aria-describedby={invalidThanksUrl ? 'handle-thanks-url-error' : undefined}
                    onChange={(e) => update({ thanksUrl: e.target.value })}
                    placeholder={tt('thanksUrlPlaceholder')}
                    className={inputClass}
                  />
                  {invalidThanksUrl && (
                    <p id="handle-thanks-url-error" className="mt-1 text-xs text-red-600">{callbackUrlError}</p>
                  )}
                </Field>
                <Field
                  label={tt('webhookLabel')}
                  hint={tt('webhookHint', { payload: '{ txHash, amount, token, from, message }' })}
                >
                  <input
                    type="url"
                    value={draft.webhook ?? ''}
                    aria-invalid={invalidWebhook || undefined}
                    aria-describedby={invalidWebhook ? 'handle-webhook-error' : undefined}
                    onChange={(e) => update({ webhook: e.target.value })}
                    placeholder={tt('webhookPlaceholder')}
                    className={inputClass}
                  />
                  {invalidWebhook && (
                    <p id="handle-webhook-error" className="mt-1 text-xs text-red-600">{callbackUrlError}</p>
                  )}
                </Field>
              </div>
              </OptionalGroup>
            </div>
          </SectionCard>
        </div>

        {/* 右カラム: ライブプレビュー (常時) + 編集中 handle の 開く/コピー/QR/X + 公開ボタンの帯 (PC)。desktop は sticky。 */}
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
                    {draft.usdcArc && !isArcTipEnabled() && (
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
            {/* 公開ボタンの帯 (PC)。スマホは画面下のバー。どちらも HandleClaimPanel が同じ公開処理で描く。 */}
            <div ref={setDesktopBarSlot} className="mt-4 hidden border-t border-slate-100 pt-4 lg:block" />
          </SectionCard>
        </aside>
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
