'use client';

// 顧客向け注文ページ: 店舗名 + チェーン + SNS + メニュー (数量ステッパ) + 合計 + 「支払いへ進む」。
// 注文トークン (?s=) を decodeOrderConfig したものを描画する。
//
// 決済は **既存の監査済み /checkout を流用** (手数料ゼロ = 現行「JPYC 0%」開示と整合・新規
// money-path コードなし)。カートの qty>0 の行を CheckoutItem[] に詰めて buildCheckoutUrl で
// /checkout へ deep-link するだけ。実際の送金/relay/控えは CheckoutForm 側 (既存)。
// モバイルオーダー固有の % 手数料は P0 (開示更新) 後の別増分で、ここには無い。

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { formatUnits, parseUnits } from 'viem';
import { ChevronDown, ChevronUp, Clock, MapPin, Phone, ShoppingCart, UtensilsCrossed } from 'lucide-react';
import { SocialIconLinks } from '@/components/SocialIconLinks';
import { env } from '@/lib/env';
import { useOrigin } from '@/hooks/useOrigin';
import { deploymentForSlug } from '@/lib/tokens';
import type { JpycChainSlug } from '@/lib/chains';
import {
  buildCheckoutUrl,
  calcCheckoutTotal,
  CHECKOUT_MAX_ITEMS,
  CHECKOUT_QTY_MAX,
  type CheckoutItem,
} from '@/lib/url';
import {
  safeHttpUrl,
  telHref,
  mapSearchHref,
  groupMenuByCategory,
  JPYC_CHAIN_LABEL,
  type MobileOrderConfig,
} from '@/lib/mobileOrder';

// 店内 (dineIn) 時のテーブル番号入力の最大長。/checkout の description (200) に十分収まる短さ。
const TABLE_NUMBER_MAX = 16;

// アバター読込失敗/未設定時のフォールバック頭文字 (@handle と同じくコードポイント単位)。
function initialOf(name: string): string {
  const n = name.trim();
  return n ? ([...n][0] ?? '').toUpperCase() : '🏪';
}

