'use client';

// 「モバイルオーダー」タブ: 店舗が 受取先 + 店舗設定 (店頭/事前・SNS) を編集し、顧客向け
// 「注文ページ URL」(設定一式を base64url で同梱) を発行するビルダー。
// **メニューは独立管理しない** — レジの商品プリセット (有効な JPYC 商品) を単一カタログとして
// 共有・読み取り表示し、URL に焼き込む (商品の追加/編集/画像/税率は「レジ」タブで一元管理)。
// レイアウトは他タブと同じ 2 カラム。下書きは useMobileOrderDraft。flag OFF で何も描画しない。
//
// ⚠️ 手数料率 (店頭/モバイル) はここでは扱わない/表示しない — 課金の実行と開示は P0/P2 ゲート後。

import { useCallback, useMemo, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import {
  ChevronDown,
  ChevronUp,
  Clock,
  Eye,
  Image as ImageIcon,
  MapPin,
  Share2,
  SlidersHorizontal,
  Store,
  UtensilsCrossed,
  Wallet,
} from 'lucide-react';
import { getAddress, isAddress, type Address } from 'viem';
import { env } from '@/lib/env';
import { AddressInput } from '@/components/AddressInput';
import { ExternalImage } from '@/components/ExternalImage';
import { ReorderableRow } from '@/components/ReorderableRow';
import { OptionalGroup } from '@/components/OptionalGroup';
import { SectionCard } from '@/components/SectionCard';
import { ShopSettingsSection, ShopSettingsSheet } from '@/components/ShopSettingsSheet';
import { shortAddress } from '@/lib/format';
import { SocialIcon, SocialIconLinks } from '@/components/SocialIconLinks';
import { StorefrontPublishPanel } from '@/components/StorefrontPublishPanel';
import {
  useMobileOrderDraft,
  presetsToMenu,
  menuToPresets,
  storefrontPartsToDraft,
  isPristineMobileOrderDraft,
} from '@/hooks/useMobileOrderDraft';
import { isUntouchedSeedCatalog, useProductPresets } from '@/hooks/useProductPresets';
import { useReceiverAutofill } from '@/hooks/useReceiverAutofill';
import { useQrSettings } from '@/hooks/useQrSettings';
import { useResolveAddress } from '@/hooks/useResolveAddress';
import { isLikelyName } from '@/lib/nameDetection';
import { useDragReorderList } from '@/hooks/useDragReorderList';
import { type JpycChainSlug } from '@/lib/chains';
import {
  safeHttpUrl,
  JPYC_CHAIN_LABEL,
  MOBILE_ORDER_CHAINS,
  SHOP_NAME_MAX,
  TAGLINE_MAX,
  SOCIALS_MAX,
  ADDRESS_MAX,
  HOURS_MAX,
  PHONE_MAX,
  type StorefrontParts,
  type MobileOrderConfig,
} from '@/lib/mobileOrder';
import { MobileOrderView } from '@/components/MobileOrderView';
import { MIN_LEAD_MAX } from '@/lib/shopTime';
import { InvoiceNumberInput } from './InvoiceNumberInput';

const inputClass =
  'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-brand focus:outline-none';

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

export function MobileOrderBuilder({
  onManageProducts,
  onGetHandle,
}: {
  /** 「レジで商品を管理」導線 (create ページが register タブへ切替える)。 */
  onManageProducts?: () => void;
  /** 「@handle を取得」導線 (create ページが profile タブへ切替える)。 */
  onGetHandle?: () => void;
} = {}) {
  const t = useTranslations('MobileOrder');
  const locale = useLocale();
  const { settings: draft, setSettings, hydrated, setReceiver } = useMobileOrderDraft();
  const { presets, replaceAll, hydrated: presetsHydrated } = useProductPresets();
  // 決済QR タブの受取先 (レジと同じく「引き継ぐ」ショートカット用)。
  const { settings: qrSettings } = useQrSettings();
  const qrReceiver = qrSettings.receiver.trim();
  // ③メニュー (レジ管理の読み取り専用一覧) の開閉。多いと長くなるので既定は閉じる。
  const [menuOpen, setMenuOpen] = useState(false);
  // スマホの下部バー (お店のページの「公開」) を描く枠。StorefrontPublishPanel がここへ描く。
  const [barSlot, setBarSlot] = useState<HTMLDivElement | null>(null);
  const [desktopBarSlot, setDesktopBarSlot] = useState<HTMLDivElement | null>(null);
  // 受け取り (受取先・受取チェーン) の設定シートの開閉。
  const [receiveOpen, setReceiveOpen] = useState(false);
  // 編集画面の第三者画像 (アイコン/カバー/メニュー) の読込失敗を壊れ画像 icon として出さない。
  // 失敗した URL だけを記録するので、URL を直せば新しい画像を再試行する。
  const [failedImageUrls, setFailedImageUrls] = useState<readonly string[]>([]);
  const markImageFailed = useCallback((url: string) => {
    setFailedImageUrls((current) => (current.includes(url) ? current : [...current, url]));
  }, []);

  // 受取先が ENS 名のときは、設定シート (その中の AddressInput) を開いていなくても名前を解決しておく。
  // シートを閉じたまま公開しても、選んだ受取先で公開されるように (受取先のずれを防ぐ)。
  const receiverName = draft.receiver.trim();
  const ens = useResolveAddress(isLikelyName(receiverName) ? receiverName : '');

  // 受取先: 生 0x は入力値を最優先。ENS 名はこの解決結果だけを使う (シートの AddressInput も同じ query を見る)。
  // シートから受け取った解決値を別に持つと、閉じた後の再解決が届かず古いアドレスのまま公開される (着金先のずれ)。
  const effectiveReceiver = useMemo<Address | null>(() => {
    const raw = draft.receiver.trim();
    if (isAddress(raw)) return getAddress(raw);
    // 再解決に失敗しても react-query は前回の解決結果を残すので、失敗中は使わない (古い着金先で公開しない)。
    return ens.error ? null : ens.data?.address ?? null;
  }, [draft.receiver, ens.data, ens.error]);

  // setReceiver は useMobileOrderDraft 側で useCallback 安定なのでそのまま渡す。
  const autofill = useReceiverAutofill({
    receiver: draft.receiver,
    receiverSource: draft.receiverSource,
    effectiveReceiver,
    hydrated,
    setReceiver,
  });

  // メニュー = レジの有効な JPYC 商品 (単一カタログ)。
  const menuItems = useMemo(() => presetsToMenu(presets), [presets]);

  // 公開可否は「有効なメニューがあるか」で決まる (受取先/店名は @handle 側が権威)。
  const hasMenu = menuItems.length > 0;

  // 店舗アイコンのプレビュー (https のみ・読込前検証)。無ければ店名の頭文字を円に表示。
  const avatarPreview = safeHttpUrl(draft.avatar.trim());
  // 店舗カバー(ヘッダー背景)のプレビュー (https のみ)。
  const coverPreview = safeHttpUrl(draft.cover.trim());
  const previewInitial = ([...draft.shopName.trim()][0] ?? '').toUpperCase();
  // プレビュー用の SNS (https のみ・公開ページ MobileOrderView と同じ SocialIconLinks で描画)。
  const socialPreview = draft.socials
    .map((s) => safeHttpUrl(s.trim()))
    .filter((u): u is string => Boolean(u));

  // @handle 公開用の店舗固有部分。受取先は @handle が権威だが、店名/アイコン/SNS は
  // ビルダーの設定をそのまま公開ページへ載せる (https 検証は validateStorefrontParts が行う)。
  // メニュー未充足なら null (公開不可)。
  const storefrontParts = hasMenu
    ? {
        chain: draft.chains[0], // 既定 (先頭)
        chains: draft.chains, // 顧客が選べる集合 (validateStorefrontParts が 2 件以上で採用)
        mode: draft.mode,
        feePayer: draft.feePayer,
        shopName: draft.shopName.trim() || undefined,
        tagline: draft.tagline.trim() || undefined,
        avatar: draft.avatar.trim() || undefined,
        cover: draft.cover.trim() || undefined,
        socials: draft.socials.map((s) => s.trim()).filter(Boolean),
        address: draft.address.trim() || undefined,
        hours: draft.hours.trim() || undefined,
        phone: draft.phone.trim() || undefined,
        invoiceNo: draft.invoiceNo.trim() || undefined, // 形式外は validateStorefrontParts が除外
        acceptingOrders: draft.acceptingOrders,
        dineIn: draft.dineIn, // 店内なら公開ページで注文時にテーブル番号を入力させる
        openFrom: draft.openFrom.trim() || undefined,
        ...(draft.lastOrder.trim() ? { lastOrder: draft.lastOrder.trim() } : {}),
        ...(draft.minLeadMinutes.trim()
          ? { minLeadMinutes: Number(draft.minLeadMinutes.trim()) }
          : {}),
        menu: menuItems,
      }
    : null;

  // ④ プレビュー用の MobileOrderConfig。下書きから生成し、必須欠落 (受取先/店名) はプレースホルダで
  // 埋めて作成途中でも実際の店舗ページ (MobileOrderView) をそのまま WYSIWYG 描画する。受取先未確定でも
  // 描けるようダミーアドレスで代用 (プレビュー専用・公開検証は storefrontParts/validateOrderConfig 側)。
  const previewConfig: MobileOrderConfig = {
    receiver: (/^0x[0-9a-fA-F]{40}$/.test(draft.receiver.trim())
      ? getAddress(draft.receiver.trim())
      : '0x0000000000000000000000000000000000000000') as Address,
    chain: draft.chains[0],
    ...(draft.chains.length > 1 ? { chains: draft.chains } : {}),
    shopName: draft.shopName.trim() || t('previewShopPlaceholder'),
    ...(draft.tagline.trim() ? { tagline: draft.tagline.trim() } : {}),
    ...(avatarPreview ? { avatar: avatarPreview } : {}),
    ...(coverPreview ? { cover: coverPreview } : {}),
    mode: draft.mode,
    feePayer: draft.feePayer,
    socials: socialPreview,
    menu: menuItems,
    ...(draft.address.trim() ? { address: draft.address.trim() } : {}),
    ...(draft.hours.trim() ? { hours: draft.hours.trim() } : {}),
    ...(draft.phone.trim() ? { phone: draft.phone.trim() } : {}),
    ...(draft.acceptingOrders ? {} : { acceptingOrders: false }),
    ...(draft.dineIn ? { dineIn: true } : {}),
    ...(draft.openFrom.trim() ? { openFrom: draft.openFrom.trim() } : {}),
    ...(draft.lastOrder.trim() ? { lastOrder: draft.lastOrder.trim() } : {}),
    ...(draft.minLeadMinutes.trim()
      ? { minLeadMinutes: Number(draft.minLeadMinutes.trim()) }
      : {}),
  };

  const update = (patch: Partial<typeof draft>) => setSettings((s) => ({ ...s, ...patch }));

  // 別端末で公開中の @handle を「読み込んで編集」する。公開済み storefront → 下書き (店舗設定) +
  // 商品カタログ (レジ共有・menu を復元) をこの端末へ復元する。受取先は @handle が権威 (config.to)。
  // ⚠️ 既存の下書き/カタログを破壊的に上書きするため、呼び出し側 (StorefrontPublishPanel) が確認を取る。
  const loadFromStorefront = useCallback(
    (parts: StorefrontParts, receiver: string) => {
      setSettings(() => storefrontPartsToDraft(parts, receiver));
      replaceAll(menuToPresets(parts.menu));
    },
    [setSettings, replaceAll],
  );

  // 受取チェーンの複数選択トグル。最低 1 件は維持 (空選択は不可)。
  const toggleChain = (slug: JpycChainSlug) => {
    const has = draft.chains.includes(slug);
    const next = has ? draft.chains.filter((c) => c !== slug) : [...draft.chains, slug];
    if (next.length > 0) update({ chains: next });
  };

  // SNS の並べ替え (@handle プロフと同型: ドラッグ + ▲▼ ボタンの 2 系統)。挙動は
  // useDragReorderList、見た目/ラベルは ReorderableRow が担う (list ごとに 1 インスタンス)。
  const socialsReorder = useDragReorderList(draft.socials, (socials) =>
    update({ socials }),
  );
  const reorderLabels = {
    dragToReorder: t('dragToReorder'),
    moveUp: t('moveUp'),
    moveDown: t('moveDown'),
  };

  // 任意のまとまりに入っている項目の数 (見出しの右に出す)。
  const filledImages = [draft.avatar, draft.cover].filter((v) => v.trim()).length;
  const filledShopInfo = [draft.address, draft.hours, draft.phone, draft.invoiceNo].filter((v) => v.trim()).length;
  const filledSns = draft.socials.filter((v) => v.trim()).length;
  const filledTime = [draft.openFrom, draft.lastOrder, draft.minLeadMinutes].filter((v) => v.trim()).length;
  const filledLabel = (count: number) => t('optionalFilled', { count });

  // 戻ってきた店主: この端末の下書きとレジの商品がまだ手付かず (既定・見本のまま) なら、公開中の店を
  // 自動で読み込んでよい (置き換えても失うものが無い)。どちらかに手が入っていれば今までどおり確認を挟む。
  const canAutoLoad =
    hydrated && presetsHydrated && isPristineMobileOrderDraft(draft) && isUntouchedSeedCatalog(presets);

  if (!env.enableMobileOrder) return null;

  // 注文の受付トグル (下書き)。@handle の公開が使えるときは状態カードの中に出す。
  const acceptingToggle = (
    <div className="rounded-2xl bg-white p-4 shadow-card ring-1 ring-slate-200/70">
      <div className="flex items-center justify-between gap-3">
        <span id="mobile-order-accepting-label" className="text-sm font-medium text-slate-700">{t('acceptingLabel')}</span>
        {/* 名前は「注文の受付 受付中」(見えている文字を含める・掟 8)。 */}
        <button
          type="button"
          role="switch"
          aria-checked={draft.acceptingOrders}
          aria-labelledby="mobile-order-accepting-label mobile-order-accepting-state"
          onClick={() => update({ acceptingOrders: !draft.acceptingOrders })}
          className={`shrink-0 rounded-full px-4 py-1.5 text-sm font-semibold transition ${
            draft.acceptingOrders ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-200 text-slate-500'
          }`}
        >
          <span id="mobile-order-accepting-state">{draft.acceptingOrders ? t('acceptingOn') : t('acceptingOff')}</span>
        </button>
      </div>
      <p className="mt-1 text-xs text-slate-500">{t('acceptingHint')}</p>
    </div>
  );

  return (
    // 並び: スマホは「お店のページ (状態・公開) → 設定 → プレビュー」(DOM の順 = 見た目の順 = focus の順)。
    // PC は左に設定 (2 行ぶち抜き)・右上にお店のページ・右下にプレビュー (追従・公開ボタンの帯つき)。
    <div className="flex flex-col gap-5 lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(300px,360px)] lg:grid-rows-[auto_1fr] lg:items-start lg:gap-x-6 lg:gap-y-5">
          {env.enableHandles && (
            <div className="min-w-0 lg:col-start-2 lg:row-start-1">
              <StorefrontPublishPanel
                storefront={storefrontParts}
                receiver={effectiveReceiver}
                onGetHandle={onGetHandle}
                onLoadStorefront={loadFromStorefront}
                canAutoLoad={canAutoLoad}
                accepting={draft.acceptingOrders}
                onToggleAccepting={() => update({ acceptingOrders: !draft.acceptingOrders })}
                barSlots={[barSlot, desktopBarSlot]}
              />
            </div>
          )}
        <div className="min-w-0 space-y-5 lg:col-start-1 lg:row-span-2 lg:row-start-1">
          {/* @handle の公開が使えない構成では、受付トグルをここに出す (状態カードが無いため)。 */}
          {!env.enableHandles && acceptingToggle}

          {/* 受け取り: 受取先と受取チェーンは一度決めたら変えないので、要約 + 「設定」(シート)。 */}
          <SectionCard
            title={t('receiveHeading')}
            headingId="mobile-order-receive-heading"
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
            {effectiveReceiver ? (
              <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
                <span className="font-mono text-slate-900">{shortAddress(effectiveReceiver)}</span>
                {autofill.matchesConnected ? (
                  <span className="text-xs text-emerald-700">{t('receiverIsWallet')}</span>
                ) : null}
              </p>
            ) : (
              <p className="text-sm text-slate-500">{t('receiverUnsetHandle')}</p>
            )}
            <p className="mt-1 text-xs text-slate-500">
              {draft.chains.map((c) => `JPYC · ${JPYC_CHAIN_LABEL[c]}`).join(' / ')}
            </p>
          </SectionCard>
          <ShopSettingsSheet
            open={receiveOpen}
            onClose={() => setReceiveOpen(false)}
            title={t('receiveSettingsTitle')}
            doneLabel={t('receiveDone')}
          >
            <ShopSettingsSection title={t('receiveHeading')}>
                  <Field label={t('receiverLabel')} hint={t('receiverHint')}>
                    <AddressInput
                      value={draft.receiver}
                      onChange={autofill.handleManualChange}
                    />
                    <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1">
                      {autofill.canUseConnected && (
                        <button
                          type="button"
                          onClick={autofill.useConnectedWallet}
                          className="text-xs font-medium text-brand hover:underline"
                        >
                          {t('useConnectedWallet')}
                        </button>
                      )}
                      {/* レジと同様、決済QR の受取先をワンタップで流用 (引き継ぎ)。 */}
                      {qrReceiver && qrReceiver !== draft.receiver.trim() && (
                        <button
                          type="button"
                          onClick={() => autofill.handleManualChange(qrReceiver)}
                          className="text-xs font-medium text-brand hover:underline"
                        >
                          {t('useQrReceiver')}
                        </button>
                      )}
                    </div>
                  </Field>
                  {/* 受取チェーンは複数選択可 (顧客が注文ページで選ぶ)。最低 1 件。受取先は全チェーン共通。 */}
                  <Field label={t('chainLabel')} hint={t('chainHint')}>
                    <div className="flex flex-wrap gap-2">
                      {MOBILE_ORDER_CHAINS.map((slug) => {
                        const checked = draft.chains.includes(slug);
                        return (
                          <label
                            key={slug}
                            className={`flex cursor-pointer items-center gap-1.5 rounded-lg border px-3 py-2 text-sm transition ${
                              checked
                                ? 'border-brand bg-brand/5 font-medium text-brand-dark'
                                : 'border-slate-300 text-slate-600 hover:border-slate-400'
                            }`}
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => toggleChain(slug)}
                              aria-label={`JPYC (${JPYC_CHAIN_LABEL[slug]})`}
                            />
                            JPYC ({JPYC_CHAIN_LABEL[slug]})
                          </label>
                        );
                      })}
                    </div>
                  </Field>
              {/* 受取先は @handle 共通 (config.to)。公開の更新でここの受取先に揃う (変わるときは状態カードに黄色の注意)。 */}
              {env.enableHandles && (
                <p className="text-xs leading-snug text-slate-500">{t('publishReceiverShared')}</p>
              )}
            </ShopSettingsSection>
          </ShopSettingsSheet>

          {/* お店の情報: 店名とひとことは常に。画像・店舗情報・SNS は任意なので畳む (入れた数を見出しに)。 */}
          <SectionCard title={t('shopHeading')} headingId="mobile-order-shop-heading" icon={Store}>
            <div className="space-y-4">
                <Field label={t('shopNameLabel')}>
                  <input
                    type="text"
                    value={draft.shopName}
                    maxLength={SHOP_NAME_MAX}
                    placeholder={t('shopNamePlaceholder')}
                    onChange={(e) => update({ shopName: e.target.value })}
                    className={inputClass}
                  />
                </Field>

                {/* 店名の下に出すひとこと (任意・キャッチコピー)。 */}
                <Field label={t('taglineLabel')}>
                  <input
                    type="text"
                    value={draft.tagline}
                    maxLength={TAGLINE_MAX}
                    placeholder={t('taglinePlaceholder')}
                    onChange={(e) => update({ tagline: e.target.value })}
                    className={inputClass}
                  />
                </Field>
              <OptionalGroup icon={ImageIcon} title={t('groupImages')} filled={filledImages} filledLabel={filledLabel}>
                  {/* 店舗アイコン (https URL・@handle のアバターと同型)。左に円形プレビュー。 */}
                  <Field label={t('avatarLabel')} hint={t('avatarHint')}>
                    <div className="flex items-center gap-3">
                      <span className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-full bg-brand text-lg font-bold text-white">
                        {avatarPreview && !failedImageUrls.includes(avatarPreview) ? (
                          // 任意の第三者 https 画像。Referer (OpenPay の origin) を画像ホストへ渡さない。
                          <ExternalImage
                            src={avatarPreview}
                            alt=""
                            referrerPolicy="no-referrer"
                            loading="lazy"
                            decoding="async"
                            className="h-full w-full object-cover"
                            onError={() => markImageFailed(avatarPreview)}
                          />
                        ) : (
                          <span aria-hidden>{previewInitial}</span>
                        )}
                      </span>
                      <input
                        type="url"
                        value={draft.avatar}
                        placeholder="https://"
                        onChange={(e) => update({ avatar: e.target.value })}
                        className={inputClass}
                      />
                    </div>
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

                  {/* 店舗カバー (ヘッダー背景画像・https URL・任意)。横長プレビュー。 */}
                  <Field label={t('coverLabel')} hint={t('coverHint')}>
                    <div className="space-y-2">
                      {coverPreview &&
                        (failedImageUrls.includes(coverPreview) ? (
                          // 読込失敗は同寸の装飾枠で置き換える。枠ごと消すと入力中の途中 URL が失敗する
                          // たびに下の入力欄が上下に跳ねるため (打鍵ごとのレイアウト崩れへの波及を断つ)。
                          <div aria-hidden className="h-24 w-full rounded-lg bg-slate-100" />
                        ) : (
                          // 任意の第三者 https 画像。
                          <ExternalImage
                            src={coverPreview}
                            alt=""
                            referrerPolicy="no-referrer"
                            loading="lazy"
                            decoding="async"
                            className="h-24 w-full rounded-lg object-cover"
                            onError={() => markImageFailed(coverPreview)}
                          />
                        ))}
                      <input
                        type="url"
                        value={draft.cover}
                        placeholder="https://"
                        onChange={(e) => update({ cover: e.target.value })}
                        className={inputClass}
                      />
                    </div>
                  </Field>
              </OptionalGroup>
              <OptionalGroup icon={MapPin} title={t('groupShopInfo')} filled={filledShopInfo} filledLabel={filledLabel}>
                  {/* 店舗情報 (任意)。入力された項目だけ公開ページに表示される。 */}
                  <Field label={t('addressLabel')} hint={t('addressHint')}>
                    <input
                      type="text"
                      value={draft.address}
                      maxLength={ADDRESS_MAX}
                      placeholder={t('addressPlaceholder')}
                      onChange={(e) => update({ address: e.target.value })}
                      className={inputClass}
                    />
                  </Field>

                  <Field label={t('hoursLabel')} hint={t('hoursHint')}>
                    <input
                      type="text"
                      value={draft.hours}
                      maxLength={HOURS_MAX}
                      placeholder={t('hoursPlaceholder')}
                      onChange={(e) => update({ hours: e.target.value })}
                      className={inputClass}
                    />
                  </Field>

                  <Field label={t('phoneLabel')} hint={t('phoneHint')}>
                    <input
                      type="tel"
                      value={draft.phone}
                      maxLength={PHONE_MAX}
                      placeholder={t('phonePlaceholder')}
                      onChange={(e) => update({ phone: e.target.value })}
                      className={inputClass}
                    />
                  </Field>

                  {/* 確認リンクと注意を <label> の外に置く (入力のアクセシブル名にリンク文言を混ぜない)。 */}
                  <div className="block">
                    <label htmlFor="mobile-order-invoice-no" className="text-sm font-medium text-slate-700">
                      {t('invoiceNoLabel')}
                    </label>
                    <div className="mt-1">
                    <InvoiceNumberInput
                      id="mobile-order-invoice-no"
                      value={draft.invoiceNo}
                      onChange={(next) => update({ invoiceNo: next })}
                      hasStoreName={draft.shopName.trim().length > 0}
                      className={inputClass}
                      text={{
                        invalid: t('invoiceNoInvalid'),
                        lookup: t('invoiceNoLookup'),
                        needsStoreName: t('invoiceNoNeedsStoreName'),
                      }}
                    />
                    </div>
                    <p className="mt-1 text-xs text-slate-500">{t('invoiceNoHint')}</p>
                  </div>
              </OptionalGroup>
              <OptionalGroup icon={Share2} title={t('groupSns')} filled={filledSns} filledLabel={filledLabel} groupId="mobile-order-group-sns">
                  <div role="group" aria-labelledby="mobile-order-group-sns">
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
                            placeholder="https://x.com/yourshop"
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
                      {draft.socials.length < SOCIALS_MAX && (
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
            </div>
          </SectionCard>

          {/* 受け渡し: 店頭/事前・テイクアウト/店内・受付時間・手数料の負担。 */}
          <SectionCard title={t('groupHandoff')} headingId="mobile-order-handoff-heading" icon={UtensilsCrossed}>
            <div className="space-y-4">
                <fieldset>
                  <legend className="text-sm font-medium text-slate-700">{t('modeLabel')}</legend>
                  <div className="mt-1 inline-flex rounded-lg border border-slate-200 bg-slate-100 p-1">
                    {(
                      [
                        ['storefront', t('modeStorefront')],
                        ['preorder', t('modePreorder')],
                      ] as const
                    ).map(([value, label]) => (
                      <button
                        key={value}
                        type="button"
                        onClick={() =>
                          // preorder は来店前注文ゆえテーブル予約不可 → 提供形態をテイクアウトに戻す。
                          update(value === 'preorder' ? { mode: value, dineIn: false } : { mode: value })
                        }
                        aria-pressed={draft.mode === value}
                        className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
                          draft.mode === value
                            ? 'bg-white text-brand-dark shadow-sm'
                            : 'text-slate-500 hover:text-slate-800'
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <p className="mt-1 text-xs text-slate-500">
                    {draft.mode === 'storefront' ? t('modeHintStorefront') : t('modeHintPreorder')}
                  </p>
                </fieldset>

                {/* 提供形態 (テイクアウト / 店内)。店内なら公開ページで注文時にテーブル番号を入力させる。
                    preorder (事前注文) は来店前ゆえテーブル予約不可 → テイクアウト固定で toggle を出さない。 */}
                <fieldset>
                  <legend className="text-sm font-medium text-slate-700">{t('serviceLabel')}</legend>
                  {draft.mode === 'storefront' ? (
                    <>
                      <div className="mt-1 inline-flex rounded-lg border border-slate-200 bg-slate-100 p-1">
                        {(
                          [
                            [false, t('serviceTakeout')],
                            [true, t('serviceDineIn')],
                          ] as const
                        ).map(([value, label]) => (
                          <button
                            key={String(value)}
                            type="button"
                            onClick={() => update({ dineIn: value })}
                            aria-pressed={draft.dineIn === value}
                            className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
                              draft.dineIn === value
                                ? 'bg-white text-brand-dark shadow-sm'
                                : 'text-slate-500 hover:text-slate-800'
                            }`}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                      <p className="mt-1 text-xs text-slate-500">
                        {draft.dineIn ? t('serviceHintDineIn') : t('serviceHintTakeout')}
                      </p>
                    </>
                  ) : (
                    <p className="mt-1 text-xs text-slate-500">{t('serviceTakeoutOnlyNote')}</p>
                  )}
                </fieldset>
                {/* 時間系 (Phase 4・flag NEXT_PUBLIC_ENABLE_PREORDER_TIME)。OFF=非表示=inert。
                    受付開始/ラストオーダー=両モード、最短受け渡し=preorder のみ。Asia/Tokyo 固定。 */}
                {env.enablePreorderTime && (
                  <OptionalGroup icon={Clock} title={t('timeLabel')} filled={filledTime} filledLabel={filledLabel}>
                    <Field label={t('openFromLabel')} hint={t('openFromHint')}>
                      <input
                        type="time"
                        value={draft.openFrom}
                        onChange={(e) => update({ openFrom: e.target.value })}
                        className={inputClass}
                      />
                    </Field>
                    <Field label={t('lastOrderLabel')} hint={t('lastOrderHint')}>
                      <input
                        type="time"
                        value={draft.lastOrder}
                        onChange={(e) => update({ lastOrder: e.target.value })}
                        className={inputClass}
                      />
                    </Field>
                    {draft.mode === 'preorder' && (
                      <Field label={t('minLeadLabel')} hint={t('minLeadHint')}>
                        <input
                          type="number"
                          inputMode="numeric"
                          min={1}
                          max={MIN_LEAD_MAX}
                          value={draft.minLeadMinutes}
                          onChange={(e) =>
                            update({ minLeadMinutes: e.target.value.replace(/[^\d]/g, '').slice(0, 4) })
                          }
                          placeholder={t('minLeadPlaceholder')}
                          className={inputClass}
                        />
                      </Field>
                    )}
                  </OptionalGroup>
                )}
                {/* 手数料の負担者は事前モバイルオーダー時のみ意味を持つ (店頭は運営負担)。
                    ⚠️ 料率はここでは表示しない (P0/P2 ゲート)。 */}
                {draft.mode === 'preorder' && (
                  <fieldset>
                    <legend className="text-sm font-medium text-slate-700">{t('feePayerLabel')}</legend>
                    <div className="mt-1 space-y-1.5">
                      {(
                        [
                          ['merchant', t('feePayerMerchant')],
                          ['customer', t('feePayerCustomer')],
                        ] as const
                      ).map(([value, label]) => (
                        <label key={value} className="flex cursor-pointer items-center gap-2 text-sm text-slate-700">
                          <input
                            type="radio"
                            name="mo-feepayer"
                            checked={draft.feePayer === value}
                            onChange={() => update({ feePayer: value })}
                          />
                          {label}
                        </label>
                      ))}
                    </div>
                    <p className="mt-1 text-xs text-slate-500">{t('feePayerHint')}</p>
                  </fieldset>
                )}
            </div>
          </SectionCard>

          {/* メニュー = レジの有効な JPYC 商品 (読み取り専用・編集はレジで) */}
          <SectionCard title={t('stepMenuTitle')} headingId="mobile-order-menu-heading" icon={UtensilsCrossed}>
            <div className="space-y-3">
              <p className="text-sm text-slate-500">{t('menuFromPresetsNote')}</p>
              {hydrated && menuItems.length === 0 ? (
                <p className="text-xs text-amber-700">{t('menuEmptyNote')}</p>
              ) : (
                <>
                  {/* メニューは「レジ」で管理する読み取り専用一覧。多いと長くなるので折りたたみ (既定=閉)。 */}
                  <button
                    type="button"
                    onClick={() => setMenuOpen((o) => !o)}
                    aria-expanded={menuOpen}
                    className="flex w-full items-center justify-between rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-600 hover:border-brand"
                  >
                    <span className="sr-only">{t('menuToggleLabel')}</span>
                    <span>{t('menuItemsCount', { count: menuItems.length })}</span>
                    {menuOpen ? (
                      <ChevronUp className="h-4 w-4 text-slate-400" aria-hidden />
                    ) : (
                      <ChevronDown className="h-4 w-4 text-slate-400" aria-hidden />
                    )}
                  </button>
                  {menuOpen && (
                    <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200">
                      {menuItems.map((item) => {
                        const imgUrl =
                          item.visual?.kind === 'image' ? safeHttpUrl(item.visual.url) : undefined;
                        return (
                          <li key={item.id} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
                            <span className="flex min-w-0 items-center gap-2">
                              {imgUrl && !failedImageUrls.includes(imgUrl) && (
                                // 任意の第三者 https 画像。失敗時は画像だけ隠し商品名を残す。
                                <ExternalImage
                                  src={imgUrl}
                                  alt=""
                                  referrerPolicy="no-referrer"
                                  loading="lazy"
                                  decoding="async"
                                  className="h-7 w-7 rounded object-cover"
                                  onError={() => markImageFailed(imgUrl)}
                                />
                              )}
                              <span className="truncate text-slate-800">{item.name}</span>
                            </span>
                            <span className="shrink-0 font-medium text-slate-900">{item.price} JPYC</span>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </>
              )}
              {onManageProducts && (
                <button
                  type="button"
                  onClick={onManageProducts}
                  className="text-sm font-medium text-brand hover:underline"
                >
                  {t('manageInRegister')}
                </button>
              )}
            </div>
          </SectionCard>
        </div>

          <div className="min-w-0 lg:sticky lg:top-4 lg:col-start-2 lg:row-start-2 lg:self-start">
            <SectionCard title={t('stepPreviewTitle')} headingId="mobile-order-preview-heading" icon={Eye}>
              {/* 客のスマホでの見え方を、実際の店舗ページ (MobileOrderView) を下書きで描いて
                  WYSIWYG 表示 (カバー/ヘッダー/メニュー/テーマ/カートバーまで実物どおり)。
                  スマホフレーム内に収め、スクロールで全体を確認できる。高さは控えめにして
                  (max-h-[46vh])、ページ/サイド列のスクロールバーと内側バーが隣り合って二重に
                  見えるのを避ける。 */}
              {hydrated && (
                <div className="mx-auto max-w-[360px] overflow-hidden rounded-[2rem] border-[6px] border-slate-900 bg-white shadow-xl ring-1 ring-black/5">
                  <div className="max-h-[46vh] overflow-y-auto px-4 py-4">
                    <MobileOrderView config={previewConfig} shopNamePending={!draft.shopName.trim()} />
                  </div>
                </div>
              )}
  
              <p className="mt-3 text-xs text-slate-500">{t('previewOpenHint')}</p>
              {/* 公開ボタンの帯 (PC)。プレビューと一緒に追従する。スマホは画面下のバー。どちらもお店のページの部品が描く。 */}
              {env.enableHandles && (
                <div ref={setDesktopBarSlot} className="mt-4 hidden border-t border-slate-100 pt-4 lg:block" />
              )}
            </SectionCard>
          </div>

      {/* スマホの下部バー (お店のページの「公開」)。決済QR・レジの会計バーと同じく sticky で、ビルダーを
          見ている間は画面の下に張り付き、下の換金・ガイドまで進むと一緒に流れる (フッターを隠さない)。 */}
      {env.enableHandles && (
        <div
          ref={setBarSlot}
          className="sticky bottom-14 z-20 -mx-4 border-t border-slate-200/70 bg-white/85 px-4 py-2.5 backdrop-blur-md supports-[backdrop-filter]:bg-white/75 md:bottom-0 lg:hidden print:hidden"
        />
      )}
    </div>
  );
}
