'use client';

// 「モバイルオーダー」タブ: 店舗が 受取先 + 店舗設定 (店頭/事前・SNS) を編集し、顧客向け
// 「注文ページ URL」(設定一式を base64url で同梱) を発行するビルダー。
// **メニューは独立管理しない** — レジの商品プリセット (有効な JPYC 商品) を単一カタログとして
// 共有・読み取り表示し、URL に焼き込む (商品の追加/編集/画像/税率は「レジ」タブで一元管理)。
// レイアウトは他タブと同じ 2 カラム。下書きは useMobileOrderDraft。flag OFF で何も描画しない。
//
// ⚠️ 手数料率 (店頭/モバイル) はここでは扱わない/表示しない — 課金の実行と開示は P0/P2 ゲート後。

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Eye, Store, UtensilsCrossed, Wallet } from 'lucide-react';
import { getAddress, isAddress, type Address } from 'viem';
import { env } from '@/lib/env';
import { AddressInput } from '@/components/AddressInput';
import { StepCard } from '@/components/StepCard';
import { LinkQrModal } from '@/components/LinkQrModal';
import { useMobileOrderDraft, draftToConfig, presetsToMenu } from '@/hooks/useMobileOrderDraft';
import { useProductPresets } from '@/hooks/useProductPresets';
import { useReceiverAutofill } from '@/hooks/useReceiverAutofill';
import { useOrigin } from '@/hooks/useOrigin';
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard';
import { useQrSettings } from '@/hooks/useQrSettings';
import { JPYC_CHAINS, type JpycChainSlug } from '@/lib/chains';
import { buildOrderUrl, safeHttpUrl, JPYC_CHAIN_LABEL, SHOP_NAME_MAX } from '@/lib/mobileOrder';

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

  const update = (patch: Partial<typeof draft>) => setSettings((s) => ({ ...s, ...patch }));

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
                  <input
                    type="url"
                    value={draft.socialX}
                    placeholder="https://x.com/yourshop"
                    onChange={(e) => update({ socialX: e.target.value })}
                    className={inputClass}
                  />
                  <input
                    type="url"
                    value={draft.socialInstagram}
                    placeholder="https://instagram.com/yourshop"
                    onChange={(e) => update({ socialInstagram: e.target.value })}
                    className={inputClass}
                  />
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