export function MobileOrderView({
  config,
  backHref,
  backLabel,
  handle,
}: {
  config: MobileOrderConfig;
  /** 「支払いへ進む」後の /checkout から戻る店舗ページのパス (同一オリジン)。@handle 公開時に渡る。 */
  backHref?: string;
  /** 戻りリンクのラベル (店名)。 */
  backLabel?: string;
  /** 公開元の @handle (正規化済み・@ 無し)。受注リレー (flag ON 時) の webhook 束縛に使う。 */
  handle?: string;
}) {
  const t = useTranslations('MobileOrder');
  const origin = useOrigin();
  const [qty, setQty] = useState<Record<string, number>>({});
  // 注文内容 (カート明細) の開閉。既定は閉 (カートマークのタップで展開)。
  const [cartOpen, setCartOpen] = useState(false);
  // 店内 (dineIn) 時に顧客が入力するテーブル番号 (注文時のみ・config には保存しない)。
  const [tableNumber, setTableNumber] = useState('');
  // 受注リレー (flag ON) 用の安定 orderId。この注文ページ訪問で一意・店主の受注画面の参照キー。
  // crypto.randomUUID 不在環境 (一部 jsdom) では時刻+乱数へフォールバック。
  const [orderId] = useState(() => {
    try {
      return crypto.randomUUID();
    } catch {
      return `o-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    }
  });

  // 店舗アイコン: 注文トークンは attacker-controllable なので safeHttpUrl で https に限定し、
  // 読込失敗 (onError) は頭文字へ fallback (@handle のアバターと同型)。URL 変更で失敗状態リセット。
  const [avatarFailed, setAvatarFailed] = useState(false);
  const avatarUrl = safeHttpUrl(config.avatar);
  useEffect(() => setAvatarFailed(false), [config.avatar]);
  const showAvatar = !!avatarUrl && !avatarFailed;

  // 二重防御: config は https のみへ検証済みだが、注文トークンは attacker-controllable な
  // ので href/src へ描画する直前にも scheme を再確認 (javascript:/data: を排除)。
  // プロフ(@handle) と同じ SocialIconLinks でアイコン行として描画 (表示順保持・ドメイン自動判定)。
  const socialUrls = config.socials
    .map((u) => safeHttpUrl(u))
    .filter((u): u is string => Boolean(u));

  // 受取チェーン: chains が 2 件以上なら顧客が選べる (既定は先頭)。1 件なら従来どおり固定。
  const offeredChains = config.chains && config.chains.length > 0 ? config.chains : [config.chain];
  const [selectedChain, setSelectedChain] = useState<JpycChainSlug>(offeredChains[0]);
  // 選択がオファー外 (config 差し替え時の stale) なら先頭へフォールバック。
  const chain = offeredChains.includes(selectedChain) ? selectedChain : offeredChains[0];

  const decimals = deploymentForSlug('jpyc', chain).decimals;
  const setItemQty = (id: string, n: number) =>
    setQty((q) => ({ ...q, [id]: Math.max(0, Math.min(CHECKOUT_QTY_MAX, n)) }));

  // qty>0 の行を CheckoutItem[] へ (表示順維持)。決済額は /checkout が items から再計算する。
  // 税率/税区分 (presets 由来) も渡し、/checkout のレシート・履歴・freee に 小計/うち税額 を反映。
  const cartItems = useMemo<CheckoutItem[]>(
    () =>
      config.menu
        .filter((m) => (qty[m.id] ?? 0) > 0)
        .map((m) => {
          const item: CheckoutItem = { name: m.name, qty: qty[m.id], price: m.price };
          if (typeof m.taxRate === 'number') item.taxRate = m.taxRate;
          if (m.taxCategory) item.taxCategory = m.taxCategory;
          return item;
        }),
    [config.menu, qty],
  );

  // /checkout は 1〜10 品まで。超過時は支払いを止めて明示 (URL を組んでも parse 側で弾かれるため)。
  const tooMany = cartItems.length > CHECKOUT_MAX_ITEMS;
  const totalHuman =
    cartItems.length > 0 && !tooMany
      ? formatUnits(calcCheckoutTotal(cartItems, decimals), decimals)
      : '0';
  // カートマークのバッジ点数 (合計数量)。
  const cartCount = cartItems.reduce((sum, it) => sum + it.qty, 0);
  // 店内 (dineIn) 時: テーブル番号を /checkout の description (→ 控え/履歴 memo) に載せ、
  // 受け渡し先を記録する (後続のフルフィルメント = Nostr 通知 / QR 照合 でも引き継げる)。
  const tableNum = config.dineIn ? tableNumber.trim() : '';
  const orderDescription = tableNum ? t('tableDescPrefix', { table: tableNum }) : undefined;
  // 店内なのにテーブル番号が未入力なら支払いを止める (どのテーブルか不明な注文を防ぐ)。
  const needsTable = Boolean(config.dineIn) && tableNum.length === 0;
  // 受注リレー (flag ON + @handle 公開時のみ): 決済成功 webhook を /api/order/notify?h= へ向け、
  // 店主の受注画面に届くようにする (CheckoutForm 無改変・既存 webhook 機構を流用)。OFF/handle 無しは付けない。
  const orderRelayWebhook =
    env.enableOrderRelay && handle && origin
      ? `${origin}/api/order/notify?h=${encodeURIComponent(handle)}`
      : undefined;
  const baseCheckoutUrl =
    origin && cartItems.length > 0 && !tooMany
      ? buildCheckoutUrl(origin, {
          to: config.receiver,
          token: 'jpyc',
          chain, // 顧客が選んだ受取チェーン (単一なら config.chain)
          gas: 'customer',
          items: cartItems,
          description: orderDescription, // 店内のテーブル番号 (テイクアウトは undefined)
          // 受注リレー用 (flag ON + @handle 公開時のみ・OFF では付かず inert)。
          ...(orderRelayWebhook ? { webhook: orderRelayWebhook, orderId } : {}),
        })
      : '';
  // /checkout の「←」を店舗へ戻すため back/backName を付与 (@handle 公開時に backHref が渡る)。
  // buildCheckoutUrl は常に query を含むので & 連結で安全。値は encode 済み。
  const checkoutUrl =
    baseCheckoutUrl && backHref
      ? `${baseCheckoutUrl}&back=${encodeURIComponent(backHref)}` +
        (backLabel ? `&backName=${encodeURIComponent(backLabel)}` : '')
      : baseCheckoutUrl;

  // メニューをカテゴリー別にグループ化 (出現順)。カテゴリーが1つも無ければ見出しを出さず単一グリッド。
  const menuGroups = useMemo(() => groupMenuByCategory(config.menu), [config.menu]);
  const showCategoryHeaders =
    menuGroups.length > 1 || (menuGroups[0]?.category ?? null) !== null;
  // カテゴリーメニュー (上部ナビ) は 2 グループ以上のときだけ表示。各カテゴリーへは id アンカー
  // (index ベースで URL 安全) でジャンプする (ref/scrollIntoView 不要・サーバ描画でも動く)。
  const showCategoryNav = menuGroups.length > 1;
  const sectionId = (i: number) => `mo-cat-${i}`;

  // 店舗情報 + 受付可否。acceptingOrders===false のとき支払いを止める (不可逆決済の事故防止)。
  const accepting = config.acceptingOrders !== false;
  const tel = telHref(config.phone);
  const mapHref = mapSearchHref(config.address);
  const hasStoreInfo = !!(config.address || config.hours || config.phone);

  return (
    <div className="space-y-5">
      <header className="text-center">
        <div className="mx-auto flex h-20 w-20 items-center justify-center overflow-hidden rounded-full bg-brand text-2xl font-bold text-white">
          {showAvatar ? (
            // 任意の第三者 https 画像。referrerPolicy で hotlink トラッキングを抑制。
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={avatarUrl}
              alt={config.shopName}
              referrerPolicy="no-referrer"
              loading="lazy"
              className="h-full w-full object-cover"
              onError={() => setAvatarFailed(true)}
            />
          ) : (
            <span aria-hidden>{initialOf(config.shopName)}</span>
          )}
        </div>
        <h1 className="mt-3 text-xl font-bold text-slate-900">{config.shopName}</h1>
        {offeredChains.length > 1 ? (
          // 複数チェーン: 顧客が支払うチェーンを選ぶ (受取先は全チェーン共通の 1 アドレス)。
          <div className="mt-2">
            <p className="text-xs text-slate-500">{t('viewChainPick')}</p>
            <div className="mt-1 flex flex-wrap justify-center gap-1.5">
              {offeredChains.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setSelectedChain(c)}
                  aria-pressed={c === chain}
                  className={`rounded-full border px-3 py-1 text-xs font-medium transition ${
                    c === chain
                      ? 'border-brand bg-brand text-white'
                      : 'border-slate-300 text-slate-600 hover:border-brand'
                  }`}
                >
                  JPYC ({JPYC_CHAIN_LABEL[c]})
                </button>
              ))}
            </div>
          </div>
        ) : (
          <p className="mt-1 text-xs text-slate-500">
            {t('viewChainBadge', { chain: JPYC_CHAIN_LABEL[config.chain] })}
          </p>
        )}
        {socialUrls.length > 0 && (
          <div className="mt-3">
            <SocialIconLinks urls={socialUrls} />
          </div>
        )}
      </header>

      {/* 受付停止中バナー (acceptingOrders===false)。客が払う前に最上部で告知。 */}
      {!accepting && (
        <div className="rounded-2xl border border-amber-300 bg-amber-50 px-4 py-3 text-center text-sm font-semibold text-amber-800">
          {t('viewClosedNotice')}
        </div>
      )}

      {/* 店舗情報 (任意・入力された項目だけ描画)。住所は地図リンク、電話は tel: リンク。 */}
      {hasStoreInfo && (
        <section className="space-y-1.5 rounded-2xl border border-slate-200 bg-white p-4 text-sm text-slate-600">
          {config.hours && (
            <p className="flex items-start gap-2">
              <Clock className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" aria-label={t('viewHoursLabel')} />
              <span>{config.hours}</span>
            </p>
          )}
          {config.address && (
            <p className="flex items-start gap-2">
              <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" aria-label={t('viewAddressLabel')} />
              {mapHref ? (
                <a
                  href={mapHref}
                  target="_blank"
                  rel="noopener noreferrer nofollow"
                  className="text-brand hover:underline"
                >
                  {config.address}
                </a>
              ) : (
                <span>{config.address}</span>
              )}
            </p>
          )}
          {config.phone && (
            <p className="flex items-start gap-2">
              <Phone className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" aria-label={t('viewPhoneLabel')} />
              {tel ? (
                <a href={tel} className="text-brand hover:underline">
                  {config.phone}
                </a>
              ) : (
                <span>{config.phone}</span>
              )}
            </p>
          )}
        </section>
      )}

      <section>
        <h2 className="mb-2 text-sm font-semibold text-slate-700">{t('viewMenuHeading')}</h2>
        {/* カテゴリーメニュー (上部・横スクロール・タップで該当カテゴリーへジャンプ)。 */}
        {showCategoryNav && (
          <nav className="sticky top-0 z-10 -mx-3 mb-3 flex gap-2 overflow-x-auto bg-white/95 px-3 py-2 backdrop-blur">
            {menuGroups.map((group, i) => (
              <a
                key={sectionId(i)}
                href={`#${sectionId(i)}`}
                className="shrink-0 rounded-full border border-slate-300 px-3 py-1 text-xs font-medium text-slate-600 hover:border-brand hover:text-brand"
              >
                {group.category ?? t('uncategorized')}
              </a>
            ))}
          </nav>
        )}
        {/* カテゴリー別 (見出し) × 2 カラムの商品カード (大きい写真 + 名前 + 価格 + − n + ステッパ)。 */}
        {menuGroups.map((group, i) => (
          <div
            key={sectionId(i)}
            id={sectionId(i)}
            className="mb-5 scroll-mt-16 last:mb-0"
          >
            {showCategoryHeaders && (
              <h3 className="mb-2 border-b border-slate-200 pb-1 text-sm font-bold text-slate-700">
                {group.category ?? t('uncategorized')}
              </h3>
            )}
            <ul className="grid grid-cols-2 gap-3">
              {group.items.map((item) => {
                const n = qty[item.id] ?? 0;
                const imgUrl =
                  item.visual?.kind === 'image' ? safeHttpUrl(item.visual.url) : undefined;
                return (
                  <li
                    key={item.id}
                    className="flex flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white"
                  >
                    {/* 写真 (大きく・正方形)。画像が無ければ絵文字、それも無ければアイコン。 */}
                    <div className="flex aspect-square w-full items-center justify-center bg-slate-50">
                      {imgUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={imgUrl} alt="" className="h-full w-full object-cover" />
                      ) : item.visual?.kind === 'emoji' ? (
                        <span className="text-5xl" aria-hidden>
                          {item.visual.value}
                        </span>
                      ) : (
                        <UtensilsCrossed className="h-8 w-8 text-slate-300" aria-hidden />
                      )}
                    </div>
                    <div className="flex flex-1 flex-col gap-2 p-3">
                      <span className="line-clamp-2 text-sm font-medium text-slate-800">
                        {item.name}
                      </span>
                      {/* 価格の横に − n + ステッパ */}
                      <div className="mt-auto flex items-center justify-between gap-1">
                        <span className="min-w-0">
                          <span className="text-base font-bold text-slate-900">{item.price}</span>{' '}
                          <span className="text-[10px] font-medium text-slate-400">JPYC</span>
                        </span>
                        <span className="flex shrink-0 items-center gap-1">
                          <button
                            type="button"
                            onClick={() => setItemQty(item.id, n - 1)}
                            disabled={n === 0}
                            aria-label={t('qtyDecrease')}
                            className="flex h-7 w-7 items-center justify-center rounded-full border border-slate-300 text-slate-600 disabled:opacity-30"
                          >
                            −
                          </button>
                          <span className="w-5 text-center text-sm font-semibold tabular-nums">
                            {n}
                          </span>
                          <button
                            type="button"
                            onClick={() => setItemQty(item.id, n + 1)}
                            aria-label={t('qtyIncrease')}
                            className="flex h-7 w-7 items-center justify-center rounded-full border border-slate-300 text-slate-600"
                          >
                            ＋
                          </button>
                        </span>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </section>

      {/* 注文サマリ + 支払い (既存 /checkout へ・手数料0) */}
      <section className="rounded-2xl border border-slate-200 bg-white p-4">
        {!accepting ? (
          // 受付停止中は支払いを止める (不可逆決済の事故防止)。メニュー閲覧は可能。
          <p className="text-center text-sm font-semibold text-amber-700">{t('viewClosedNotice')}</p>
        ) : cartItems.length === 0 ? (
          <p className="text-center text-sm text-slate-400">{t('cartEmpty')}</p>
        ) : tooMany ? (
          <p className="text-center text-sm text-red-600">
            {t('tooManyItems', { max: CHECKOUT_MAX_ITEMS })}
          </p>
        ) : (
          <div className="space-y-3">
            {/* 店内 (dineIn): テーブル番号 (必須)。未入力なら支払いボタンを無効化。 */}
            {config.dineIn && (
              <div>
                <label htmlFor="mo-table" className="block text-sm font-medium text-slate-700">
                  {t('tableLabel')}
                </label>
                <input
                  id="mo-table"
                  type="text"
                  inputMode="numeric"
                  value={tableNumber}
                  onChange={(e) => setTableNumber(e.target.value.slice(0, TABLE_NUMBER_MAX))}
                  placeholder={t('tablePlaceholder')}
                  aria-required="true"
                  aria-invalid={needsTable}
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-brand focus:outline-none"
                />
                {needsTable && <p className="mt-1 text-xs text-amber-700">{t('tableRequired')}</p>}
              </div>
            )}
            {/* ご注文内容 (合計の上)。カートマーク+点数のタップで明細を開閉。明細では −n+ で増減。 */}
            {cartOpen && (
              <ul className="space-y-2 border-b border-slate-100 pb-3">
                {config.menu
                  .filter((m) => (qty[m.id] ?? 0) > 0)
                  .map((m) => {
                    const n = qty[m.id] ?? 0;
                    return (
                      <li key={m.id} className="flex items-center justify-between gap-2 text-sm">
                        <span className="min-w-0 flex-1 truncate text-slate-700">{m.name}</span>
                        <span className="flex shrink-0 items-center gap-1">
                          <button
                            type="button"
                            onClick={() => setItemQty(m.id, n - 1)}
                            aria-label={t('qtyDecrease')}
                            className="flex h-6 w-6 items-center justify-center rounded-full border border-slate-300 text-slate-600"
                          >
                            −
                          </button>
                          <span className="w-5 text-center text-sm font-semibold tabular-nums">{n}</span>
                          <button
                            type="button"
                            onClick={() => setItemQty(m.id, n + 1)}
                            aria-label={t('qtyIncrease')}
                            className="flex h-6 w-6 items-center justify-center rounded-full border border-slate-300 text-slate-600"
                          >
                            ＋
                          </button>
                        </span>
                        <span className="w-16 shrink-0 text-right tabular-nums text-slate-600">
                          {formatUnits(parseUnits(m.price, decimals) * BigInt(n), decimals)}
                        </span>
                      </li>
                    );
                  })}
              </ul>
            )}
            {/* 合計 = カートマーク + 点数 (タップで上の明細を開閉) + 総額 */}
            <button
              type="button"
              onClick={() => setCartOpen((o) => !o)}
              aria-expanded={cartOpen}
              aria-label={t('orderItemsToggle')}
              className="flex w-full items-center justify-between gap-2"
            >
              <span className="flex items-center gap-1.5 text-sm font-medium text-slate-700">
                <span className="relative inline-flex">
                  <ShoppingCart className="h-5 w-5 text-slate-600" aria-hidden />
                  <span className="absolute -right-2 -top-2 flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-brand px-1 text-[10px] font-bold leading-none text-white">
                    {cartCount}
                  </span>
                </span>
                {t('orderItemsToggle')}
                {cartOpen ? (
                  <ChevronDown className="h-4 w-4 text-slate-400" aria-hidden />
                ) : (
                  <ChevronUp className="h-4 w-4 text-slate-400" aria-hidden />
                )}
              </span>
              <span className="text-base font-semibold text-slate-900">{totalHuman} JPYC</span>
            </button>
            <p className="text-xs text-amber-700">{t('irreversibleNote')}</p>
            {needsTable ? (
              // テーブル番号 未入力 (店内): 支払いを止める。入力すればリンクへ切り替わる。
              <button
                type="button"
                disabled
                className="block w-full cursor-not-allowed rounded-xl bg-slate-300 px-4 py-3 text-center text-sm font-semibold text-white"
              >
                {t('payButton')}
              </button>
            ) : (
              <a
                href={checkoutUrl}
                className="block rounded-xl bg-brand px-4 py-3 text-center text-sm font-semibold text-white hover:bg-brand-dark"
              >
                {t('payButton')}
              </a>
            )}
          </div>
        )}
      </section>

      <p className="text-center text-xs text-slate-400">
        {t.rich('poweredBy', {
          link: (chunks) => (
            <Link href="/" prefetch={false} className="underline hover:text-slate-600">
              {chunks}
            </Link>
          ),
        })}
      </p>
    </div>
  );
}
