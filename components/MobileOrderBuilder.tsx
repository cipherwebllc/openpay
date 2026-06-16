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
import { Eye, GripVertical, Store, UtensilsCrossed, Wallet } from 'lucide-react';
import { getAddress, isAddress, type Address } from 'viem';
import { env } from '@/lib/env';
import { AddressInput } from '@/components/AddressInput';
import { StepCard } from '@/components/StepCard';
import { LinkQrModal } from '@/components/LinkQrModal';
import { SocialIcon } from '@/components/SocialIconLinks';
import { useMobileOrderDraft, draftToConfig, presetsToMenu } from '@/hooks/useMobileOrderDraft';
import { useProductPresets } from '@/hooks/useProductPresets';
import { useReceiverAutofill } from '@/hooks/useReceiverAutofill';
import { useOrigin } from '@/hooks/useOrigin';
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard';
import { useQrSettings } from '@/hooks/useQrSettings';
import { JPYC_CHAINS, type JpycChainSlug } from '@/lib/chains';
import {
  buildOrderUrl,
  safeHttpUrl,
  JPYC_CHAIN_LABEL,
  SHOP_NAME_MAX,
  SOCIALS_MAX,
} from '@/lib/mobileOrder';

// QR を描く URL の上限長 (qrcode.react は長大入力で throw する)。超過時は QR を省略し
// リンク/コピーのみ提供する (TipEmbedGenerator と同方針)。メニューが多いと URL が伸びる。
const QR_MAX_URL_LEN = 1200;

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
}: {
  /** 「レジで商品を管理」導線 (create ページが register タブへ切替える)。 */
  onManageProducts?: () => void;
} = {}) {
  const t = useTranslations('MobileOrder');
  const { settings: draft, setSettings, hydrated, setReceiver } = useMobileOrderDraft();
  const { presets } = useProductPresets();
  const origin = useOrigin();
  const linkCopy = useCopyToClipboard();
  // 決済QR タブの受取先 (レジと同じく「引き継ぐ」ショートカット用)。
  const { settings: qrSettings } = useQrSettings();
  const qrReceiver = qrSettings.receiver.trim();
  const [resolved, setResolved] = useState<Address | null>(null);
  const [showQr, setShowQr] = useState(false);

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

  const config = useMemo(
    () => (hydrated ? draftToConfig(draft, effectiveReceiver, presets) : null),
    [hydrated, draft, effectiveReceiver, presets],
  );
  const orderUrl = config && origin ? buildOrderUrl(origin, config) : '';

  // URL が組めない理由 (右カラムのチェックリスト)。core 3 条件で導く。
  const hasReceiver = effectiveReceiver !== null;
  const hasShopName = draft.shopName.trim().length > 0;
  const hasMenu = menuItems.length > 0;

  // 店舗アイコンのプレビュー (https のみ・読込前検証)。無ければ店名の頭文字を円に表示。
  const avatarPreview = safeHttpUrl(draft.avatar.trim());
  const previewInitial = ([...draft.shopName.trim()][0] ?? '').toUpperCase();

  const update = (patch: Partial<typeof draft>) => setSettings((s) => ({ ...s, ...patch }));

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
          {/* ① 受取先 (店舗ウォレット) + 受取チェーン (JPYC・単一) */}
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

              <Field label={t('chainLabel')} hint={t('chainHint')}>
                <select
                  value={draft.chain}
                  onChange={(e) => update({ chain: e.target.value as JpycChainSlug })}
                  className={inputClass}
                  aria-label={t('chainLabel')}
                >
                  {JPYC_CHAINS.map((slug) => (
                    <option key={slug} value={slug}>
                      {JPYC_CHAIN_LABEL[slug]}
                    </option>
                  ))}
                </select>
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
              <div className="flex items-center justify-between">
                {onManageProducts ? (
                  <button
                    type="button"
                    onClick={onManageProducts}
                    className="text-sm font-medium text-brand hover:underline"
                  >
                    {t('manageInRegister')}
                  </button>
                ) : (
                  <span />
                )}
                {menuItems.length > 0 && (
                  <span className="text-xs text-slate-400">
                    {t('menuItemsCount', { count: menuItems.length })}
                  </span>
                )}
              </div>
            </div>
          </StepCard>
        </div>

        {/* 右カラム: ④ プレビュー + 注文 URL (desktop は sticky) */}
        <aside className="mt-6 min-w-0 self-start lg:mt-0 lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:overflow-y-auto">
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
                  <ul className="mt-3 space-y-1.5">
                    {menuItems.map((item) => {
                      const imgUrl =
                        item.visual?.kind === 'image' ? safeHttpUrl(item.visual.url) : undefined;
                      return (
                        <li key={item.id} className="flex items-center justify-between gap-2 text-sm">
                          <span className="flex min-w-0 items-center gap-1.5">
                            {imgUrl && (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img src={imgUrl} alt="" className="h-5 w-5 rounded object-cover" />
                            )}
                            <span className="truncate text-slate-700">{item.name}</span>
                          </span>
                          <span className="shrink-0 font-medium text-slate-900">{item.price}</span>
                        </li>
                      );
                    })}
                  </ul>
                  {menuItems.length === 0 && (
                    <p className="mt-2 text-center text-xs text-slate-400">{t('previewNoMenu')}</p>
                  )}
                </div>
              </div>
            )}

            <div className="mt-4">
              <p className="text-sm font-semibold text-slate-700">{t('orderUrlTitle')}</p>
              {orderUrl ? (
                <div className="mt-2 space-y-2">
                  <p className="break-all rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">{orderUrl}</p>
                  <div className="flex flex-wrap gap-1.5">
                    <button
                      type="button"
                      onClick={() => void linkCopy.copy(orderUrl)}
                      className="rounded-md bg-slate-900 px-2 py-1 text-xs font-semibold text-white hover:bg-slate-700"
                    >
                      {linkCopy.copied ? t('copied') : t('copy')}
                    </button>
                    <a
                      href={orderUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="rounded-md border border-slate-200 px-2 py-1 text-xs font-semibold text-slate-600 hover:border-brand hover:text-brand"
                    >
                      {t('open')}
                    </a>
                    {orderUrl.length <= QR_MAX_URL_LEN ? (
                      <button
                        type="button"
                        onClick={() => setShowQr(true)}
                        className="rounded-md border border-slate-200 px-2 py-1 text-xs font-semibold text-slate-600 hover:border-brand hover:text-brand"
                      >
                        {t('showQr')}
                      </button>
                    ) : (
                      <span className="text-xs text-slate-400">{t('qrTooLong')}</span>
                    )}
                  </div>
                  <p className="text-xs text-slate-400">{t('orderUrlHint')}</p>
                  <p className="text-xs text-amber-700">{t('shareAgainHint')}</p>
                </div>
              ) : (
                <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  <p className="font-medium">{t('needLabel')}</p>
                  <ul className="mt-1 list-inside list-disc space-y-0.5">
                    {!hasReceiver && <li>{t('needReceiver')}</li>}
                    {!hasShopName && <li>{t('needShopName')}</li>}
                    {!hasMenu && <li>{t('needMenu')}</li>}
                    {hasReceiver && hasShopName && hasMenu && <li>{t('needValid')}</li>}
                  </ul>
                </div>
              )}
            </div>
          </StepCard>
        </aside>
      </div>

      <LinkQrModal
        open={showQr && orderUrl !== ''}
        value={orderUrl}
        title={draft.shopName.trim() || t('builderHeading')}
        closeLabel={t('qrClose')}
        onClose={() => setShowQr(false)}
      />
    </div>
  );
}
