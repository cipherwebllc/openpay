'use client';

// 顧客向け注文ページ: 店舗名 + チェーン + SNS + メニュー (数量ステッパ) + 合計 + 「支払いへ進む」。
// 注文トークン (?s=) を decodeOrderConfig したものを描画する。
//
// 決済は **既存の監査済み /checkout を流用** (手数料ゼロ = 現行「JPYC 0%」開示と整合・新規
// money-path コードなし)。カートの qty>0 の行を CheckoutItem[] に詰めて buildCheckoutUrl で
// /checkout へ deep-link するだけ。実際の送金/relay/控えは CheckoutForm 側 (既存)。
// モバイルオーダー固有の % 手数料は P0 (開示更新) 後の別増分で、ここには無い。

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { formatUnits } from 'viem';
import { SocialIconLinks } from '@/components/SocialIconLinks';
import { useOrigin } from '@/hooks/useOrigin';
import { deploymentForSlug } from '@/lib/tokens';
import {
  buildCheckoutUrl,
  calcCheckoutTotal,
  CHECKOUT_MAX_ITEMS,
  CHECKOUT_QTY_MAX,
  type CheckoutItem,
} from '@/lib/url';
import { safeHttpUrl, JPYC_CHAIN_LABEL, type MobileOrderConfig } from '@/lib/mobileOrder';

// アバター読込失敗/未設定時のフォールバック頭文字 (@handle と同じくコードポイント単位)。
function initialOf(name: string): string {
  const n = name.trim();
  return n ? ([...n][0] ?? '').toUpperCase() : '🏪';
}

export function MobileOrderView({ config }: { config: MobileOrderConfig }) {
  const t = useTranslations('MobileOrder');
  const origin = useOrigin();
  const [qty, setQty] = useState<Record<string, number>>({});

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

  const decimals = deploymentForSlug('jpyc', config.chain).decimals;
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
  const checkoutUrl =
    origin && cartItems.length > 0 && !tooMany
      ? buildCheckoutUrl(origin, {
          to: config.receiver,
          token: 'jpyc',
          chain: config.chain,
          gas: 'customer',
          items: cartItems,
        })
      : '';

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
        <p className="mt-1 text-xs text-slate-500">
          {t('viewChainBadge', { chain: JPYC_CHAIN_LABEL[config.chain] })}
        </p>
        {socialUrls.length > 0 && (
          <div className="mt-3">
            <SocialIconLinks urls={socialUrls} />
          </div>
        )}
      </header>

      <section>
        <h2 className="mb-2 text-sm font-semibold text-slate-700">{t('viewMenuHeading')}</h2>
        <ul className="divide-y divide-slate-100 rounded-2xl border border-slate-200 bg-white">
          {config.menu.map((item) => {
            const n = qty[item.id] ?? 0;
            const imgUrl = item.visual?.kind === 'image' ? safeHttpUrl(item.visual.url) : undefined;
            return (
              <li key={item.id} className="flex items-center justify-between gap-3 px-4 py-3">
                <span className="flex min-w-0 flex-1 items-center gap-2">
                  {item.visual?.kind === 'emoji' && (
                    <span className="text-lg" aria-hidden>
                      {item.visual.value}
                    </span>
                  )}
                  {imgUrl && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={imgUrl} alt="" className="h-9 w-9 rounded object-cover" />
                  )}
                  <span className="min-w-0">
                    <span className="block truncate text-slate-800">{item.name}</span>
                    <span className="text-xs text-slate-500">{item.price} JPYC</span>
                  </span>
                </span>
                {/* 数量ステッパ (− n +) */}
                <span className="flex shrink-0 items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setItemQty(item.id, n - 1)}
                    disabled={n === 0}
                    aria-label={t('qtyDecrease')}
                    className="flex h-8 w-8 items-center justify-center rounded-full border border-slate-300 text-slate-600 disabled:opacity-30"
                  >
                    −
                  </button>
                  <span className="w-6 text-center text-sm font-semibold tabular-nums">{n}</span>
                  <button
                    type="button"
                    onClick={() => setItemQty(item.id, n + 1)}
                    aria-label={t('qtyIncrease')}
                    className="flex h-8 w-8 items-center justify-center rounded-full border border-slate-300 text-slate-600"
                  >
                    ＋
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
      </section>

      {/* 注文サマリ + 支払い (既存 /checkout へ・手数料0) */}
      <section className="rounded-2xl border border-slate-200 bg-white p-4">
        {cartItems.length === 0 ? (
          <p className="text-center text-sm text-slate-400">{t('cartEmpty')}</p>
        ) : tooMany ? (
          <p className="text-center text-sm text-red-600">
            {t('tooManyItems', { max: CHECKOUT_MAX_ITEMS })}
          </p>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center justify-between text-base font-semibold text-slate-900">
              <span>{t('orderTotal')}</span>
              <span>{totalHuman} JPYC</span>
            </div>
            <p className="text-xs text-amber-700">{t('irreversibleNote')}</p>
            <a
              href={checkoutUrl}
              className="block rounded-xl bg-brand px-4 py-3 text-center text-sm font-semibold text-white hover:bg-brand-dark"
            >
              {t('payButton')}
            </a>
          </div>
        )}
      </section>

      <p className="text-center text-xs text-slate-400">{t('poweredBy')}</p>
    </div>
  );
}
