'use client';

// 顧客向け注文ページ: 店舗名 + チェーン + SNS + メニュー (数量ステッパ) + 合計 + 「支払いへ進む」。
// 注文トークン (?s=) を decodeOrderConfig したものを描画する。
//
// 決済は **既存の監査済み /checkout を流用** (手数料ゼロ = 現行「JPYC 0%」開示と整合・新規
// money-path コードなし)。カートの qty>0 の行を CheckoutItem[] に詰めて buildCheckoutUrl で
// /checkout へ deep-link するだけ。実際の送金/relay/控えは CheckoutForm 側 (既存)。
// モバイルオーダー固有の % 手数料は P0 (開示更新) 後の別増分で、ここには無い。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { formatUnits } from 'viem';
import { Clock, MapPin, Phone } from 'lucide-react';
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
  type MenuItem,
} from '@/lib/mobileOrder';
import { EMPTY_SHOP_LIVE, type ShopLiveState } from '@/lib/shopLive';
import { isPastLastOrder, pickupSlots } from '@/lib/shopTime';
import {
  mobileOrderFeeBps,
  mobileOrderFeeValue,
  mobileOrderGasMode,
} from '@/lib/mobileOrderFee';
import {
  composeLineName,
  effectiveUnitPrice,
  selectionKey,
  type OptionChoice,
} from '@/lib/menuOptions';
import { resolvePrefillCart } from '@/lib/prefillCart';
import type { AgentCartItem } from '@/lib/agentOrder';
import { OptionSelectModal } from '@/components/OptionSelectModal';
import { MenuItemCard } from '@/components/MenuItemCard';
import { MobileOrderCartBar } from '@/components/MobileOrderCartBar';

// カート行 (オプション無し=menu+qty / オプション有り=optionEntries) の統合ビュー型。
type OptionCartEntry = {
  key: string; // selectionKey (itemId#group:choice,...)
  itemId: string;
  name: string; // composeLineName 済 (オプションをサフィックス化)
  price: string; // effectiveUnitPrice 済 (base + Σdelta)
  qty: number;
  taxRate?: number;
  taxCategory?: MenuItem['taxCategory'];
};
export type CartLineView = OptionCartEntry & { isOption: boolean };

// 店内 (dineIn) 時のテーブル番号入力の最大長。/checkout の description (200) に十分収まる短さ。
const TABLE_NUMBER_MAX = 16;

// 受け渡し照合用の短い受注番号 (客の完了画面 + 店主の受注カードの双方に表示)。混同しやすい
// 0/1/O/I/L を除いた 31 文字 × 6 桁 ≈ 8.87 億通り。
const ORDER_CODE_CHARS = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
function generateOrderCode(): string {
  const n = 6;
  let out = '';
  try {
    const buf = new Uint32Array(n);
    crypto.getRandomValues(buf);
    for (let i = 0; i < n; i++) out += ORDER_CODE_CHARS[buf[i] % ORDER_CODE_CHARS.length];
  } catch {
    // CSPRNG when available。これは表示用 ID なので、利用不能環境では可用性を優先して
    // Math.random へ fallback する (決済・署名・冪等性の安全性には使用しない)。
    for (let i = 0; i < n; i++)
      out += ORDER_CODE_CHARS[Math.floor(Math.random() * ORDER_CODE_CHARS.length)];
  }
  return out;
}

// アバター読込失敗/未設定時のフォールバック頭文字 (@handle と同じくコードポイント単位)。
function initialOf(name: string): string {
  const n = name.trim();
  return n ? ([...n][0] ?? '').toUpperCase() : '🏪';
}

// テーマ色 (config.accent) 未設定時のブランド既定 (= tailwind brand.DEFAULT)。
const DEFAULT_ACCENT = '#1e40af';

// 任意のアクセント色の上に「白」と「濃色」どちらの文字が読めるかを相対輝度 (WCAG 近似) で判定。
// 淡い色 (黄/水色 等) を選んだ店でも「支払いへ進む」等の塗り潰しボタンが読めるようにする。
function readableInk(hex: string): string {
  const ch = (i: number) => parseInt(hex.slice(i, i + 2), 16) / 255;
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const L = 0.2126 * lin(ch(1)) + 0.7152 * lin(ch(3)) + 0.0722 * lin(ch(5));
  return L > 0.45 ? '#0f172a' : '#ffffff'; // 明るい背景 → slate-900 / 暗い背景 → 白
}

