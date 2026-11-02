'use client';

// /create「注文リンク」タブ: 通販の注文ごとに、お客様へ送る /checkout のリンクを作る。
// ブラウザの中で完結し、サーバーへ送らない (lib/orderLink.ts)。氏名・住所の欄は作らない。
// 骨格はレジと同じ: PC は左に入力・右に sticky の見本、スマホは下部の固定バーに合計と主ボタン。
// 1 度決めたら変わらない受取先・チェーン・支払い方法は要約の行と設定シートに畳み、画面には毎回変わる物だけを残す。
// 金額はお客様が URL で書き換えられるので、いくら届いたら発送するかをリンクの下に常に出す。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Check, Copy, Plus, Send } from 'lucide-react';
import { ChainChooser } from '@/components/ChainChooser';
import {
  invalidClass,
  OrderLinkAmountField,
  ORDER_LINK_INPUT_CLASS,
} from '@/components/order-link/OrderLinkAmountField';
import { OrderLinkLineRow } from '@/components/order-link/OrderLinkLineRow';
import { OrderLinkPreview } from '@/components/order-link/OrderLinkPreview';
import { OrderLinkReceiverFields } from '@/components/order-link/OrderLinkReceiverFields';
import { ShopSettingsSection, ShopSettingsSheet } from '@/components/ShopSettingsSheet';
import { ShopSummaryRow } from '@/components/ShopSummaryRow';
import { useCopyToClipboard, useHydrationSafeAvailable } from '@/hooks/useCopyToClipboard';
import { useOrderLinkSettings } from '@/hooks/useOrderLinkSettings';
import { useOrigin } from '@/hooks/useOrigin';
import { useReceiverAutofill, type ReceiverSource } from '@/hooks/useReceiverAutofill';
import { useResolveAddress } from '@/hooks/useResolveAddress';
import { groupAmountDigits } from '@/lib/amount';
import { chainForSlug, JPYC_CHAINS } from '@/lib/chains';
import type { PayMode } from '@/lib/fee';
import { pickEffectiveAddress } from '@/lib/format';
import { isLikelyName } from '@/lib/nameDetection';
import {
  buildOrderLink,
  nextOrderLinkId,
  orderLinkChains,
  orderLinkFitsStandard,
  orderLinkLineIssues,
  orderLinkPreviewLines,
  ORDER_LINK_DESCRIPTION_MAX,
  ORDER_LINK_FIRST_ID,
  ORDER_LINK_ID_MAX,
  ORDER_LINK_STANDARD_MAX_JPYC,
  type OrderLinkError,
  type OrderLinkLine,
} from '@/lib/orderLink';
import { CHECKOUT_MAX_ITEMS, CHECKOUT_QTY_MAX } from '@/lib/url/checkout';

const MODES: readonly PayMode[] = ['gasless', 'standard'];
// 送料の行の分を残す (/checkout の明細は送料を含めて CHECKOUT_MAX_ITEMS 行まで)。
const MAX_LINES = CHECKOUT_MAX_ITEMS - 1;

// まだ入力の途中なだけの理由。これ以外は入力を直さないと進めないので、エラーの色で出す。
const GUIDANCE: ReadonlySet<OrderLinkError> = new Set(['receiver', 'receiverResolving', 'orderId', 'noItems']);
const ISSUE_MESSAGE = { name: 'itemName', qty: 'itemQty', price: 'itemPrice' } as const;

type LineState = OrderLinkLine & { id: number };
type SentLink = { url: string; via: 'copy' | 'share' };

