'use client';

// 「モバイルオーダー」タブ: 店舗が 受取先 + 店舗設定 (店頭/事前・SNS) を編集し、顧客向け
// 「注文ページ URL」(設定一式を base64url で同梱) を発行するビルダー。
// **メニューは独立管理しない** — レジの商品プリセット (有効な JPYC 商品) を単一カタログとして
// 共有・読み取り表示し、URL に焼き込む (商品の追加/編集/画像/税率は「レジ」タブで一元管理)。
// レイアウトは他タブと同じ 2 カラム。下書きは useMobileOrderDraft。flag OFF で何も描画しない。
//
// ⚠️ 手数料率 (店頭/モバイル) はここでは扱わない/表示しない — 課金の実行と開示は P0/P2 ゲート後。

import { useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronDown, ChevronUp, Eye, GripVertical, Store, UtensilsCrossed, Wallet } from 'lucide-react';
import { getAddress, isAddress, type Address } from 'viem';
import { env } from '@/lib/env';
import { AddressInput } from '@/components/AddressInput';
import { StepCard } from '@/components/StepCard';
import { SocialIcon, SocialIconLinks } from '@/components/SocialIconLinks';
import { StorefrontPublishPanel } from '@/components/StorefrontPublishPanel';
import { useMobileOrderDraft, presetsToMenu } from '@/hooks/useMobileOrderDraft';
import { useProductPresets } from '@/hooks/useProductPresets';
import { useReceiverAutofill } from '@/hooks/useReceiverAutofill';
import { useQrSettings } from '@/hooks/useQrSettings';
import { type JpycChainSlug } from '@/lib/chains';
import {
  safeHttpUrl,
  JPYC_CHAIN_LABEL,
  MOBILE_ORDER_CHAINS,
  SHOP_NAME_MAX,
  SOCIALS_MAX,
  ADDRESS_MAX,
  HOURS_MAX,
  PHONE_MAX,
} from '@/lib/mobileOrder';

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
      {hint && <p className="mt-1 text-xs text-slate-400">{hint}</p>}
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
  const { settings: draft, setSettings, hydrated, setReceiver } = useMobileOrderDraft();
  const { presets } = useProductPresets();
  // 決済QR タブの受取先 (レジと同じく「引き継ぐ」ショートカット用)。
  const { settings: qrSettings } = useQrSettings();
  const qrReceiver = qrSettings.receiver.trim();
  const [resolved, setResolved] = useState<Address | null>(null);
  // ③メニュー (レジ管理の読み取り専用一覧) の開閉。多いと長くなるので既定は閉じる。
  const [menuOpen, setMenuOpen] = useState(false);

  // 受取先: 生 0x は入力値を最優先 (ENS 名のときだけ AddressInput の解決値を使う)。
  const effectiveReceiver = useMemo<Address | null>(() => {
    const raw = draft.receiver.trim();
    if (isAddress(raw)) return getAddress(raw);
    return resolved;
  }, [draft.receiver, resolved]);

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
        avatar: draft.avatar.trim() || undefined,
        socials: draft.socials.map((s) => s.trim()).filter(Boolean),
        address: draft.address.trim() || undefined,
        hours: draft.hours.trim() || undefined,
        phone: draft.phone.trim() || undefined,
        acceptingOrders: draft.acceptingOrders,
        dineIn: draft.dineIn, // 店内なら公開ページで注文時にテーブル番号を入力させる
        menu: menuItems,
      }
    : null;

  const update = (patch: Partial<typeof draft>) => setSettings((s) => ({ ...s, ...patch }));

  // 受取チェーンの複数選択トグル。最低 1 件は維持 (空選択は不可)。
  const toggleChain = (slug: JpycChainSlug) => {
    const has = draft.chains.includes(slug);
    const next = has ? draft.chains.filter((c) => c !== slug) : [...draft.chains, slug];
    if (next.length > 0) update({ chains: next });
  };

  // SNS の並べ替え (@handle プロフと同型: ドラッグ + ▲▼ ボタンの 2 系統)。
  const dragIndex = useRef<number | null>(null);
  const moveItem = <T,>(arr: T[], from: number, to: number): T[] => {
    const next = [...arr];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    return next;
  };
  // ▲▼ ボタン。drag を発火しないモバイル/キーボード操作のための並べ替え手段。境界では disabled。
  const renderMoveButtons = (index: number, length: number) => (
    <span className="flex shrink-0 flex-col">
      <button
        type="button"
        onClick={() => update({ socials: moveItem(draft.socials, index, index - 1) })}
        disabled={index === 0}
        aria-label={t('moveUp')}
        title={t('moveUp')}
        className="leading-none text-slate-300 hover:text-slate-600 disabled:opacity-30"
      >
        ▲
      </button>
      <button
        type="button"
        onClick={() => update({ socials: moveItem(draft.socials, index, index + 1) })}
        disabled={index >= length - 1}
        aria-label={t('moveDown')}
        title={t('moveDown')}
        className="leading-none text-slate-300 hover:text-slate-600 disabled:opacity-30"
      >
        ▼
      </button>
    </span>
  );

  if (!env.enableMobileOrder) return null;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-slate-800">{t('builderHeading')}</h2>
        <p className="mt-1 text-sm text-slate-500">{t('builderSubheading')}</p>
      </div>

      <div className="lg:grid lg:grid-cols-[1fr_minmax(300px,360px)] lg:items-start lg:gap-6">
        <div className="min-w-0 space-y-5">
          {/* 注文の受付トグル (開店=受付中 / 閉店=停止中 を都度切替)。最上部に置きクリックしやすく。
              停止中は公開ページの支払いを止める (不可逆決済の事故防止)。 */}
          <div className="rounded-xl border border-slate-200 bg-white p-3">
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm font-medium text-slate-700">{t('acceptingLabel')}</span>
              <button
                type="button"
                role="switch"
                aria-checked={draft.acceptingOrders}
                aria-label={t('acceptingLabel')}
                onClick={() => update({ acceptingOrders: !draft.acceptingOrders })}
                className={`shrink-0 rounded-full px-4 py-1.5 text-sm font-semibold transition ${
                  draft.acceptingOrders
                    ? 'bg-emerald-100 text-emerald-700'
                    : 'bg-slate-200 text-slate-500'
                }`}
              >
                {draft.acceptingOrders ? t('acceptingOn') : t('acceptingOff')}
              </button>
            </div>
            <p className="mt-1 text-xs text-slate-400">{t('acceptingHint')}</p>
            <p className="mt-1 text-xs text-amber-700">{t('acceptingRepublishNote')}</p>
          </div>

          {/* ① 受取先 (店舗ウォレット) + 受取チェーン (JPYC・複数選択可) */}
          <StepCard step={1} icon={Wallet} title={t('stepReceiverTitle')}>
            <div className="space-y-4">
              <Field label={t('receiverLabel')} hint={t('receiverHint')}>
                <AddressInput
                  value={draft.receiver}
                  onChange={autofill.handleManualChange}
                  onResolved={setResolved}
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
            </div>
          </StepCard>

          {/* ② 店舗設定 (店名・モード・SNS) */}
          <StepCard step={2} icon={Store} title={t('stepShopTitle')}>
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

              {/* 店舗アイコン (https URL・@handle のアバターと同型)。左に円形プレビュー。 */}
              <Field label={t('avatarLabel')} hint={t('avatarHint')}>
                <div className="flex items-center gap-3">
                  <span className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-full bg-brand text-lg font-bold text-white">
                    {avatarPreview ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={avatarPreview} alt="" className="h-full w-full object-cover" />
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
                      onClick={() => update({ mode: value })}
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
                <p className="mt-1 text-xs text-slate-400">
                  {draft.mode === 'storefront' ? t('modeHintStorefront') : t('modeHintPreorder')}
                </p>
              </fieldset>

              {/* 提供形態 (テイクアウト / 店内)。店内なら公開ページで注文時にテーブル番号を入力させる。 */}
              <fieldset>
                <legend className="text-sm font-medium text-slate-700">{t('serviceLabel')}</legend>
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
                <p className="mt-1 text-xs text-slate-400">
                  {draft.dineIn ? t('serviceHintDineIn') : t('serviceHintTakeout')}
                </p>
              </fieldset>

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
                  <p className="mt-1 text-xs text-slate-400">{t('feePayerHint')}</p>
                </fieldset>
              )}

              <Field label={t('socialsLabel')} hint={t('socialsHint')}>
                <div className="space-y-2">
                  {draft.socials.map((s, i) => (
                    <div
                      key={i}
                      className="flex items-center gap-2"
                      onDragOver={(e) => {
                        if (dragIndex.current !== null) e.preventDefault();
                      }}
                      onDrop={(e) => {
                        const from = dragIndex.current;
                        if (from === null) return;
                        e.preventDefault();
                        if (from !== i) update({ socials: moveItem(draft.socials, from, i) });
                        dragIndex.current = null;
                      }}
                    >
                      <span
                        draggable
                        onDragStart={() => {
                          dragIndex.current = i;
                        }}
                        onDragEnd={() => {
                          dragIndex.current = null;
                        }}
                        role="button"
                        aria-label={t('dragToReorder')}
                        title={t('dragToReorder')}
                        className="shrink-0 cursor-grab select-none text-slate-300 hover:text-slate-500"
                      >
                        <GripVertical className="h-4 w-4" />
                      </span>
                      {renderMoveButtons(i, draft.socials.length)}
                      <span className="shrink-0 text-slate-400">
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
                        className="rounded-md border border-slate-200 px-2 text-sm text-slate-400 hover:text-red-600"
                        aria-label={t('removeSocial')}
                      >
                        ×
                      </button>
                    </div>
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
              </Field>
            </div>
          </StepCard>

          {/* ③ メニュー = レジの有効な JPYC 商品 (読み取り専用・編集はレジで) */}
          <StepCard step={3} icon={UtensilsCrossed} title={t('stepMenuTitle')}>
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
                    aria-label={t('menuToggleLabel')}
                    className="flex w-full items-center justify-between rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-600 hover:border-brand"
                  >
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
                              {imgUrl && (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img src={imgUrl} alt="" className="h-7 w-7 rounded object-cover" />
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
          </StepCard>

        </div>

        {/* 右カラム: @handle 公開 (上) + ④ プレビュー (desktop は sticky) */}
        <aside className="mt-6 min-w-0 space-y-5 self-start lg:mt-0 lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:overflow-y-auto">
          {/* レジ商品を @handle に公開して固定店舗 URL にする (handles ON のときだけマウント:
              react-query を使うため OFF 環境/テストで QueryClient を要求しない)。④ プレビューの上。 */}
          {env.enableHandles && (
            <StorefrontPublishPanel storefront={storefrontParts} onGetHandle={onGetHandle} />
          )}
          <StepCard step={4} icon={Eye} title={t('stepPreviewTitle')}>
            {hydrated && (
              <div className="rounded-xl bg-slate-50 p-4">
                <div className="mx-auto max-w-xs rounded-xl bg-white p-4 shadow-sm">
                  <div className="mx-auto mb-2 flex h-14 w-14 items-center justify-center overflow-hidden rounded-full bg-brand text-lg font-bold text-white">
                    {avatarPreview ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={avatarPreview} alt="" className="h-full w-full object-cover" />
                    ) : (
                      <span aria-hidden>{previewInitial}</span>
                    )}
                  </div>
                  <p className="text-center text-base font-semibold text-slate-800">
                    {draft.shopName.trim() || t('previewShopPlaceholder')}
                  </p>
                  {/* 受取チェーン (複数なら "+N")。プレビューは店舗情報まで・メニューは出さない。 */}
                  <p className="mt-0.5 text-center text-xs text-slate-500">
                    JPYC ({JPYC_CHAIN_LABEL[draft.chains[0]]}
                    {draft.chains.length > 1 ? ` +${draft.chains.length - 1}` : ''})
                  </p>
                  {(draft.hours.trim() || draft.address.trim() || draft.phone.trim()) && (
                    <div className="mt-2 space-y-0.5 text-xs text-slate-500">
                      {draft.hours.trim() && <p className="truncate">{draft.hours.trim()}</p>}
                      {draft.address.trim() && <p className="truncate">{draft.address.trim()}</p>}
                      {draft.phone.trim() && <p className="truncate">{draft.phone.trim()}</p>}
                    </div>
                  )}
                  {/* SNS アイコン (公開ページと同じ描画)。プレビューにも反映。 */}
                  {socialPreview.length > 0 && (
                    <div className="mt-2 flex justify-center">
                      <SocialIconLinks urls={socialPreview} />
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* プレビューは店舗情報まで (メニュー手前)。メニューを含む実際の見え方は、上の
                「@handle に公開」→「店舗ページを開く」で確認してもらう。 */}
            <p className="mt-3 text-xs text-slate-400">{t('previewOpenHint')}</p>
          </StepCard>
        </aside>
      </div>
    </div>
  );
}
