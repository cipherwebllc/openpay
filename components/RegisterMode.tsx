'use client';

// 簡易レジモード (複数商品カート MVP): 商品プリセット選択 or 手入力で商品をカートに追加し、
// 行ごとに数量/単価/税率/メモを編集、小計/税額/合計を即時計算して、明細付き /checkout の QR を
// 生成する。決済画面 (/checkout) で内訳がレシート風に表示され、CheckoutForm が履歴に売上明細
// (lineItems) + per-item 税/管理番号を保存する。
//
// レイアウトは POS レジ風: デスクトップ/タブレットは左右2カラム (左=操作スクロール / 右=会計
// サマリ sticky)、モバイルは1カラム + 画面下部固定の会計バー (合計 + QR ボタン)。
//
// - 受取先/token/chain/gas/mode は QR タブと同じ useQrSettings を共有 (住所再入力不要)。
// - 同一カートは単一通貨 (最初の商品で通貨確定・異通貨プリセットは警告)。チェーンは既存ロジック維持。
// - 本格 POS ではなくイベント販売・少量販売向け。値引/在庫/カテゴリ/レシート印刷/日報は対象外。
//   税額は税込金額からの内税の目安 (記帳補助)。最終的な会計処理は会計ソフト・税理士側で確認。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { formatUnits, type Address } from 'viem';
import { ChevronRight, Minus, Plus, QrCode as QrCodeIcon, Star, Trash2 } from 'lucide-react';
import { AccountingSection } from './AccountingSection';
import { QrPreviewModal } from './QrPreviewModal';
import { Field } from './Field';
import { ProductPresetManager } from './ProductPresetManager';
import { useQrSettings } from '@/hooks/useQrSettings';
import { useReceiverAutofill, type ReceiverSource } from '@/hooks/useReceiverAutofill';
import { useResolveAddress } from '@/hooks/useResolveAddress';
import { useProductPresets, type ProductPreset } from '@/hooks/useProductPresets';
import { randomId } from '@/lib/id';
import { useOrigin } from '@/hooks/useOrigin';
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard';
import { pickEffectiveAddress, shortAddress } from '@/lib/format';
import { isLikelyName } from '@/lib/nameDetection';
import { paymentPolicyKey } from '@/lib/paymentPolicy';
import { resolveJpycGaslessProvider } from '@/lib/jpycGaslessProvider';
import { jpycForwarderFor } from '@/lib/relay/forwarderConfig';
import { chainForSlug } from '@/lib/chains';
import { env } from '@/lib/env';
import { safeHttpUrl } from '@/lib/mobileOrder';
import { DEFAULT_CHAIN_FOR_SYMBOL, deploymentForSlug } from '@/lib/tokens';
import {
  buildCheckoutUrl,
  calcCheckoutTotal,
  CHECKOUT_MAX_ITEMS,
  DECIMAL_PATTERN,
  exceedsTokenPrecision,
  type CheckoutItem,
} from '@/lib/url';
import { taxAmountDecimal, taxDisplayDecimals, type TaxCategory } from '@/lib/tax';
import { TaxCategorySelect } from './TaxCategorySelect';
import { TokenLogo, ChainLogo } from './AssetLogo';

type CartLine = {
  id: string;
  name: string;
  unitPrice: string;
  quantity: number;
  taxRate: number | null;
  taxCategory: TaxCategory | null;
  memo: string;
  presetId?: string;
};