export function OrderLinkBuilder() {
  const t = useTranslations('OrderLinkBuilder');
  const origin = useOrigin();
  const copier = useCopyToClipboard();
  const canCopy = useHydrationSafeAvailable(copier.available);
  const canShare = useHydrationSafeAvailable(typeof navigator !== 'undefined' && typeof navigator.share === 'function');
  const nextLineId = useRef(1);
  const newLine = (): LineState => ({ id: nextLineId.current++, name: '', qty: '1', price: '' });

  // null = 自動の番号を使う。使う人が打ったときと、コピーで番号を固定したときだけ値を持つ。
  const [orderIdInput, setOrderIdInput] = useState<string | null>(null);
  const [description, setDescription] = useState('');
  const [descriptionOpen, setDescriptionOpen] = useState(false);
  const [lines, setLines] = useState<LineState[]>(() => [newLine()]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [receiverInline, setReceiverInline] = useState(true);
  const [receiverChecked, setReceiverChecked] = useState(false);
  const [sent, setSent] = useState<SentLink | null>(null);
  const [focusFirstLine, setFocusFirstLine] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const firstNameRef = useRef<HTMLInputElement>(null);
  const orderIdRef = useRef<HTMLInputElement>(null);

  const typedItems = lines.some((line) => line.name !== '' || line.price !== '');
  // 取り込みの保留は使う人が打った内容だけで決める。自動の番号や覚えた送料で保留すると、別のタブの設定が永久に入らない。
  const { settings, setSettings, hydrated } = useOrderLinkSettings({
    holdImport: typedItems || description !== '' || orderIdInput !== null,
  });
  const autoOrderId = settings.lastOrderId ? nextOrderLinkId(settings.lastOrderId) : ORDER_LINK_FIRST_ID;
  const orderId = orderIdInput ?? (hydrated ? autoOrderId : '');

  const receiverName = settings.receiver.trim();
  const ens = useResolveAddress(isLikelyName(receiverName) ? receiverName : '');
  // 再解決に失敗しても react-query は前回の解決結果を残すので、失敗中は使わない (古いアドレスのリンクを作らない)。
  const effectiveReceiver = useMemo(
    () => pickEffectiveAddress(settings.receiver, ens.error ? null : ens.data?.address ?? null),
    [settings.receiver, ens.data, ens.error],
  );
  // 名前の再解決の間は前回の結果が残るので、リンクには使わない (期限切れのアドレスをコピーさせない)。
  const resolving = isLikelyName(receiverName) && ens.isFetching;
  const linkReceiver = resolving ? null : effectiveReceiver;
  const setReceiver = useCallback(
    (value: string, source: ReceiverSource) =>
      setSettings((current) => ({ ...current, receiver: value, receiverSource: source })),
    [setSettings],
  );
  const autofill = useReceiverAutofill({
    receiver: settings.receiver,
    receiverSource: settings.receiverSource,
    effectiveReceiver,
    hydrated,
    setReceiver,
  });

  // 受取先が決まっていれば要約の行に畳む。読み込み後に 1 度だけ決め、入力の途中では畳まない (チップのタブと同じ)。
  useEffect(() => {
    if (!hydrated || receiverChecked) return;
    if (settings.receiver.trim() === '' && autofill.connected) return;
    if (isLikelyName(settings.receiver) && !effectiveReceiver) return;
    setReceiverInline(effectiveReceiver === null);
    setReceiverChecked(true);
  }, [hydrated, receiverChecked, settings.receiver, autofill.connected, effectiveReceiver]);

  const onReceiverInput = (value: string) => {
    setReceiverChecked(true);
    autofill.handleManualChange(value);
  };
  const onUseConnected = () => {
    setReceiverChecked(true);
    autofill.useConnectedWallet();
    setReceiverInline(false);
  };

  const chains = useMemo(() => orderLinkChains(JPYC_CHAINS), []);
  const shippingLabel = t('shippingLineName');
  const result = useMemo(
    () =>
      buildOrderLink({
        origin: origin || 'https://open-pay.jp',
        to: linkReceiver,
        chain: settings.chain,
        mode: settings.payMode,
        orderId,
        description,
        lines,
        shipping: settings.shipping,
        shippingLabel,
      }),
    [origin, linkReceiver, settings.chain, settings.payMode, settings.shipping, orderId, description, lines, shippingLabel],
  );
  const previewLines = useMemo(
    () => orderLinkPreviewLines(lines, settings.shipping, shippingLabel),
    [lines, settings.shipping, shippingLabel],
  );

  const reason = result.ok ? null : resolving ? 'receiverResolving' : result.error;
  const firstIssue = lines.flatMap((line) => orderLinkLineIssues(line))[0];
  const canSwitchToStandard =
    !result.ok &&
    reason === 'tooLarge' &&
    settings.payMode === 'gasless' &&
    result.total !== undefined &&
    orderLinkFitsStandard(result.total);
  const messageKey =
    reason === 'item' && firstIssue ? ISSUE_MESSAGE[firstIssue] : canSwitchToStandard ? 'tooLargeGasless' : reason;
  const messageValues = {
    minimum: result.ok ? '' : result.minimum ?? '',
    maximum: groupAmountDigits(result.ok ? '' : result.maximum ?? ''),
    standardMaximum: groupAmountDigits(ORDER_LINK_STANDARD_MAX_JPYC.toString()),
    max: CHECKOUT_MAX_ITEMS,
    qtyMax: CHECKOUT_QTY_MAX,
  };
  const errorText = messageKey === null ? null : t(`errors.${messageKey}`, messageValues);
  const shortText = messageKey === null ? null : t(`errorsShort.${messageKey}`, messageValues);
  const blocked = reason !== null && !GUIDANCE.has(reason);

  const sentVia = result.ok && sent?.url === result.url ? sent.via : null;
  const sentLabel = sentVia === null ? null : t(sentVia === 'share' ? 'shared' : 'copied');
  // 番号はリンクを渡すときに確定する (開いただけでは進めない)。固定してから進めるので、表示中の注文の番号は変わらない。
  const markSent = (url: string, via: SentLink['via']) => {
    setOrderIdInput(orderId);
    setSent({ url, via });
    setSettings((current) => ({ ...current, lastOrderId: orderId }));
  };
  const copyLink = async () => {
    if (!result.ok) return;
    const copied = await copier.copy(result.url);
    setCopyFailed(!copied);
    if (copied) markSent(result.url, 'copy');
  };
  const shareLink = async () => {
    if (!result.ok) return;
    try {
      await navigator.share({ text: t('shareText', { id: orderId }), url: result.url });
      markSent(result.url, 'share');
    } catch {
      // 取り消しや許可の拒否は正常系。共有できなくてもコピーが残る (掟 13)。
    }
  };
  const startNextOrder = () => {
    setOrderIdInput(null);
    setSent(null);
    setCopyFailed(false);
    setDescription('');
    setDescriptionOpen(false);
    setLines([newLine()]);
    setFocusFirstLine(true);
  };
  useEffect(() => {
    if (!focusFirstLine) return;
    setFocusFirstLine(false);
    // 続きを決められない番号なら、番号の欄から始める。
    (autoOrderId ? firstNameRef.current : orderIdRef.current)?.focus();
  }, [focusFirstLine, autoOrderId]);
  useEffect(() => {
    // コピーできない環境では、手で選べるようリンクの欄へ案内する (欄は focus で全選択になる)。
    if (copyFailed) document.getElementById('order-link-url')?.focus();
  }, [copyFailed]);

  const updateLine = (id: number, patch: Partial<OrderLinkLine>) =>
    setLines((current) => current.map((line) => (line.id === id ? { ...line, ...patch } : line)));

  const shippingInvalid = !result.ok && result.error === 'shipping';
  const orderIdInvalid = !result.ok && result.error === 'orderId' && orderId !== '';

  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(320px,380px)] lg:items-start lg:gap-6">
      <section
        aria-labelledby="order-link-order-heading"
        className="min-w-0 overflow-hidden rounded-2xl bg-white shadow-card ring-1 ring-slate-200/70"
      >
        <h2 id="order-link-order-heading" className="sr-only">
          {t('orderTitle')}
        </h2>
        <div
          className="border-b border-slate-100 px-5 py-4"
          onBlur={() => {
            if (receiverInline && receiverChecked && linkReceiver) setReceiverInline(false);
          }}
        >
          {receiverInline ? (
            <OrderLinkReceiverFields
              value={settings.receiver}
              onChange={onReceiverInput}
              connected={autofill.connected !== null}
              canUseConnected={autofill.canUseConnected}
              matchesConnected={autofill.matchesConnected}
              onUseConnected={onUseConnected}
            />
          ) : (
            <ShopSummaryRow
              storeName={t('receiverLabel')}
              receiver={effectiveReceiver}
              chainSlug={settings.chain}
              chainName={chainForSlug(settings.chain).name}
              payLabel={t(`modes.${settings.payMode}`)}
              payTone={settings.payMode}
              onOpenSettings={() => setSettingsOpen(true)}
              // 行の高さを増やさず、押せる範囲だけを 44px 以上に広げる。
              settingsClassName="relative after:absolute after:-inset-x-1 after:-inset-y-2 after:content-['']"
              labels={{
                settings: t('settingsOpen'),
                noStoreName: t('receiverLabel'),
                noReceiver: t('noReceiver'),
              }}
            />
          )}
        </div>

        <div className="space-y-3 px-5 py-4">
          <ul className="space-y-3">
            {lines.map((line, index) => (
              <OrderLinkLineRow
                key={line.id}
                ref={index === 0 ? firstNameRef : undefined}
                id={line.id}
                line={line}
                issues={orderLinkLineIssues(line)}
                removable={lines.length > 1}
                onChange={(patch) => updateLine(line.id, patch)}
                onRemove={() => setLines((current) => current.filter((other) => other.id !== line.id))}
              />
            ))}
          </ul>

          <div className="flex flex-wrap items-center gap-x-5">
            {lines.length < MAX_LINES && (
              <button
                type="button"
                onClick={() => setLines((current) => [...current, newLine()])}
                className="inline-flex h-11 items-center gap-1.5 text-sm font-medium text-brand hover:text-brand-dark"
              >
                <Plus className="h-4 w-4" aria-hidden />
                {t('addLine')}
              </button>
            )}
            {!descriptionOpen && (
              <button
                type="button"
                onClick={() => setDescriptionOpen(true)}
                className="inline-flex h-11 items-center gap-1.5 text-sm font-medium text-brand hover:text-brand-dark"
              >
                <Plus className="h-4 w-4" aria-hidden />
                {t('addDescription')}
              </button>
            )}
          </div>

          {descriptionOpen && (
            <div>
              <label htmlFor="order-link-description" className="mb-1.5 block text-sm font-medium text-slate-700">
                {t('descriptionLabel')}
              </label>
              <input
                id="order-link-description"
                value={description}
                maxLength={ORDER_LINK_DESCRIPTION_MAX}
                placeholder={t('descriptionPlaceholder')}
                onChange={(event) => setDescription(event.target.value)}
                className={ORDER_LINK_INPUT_CLASS}
              />
              <p className="mt-1.5 text-xs text-slate-500">{t('noPersonalData')}</p>
            </div>
          )}

          <div className="divide-y divide-slate-100 border-t border-slate-100">
            <div className="flex items-center justify-between gap-3 py-2.5">
              <label htmlFor="order-link-shipping" className="text-sm font-medium text-slate-700">
                {t('shippingLabel')}
              </label>
              <div className="w-[9.5rem]">
                <OrderLinkAmountField
                  id="order-link-shipping"
                  value={settings.shipping}
                  invalid={shippingInvalid}
                  onChange={(shipping) => setSettings((current) => ({ ...current, shipping }))}
                />
              </div>
            </div>
            <div className="flex items-center justify-between gap-3 pt-2.5">
              <label htmlFor="order-link-id" className="text-sm font-medium text-slate-700">
                {t('orderIdLabel')}
              </label>
              <input
                ref={orderIdRef}
                id="order-link-id"
                value={orderId}
                maxLength={ORDER_LINK_ID_MAX}
                aria-invalid={orderIdInvalid || undefined}
                onChange={(event) => setOrderIdInput(event.target.value)}
                className={`${ORDER_LINK_INPUT_CLASS} !w-[9.5rem] text-right tabular-nums ${invalidClass(orderIdInvalid)}`}
              />
            </div>
          </div>
        </div>
      </section>

      {/* スマホは中身が出るまで見本を出さない (下部のバーと同じことを 2 回言わない)。 */}
      <aside className={`min-w-0 self-start lg:sticky lg:top-20 ${previewLines.length > 0 ? '' : 'hidden lg:block'}`}>
        <OrderLinkPreview
          result={result}
          orderId={orderId}
          description={description}
          lines={previewLines}
          message={errorText}
          messageIsError={blocked}
          sentLabel={sentLabel}
          hasSent={sent !== null}
          canCopy={canCopy}
          showUrl={!canCopy || copyFailed}
          canShare={canShare}
          onCopy={() => void copyLink()}
          onShare={() => void shareLink()}
          onNextOrder={startNextOrder}
          onSwitchToStandard={
            canSwitchToStandard ? () => setSettings((current) => ({ ...current, payMode: 'standard' })) : null
          }
        />
      </aside>

      <span role="status" className="sr-only">
        {sentLabel ?? ''}
      </span>

      {/* 下部の固定バー (レジと同じ型)。押せないときは短い理由だけを出す。 */}
      {(canCopy || canShare) && (
        <div className="sticky bottom-14 z-20 -mx-4 flex items-center gap-3 border-t border-slate-200/70 bg-white/85 px-4 py-2.5 backdrop-blur-md md:bottom-0 lg:hidden">
          <div className="min-w-0 flex-1">
            {sentLabel ? (
              <p className="inline-flex items-center gap-1.5 text-sm font-semibold text-emerald-700">
                <Check className="h-4 w-4 flex-none" aria-hidden />
                {sentLabel}
              </p>
            ) : sent ? (
              // 送った後に書き換えたら、同じ番号のまま別の注文に使わないよう次の注文への出口を残す。
              <button
                type="button"
                onClick={startNextOrder}
                className="h-12 text-sm font-semibold text-brand hover:text-brand-dark"
              >
                {t('nextOrder')}
              </button>
            ) : copyFailed && result.ok ? (
              <p className="text-sm font-medium text-rose-700">{t('copyFailed')}</p>
            ) : result.ok ? (
              <>
                <div className="text-[11px] text-slate-500">{t('total')}</div>
                <div className="truncate text-lg font-bold tabular-nums text-slate-900">
                  {groupAmountDigits(result.total)} JPYC
                </div>
              </>
            ) : (
              <p className={`line-clamp-2 text-sm font-medium ${blocked ? 'text-rose-700' : 'text-slate-500'}`}>{shortText}</p>
            )}
          </div>
          <button
            type="button"
            disabled={!result.ok}
            onClick={sentLabel ? startNextOrder : () => void (canShare ? shareLink() : copyLink())}
            className="inline-flex h-12 shrink-0 items-center justify-center gap-2 rounded-xl bg-brand px-4 text-base font-bold text-white hover:bg-brand-dark disabled:bg-slate-200 disabled:text-slate-500"
          >
            {sentLabel ? (
              t('nextOrder')
            ) : canShare ? (
              <>
                <Send className="h-5 w-5" aria-hidden />
                {t('share')}
              </>
            ) : (
              <>
                <Copy className="h-5 w-5" aria-hidden />
                {t('copy')}
              </>
            )}
          </button>
        </div>
      )}

      <ShopSettingsSheet
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        title={t('settingsTitle')}
        doneLabel={t('settingsDone')}
      >
        <ShopSettingsSection title={t('receiverLabel')}>
          <OrderLinkReceiverFields
            hideLabel
            value={settings.receiver}
            onChange={onReceiverInput}
            canUseConnected={autofill.canUseConnected}
            matchesConnected={autofill.matchesConnected}
            onUseConnected={autofill.useConnectedWallet}
            connected={autofill.connected !== null}
          />
        </ShopSettingsSection>
        <ShopSettingsSection title={t('chainLabel')}>
          <ChainChooser
            slugs={chains}
            selected={settings.chain}
            onSelect={(chain) => setSettings((current) => ({ ...current, chain }))}
            showId={false}
            gridClassName="grid grid-cols-2 gap-2"
          />
          <p className="text-xs text-slate-600">{t('chainHint')}</p>
        </ShopSettingsSection>
        <ShopSettingsSection title={t('modeLabel')}>
          <div className="space-y-2">
            {MODES.map((mode) => (
              <button
                key={mode}
                type="button"
                aria-pressed={settings.payMode === mode}
                onClick={() => setSettings((current) => ({ ...current, payMode: mode }))}
                className={`block w-full rounded-xl px-4 py-3 text-left ring-1 transition-colors ${
                  settings.payMode === mode ? 'bg-brand/5 ring-2 ring-brand' : 'bg-white ring-slate-200 hover:ring-slate-300'
                }`}
              >
                <span className="block text-sm font-semibold text-slate-900">{t(`modes.${mode}`)}</span>
                <span className="mt-0.5 block text-xs text-slate-600">{t(`modes.${mode}Desc`)}</span>
              </button>
            ))}
          </div>
        </ShopSettingsSection>
      </ShopSettingsSheet>
    </div>
  );
}