// 白背景で「文字色/枠色」として読めるアクセント。淡い色 (黄等) はそのままだと白地で読めないので
// 輝度が下がるまで暗くする (塗り潰しは readableInk で担保・こちらは text/border 用)。
function accentOnWhite(hex: string): string {
  let r = parseInt(hex.slice(1, 3), 16);
  let g = parseInt(hex.slice(3, 5), 16);
  let b = parseInt(hex.slice(5, 7), 16);
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const lum = () => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  for (let i = 0; i < 20 && lum() > 0.3; i++) {
    r = Math.round(r * 0.85);
    g = Math.round(g * 0.85);
    b = Math.round(b * 0.85);
  }
  const h = (n: number) => n.toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

export function MobileOrderView({
  config,
  backHref,
  backLabel,
  handle,
  live,
  initialCart,
}: {
  config: MobileOrderConfig;
  /** 「支払いへ進む」後の /checkout から戻る店舗ページのパス (同一オリジン)。@handle 公開時に渡る。 */
  backHref?: string;
  /** 戻りリンクのラベル (店名)。 */
  backLabel?: string;
  /** 公開元の @handle (正規化済み・@ 無し)。受注リレー (flag ON 時) の webhook 束縛に使う。 */
  handle?: string;
  /** ライブ運用状態 (売り切れ / 受付一時停止)。flag OFF / ?s= 経路では未指定 = 制限なし。 */
  live?: ShopLiveState;
  /**
   * 事前充填カート (@handle ?cart= 経路のみ)。server で decodeAgentCart 済みの **検証済み** カート。
   * マウント時に menu と突合して初期カート状態にする (価格・受取先は menu/KV 由来で再計算 = 改ざん無害化)。
   * 未指定 (bare @handle / ?s= 経路) では従来挙動と完全同一 (構造的 inert)。
   */
  initialCart?: AgentCartItem[] | null;
}) {
  const t = useTranslations('MobileOrder');
  const origin = useOrigin();
  // 店舗のテーマ色 (@handle のプロフィール色 config.color 由来)。未設定/不正はブランド既定。
  // アクセント (カートバー/＋/チェーン/ヘッダー) を CSS 変数で配り、塗り潰しの文字色は輝度から
  // 自動選択してコントラストを担保する。
  const accent =
    config.accent && /^#[0-9a-fA-F]{6}$/.test(config.accent)
      ? config.accent
      : DEFAULT_ACCENT;
  const accentInk = readableInk(accent); // 塗り潰し背景の上の文字色
  const accentText = accentOnWhite(accent); // 白地での文字色/枠色 (淡色は暗くして可読性確保)
  // 事前充填 (?cart=)。@handle 店舗ページが server で decodeAgentCart 済みの検証済みカートを渡す。
  // マウント時に一度だけ menu と突合して初期カートを解決する (未知 id / オプション不整合は該当行を
  // drop・価格は menu 由来で再計算 = 改ざん無害化)。cart 不在では空 = 従来挙動と完全同一 (inert)。
  const initialPrefill = useMemo(
    () => resolvePrefillCart(config.menu, initialCart ?? null, env.enableMenuOptions),
    // 初期状態の解決はマウント時のみ (deps 空)。以後 config 差し替えでもユーザが編集したカートを
    // 上書きしない (再充填しない)。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const prefilled =
    Object.keys(initialPrefill.qty).length > 0 || initialPrefill.optionEntries.length > 0;
  const [qty, setQty] = useState<Record<string, number>>(initialPrefill.qty);
  // 注文内容 (カート明細) の開閉。既定は閉 (カートマークのタップで展開)。事前充填時は AI が選んだ明細を
  // 人が確認してから支払えるよう既定で開く (M2 の「人間の最終確認面」)。
  const [cartOpen, setCartOpen] = useState(prefilled);
  // 店内 (dineIn) 時に顧客が入力するテーブル番号 (注文時のみ・config には保存しない)。
  const [tableNumber, setTableNumber] = useState('');
  // 受注リレー (flag ON) 用の短い受注番号。この注文ページ訪問で安定 (再描画/チェーン切替で不変)。
  // 客の完了画面 (/checkout の order_id) と店主の受注カードの双方に表示され、受け渡し照合に使う。
  const [orderId, setOrderId] = useState<string | null>(null);
  const orderIdGenerated = useRef(false);
  useEffect(() => {
    // SSR/client の初回 HTML を一致させ、StrictMode の effect 再実行でも同一 mount 中は再生成しない。
    if (orderIdGenerated.current) return;
    orderIdGenerated.current = true;
    setOrderId(generateOrderCode());
  }, []);

  // 店舗アイコン: 注文トークンは attacker-controllable なので safeHttpUrl で https に限定し、
  // 読込失敗 (onError) は頭文字へ fallback (@handle のアバターと同型)。URL 変更で失敗状態リセット。
  const [avatarFailed, setAvatarFailed] = useState(false);
  const avatarUrl = safeHttpUrl(config.avatar);
  useEffect(() => setAvatarFailed(false), [config.avatar]);
  const showAvatar = !!avatarUrl && !avatarFailed;

  // 店舗カバー (ヘッダー背景画像)。avatar と同型: https 限定 + 読込失敗で非表示に fallback。
  const [coverFailed, setCoverFailed] = useState(false);
  const coverUrl = safeHttpUrl(config.cover);
  useEffect(() => setCoverFailed(false), [config.cover]);
  const showCover = !!coverUrl && !coverFailed;

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
  // MenuItemCard へ安定参照で渡す (memo が効くよう useCallback 化)。setQty は不変・定数のみ参照。
  const setItemQty = useCallback(
    (id: string, n: number) =>
      setQty((q) => ({ ...q, [id]: Math.max(0, Math.min(CHECKOUT_QTY_MAX, n)) })),
    [],
  );

  // ライブ運用状態 (売り切れ / 受付一時停止)。未指定 (flag OFF / ?s= 経路) は制限なし (EMPTY)。
  const liveState = live ?? EMPTY_SHOP_LIVE;
  const soldOutSet = useMemo(() => new Set(liveState.soldOut), [liveState.soldOut]);
  const paused = liveState.paused;

  // 時間系 (Phase 4・flag NEXT_PUBLIC_ENABLE_PREORDER_TIME)。OFF では一切評価しない (inert)。
  // Asia/Tokyo 固定。ラストオーダー超過で受付停止、preorder は受取スロットを選んで pickupAt を付与。
  const timeEnabled = env.enablePreorderTime;
  const isPreorder = config.mode === 'preorder';
  // ラストオーダー停止判定とスロット候補のため現在時刻を保持 (15分グリッドなので 30s 更新で十分)。
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!timeEnabled) return;
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, [timeEnabled]);
  // preorder の受取スロット候補 (絶対 ms・昇順)。storefront/flag OFF は空。
  const pickupSlotList = useMemo(
    () =>
      timeEnabled && isPreorder
        ? pickupSlots(now, config.minLeadMinutes, config.lastOrder)
        : [],
    [timeEnabled, isPreorder, now, config.minLeadMinutes, config.lastOrder],
  );
  const [pickupAt, setPickupAt] = useState<number | null>(null);
  // 時間経過で選択スロットが候補外 (過去) になったら解除 (過去の受取時刻を送らない)。スロットは
  // 15分グリッド固定ゆえ、まだ未来の選択は候補に残り続け、過去落ちしたときだけ false になる。
  useEffect(() => {
    if (pickupAt !== null && !pickupSlotList.includes(pickupAt)) setPickupAt(null);
  }, [pickupAt, pickupSlotList]);

  // メニューオプション (サイズ/トッピング)・flag 裏。OFF では options を無視し従来の数量ステッパのみ
  // (オプション無し商品は常に従来の qty マップを使う = 既存挙動不変)。
  const optionsEnabled = env.enableMenuOptions;
  const hasOptions = (m: MenuItem) => optionsEnabled && (m.options?.length ?? 0) > 0;
  // オプション選択で確定した行 (selectionKey で識別・同一商品の別オプションは別行)。
  // 事前充填 (?cart=) 時はマウント時に解決したオプション行を初期値にする。
  const [optionEntries, setOptionEntries] =
    useState<OptionCartEntry[]>(initialPrefill.optionEntries);
  const [optionModalItem, setOptionModalItem] = useState<MenuItem | null>(null);
  const optionCount = (itemId: string) =>
    optionEntries.filter((e) => e.itemId === itemId).reduce((s, e) => s + e.qty, 0);

  const addOptionEntry = (
    item: MenuItem,
    choices: OptionChoice[],
    selections: { groupId: string; choiceId: string }[],
  ) => {
    const key = selectionKey(item.id, selections);
    setOptionEntries((list) => {
      const idx = list.findIndex((e) => e.key === key);
      if (idx >= 0) {
        const next = [...list];
        next[idx] = { ...next[idx], qty: Math.min(CHECKOUT_QTY_MAX, next[idx].qty + 1) };
        return next;
      }
      return [
        ...list,
        {
          key,
          itemId: item.id,
          name: composeLineName(item.name, choices),
          price: effectiveUnitPrice(item.price, choices),
          qty: 1,
          taxRate: item.taxRate,
          taxCategory: item.taxCategory,
        },
      ];
    });
    setOptionModalItem(null);
  };
  const setOptionEntryQty = (key: string, n: number) =>
    setOptionEntries((list) =>
      n <= 0
        ? list.filter((e) => e.key !== key)
        : list.map((e) => (e.key === key ? { ...e, qty: Math.min(CHECKOUT_QTY_MAX, n) } : e)),
    );

  // カート行を統合 (明細表示 + 決済 items の単一情報源・売り切れは除外)。
  const cartLines = useMemo<CartLineView[]>(() => {
    const base: CartLineView[] = config.menu
      .filter((m) => !hasOptions(m) && (qty[m.id] ?? 0) > 0 && !soldOutSet.has(m.id))
      .map((m) => ({
        key: m.id,
        itemId: m.id,
        name: m.name,
        price: m.price,
        qty: qty[m.id],
        taxRate: m.taxRate,
        taxCategory: m.taxCategory,
        isOption: false,
      }));
    const opt: CartLineView[] = optionEntries
      .filter((e) => e.qty > 0 && !soldOutSet.has(e.itemId))
      .map((e) => ({ ...e, isOption: true }));
    return [...base, ...opt];
    // hasOptions は optionsEnabled に依存 (deps に含める)。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.menu, qty, soldOutSet, optionEntries, optionsEnabled]);

  // cartLines → CheckoutItem[] (決済額は /checkout が items から再計算)。税率/税区分も引き継ぐ。
  const cartItems = useMemo<CheckoutItem[]>(
    () =>
      cartLines.map((l) => {
        const item: CheckoutItem = { name: l.name, qty: l.qty, price: l.price };
        if (typeof l.taxRate === 'number') item.taxRate = l.taxRate;
        if (l.taxCategory) item.taxCategory = l.taxCategory;
        return item;
      }),
    [cartLines],
  );

  // /checkout は 1〜10 品まで。超過時は支払いを止めて明示 (URL を組んでも parse 側で弾かれるため)。
  const tooMany = cartItems.length > CHECKOUT_MAX_ITEMS;
  // 商品小計 (税込・システム利用料を含まない)。
  const orderWei =
    cartItems.length > 0 && !tooMany
      ? calcCheckoutTotal(cartItems, decimals)
      : 0n;
  // モバイル注文システム利用料 (flag ON のときのみ)。顧客上乗せ (preorder + feePayer=customer) では
  // 客の表示総額に上乗せする (店頭/店舗負担は原価のみ表示・店舗が受取から吸収するので客には出さない)。
  // 料率は店舗モード (config.mode) 由来。flag OFF は 0n = 従来どおり原価のみ表示。
  const feeUpcharge =
    env.enableMobileOrderFee &&
    mobileOrderGasMode(config.mode, config.feePayer) === 'customer'
      ? mobileOrderFeeValue(orderWei, config.mode)
      : 0n;
  const totalHuman =
    orderWei > 0n ? formatUnits(orderWei + feeUpcharge, decimals) : '0';
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
  const awaitsOrderId = env.enableOrderRelay && Boolean(handle) && orderId === null;
  const baseCheckoutUrl =
    origin && cartItems.length > 0 && !tooMany && !awaitsOrderId
      ? buildCheckoutUrl(origin, {
          to: config.receiver,
          token: 'jpyc',
          chain, // 顧客が選んだ受取チェーン (単一なら config.chain)
          gas: 'customer',
          items: cartItems,
          description: orderDescription, // 店内のテーブル番号 (テイクアウトは undefined)
          // モバイル注文システム利用料 (flag ON のときだけ)。CheckoutForm/relay が feeKind/feePayer
          // から経路非依存に 1%(店頭)/3%(事前) を分割する。flag OFF では付かず従来動作 (inert)。
          ...(env.enableMobileOrderFee
            ? { feeKind: config.mode, feePayer: config.feePayer }
            : {}),
          // 受注リレー用 (flag ON + @handle 公開時のみ・OFF では付かず inert)。
          // orderId = webhook→店主の受注フィード + 完了画面の見出し。
          // receiptNo = 同じ受注番号を顧客の控え (localStorage・/scan で後から確認可) にも残す
          //   → 完了画面を閉じても「レシート番号」として受注番号を再確認できる (受け渡し照合用)。
          ...(orderRelayWebhook && orderId
            ? { webhook: orderRelayWebhook, orderId, receiptNo: orderId }
            : {}),
          // 受取予定時刻 (Phase 4・preorder で顧客が選んだスロット・flag OFF/未選択は付かない)。
          ...(timeEnabled && isPreorder && pickupAt ? { pickupAt } : {}),
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

  // 商品カード (おすすめセクション + カテゴリーグリッドで共用)。この品の派生値 (qty / 売り切れ /
  // オプション数) + 安定コールバックだけを React.memo 化した MenuItemCard に渡し、変化していない品を
  // 再描画しない (売り切れ品のステッパ非表示・写真上の「売り切れ」重ねは MenuItemCard 内で描画)。
  const renderItemCard = (item: MenuItem) => (
    <MenuItemCard
      key={item.id}
      item={item}
      qty={qty[item.id] ?? 0}
      isSoldOut={soldOutSet.has(item.id)}
      hasOptions={hasOptions(item)}
      optionCount={optionCount(item.id)}
      onQtyChange={setItemQty}
      onOpenOptions={setOptionModalItem}
    />
  );

  // おすすめ (公開ページ先頭で訴求)。売り切れ品は除外。
  const recommendedItems = useMemo(
    () => config.menu.filter((m) => m.recommended && !soldOutSet.has(m.id)),
    [config.menu, soldOutSet],
  );

  // 店舗情報 + 受付可否。静的 acceptingOrders===false / ライブ paused / ラストオーダー超過 のとき
  // 支払いを止める (不可逆決済の事故防止)。メッセージは 終了 > 一時停止 > ラストオーダー の優先。
  const pastLastOrder = timeEnabled && isPastLastOrder(now, config.lastOrder);
  const accepting = config.acceptingOrders !== false && !paused && !pastLastOrder;
  const closedNoticeKey =
    config.acceptingOrders === false
      ? 'viewClosedNotice'
      : paused
        ? 'viewPausedNotice'
        : 'viewLastOrderNotice';
  const tel = telHref(config.phone);
  const mapHref = mapSearchHref(config.address);
  const hasStoreInfo = !!(config.address || config.hours || config.phone);

  return (
    <div
      className="space-y-5"
      style={
        {
          '--mo-accent': accent,
          '--mo-accent-ink': accentInk,
          '--mo-accent-text': accentText,
        } as React.CSSProperties
      }
    >
      <header className="text-center">
        {/* 店舗カバー (任意・https のみ)。横幅いっぱい (px-4 を打ち消し) のヒーロー背景に、
            アバターを下端へ重ねる定番の店舗ヘッダー。読込失敗でカバーは消えアバターのみに。 */}
        {showCover && (
          <div className="relative -mx-4 h-36 overflow-hidden rounded-b-3xl bg-slate-100">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={coverUrl}
              alt=""
              referrerPolicy="no-referrer"
              loading="lazy"
              className="h-full w-full object-cover"
              onError={() => setCoverFailed(true)}
            />
          </div>
        )}
        <div
          className={`mx-auto flex h-24 w-24 items-center justify-center overflow-hidden rounded-full bg-[var(--mo-accent)] text-3xl font-bold text-[var(--mo-accent-ink)] ${
            showCover
              ? 'relative -mt-12 shadow-lg ring-4 ring-white'
              : 'shadow-[0_12px_30px_-10px_rgba(15,23,42,0.28)] ring-1 ring-black/5'
          }`}
        >
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
        <h1 className="mt-4 text-2xl font-bold tracking-tight text-slate-900">{config.shopName}</h1>
        {config.tagline && (
          <p className="mt-1.5 text-sm text-slate-500">{config.tagline}</p>
        )}
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
                      ? 'border-[var(--mo-accent)] bg-[var(--mo-accent)] text-[var(--mo-accent-ink)]'
                      : 'border-slate-300 text-slate-600 hover:border-[var(--mo-accent-text)]'
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

      {/* 事前充填 (?cart=) の通知。AI/リンク経由で選ばれた注文であることを客に伝え、明細と合計を
          確認のうえ支払うよう促す (M2 の「人間の最終確認面」の砦・下部カートバーは既定で開いて出す)。
          可視テキストのみ (aria-label 単独付与なし・掟8)。cart 不在では出ない (inert)。 */}
      {prefilled && (
        <div className="rounded-2xl border border-blue-200 bg-blue-50 px-4 py-3 text-center text-sm font-medium text-blue-800">
          {t('prefillNotice')}
        </div>
      )}

      {/* 受付停止中バナー (acceptingOrders===false)。客が払う前に最上部で告知。 */}
      {!accepting && (
        <div className="rounded-2xl border border-amber-300 bg-amber-50 px-4 py-3 text-center text-sm font-semibold text-amber-800">
          {t(closedNoticeKey)}
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
                  className="text-[var(--mo-accent-text)] hover:underline"
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
                <a href={tel} className="text-[var(--mo-accent-text)] hover:underline">
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
        {/* おすすめ (最初に目にする位置で一押しを訴求)。売り切れ品は除外済。flag 裏 (既定 OFF=非表示)。 */}
        {env.enableShopLive && recommendedItems.length > 0 && (
          <div className="mb-5">
            <h3 className="mb-2 border-b border-amber-200 pb-1 text-sm font-bold text-amber-700">
              {t('viewRecommendedHeading')}
            </h3>
            <ul className="grid grid-cols-2 gap-3">{recommendedItems.map(renderItemCard)}</ul>
          </div>
        )}
        {/* カテゴリーメニュー (上部・横スクロール・タップで該当カテゴリーへジャンプ)。 */}
        {showCategoryNav && (
          <nav className="sticky top-0 z-10 -mx-3 mb-3 flex gap-2 overflow-x-auto bg-white/95 px-3 py-2 backdrop-blur">
            {menuGroups.map((group, i) => (
              <a
                key={sectionId(i)}
                href={`#${sectionId(i)}`}
                className="shrink-0 rounded-full border border-slate-300 px-3 py-1 text-xs font-medium text-slate-600 hover:border-[var(--mo-accent-text)] hover:text-[var(--mo-accent-text)]"
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
            <ul className="grid grid-cols-2 gap-3">{group.items.map(renderItemCard)}</ul>
          </div>
        ))}
      </section>

      {/* 注文サマリ + 支払い — 商品があれば画面下部に浮く (sticky) アプリ風カートバー。
          メニューをスクロール中も常に見え、最下部ではフッターの上に収まる (通常フロー=重ならない)。
          空 / 受付停止では出さない (受付停止は上部バナーで告知済み)。決済は既存 /checkout へ。 */}
      {accepting && cartItems.length > 0 && (
        <MobileOrderCartBar
          tooMany={tooMany}
          dineIn={config.dineIn}
          tableNumber={tableNumber}
          onTableNumberChange={(v) => setTableNumber(v.slice(0, TABLE_NUMBER_MAX))}
          needsTable={needsTable}
          pickup={{
            show: timeEnabled && isPreorder,
            slots: pickupSlotList,
            value: pickupAt,
            onChange: setPickupAt,
          }}
          cart={{
            open: cartOpen,
            onToggle: () => setCartOpen((o) => !o),
            lines: cartLines,
            decimals,
            count: cartCount,
            totalHuman,
            feeUpcharge,
            feeBps: mobileOrderFeeBps(config.mode),
            onItemQtyChange: setItemQty,
            onOptionQtyChange: setOptionEntryQty,
          }}
          lastOrder={timeEnabled ? config.lastOrder : undefined}
          checkoutUrl={checkoutUrl}
          checkoutPending={awaitsOrderId}
        />
      )}

      <p className="text-center text-xs text-slate-400">
        {t.rich('poweredBy', {
          link: (chunks) => (
            <Link href="/" prefetch={false} className="underline hover:text-slate-600">
              {chunks}
            </Link>
          ),
        })}
      </p>

      {/* オプション選択モーダル (flag ON + options 有り商品をタップしたとき)。確定で optionEntries へ。 */}
      {optionModalItem && (
        <OptionSelectModal
          open
          itemName={optionModalItem.name}
          basePrice={optionModalItem.price}
          options={optionModalItem.options ?? []}
          symbol="JPYC"
          onConfirm={(choices, selections) =>
            addOptionEntry(optionModalItem, choices, selections)
          }
          onClose={() => setOptionModalItem(null)}
        />
      )}
    </div>
  );
}
