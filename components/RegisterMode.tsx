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
import { useQuery } from '@tanstack/react-query';
import { formatUnits, getAddress, isAddress, type Address } from 'viem';
import { ChevronRight, Minus, Plus, QrCode as QrCodeIcon, Star, Trash2 } from 'lucide-react';
import { AccountingSection } from './AccountingSection';
import { QrPreviewModal } from './QrPreviewModal';
import { StoreGasWalletPanel } from './StoreGasWalletPanel';
import { StoreDeviceRegisterStatus } from './StoreDeviceRegisterStatus';
import { useStoreDeviceMode } from './StoreDeviceProvider';
import {
  STORE_DEVICE_MIN_AMOUNT_WEI,
  formatStoreDeviceAmount,
  storeDeviceChainConfig,
  storeDeviceChainNames,
} from '@/lib/storeDevicePayment';
import { storePaysActive, storePaysRequested } from '@/lib/storePaysMode';
import { Field } from './Field';
import { ExternalImage } from './ExternalImage';
import { ProductPresetManager } from './ProductPresetManager';
import { switchTokenKeepingPrefs, useQrSettings } from '@/hooks/useQrSettings';
import { useReceiverAutofill, type ReceiverSource } from '@/hooks/useReceiverAutofill';
import { useResolveAddress } from '@/hooks/useResolveAddress';
import { useProductPresets, type ProductPreset } from '@/hooks/useProductPresets';
import { useShopLive } from '@/hooks/useShopLive';
import { useSiweSession } from '@/hooks/useSiweSession';
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
import { composeLineName, effectiveUnitPrice, type OptionChoice } from '@/lib/menuOptions';
import { OptionSelectModal } from './OptionSelectModal';
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
import { categoryColorClasses } from '@/lib/categoryColor';
import type { ShopLiveState } from '@/lib/shopLive';
import { fetchMyHandles, myHandlesQueryKey } from '@/lib/handleMine';

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

type RegisterModeProps = {
  /** 通貨/チェーンを変更する導線 (page が QR タブへ切替える)。レジは読み取り専用表示。 */
  onEditCurrency?: () => void;
};

type RegisterShopLive = {
  state: ShopLiveState;
  toggleSoldOut: (itemId: string, value: boolean) => void;
  isPending: boolean;
};

export function RegisterMode(props: RegisterModeProps) {
  // flag OFF では SIWE / handle / live の query を一切起動せず、従来のレジ依存境界を保つ。
  return env.enableShopLive ? (
    <RegisterModeWithShopLive {...props} />
  ) : (
    <RegisterModeContent {...props} />
  );
}

function RegisterModeWithShopLive(props: RegisterModeProps) {
  const { isSignedIn, sessionAddress } = useSiweSession();
  const mine = useQuery({
    // 取得と返り値の形は lib/handleMine.ts に 1 つ (他の画面・トップと同じ cache を共有する)。
    queryKey: myHandlesQueryKey(sessionAddress),
    enabled: env.enableHandles && env.enableShopLive && isSignedIn,
    queryFn: fetchMyHandles,
  });
  const liveHandle = mine.data?.handles.find((h) => h.storefront)?.handle ?? '';
  const { live, patch } = useShopLive(liveHandle);

  // handle/live の障害をレジ本来の会計・商品選択 UI へ波及させないため、取得成功時だけ付加 UI を渡す。
  const shopLive: RegisterShopLive | undefined =
    isSignedIn && mine.isSuccess && liveHandle && live.isSuccess && !patch.isError
      ? {
          state: live.data,
          toggleSoldOut: (itemId, value) =>
            patch.mutate({ op: 'soldOut', itemId, value }),
          isPending: patch.isPending,
        }
      : undefined;

  return <RegisterModeContent {...props} shopLive={shopLive} />;
}