export function RegisterMode({
  onEditCurrency,
}: {
  /** 通貨/チェーンを変更する導線 (page が QR タブへ切替える)。レジは読み取り専用表示。 */
  onEditCurrency?: () => void;
}) {
  const t = useTranslations('RegisterMode');
  const { settings, setSettings, hydrated } = useQrSettings();
  const presetStore = useProductPresets();
  const origin = useOrigin();
  const { copied, copy } = useCopyToClipboard();

  const [cart, setCart] = useState<CartLine[]>([]);
  const [receiptNo, setReceiptNo] = useState('');
  const [resolvedReceiver, setResolvedReceiver] = useState<Address | null>(null);
  const [managerOpen, setManagerOpen] = useState(false);
  const [currencyWarning, setCurrencyWarning] = useState(false);
  // レジの QR も即時表示せず「QRコードを表示する」→ 全画面モーダルで提示。
  const [qrModalOpen, setQrModalOpen] = useState(false);
  const qrRef = useRef<HTMLDivElement>(null);
  const totalBarRef = useRef<HTMLDivElement>(null);

  const effectiveReceiver = pickEffectiveAddress(settings.receiver, resolvedReceiver);
  const setReceiver = useCallback(
    (value: string, source: ReceiverSource) =>
      setSettings((s) => ({ ...s, receiver: value, receiverSource: source })),
    [setSettings],
  );
  // 受取先は決済QRタブから継承 (レジでは編集しない)。autofill は接続ウォレットからの
  // 受取先自動補完の side-effect のために呼ぶ (返り値は読まない)。
  useReceiverAutofill({
    receiver: settings.receiver,
    receiverSource: settings.receiverSource,
    effectiveReceiver,
    hydrated,
    setReceiver,
  });

  // レジは受取先を読み取り表示するため AddressInput を介さない。ENS/.base.eth の
  // 名前解決は AddressInput と同じ hook で自前に行い resolvedReceiver を満たす
  // (これが無いと名前建ての受取先で effectiveReceiver が null のままになり QR が出ない)。
  const receiverName = isLikelyName(settings.receiver.trim())
    ? settings.receiver.trim()
    : '';
  const resolveQuery = useResolveAddress(receiverName);
  useEffect(() => {
    setResolvedReceiver(
      receiverName && resolveQuery.data ? resolveQuery.data.address : null,
    );
  }, [receiverName, resolveQuery.data]);

  // 通貨/チェーンは QR タブで設定 (レジは読み取り専用)。QR タブへ切替えるとレジは unmount され
  // カート/管理番号の編集中 state が破棄されるため、非空カート時は確認してから遷移する。
  function handleEditCurrency() {
    if (cart.length > 0 && !window.confirm(t('editCurrencyConfirm'))) return;
    onEditCurrency?.();
  }

  const deployment = deploymentForSlug(settings.token, settings.chain);
  const symbol = deployment.displaySymbol;
  // 決済QRタブから継承する設定に stale な gasMode が残っていても、経路ごとに正規化する:
  //   JPYC free (relay・無徴収): 負担者の概念が無いため gas=customer 相当 (決済側 useRelay
  //     && !useRecover と同条件)。
  //   JPYC recover (forwarder 設定済): 確定モデルで店舗が手数料を吸収する固定 (gas=merchant)。
  //     CheckoutForm 側も recover では URL の gas を無視して merchant に倒すが、URL とポリシー
  //     表示も merchant に揃えて齟齬を無くす。
  const isFreeGasless =
    settings.payMode === 'gasless' &&
    resolveJpycGaslessProvider(deployment, deployment.chainId) ===
      'eip3009-relay' &&
    jpycForwarderFor(deployment.chainId) === null;
  const isJpycRecover =
    settings.payMode === 'gasless' &&
    settings.token === 'jpyc' &&
    resolveJpycGaslessProvider(deployment, deployment.chainId) ===
      'eip3009-relay' &&
    jpycForwarderFor(deployment.chainId) !== null;
  // URL・ポリシー表示の実効 gasMode (free=customer / JPYC recover=merchant / 他=店主選択)。
  const effectiveGasMode = isFreeGasless
    ? 'customer'
    : isJpycRecover
      ? 'merchant'
      : settings.gasMode;
  const taxDec = taxDisplayDecimals(settings.token);

  // レジ表示設定 (Phase 1・flag 裏)。flag OFF では従来どおり = 画像常時表示・絞り込みなし。
  const showImages = !env.enableShopLive || settings.showPresetImages !== false;
  const [catFilter, setCatFilter] = useState<string | null>(null);
  const presetCategories = useMemo(() => {
    const out: string[] = [];
    for (const p of presetStore.enabledPresets) {
      const c = p.category?.trim();
      if (c && !out.includes(c)) out.push(c);
    }
    return out;
  }, [presetStore.enabledPresets]);
  // 絞り込み中のカテゴリーが (編集で) 消えたら「すべて」に戻す (空グリッドで取り残さない)。
  // flag OFF では絞り込み UI を出さないので常に null (= 全件表示)。
  const effectiveCatFilter =
    env.enableShopLive && catFilter && presetCategories.includes(catFilter)
      ? catFilter
      : null;
  const visiblePresets = effectiveCatFilter
    ? presetStore.enabledPresets.filter(
        (p) => (p.category?.trim() ?? '') === effectiveCatFilter,
      )
    : presetStore.enabledPresets;

  function addFromPreset(p: ProductPreset) {
    // 異通貨プリセットはカート非空時に警告 (同一カート単一通貨)。空なら通貨を切替。
    if (cart.length > 0 && p.token !== settings.token) {
      setCurrencyWarning(true);
      return;
    }
    setCurrencyWarning(false);
    if (cart.length === 0 && p.token !== settings.token) {
      setSettings((s) => ({
        ...s,
        token: p.token,
        chain: DEFAULT_CHAIN_FOR_SYMBOL[p.token],
      }));
    }
    setCart((c) => {
      const existing = c.find((l) => l.presetId === p.id);
      if (existing) {
        // 同じプリセットの再追加は数量 +1 (レジとして自然)。
        return c.map((l) =>
          l.id === existing.id ? { ...l, quantity: Math.min(999, l.quantity + 1) } : l,
        );
      }
      if (c.length >= CHECKOUT_MAX_ITEMS) return c;
      return [
        ...c,
        {
          id: randomId(),
          name: p.name,
          unitPrice: p.unitPrice,
          quantity: 1,
          taxRate: p.taxRate,
          taxCategory: p.taxCategory,
          memo: p.memo ?? '',
          presetId: p.id,
        },
      ];
    });
  }

  function addEmptyLine() {
    setCurrencyWarning(false);
    setCart((c) =>
      c.length >= CHECKOUT_MAX_ITEMS
        ? c
        : [
            ...c,
            {
              id: randomId(),
              name: '',
              unitPrice: '',
              quantity: 1,
              taxRate: null,
              taxCategory: null,
              memo: '',
            },
          ],
    );
  }

  function updateLine(id: string, patch: Partial<CartLine>) {
    setCart((c) => c.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  }
  function removeLine(id: string) {
    setCart((c) => c.filter((l) => l.id !== id));
  }
  function setQty(id: string, qty: number) {
    updateLine(id, { quantity: Math.max(1, Math.min(999, qty)) });
  }

  // 各行を検証・金額/税額を算出。
  const lines = cart.map((l) => {
    const priceValid =
      DECIMAL_PATTERN.test(l.unitPrice) &&
      Number(l.unitPrice) > 0 &&
      !exceedsTokenPrecision(l.unitPrice, deployment.decimals);
    const valid = l.name.trim().length > 0 && priceValid && l.quantity >= 1;
    const amountWei = valid
      ? calcCheckoutTotal(
          [{ name: l.name, qty: l.quantity, price: l.unitPrice }],
          deployment.decimals,
        )
      : 0n;
    const amountHuman = formatUnits(amountWei, deployment.decimals);
    const lineTax = valid
      ? taxAmountDecimal(Number(amountHuman), l.taxRate, taxDec)
      : null;
    return { l, valid, amountHuman, lineTax };
  });

  // 右サマリ用: 確定 (valid) 行のみの読み取りリスト。
  const summaryLines = lines.filter((x) => x.valid);

  const validItems: CheckoutItem[] = lines
    .filter((x) => x.valid)
    .map(({ l }) => ({
      name: l.name.trim(),
      qty: l.quantity,
      price: l.unitPrice,
      taxRate: l.taxRate ?? undefined,
      taxCategory: l.taxCategory ?? undefined,
      memo: l.memo.trim() || undefined,
    }));

  const totalWei = calcCheckoutTotal(validItems, deployment.decimals);
  const totalHuman = formatUnits(totalWei, deployment.decimals);
  const totalTax = lines.reduce((s, x) => s + (x.lineTax ?? 0), 0);
  const totalTaxRounded =
    Math.round(totalTax * 10 ** taxDec) / 10 ** taxDec;

  // WebKit (モバイル Safari・SNS アプリ内ブラウザ) では position:sticky な下部会計バーの
  // 子テキストを JS で書き換えても合成レイヤーが再ラスタライズされず、合計が古いまま残る
  // ことがある (スクロール等の別トリガーで初めて反映 = ユーザ報告「モバイルだけ合計反映が
  // 遅い」)。合計が変わるたび transform を 1 フレームだけ入れてレイヤーの再描画を強制する。
  useEffect(() => {
    const el = totalBarRef.current;
    if (!el) return;
    el.style.transform = 'translateZ(0)';
    const id = requestAnimationFrame(() => {
      if (el) el.style.transform = '';
    });
    return () => cancelAnimationFrame(id);
  }, [totalHuman, totalTaxRounded]);

  const checkoutUrl =
    hydrated && effectiveReceiver && origin && validItems.length > 0
      ? buildCheckoutUrl(origin, {
          to: effectiveReceiver,
          token: settings.token,
          chain: settings.chain,
          gas: effectiveGasMode,
          mode: settings.payMode,
          items: validItems,
          receiptNo: receiptNo || undefined,
          // レジ システム利用料 (flag ON のときだけ)。CheckoutForm が standard 経路の JPYC 決済に
          // recover の OpenPay利用料 % を店舗負担で課金する合図。USDC/relay/7月前は実質無料・flag
          // OFF では付かず従来動作 (inert)。
          ...(env.enableRegisterFee ? { feeKind: 'register' as const } : {}),
        })
      : '';

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-slate-800">{t('heading')}</h2>
        <p className="mt-1 text-sm text-slate-500">{t('subheading')}</p>
      </div>

      {/* 受取先/通貨/チェーン/決済設定は決済QRタブから継承。レジでは大きく露出させず、
          確認用に 1 行のステータスバー (受取先・通貨/チェーン・決済設定 + 変更導線) へ圧縮し、
          上部の縦幅を削って商品プリセットを上に押し上げる。 */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500">
        <span className="font-medium text-slate-400">{t('statusReceiverLabel')}:</span>
        <span className="font-mono text-slate-600">
          {effectiveReceiver
            ? shortAddress(effectiveReceiver)
            : settings.receiver.trim() || '—'}
        </span>
        <span className="inline-flex items-center gap-1 text-slate-400">
          <TokenLogo symbol={settings.token} size={14} className="h-3.5 w-3.5" />
          <ChainLogo slug={settings.chain} size={14} className="h-3.5 w-3.5" />
          ({chainForSlug(settings.chain).name} / {symbol})
        </span>
        <span className="text-slate-300" aria-hidden>
          ｜
        </span>
        <span className="text-slate-500">
          {isFreeGasless
            ? t('paymentPolicy.gaslessFree')
            : t(
                `paymentPolicy.${paymentPolicyKey(settings.payMode, effectiveGasMode)}`,
              )}
        </span>
        {onEditCurrency && (
          <button
            type="button"
            onClick={handleEditCurrency}
            className="font-medium text-brand hover:underline"
          >
            {t('statusChangeLink')}
          </button>
        )}
      </div>

      {/* POS 2カラム: 左=操作 (page scroll) / 右=会計サマリ (lg で sticky 追従)。 */}
      <div className="lg:grid lg:grid-cols-[1fr_minmax(300px,360px)] lg:items-start lg:gap-6">
        {/* ── LEFT: メイン操作エリア ── */}
        <div className="min-w-0 space-y-5">
          {/* 商品プリセット (常時描画・末尾に ＋カスタム追加 を同サイズで統合) */}
          <div>
            <div className="mb-2 flex items-center justify-between gap-2">
              <p className="text-xs font-semibold text-slate-500">{t('presetsLabel')}</p>
              {env.enableShopLive && (
                <label className="flex shrink-0 items-center gap-1 text-[11px] text-slate-500">
                  <input
                    type="checkbox"
                    checked={showImages}
                    onChange={(e) =>
                      setSettings((s) => ({ ...s, showPresetImages: e.target.checked }))
                    }
                  />
                  {t('showImagesLabel')}
                </label>
              )}
            </div>
            {/* カテゴリー絞り込み (flag 裏・カテゴリーを 1 つ以上付けた店舗のみ表示)。 */}
            {env.enableShopLive && presetCategories.length > 0 && (
              <div className="mb-2 flex flex-wrap gap-1.5">
                <button
                  type="button"
                  onClick={() => setCatFilter(null)}
                  aria-pressed={effectiveCatFilter === null}
                  className={`rounded-full border px-2.5 py-0.5 text-xs font-medium transition ${
                    effectiveCatFilter === null
                      ? 'border-brand bg-brand text-white'
                      : 'border-slate-300 text-slate-600 hover:border-brand'
                  }`}
                >
                  {t('filterAll')}
                </button>
                {presetCategories.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setCatFilter(c)}
                    aria-pressed={effectiveCatFilter === c}
                    className={`rounded-full border px-2.5 py-0.5 text-xs font-medium transition ${
                      effectiveCatFilter === c
                        ? 'border-brand bg-brand text-white'
                        : 'border-slate-300 text-slate-600 hover:border-brand'
                    }`}
                  >
                    {c}
                  </button>
                ))}
              </div>
            )}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {visiblePresets.map((p) => {
                // 商品画像 (https のみ・任意)。管理で入れた image をプリセットのカードにもサムネ表示する
                // (モバイルオーダーのメニュー画像と同じ image を共有)。https 以外は描画しない (二重防御)。
                // 読込失敗は onError で隠し、名前+価格のテキスト表示へフォールバック (グリッドを壊さない)。
                const presetImg = safeHttpUrl(p.image);
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => addFromPreset(p)}
                    className="relative flex min-h-[72px] flex-col justify-center rounded-xl border border-slate-200 bg-white px-3 py-3 text-left shadow-sm transition hover:border-brand hover:shadow active:scale-[0.98] active:bg-brand/5"
                  >
                    {env.enableShopLive && p.recommended && (
                      <span
                        className="absolute right-1.5 top-1.5 inline-flex items-center rounded-full bg-amber-100 px-1 py-0.5"
                        title={t('recommendedBadge')}
                        aria-label={t('recommendedBadge')}
                      >
                        <Star className="h-3 w-3 fill-amber-400 text-amber-400" aria-hidden />
                      </span>
                    )}
                    {showImages && presetImg && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={presetImg}
                        alt=""
                        referrerPolicy="no-referrer"
                        loading="lazy"
                        onError={(e) => {
                          e.currentTarget.style.display = 'none';
                        }}
                        className="mb-2 h-16 w-full rounded-lg object-cover"
                      />
                    )}
                    <div className="truncate text-sm font-semibold text-slate-800">
                      {p.name}
                    </div>
                    <div className="font-mono text-xs text-slate-500">
                      {p.unitPrice}{' '}
                      {deploymentForSlug(p.token, DEFAULT_CHAIN_FOR_SYMBOL[p.token])
                        .displaySymbol}
                    </div>
                  </button>
                );
              })}
              {/* カスタム追加 (空行) — プリセットと同サイズの末尾セル。 */}
              <button
                type="button"
                onClick={addEmptyLine}
                disabled={cart.length >= CHECKOUT_MAX_ITEMS}
                className="flex min-h-[72px] flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-slate-300 text-sm font-medium text-slate-500 transition hover:border-brand hover:text-brand-dark active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Plus className="h-5 w-5" aria-hidden />
                {t('addLine')}
              </button>
            </div>
            {currencyWarning && (
              <p className="mt-2 text-xs text-amber-600">
                {t('currencyMismatch', { symbol })}
              </p>
            )}
          </div>

          {/* カート (商品行カード) */}
          {cart.length === 0 ? (
            <p className="rounded-xl border border-dashed border-slate-300 px-4 py-6 text-center text-sm text-slate-400">
              {t('cartEmpty')}
            </p>
          ) : (
            <ul className="space-y-3">
              {lines.map(({ l, amountHuman, valid }) => (
                <li
                  key={l.id}
                  className="space-y-3 rounded-2xl border border-slate-200 bg-white p-3"
                >
                  <div className="flex items-start gap-2">
                    <input
                      type="text"
                      value={l.name}
                      onChange={(e) => updateLine(l.id, { name: e.target.value })}
                      placeholder={t('productNamePlaceholder')}
                      aria-label={t('productNameLabel')}
                      className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-2 text-base focus:border-brand focus:outline-none"
                      maxLength={80}
                    />
                    <button
                      type="button"
                      onClick={() => removeLine(l.id)}
                      aria-label={t('removeLine')}
                      className="rounded-lg border border-slate-200 p-2 text-slate-400 hover:border-red-300 hover:text-red-600"
                    >
                      <Trash2 className="h-4 w-4" aria-hidden />
                    </button>
                  </div>

                  <div className="flex flex-wrap items-end gap-3">
                    <Field label={t('unitPriceLabel', { symbol })}>
                      <input
                        type="text"
                        inputMode="decimal"
                        value={l.unitPrice}
                        onChange={(e) =>
                          updateLine(l.id, {
                            unitPrice: e.target.value.replace(/[^\d.]/g, ''),
                          })
                        }
                        placeholder="0"
                        aria-label={t('unitPriceLabel', { symbol })}
                        className="w-28 rounded-lg border border-slate-300 px-3 py-2 text-right font-mono text-base focus:border-brand focus:outline-none"
                      />
                    </Field>
                    <Field label={t('quantityLabel')}>
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => setQty(l.id, l.quantity - 1)}
                          aria-label={t('quantityDecrement')}
                          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-slate-300 text-slate-600 hover:border-brand"
                        >
                          <Minus className="h-5 w-5" aria-hidden />
                        </button>
                        <input
                          type="text"
                          inputMode="numeric"
                          value={l.quantity}
                          aria-label={t('quantityLabel')}
                          onChange={(e) => {
                            const n = Number(e.target.value.replace(/[^\d]/g, ''));
                            setQty(l.id, Number.isFinite(n) && n >= 1 ? n : 1);
                          }}
                          className="h-11 w-14 rounded-lg border border-slate-300 text-center font-mono text-lg focus:border-brand focus:outline-none"
                        />
                        <button
                          type="button"
                          onClick={() => setQty(l.id, l.quantity + 1)}
                          aria-label={t('quantityIncrement')}
                          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-slate-300 text-slate-600 hover:border-brand"
                        >
                          <Plus className="h-5 w-5" aria-hidden />
                        </button>
                      </div>
                    </Field>
                    <Field label={t('taxLabel')}>
                      <TaxCategorySelect
                        taxRate={l.taxRate}
                        taxCategory={l.taxCategory}
                        onChange={(next) => updateLine(l.id, next)}
                        ariaLabel={t('taxLabel')}
                        customAriaLabel={t('taxCustomLabel')}
                      />
                    </Field>
                    <div className="ml-auto text-right">
                      <div className="text-[11px] text-slate-400">{t('lineAmount')}</div>
                      <div className="font-mono text-sm font-semibold text-slate-800">
                        {valid ? `${amountHuman} ${symbol}` : '—'}
                      </div>
                    </div>
                  </div>

                  <input
                    type="text"
                    value={l.memo}
                    onChange={(e) => updateLine(l.id, { memo: e.target.value })}
                    placeholder={t('memoPlaceholder')}
                    aria-label={t('memoLabel')}
                    className="w-full rounded-lg border border-slate-200 px-3 py-1.5 text-xs focus:border-brand focus:outline-none"
                    maxLength={80}
                  />
                </li>
              ))}
            </ul>
          )}

          {/* ▸ 記帳・会計 (任意): 3 モード共通 AccountingSection。レジは cart variant =
              商品名/税はカート明細から自動反映するので手入力欄は出さず、管理番号 + 採番 のみ。 */}
          <AccountingSection
            variant="cart"
            receiptNo={receiptNo}
            onReceiptNoChange={setReceiptNo}
            onGenerateReceiptNo={() => setReceiptNo(presetStore.nextReceiptNo())}
            labels={{
              title: t('accountingTitle'),
              receiptNo: t('receiptNoLabel'),
              receiptNoPlaceholder: t('receiptNoPlaceholder'),
              generate: t('receiptNoGenerate'),
              cartAutoNote: t('cartAutoNote'),
            }}
          />

          {/* 商品プリセット管理 (折りたたみ) */}
          <details
            className="group rounded-2xl border border-slate-200 bg-white p-4"
            open={managerOpen}
          >
            <summary
              onClick={(e) => {
                e.preventDefault();
                setManagerOpen((o) => !o);
              }}
              className="flex cursor-pointer list-none items-center justify-between text-sm font-medium text-slate-700"
            >
              <span>{t('presetManagerTitle')}</span>
              <ChevronRight
                className="h-4 w-4 text-slate-400 transition-transform group-open:rotate-90"
                aria-hidden
              />
            </summary>
            <div className="mt-3">
              <ProductPresetManager
                presets={presetStore.presets}
                addPreset={presetStore.addPreset}
                updatePreset={presetStore.updatePreset}
                removePreset={presetStore.removePreset}
                movePreset={presetStore.movePreset}
              />
            </div>
          </details>
        </div>

        {/* ── RIGHT: 会計サマリ (lg で sticky 追従・モバイルは in-flow) ── */}
        <aside className="mt-6 min-w-0 self-start lg:mt-0 lg:sticky lg:top-20 lg:max-h-[calc(100vh-6rem)]">
          <div className="flex flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white lg:max-h-[calc(100vh-6rem)]">
            <div className="border-b border-slate-100 px-4 py-3">
              <p className="text-sm font-semibold text-slate-700">
                {t('orderSummaryTitle')}
              </p>
            </div>

            {/* 注文明細 (読み取り・確定行のみ。長いカートは内部スクロール) */}
            <div className="min-h-[3rem] flex-1 overflow-y-auto px-4 py-3">
              {summaryLines.length === 0 ? (
                <p className="py-3 text-center text-xs text-slate-400">
                  {t('previewPlaceholder')}
                </p>
              ) : (
                <ul className="space-y-2 text-sm">
                  {summaryLines.map(({ l, amountHuman }) => (
                    <li
                      key={l.id}
                      className="flex items-baseline justify-between gap-2"
                    >
                      <span className="min-w-0 truncate text-slate-700">
                        {l.name}
                        <span className="ml-1 text-slate-400">×{l.quantity}</span>
                      </span>
                      <span className="shrink-0 font-mono text-slate-800">
                        {amountHuman} {symbol}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* 小計 / 税額 / 合計 (大) */}
            <div className="border-t border-slate-200 bg-slate-50 px-4 py-3">
              <dl className="space-y-1.5 text-sm">
                <div className="flex justify-between">
                  <dt className="text-slate-500">{t('subtotal')}</dt>
                  <dd className="font-mono text-slate-800">
                    {totalHuman} {symbol}
                  </dd>
                </div>
                {totalTaxRounded > 0 && (
                  <div className="flex justify-between">
                    <dt className="text-slate-500">{t('taxAmount')}</dt>
                    <dd className="font-mono text-slate-600">
                      {totalTaxRounded} {symbol}
                    </dd>
                  </div>
                )}
                <div className="flex items-baseline justify-between border-t border-slate-200 pt-2">
                  <dt className="text-sm font-semibold text-slate-700">{t('total')}</dt>
                  <dd className="font-mono text-xl font-bold text-slate-900">
                    {totalHuman} {symbol}
                  </dd>
                </div>
              </dl>
              <p className="mt-2 text-[11px] text-slate-400">{t('taxInclusiveNote')}</p>
            </div>

            {/* デスクトップ CTA (サイドバー最下部に固定表示)。モバイルは下部バー側を使う。 */}
            <div className="hidden border-t border-slate-100 p-3 lg:block">
              <button
                type="button"
                onClick={() => setQrModalOpen(true)}
                disabled={!checkoutUrl}
                className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-brand px-5 py-4 text-base font-bold text-white shadow-sm transition hover:bg-brand-dark disabled:cursor-not-allowed disabled:bg-slate-300"
              >
                <QrCodeIcon className="h-5 w-5" aria-hidden />
                {t('showQr')}
              </button>
            </div>
          </div>
        </aside>
      </div>

      {/* モバイル下部固定 会計バー (合計 + QR ボタン)。lg では右サイドバー CTA を使う。
          グローバルの BottomNav (fixed bottom-0 z-20・md:hidden) の上に重ねるため、
          < md は bottom-14 で nav 分浮かせ、md 以上 (nav 非表示) は bottom-0。 */}
      <div
        ref={totalBarRef}
        className="sticky bottom-14 z-20 -mx-4 flex items-center gap-3 border-t border-slate-200 bg-white px-4 py-3 shadow-[0_-1px_4px_rgba(0,0,0,0.04)] md:bottom-0 lg:hidden"
      >
        <div className="min-w-0 flex-1">
          <div className="text-[11px] text-slate-400">{t('total')}</div>
          <div className="truncate font-mono text-lg font-bold text-slate-900">
            {totalHuman} {symbol}
          </div>
        </div>
        <button
          type="button"
          onClick={() => setQrModalOpen(true)}
          disabled={!checkoutUrl}
          className="inline-flex shrink-0 items-center justify-center gap-2 rounded-xl bg-brand px-5 py-3 text-base font-bold text-white shadow-sm transition hover:bg-brand-dark disabled:cursor-not-allowed disabled:bg-slate-300"
        >
          <QrCodeIcon className="h-5 w-5" aria-hidden />
          {t('showQr')}
        </button>
      </div>

      {/* 全画面プレビュー (ポスター調 + 印刷/URLコピー + × 閉じる)。決済QRと共通コンポーネント。 */}
      {checkoutUrl && (
        <QrPreviewModal
          open={qrModalOpen}
          onClose={() => setQrModalOpen(false)}
          labels={{
            title: t('qrModalTitle'),
            close: t('qrModalClose'),
            eyebrow: t('qrPosterEyebrow'),
            copy: t('copyUrl'),
            copied: t('copied'),
            localGenNote: t('qrLocalGenNote'),
          }}
          qrValue={checkoutUrl}
          qrRef={qrRef}
          storeName={settings.storeName.trim() || t('qrPosterDefaultStoreName')}
          amountText={`${totalHuman} ${symbol}`}
          note={settings.posterNote.trim() || undefined}
          chainText={`${symbol} · ${chainForSlug(settings.chain).name}`}
          receiverShort={effectiveReceiver ? shortAddress(effectiveReceiver) : ''}
          copied={copied}
          onCopy={() => copy(checkoutUrl)}
        />
      )}
    </div>
  );
}