function RegisterModeContent({
  onEditCurrency,
  shopLive,
}: RegisterModeProps & { shopLive?: RegisterShopLive }) {
  const t = useTranslations('RegisterMode');
  const tQr = useTranslations('QrGenerator');
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
  // オプション付き preset をタップしたとき表示する選択モーダル (flag 裏)。
  const [optionModalPreset, setOptionModalPreset] = useState<ProductPreset | null>(null);
  const qrRef = useRef<HTMLDivElement>(null);
  const totalBarRef = useRef<HTMLDivElement>(null);

  // お店の端末で送る (flag 裏・端末ごとの切替・plans/store-gas-wallet.md P2b-2・§19)。状態は作成ページの両タブの外
  // (StoreDeviceProvider) に 1 つ (タブを切り替えても送信と「次の QR を出せない間」が続く)。flag OFF・切替 OFF では
  // 通信も effect も起こさず、QR・URL・ボタンの動きは今のまま。
  const {
    setOn: setStoreDeviceOn,
    gasAddress,
    setGasAddress,
    chainIds: sdChainIds,
    blocked: sdBlocked,
    enabled: sdEnabled,
    device,
  } = useStoreDeviceMode();
  // お店負担の QR (受け渡しを作った時点の会計で組み立てたもの・null = 出していない)。
  const [storeQr, setStoreQr] = useState<{ id: string; url: string } | null>(null);
  // 「通常の QR を出す」を店員が選んだ (お店の端末で送るの QR を作れない・読み取れないとき)。
  const [forceNormalQr, setForceNormalQr] = useState(false);
  // 決済モードの 3 つ目「お店がガス代を肩代わりして送る」(決済QRタブで選び、レジは引き継ぐ・§19)。
  // 選んでいる (requested) と、いまの通貨・チェーンで使える (active) を分ける (通貨が暗黙に切り替わっても設定は消さない)。
  const storeRequested = storePaysRequested(settings);
  const storeCfgActive = storePaysActive(settings);
  useEffect(() => {
    // 設定を読み込む前の既定値 (OFF) で、送っている支払いの「次の QR を出せない間」や「もう一度送る」を消さない。
    // 選んでいるか (requested) で知らせる。いまの通貨・チェーンで使えるかは会計ごとに止める (理由 'token') ので、レジの
    // 商品で USDC に暗黙に切り替わっても送る設定は OFF にしない (送れなかった支払いの「もう一度送る」を黙って消さない)。
    if (hydrated) setStoreDeviceOn(storeRequested);
  }, [hydrated, storeRequested, setStoreDeviceOn]);

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
  // この会計のチェーンでお店負担に使う値 (JPYC・forwarder・手数料受取口・使えないチェーンなら null)。
  const sdConfig = storeDeviceChainConfig(deployment.chainId);
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
  const soldOut = useMemo(
    () => new Set(shopLive?.state.soldOut ?? []),
    [shopLive?.state.soldOut],
  );

  function addFromPreset(p: ProductPreset) {
    // 異通貨プリセットはカート非空時に警告 (同一カート単一通貨)。空なら通貨を切替。
    if (cart.length > 0 && p.token !== settings.token) {
      setCurrencyWarning(true);
      return;
    }
    setCurrencyWarning(false);
    if (cart.length === 0 && p.token !== settings.token) {
      setSettings((s) => switchTokenKeepingPrefs(s, p.token));
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

  const hasPresetOptions = (p: ProductPreset) =>
    env.enableMenuOptions && (p.options?.length ?? 0) > 0;

  // オプション付き preset: モーダルで選択 → 実効単価 + サフィックス名で新規行を追加 (option 行は dedup せず・
  // 行は通常どおり編集可)。通貨ガードは addFromPreset と同じ。
  function addOptionLine(p: ProductPreset, choices: OptionChoice[]) {
    setOptionModalPreset(null);
    if (cart.length > 0 && p.token !== settings.token) {
      setCurrencyWarning(true);
      return;
    }
    setCurrencyWarning(false);
    if (cart.length === 0 && p.token !== settings.token) {
      setSettings((s) => switchTokenKeepingPrefs(s, p.token));
    }
    const name = composeLineName(p.name, choices);
    const unitPrice = effectiveUnitPrice(p.unitPrice, choices);
    setCart((c) => {
      // 同一 preset + 同一オプション (= 同一表示名) の行は qty+1 にまとめる (10 行上限の浪費防止)。
      // 行をリネーム済なら一致せず新規行になる (許容)。
      const existing = c.find((l) => l.presetId === p.id && l.name === name);
      if (existing) {
        return c.map((l) =>
          l.id === existing.id ? { ...l, quantity: Math.min(999, l.quantity + 1) } : l,
        );
      }
      if (c.length >= CHECKOUT_MAX_ITEMS) return c;
      return [
        ...c,
        {
          id: randomId(),
          name,
          unitPrice,
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

  // プリセット → カート投入数の合計 (POS タイルのバッジ用)。オプション付きで複数行に
  // 分かれても presetId 単位で合算し、そのプリセットが「今いくつ入っているか」を1目で示す。
  const presetQty = useMemo(() => {
    const m = new Map<string, number>();
    for (const l of cart) {
      if (l.presetId) m.set(l.presetId, (m.get(l.presetId) ?? 0) + l.quantity);
    }
    return m;
  }, [cart]);

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
          // 店名とインボイス登録番号 (QR タブの共通設定)。顧客の控えに出す表示専用の値で、
          // 金額・受取先・手数料には関与しない (形式外の番号は buildCheckoutUrl が出さない)。
          storeName: settings.storeName.trim() || undefined,
          invoiceNo: settings.invoiceNo || undefined,
          // レジ システム利用料 (flag ON のときだけ)。CheckoutForm が standard 経路の JPYC 決済に
          // recover の OpenPay利用料 % を店舗負担で課金する合図。USDC/relay/7月前は実質無料・flag
          // OFF では付かず従来動作 (inert)。
          ...(env.enableRegisterFee ? { feeKind: 'register' as const } : {}),
        })
      : '';

  // この会計でお店の端末で送るを使えるか (JPYC・対象チェーン・受取先・最低 1 JPYC)。使えないときは理由を出し、
  // 通常の QR を出す (黙って切り替えない)。
  const sdSaleBlocked:
    | 'token'
    | 'receiver'
    | 'min_amount'
    | 'no_wallet'
    | 'no_locks'
    | 'config'
    | null = !storeRequested
    ? null
    : !storeCfgActive
      ? 'token'
      : sdBlocked !== null
        ? sdBlocked
        : gasAddress === null
          ? 'no_wallet'
          : effectiveReceiver &&
              [sdConfig?.forwarder, sdConfig?.feeReceiver].some(
                (a) => a && a.toLowerCase() === effectiveReceiver.toLowerCase(),
              )
            ? 'receiver'
            : validItems.length > 0 && totalWei < STORE_DEVICE_MIN_AMOUNT_WEI
              ? 'min_amount'
              : null;
  const storeDeviceForSale = sdEnabled && sdSaleBlocked === null;
  // お店負担を選んでいて使えるはずだが、まだ準備中 (ガス用ウォレットの確認待ち等) → QR は出さない
  // (黙って通常の QR を出さない)。
  const storeDeviceNotReady = storeRequested && sdSaleBlocked === null && !storeDeviceForSale;
  // お店の端末で送るの QR に載せる会計 (receiptNo 等は通常と同じ・feeKind は付けない = parse が fail-closed で弾くため)。
  // 受け渡しの id は作った後に足す。
  const storeCheckout =
    storeDeviceForSale && checkoutUrl && effectiveReceiver
      ? {
          to: effectiveReceiver,
          token: settings.token,
          chain: settings.chain,
          gas: effectiveGasMode,
          mode: settings.payMode,
          items: validItems,
          receiptNo: receiptNo || undefined,
          storeName: settings.storeName.trim() || undefined,
          invoiceNo: settings.invoiceNo || undefined,
          submit: 'store' as const,
        }
      : null;
  // QR を出す判断の時点と、受け渡しを作り終えた時点で会計・設定が同じか (作っている間にカートや設定を変えたら、
  // その QR は出さずに受け渡しを締め切る = 請求額の違う QR・黙って通常の QR にしない)。
  const storeOpenKey = JSON.stringify([
    storeRequested,
    storeDeviceForSale,
    totalWei.toString(),
    storeCheckout,
    checkoutUrl,
  ]);
  const storeOpenKeyRef = useRef(storeOpenKey);
  useEffect(() => {
    storeOpenKeyRef.current = storeOpenKey;
  }, [storeOpenKey]);
  // QR を閉じたら進める (出し直しの途中で閉じたとき、遅れて返った受け渡しで QR を開き直さない)。
  const storeOpenAttemptRef = useRef(0);
  // 表示中のお店負担の QR は、受け渡しを作った時点の会計で組み立てた写しから出す (後から変わっても混ぜない)。
  const storeQrActive = storeQr !== null && !forceNormalQr;
  const qrValue = storeQrActive ? storeQr.url : checkoutUrl;
  const sdState = device.state;
  // QR を薄くする: この QR の受け渡しが署名を待っている (受付時間が十分残る) とき以外 (署名を受け取った後・受付時間の
  // 終わり・出し直しの途中 = 次のお客様に読ませない)。
  const storeQrDimmed =
    storeQrActive &&
    !(sdState.phase === 'waiting' && !sdState.stale && sdState.session.id === storeQr.id);

  /** 受け渡しを作り、作った時点の会計で QR を組み立てて出す。作る間に会計・設定が変わった・閉じたら出さずに締め切る。 */
  async function openStoreQr(): Promise<boolean> {
    if (!effectiveReceiver || !storeCheckout) return false;
    const key = storeOpenKeyRef.current;
    const attempt = storeOpenAttemptRef.current;
    const checkout = storeCheckout;
    // チェーンは QR の写し (storeCheckout) と同じもの (この会計のチェーン)。
    const s = await device.start(getAddress(effectiveReceiver), totalWei, deployment.chainId);
    // 作れなかった (理由は状態に出る)・前の会計の署名の送信を優先した → QR は開かない。
    if (!s) return false;
    if (storeOpenKeyRef.current !== key || storeOpenAttemptRef.current !== attempt) {
      device.stop();
      return false;
    }
    setStoreQr({ id: s.id, url: buildCheckoutUrl(origin, { ...checkout, handoffId: s.id }) });
    setQrModalOpen(true);
    return true;
  }

  async function openQr() {
    // 受け取った署名を送っている・結果を待っている間は次の QR を出さない (二重払いにしない)。
    if (device.busy || storeDeviceNotReady) return;
    setForceNormalQr(false);
    if (storeDeviceForSale && effectiveReceiver) {
      await openStoreQr();
      return;
    }
    if (env.enableStoreGasWallet) {
      // 通常の QR: 前の受け渡し (切替を OFF にする前のものも) を締め切ってから出す。署名が入っていたら
      // 端末が送るので、通常の QR は出さない。受け渡しが無ければ通信せずにすぐ出す。締め切りを待つ間に
      // 会計・設定が変わったら出さない (押し直してもらう)。
      const key = storeOpenKeyRef.current;
      if (!(await device.releaseForNormal()) || storeOpenKeyRef.current !== key) return;
      setStoreQr(null);
    }
    setQrModalOpen(true);
  }

  function closeQr() {
    storeOpenAttemptRef.current += 1;
    setQrModalOpen(false);
    setForceNormalQr(false);
    if (storeQr) {
      // 署名を待っていたセッションは締め切る (署名が入っていれば送る・結果は会計ボタンの下に出る)。
      device.stop();
      setStoreQr(null);
    }
  }

  async function showNormalQr() {
    // 署名を待っていた受け渡しを締め切ってから。署名が入っていたら端末が送る (通常の QR は出さない)。
    const attempt = storeOpenAttemptRef.current;
    const key = storeOpenKeyRef.current;
    // 締め切りを待つ間に閉じた・会計や設定を変えた → 開かない (押し直してもらう)。
    if (
      !(await device.releaseForNormal()) ||
      storeOpenAttemptRef.current !== attempt ||
      storeOpenKeyRef.current !== key
    ) {
      return;
    }
    setStoreQr(null);
    setForceNormalQr(true);
    setQrModalOpen(true);
  }

  async function reissueStoreQr() {
    // 出し直す間は前の (薄くした) QR のまま。出せなければ閉じる (通常の QR に変えない)。閉じた後 (会計ボタンの下)
    // から出し直したときも、新しい QR を見せる (QR の無い「署名待ち」を残さない)。
    if (!(await openStoreQr())) {
      setStoreQr(null);
      setQrModalOpen(false);
    }
  }

  const storeDeviceStatus = (
    <StoreDeviceRegisterStatus
      state={sdState}
      formatAmount={formatStoreDeviceAmount}
      onCheckNow={() => void device.checkNow()}
      onRetry={device.retry}
      onReissue={() => void reissueStoreQr()}
      onShowNormal={() => void showNormalQr()}
      onDismiss={device.dismiss}
    />
  );

  return (
    <div className="space-y-5">
      {/* 見出し・説明は出さない (タブ名「レジ」で足りる・2026-10 磨き上げ P1)。 */}
      {/* 受取先/通貨/チェーン/決済設定は決済QRタブから継承。レジでは大きく露出させず、
          確認用に 1 行のステータスバー (受取先・通貨/チェーン・決済設定 + 変更導線) へ圧縮し、
          上部の縦幅を削って商品プリセットを上に押し上げる。 */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500">
        <span className="font-medium text-slate-500">{t('statusReceiverLabel')}:</span>
        <span className="font-mono text-slate-600">
          {effectiveReceiver
            ? shortAddress(effectiveReceiver)
            : settings.receiver.trim() || '—'}
        </span>
        <span className="inline-flex items-center gap-1 text-slate-500">
          <TokenLogo symbol={settings.token} size={14} className="h-3.5 w-3.5" />
          <ChainLogo slug={settings.chain} size={14} className="h-3.5 w-3.5" />
          ({chainForSlug(settings.chain).name} / {symbol})
        </span>
        <span className="text-slate-300" aria-hidden>
          ｜
        </span>
        <span className="text-slate-500">
          {storeRequested
            ? t('storeDevice.badge')
            : isFreeGasless
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
                {presetCategories.map((c) => {
                  const colors = categoryColorClasses(c);
                  return (
                    <button
                      key={c}
                      type="button"
                      onClick={() => setCatFilter(c)}
                      aria-pressed={effectiveCatFilter === c}
                      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium transition ${
                        effectiveCatFilter === c
                          ? 'border-brand bg-brand text-white'
                          : 'border-slate-300 text-slate-600 hover:border-brand'
                      }`}
                    >
                      <span
                        className={`h-2 w-2 rounded-full ${colors.dot}`}
                        aria-hidden
                      />
                      {c}
                    </button>
                  );
                })}
              </div>
            )}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {visiblePresets.map((p) => {
                // 商品画像 (https のみ・任意)。管理で入れた image をプリセットのカードにもサムネ表示する
                // (モバイルオーダーのメニュー画像と同じ image を共有)。https 以外は描画しない (二重防御)。
                // 読込失敗は onError で隠し、名前+価格のテキスト表示へフォールバック (グリッドを壊さない)。
                const presetImg = safeHttpUrl(p.image);
                const category = p.category?.trim() ?? '';
                const categoryColors = category ? categoryColorClasses(category) : null;
                const isSoldOut = soldOut.has(p.id);
                // このプリセットが今カートにいくつ入っているか (0 = 未投入)。
                const qty = presetQty.get(p.id) ?? 0;
                const inCart = qty > 0;
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => (hasPresetOptions(p) ? setOptionModalPreset(p) : addFromPreset(p))}
                    className={`relative flex min-h-[76px] flex-col justify-center rounded-xl border bg-white px-3 py-3 text-left shadow-card transition hover:-translate-y-0.5 hover:border-brand hover:shadow-card-hover active:translate-y-0 active:scale-[0.98] active:bg-brand/5 ${categoryColors ? `border-l-4 ${categoryColors.border}` : ''} ${
                      inCart
                        ? 'border-brand ring-2 ring-brand/15'
                        : 'border-slate-200'
                    }`}
                  >
                    {/* カート投入数バッジ (POS の要・右上)。タップごとに +1 され、何個入れたかを一目で。 */}
                    {inCart && (
                      <span
                        className="absolute -right-1.5 -top-1.5 z-10 inline-flex h-6 min-w-[1.5rem] items-center justify-center rounded-full bg-brand px-1.5 text-xs font-bold tabular-nums text-white shadow-[0_2px_8px_-2px_rgba(37,99,235,0.6)]"
                        aria-hidden
                      >
                        {qty}
                      </span>
                    )}
                    {env.enableShopLive && p.recommended && (
                      <span
                        className="absolute left-1.5 top-1.5 z-10 inline-flex items-center rounded-full bg-amber-100 px-1 py-0.5"
                        title={t('recommendedBadge')}
                        aria-label={t('recommendedBadge')}
                      >
                        <Star className="h-3 w-3 fill-amber-400 text-amber-400" aria-hidden />
                      </span>
                    )}
                    {isSoldOut && (
                      <span className="mb-1 inline-flex w-fit rounded bg-slate-200 px-1.5 py-0.5 text-[10px] font-semibold text-slate-600">
                        {t('soldOutBadge')}
                      </span>
                    )}
                    {showImages && presetImg && (
                      <ExternalImage
                        src={presetImg}
                        alt=""
                        referrerPolicy="no-referrer"
                        loading="lazy"
                        decoding="async"
                        // 第三者画像の読込失敗を壊れ画像 icon として商品ボタンに出さない。URL を直すと
                        // ExternalImage が node を作り直すので、この display:none は新 URL に残らない。
                        onError={(e) => {
                          e.currentTarget.style.display = 'none';
                        }}
                        className={`mb-2 h-16 w-full rounded-lg object-cover ${isSoldOut ? 'grayscale' : ''}`}
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
                    {inCart && <span className="sr-only">{t('presetInCart', { count: qty })}</span>}
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
            <p className="rounded-xl border border-dashed border-slate-300 px-4 py-6 text-center text-sm text-slate-500">
              {t('cartEmpty')}
            </p>
          ) : (
            <ul className="space-y-3">
              {lines.map(({ l, amountHuman, valid }) => (
                <li
                  key={l.id}
                  className="space-y-3 rounded-2xl bg-white p-3 ring-1 ring-slate-200/70"
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
                      className="rounded-lg border border-slate-200 p-2 text-slate-500 hover:border-red-300 hover:text-red-600"
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
                      <div className="text-[11px] text-slate-500">{t('lineAmount')}</div>
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
            className="group rounded-2xl bg-white p-4 shadow-card ring-1 ring-slate-200/70"
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
                className="h-4 w-4 text-slate-500 transition-transform group-open:rotate-90"
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
                shopLive={shopLive}
              />
            </div>
          </details>
        </div>

        {/* ── RIGHT: 会計サマリ (lg で sticky 追従・モバイルは in-flow) ── */}
        <aside className="mt-6 min-w-0 self-start lg:mt-0 lg:sticky lg:top-20 lg:max-h-[calc(100vh-6rem)]">
          <div className="flex flex-col overflow-hidden rounded-2xl bg-white shadow-card ring-1 ring-slate-200/70 lg:max-h-[calc(100vh-6rem)]">
            <div className="border-b border-slate-100 px-4 py-3">
              <p className="text-sm font-semibold text-slate-700">
                {t('orderSummaryTitle')}
              </p>
            </div>

            {/* 注文明細 (読み取り・確定行のみ。長いカートは内部スクロール) */}
            <div className="min-h-[3rem] flex-1 overflow-y-auto px-4 py-3">
              {summaryLines.length === 0 ? (
                <p className="py-3 text-center text-xs text-slate-500">
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
                        <span className="ml-1 text-slate-500">×{l.quantity}</span>
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
              <p className="mt-2 text-[11px] text-slate-500">{t('taxInclusiveNote')}</p>
            </div>

            {/* デスクトップ CTA (サイドバー最下部に固定表示)。モバイルは下部バー側を使う。 */}
            <div className="hidden border-t border-slate-100 p-3 lg:block">
              <button
                type="button"
                onClick={() => void openQr()}
                disabled={!checkoutUrl || device.busy || storeDeviceNotReady}
                className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-brand px-5 py-4 text-base font-bold text-white shadow-card transition hover:-translate-y-0.5 hover:bg-brand-dark hover:shadow-card-hover active:translate-y-0 disabled:cursor-not-allowed disabled:bg-slate-300 disabled:shadow-none disabled:hover:translate-y-0"
              >
                <QrCodeIcon className="h-5 w-5" aria-hidden />
                {/* お店負担を選んでいるがこの会計では使えない → 店員が通常の QR を選ぶ (黙って切り替えない)。 */}
                {sdSaleBlocked ? t('storeDevice.showNormalQr') : t('showQr')}
              </button>
            </div>
          </div>
        </aside>
      </div>

      {/* お店の端末のガス用ウォレット (flag OFF では出さない・plans/store-gas-wallet.md)。 */}
      {env.enableStoreGasWallet && (storeDeviceForSale || sdSaleBlocked || (sdState.phase !== 'idle' && !qrModalOpen)) && (
        <div className="space-y-2">
          {storeDeviceForSale && (
            <p className="text-xs font-semibold text-emerald-800">{t('storeDevice.badge')}</p>
          )}
          {sdSaleBlocked && (
            <p role="status" className="text-xs text-amber-800">
              {t(`storeDevice.saleBlocked.${sdSaleBlocked}`, { chain: storeDeviceChainNames(sdChainIds) })}{' '}
              {t('storeDevice.saleBlockedHint')}
            </p>
          )}
          {/* 切替を OFF にしても、送っている・結果を待っている支払いの表示は残す (次の QR を出せない理由)。 */}
          {sdState.phase !== 'idle' && !qrModalOpen && storeDeviceStatus}
        </div>
      )}
      {env.enableStoreGasWallet && (
        <StoreGasWalletPanel onAddressChange={setGasAddress} />
      )}

      {/* モバイル下部固定 会計バー (合計 + QR ボタン)。lg では右サイドバー CTA を使う。
          グローバルの BottomNav (fixed bottom-0 z-20・md:hidden) の上に重ねるため、
          < md は bottom-14 で nav 分浮かせ、md 以上 (nav 非表示) は bottom-0。 */}
      <div
        ref={totalBarRef}
        className="sticky bottom-14 z-20 -mx-4 flex items-center gap-3 border-t border-slate-200/80 bg-white/95 px-4 py-3 shadow-[0_-6px_20px_-6px_rgba(15,23,42,0.14)] backdrop-blur md:bottom-0 lg:hidden"
      >
        <div className="min-w-0 flex-1">
          <div className="text-[11px] text-slate-500">{t('total')}</div>
          <div className="truncate font-mono text-lg font-bold text-slate-900">
            {totalHuman} {symbol}
          </div>
        </div>
        <button
          type="button"
          onClick={() => void openQr()}
          disabled={!checkoutUrl || device.busy || storeDeviceNotReady}
          className="inline-flex shrink-0 items-center justify-center gap-2 rounded-xl bg-brand px-5 py-3 text-base font-bold text-white shadow-card transition hover:-translate-y-0.5 hover:bg-brand-dark hover:shadow-card-hover active:translate-y-0 disabled:cursor-not-allowed disabled:bg-slate-300 disabled:shadow-none disabled:hover:translate-y-0"
        >
          <QrCodeIcon className="h-5 w-5" aria-hidden />
          {sdSaleBlocked ? t('storeDevice.showNormalQr') : t('showQr')}
        </button>
      </div>

      {/* 全画面プレビュー (ポスター調 + 印刷/URLコピー + × 閉じる)。決済QRと共通コンポーネント。 */}
      {checkoutUrl && (
        <QrPreviewModal
          open={qrModalOpen}
          onClose={closeQr}
          labels={{
            title: t('qrModalTitle'),
            close: t('qrModalClose'),
            eyebrow: t('qrPosterEyebrow'),
            copy: t('copyUrl'),
            copied: t('copied'),
            // お店負担の QR は端末が通信して送るので「圏外でも提示できます」は出さない。
            localGenNote: storeQrActive ? undefined : t('qrLocalGenNote'),
          }}
          convertExpired={storeQrDimmed}
          payModeBadge={storeQrActive ? { text: t('storeDevice.badge'), tone: 'gasless' } : undefined}
          deviceStatus={env.enableStoreGasWallet && sdState.phase !== 'idle' ? storeDeviceStatus : undefined}
          qrValue={qrValue}
          qrRef={qrRef}
          storeName={settings.storeName.trim() || t('qrPosterDefaultStoreName')}
          amountText={`${totalHuman} ${symbol}`}
          note={settings.posterNote.trim() || undefined}
          chainText={`${symbol} · ${chainForSlug(settings.chain).name}`}
          // 決済QR の全画面表示と同じトークン/チェーンロゴ行を出す (視認性)。
          asset={{
            tokenSymbol: settings.token,
            chainSlug: settings.chain,
            chainLabel: chainForSlug(settings.chain).name,
          }}
          receiverShort={effectiveReceiver ? shortAddress(effectiveReceiver) : ''}
          // お店負担の QR は画面に表示している間だけ使える (URL の表示・コピーは出さない・決済QRタブと同じ)。
          {...(storeQrActive
            ? { hideUrl: true, actionsNote: tQr('storeDevice.actionsNote') }
            : { copied, onCopy: () => copy(qrValue) })}
        />
      )}

      {/* オプション選択モーダル (flag ON + options 付き preset をタップ)。確定で実効単価の行を追加。 */}
      {optionModalPreset && (
        <OptionSelectModal
          open
          itemName={optionModalPreset.name}
          basePrice={optionModalPreset.unitPrice}
          options={optionModalPreset.options ?? []}
          symbol={
            deploymentForSlug(
              optionModalPreset.token,
              DEFAULT_CHAIN_FOR_SYMBOL[optionModalPreset.token],
            ).displaySymbol
          }
          onConfirm={(choices) => addOptionLine(optionModalPreset, choices)}
          onClose={() => setOptionModalPreset(null)}
        />
      )}
    </div>
  );
}
