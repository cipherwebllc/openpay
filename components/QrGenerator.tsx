'use client';

import { crossChainAllowed } from '@/lib/url/shared';

import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { useTranslations } from 'next-intl';
import dynamic from 'next/dynamic';
import type { Address } from 'viem';
import { formatUnits, getAddress, parseUnits } from 'viem';
import { AccountingSection } from './AccountingSection';
import { QrPreviewModal } from './QrPreviewModal';
import { PwaInstallHint } from './PwaInstallHint';
import { OfflineLastQr } from './OfflineLastQr';
import { QrAmountSection, type Mode } from './qr/QrAmountSection';
import {
  QrReceiptPosterFields,
  QrReceiverFields,
  QrStoreNameField,
} from './qr/QrReceiverSection';
import { QrSettingsSection } from './qr/QrSettingsSection';
import { QrMobileBar, QrPreviewSection, qrNotReadyKey } from './qr/QrPreviewSection';
import { ShopSettingsSection, ShopSettingsSheet } from './ShopSettingsSheet';
import { ShopSummaryRow } from './ShopSummaryRow';
import { TokenChooser } from './TokenChooser';
import { ChainChooser } from './ChainChooser';
import { downloadPng, downloadSvg, fileSafe } from './qr/qrDownload';
import { rememberTokenPrefs, useQrSettings } from '@/hooks/useQrSettings';
import { useResolveAddress } from '@/hooks/useResolveAddress';
import { isLikelyName } from '@/lib/nameDetection';
import { useDiscountInput } from '@/hooks/useDiscountInput';
import { taxDisplayDecimals } from '@/lib/tax';
import {
  useReceiverAutofill,
  type ReceiverSource,
} from '@/hooks/useReceiverAutofill';
import { useOrigin } from '@/hooks/useOrigin';
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard';
import { useLocalStorageRecord } from '@/hooks/useLocalStorageRecord';
import { useOfflineQrServiceWorker } from '@/hooks/useOfflineQrServiceWorker';
import { isLastQrRecord, LAST_QR_KEY } from '@/lib/offlineQr';
import {
  buildCheckoutUrl,
  buildPayUrl,
  DECIMAL_PATTERN,
  parseSplitDrafts,
  type PayParams,
} from '@/lib/url';
import { buildEip681TransferUri } from '@/lib/eip681';
import {
  counterpartSymbol,
  DEFAULT_CHAIN_FOR_SYMBOL,
  defaultDeploymentForSymbol,
  deploymentForSlug,
  displaySymbolFor,
  isGaslessSupported,
  type TokenSymbol,
} from '@/lib/tokens';
import { rateIsSane } from '@/lib/fx';
import { useFxConvert } from '@/hooks/useFxConvert';
import { useMarketRates } from '@/hooks/useMarketRates';
import {
  buyerUsdcChainNames,
  chainForSlug,
  JPYC_CHAINS,
  USDC_CHAINS,
  type ChainSlug,
} from '@/lib/chains';
import type { GasMode, PayMode } from '@/lib/fee';
import { jpycForwarderFor } from '@/lib/relay/forwarderConfig';
import { recoverFeeValue } from '@/lib/relay/recoverFee';
import { resolveJpycGaslessProvider } from '@/lib/jpycGaslessProvider';
import { pickEffectiveAddress, shortAddress, formatTokenAmount } from '@/lib/format';
import { useIncomingPaymentWatch } from '@/hooks/useIncomingPaymentWatch';
import { useStoreDeviceMode } from '@/components/StoreDeviceProvider';
import { env } from '@/lib/env';
import {
  STORE_DEVICE_MIN_AMOUNT_WEI,
  formatStoreDeviceAmount,
  storeDeviceChainConfig,
  storeDeviceChainNames,
} from '@/lib/storeDevicePayment';
import { storePaysActive, storePaysRequested } from '@/lib/storePaysMode';
import { groupAmountDigits, truncateAmount } from '@/lib/amount';

// 「お店がガス代を肩代わりして送る」(flag 裏) の部品は選んだときだけ読み込む (ガス用ウォレットの鍵の扱い = viem の
// アカウント部品を、使わない店の初回の読み込みに載せない)。
const StoreGasWalletPanel = dynamic(
  () => import('./StoreGasWalletPanel').then((m) => m.StoreGasWalletPanel),
  { ssr: false },
);
const StoreDeviceRegisterStatus = dynamic(
  () => import('./StoreDeviceRegisterStatus').then((m) => m.StoreDeviceRegisterStatus),
  { ssr: false },
);

export function QrGenerator() {
  const { settings: savedSettings, setSettings: saveSettings, hydrated } = useQrSettings();
  const [mode, setMode] = useState<Mode>('amount');
  const [amount, setAmount] = useState('');
  const origin = useOrigin();
  const { copied, copy } = useCopyToClipboard();
  const { copied: eip681Copied, copy: eip681Copy } = useCopyToClipboard();
  // オフライン受け取り QR: flag ON なら SW を登録し enable marker を書く (flag OFF は既存
  // 登録があれば disable・無ければ no-op)。lastQr は modal を開いた時点で保存する。
  useOfflineQrServiceWorker();
  const { save: saveLastQr } = useLocalStorageRecord(LAST_QR_KEY, isLastQrRecord);
  const qrRef = useRef<HTMLDivElement>(null);
  // 「お店の設定」シート (受取先・通貨とチェーン・支払い方法・控えとポスター) の開閉。
  const [settingsOpen, setSettingsOpen] = useState(false);
  // 受取先が未設定のときは、QR を出す唯一の前提なので会計画面に受取先の欄を直接出す。読み込み後に未設定だったら
  // 出し、入力し終えても消さない (打っている途中で欄が消えない・次に開いたときは保存済みなので出ない)。
  const [receiverInline, setReceiverInline] = useState(false);
  // QR は即時表示せず「QRコードを表示する」ボタン → 全画面モーダルで提示。
  const [qrModalOpen, setQrModalOpen] = useState(false);
  // 「お店がガス代を肩代わりして送る」(内部名「お店の端末で送る」・flag 裏) の状態は作成ページで 1 つ。お店の端末が
  // 支払いを送っている・結果を待っている間は、このタブでも通常の QR を出さない (同じ会計を二重に払わせない・
  // 状態はタブの上に出る)。締め切っていない受け渡しは締め切ってから (署名が入っていたら端末が送るので出さない)。
  // flag OFF では今までどおりそのまま開く。
  const storeDevice = useStoreDeviceMode();
  // 「お店がガス代を肩代わりして送る」の QR (受け渡しを作った時点の会計で組み立てたもの・null = 出していない)。
  // 受け渡しの請求額と QR の会計を必ず揃えるため、表示はこの写しから作る (後から入力が変わっても混ぜない)。
  const [storeQr, setStoreQr] = useState<{ id: string; url: string; amountText: string } | null>(null);
  // 店員が「通常の QR を出す」を選んだ (お店負担の QR を作れない・読み取れないとき)。
  const [forceNormalQr, setForceNormalQr] = useState(false);
  // 初回に QR モーダルを開いた「ピークモーメント」を latch。以降 A2HS hint を出す
  // (毎日この QR を使う店主に、ホーム画面への追加を提案する)。閉じても latch は保持。
  const [hasOpenedQr, setHasOpenedQr] = useState(false);
  useEffect(() => {
    if (qrModalOpen) setHasOpenedQr(true);
  }, [qrModalOpen]);

  const t = useTranslations('QrGenerator');
  const tFee = useTranslations('UsageFee');
  // 管理番号 (レシート番号) はトランザクション固有なので settings に永続せず local state。
  const [receiptNo, setReceiptNo] = useState('');

  // 「他トークン建てで受け取る」用の為替レート (USDC→JPY)。convert 押下時に参照。
  const { data: marketRates } = useMarketRates();
  // FX 換算 (他トークン建て受取・画面上の期限目安付き) の状態とハンドラ。convert / カウントダウン /
  // applyConvert・recalcConvert・revertConvert と一時的な通貨選択を hook 内に保持し、保存設定と分離する。
  const {
    settings,
    setSettings,
    clearSelection,
    convert,
    convertRemaining,
    convertExpired,
    applyConvert,
    recalcConvert,
    revertConvert,
    resetConvert,
    fxWarning,
    acknowledgeFxWarning,
  } = useFxConvert({
    settings: savedSettings,
    amount,
    marketRates: marketRates ?? null,
    setSettings: saveSettings,
    setAmount,
  });

  // 受取先が名前 (shop.eth 等) のときは、設定シート (その中の AddressInput) を開いていなくても名前を解決しておき、この
  // 解決結果だけを使う (シートの AddressInput も同じ query を見る)。シートから受け取った解決値を別に持つと、閉じた後の
  // 再解決の失敗が届かず、古いアドレスで QR・お店負担の受け渡しを作る (着金先のずれ・第 7 回レビュー G1)。
  const receiverName = settings.receiver.trim();
  const ens = useResolveAddress(isLikelyName(receiverName) ? receiverName : '');
  // 再解決に失敗しても react-query は前回の解決結果 (data) を残すので、失敗中は使わない (RegisterMode・AddressInput と同じ)。
  const effectiveReceiver = useMemo(
    () => pickEffectiveAddress(settings.receiver, ens.error ? null : ens.data?.address ?? null),
    [settings.receiver, ens.data, ens.error],
  );

  const setReceiver = useCallback(
    (value: string, source: ReceiverSource) =>
      setSettings((s) => ({ ...s, receiver: value, receiverSource: source })),
    [setSettings],
  );
  const autofill = useReceiverAutofill({
    receiver: settings.receiver,
    receiverSource: settings.receiverSource,
    effectiveReceiver,
    hydrated,
    setReceiver,
  });

  const receiverValid = effectiveReceiver !== null;
  useEffect(() => {
    if (hydrated && !receiverValid) setReceiverInline(true);
  }, [hydrated, receiverValid]);
  // QR の画面が開いたら設定シートは閉じる (QR を作っている間に設定を開いても、2 つの dialog を重ねない =
  // Escape 1 回で両方が閉じる・focus の行き先が混ざるのを防ぐ)。
  useEffect(() => {
    if (qrModalOpen) setSettingsOpen(false);
  }, [qrModalOpen]);
  // 入力した金額が使えるか (値引きを除く)。QR を出せない理由の「金額を入れてください」はこれで決める。
  const amountInputValid =
    mode === 'static' ||
    (mode === 'amount' && DECIMAL_PATTERN.test(amount) && Number(amount) > 0);
  // 値引き (任意・plans/discount-common.md)。金額ありの QR・為替換算なしのときだけ。入力欄の amount は値引き前で、
  // QR・請求・着金の見張り・表示はすべて支払額 (chargeAmount = amount − 値引き) を使う。
  const amountDecimals = deploymentForSlug(settings.token, settings.chain).decimals;
  const listAmountWei = useMemo(() => {
    if (mode !== 'amount' || !amountInputValid) return 0n;
    try {
      return parseUnits(amount, amountDecimals);
    } catch {
      return 0n;
    }
  }, [mode, amountInputValid, amount, amountDecimals]);
  const discount = useDiscountInput(listAmountWei, amountDecimals, taxDisplayDecimals(settings.token));
  const discountAvailable = mode === 'amount' && !convert;
  const { reset: resetDiscount } = discount;
  // 値引きを使えない QR に切り替えた・金額を消した (次の会計) ら外す。
  useEffect(() => {
    if (!discountAvailable || amount === '') resetDiscount();
  }, [discountAvailable, amount, resetDiscount]);
  // 通貨を変えたら外す (同じ入力が別の単位の値引きにならない: 20 JPYC → 20 USDC)。
  useEffect(() => {
    resetDiscount();
  }, [settings.token, resetDiscount]);
  // QR を出せる金額か (値引きを直している間は出さない = 値引き前の額を請求させない)。
  const amountValid = amountInputValid && !discount.invalid;
  const chargeAmount =
    discount.wei !== null ? formatUnits(listAmountWei - discount.wei, amountDecimals) : amount;
  const payMode: PayMode = settings.payMode;
  const isStandard = payMode === 'standard';

  // standard mode では split は無視する (PaymentForm 側でも無視するので URL に
  // 含めると混乱)。それ以外では parseSplitDrafts で検証して、有効な entries
  // のみ URL に含める。
  const splitParsed = useMemo(
    () => parseSplitDrafts(settings.splits, effectiveReceiver),
    [settings.splits, effectiveReceiver],
  );
  const splitsForUrl =
    !isStandard && splitParsed.entries && splitParsed.entries.length > 0
      ? splitParsed.entries
      : undefined;

  // ガス負担者 (顧客/店主) の選択が無意味になるのは「JPYC の EIP-3009 relay free 経路」
  // (OpenPay がガスを全額負担し誰からも徴収しない) のときだけ。USDC (Paymaster で顧客が
  // gas を負担、店主吸収も可) や JPYC recover (forwarder 設定で相当額回収)、JPYC
  // sponsorship (flag off) では gas コストが発生し負担者が意味を持つ。決済側の
  // useRelay (= !isStandard && !hasSplit && provider==='eip3009-relay') かつ !useRecover
  // と同条件で free 経路を判定し、その時だけトグルを隠して gas=customer 固定にする。
  // split 指定時は PaymentForm が relay を外し sponsorship に倒す (= 非 free) ため除外する。
  // 将来 JPYC が native Paymaster 対応 (forwarder 設定) されれば自動的に再表示される。
  const isFreeGasless = useMemo(() => {
    if (isStandard || splitsForUrl) return false;
    const dep = deploymentForSlug(settings.token, settings.chain);
    return (
      resolveJpycGaslessProvider(dep, dep.chainId) === 'eip3009-relay' &&
      jpycForwarderFor(dep.chainId) === null
    );
  }, [isStandard, splitsForUrl, settings.token, settings.chain]);

  // JPYC recover (forwarder 設定済) は確定モデルで「店舗が常に手数料を吸収」(gasMode=merchant
  // 固定・per-QR 負担者トグルは撤去) になる。よってトグルを隠し gasMode を merchant に強制する
  // (URL params・読み戻しサマリ・RecoverFeeNotice すべて)。USDC や他トークンの recover では
  // トグルを従来どおり出す (この flag は JPYC かつ forwarder 設定済のときだけ true)。
  const isJpycRecover = useMemo(() => {
    if (isStandard || splitsForUrl || settings.token !== 'jpyc') return false;
    const dep = deploymentForSlug(settings.token, settings.chain);
    return (
      resolveJpycGaslessProvider(dep, dep.chainId) === 'eip3009-relay' &&
      jpycForwarderFor(dep.chainId) !== null
    );
  }, [isStandard, splitsForUrl, settings.token, settings.chain]);

  // 負担者トグルを隠すべき経路 (free = 概念なし・customer 固定 / JPYC recover = merchant 固定)。
  // USDC や JPYC recover 以外では従来どおりトグルを出す。
  const hideGasMode = isFreeGasless || isJpycRecover;
  // URL・サマリ・開示に焼き込む実効 gasMode。free=customer 固定 / JPYC recover=merchant 固定 /
  // それ以外 (USDC 等) は店主の選択 (settings.gasMode)。
  const effectiveGasMode: GasMode = isFreeGasless
    ? 'customer'
    : isJpycRecover
      ? 'merchant'
      : settings.gasMode;

  // Recover モードの手数料開示に渡す請求額 (wei) と負担者。FREE モード (forwarder null)
  // では共有 RecoverFeeNotice が null を返してパネルを描画しない。JPYC recover は merchant 固定。
  const recoverBillAmount = useMemo(() => {
    // お店がガス代を肩代わりして送るときは OpenPay の利用料がかからない (回収の開示を出さない)。
    if (storePaysRequested(settings)) return null;
    if (!amountValid || mode !== 'amount' || settings.token !== 'jpyc') return null;
    const dep = deploymentForSlug(settings.token, settings.chain);
    try {
      const wei = parseUnits(chargeAmount, dep.decimals);
      return wei > 0n ? wei : null;
    } catch {
      return null;
    }
  }, [amountValid, mode, settings, chargeAmount]);
  const recoverGasMode: GasMode = effectiveGasMode;

  const payUrl = useMemo(() => {
    if (!hydrated || !effectiveReceiver || !origin || !amountValid) return '';
    const params: PayParams = {
      to: effectiveReceiver,
      token: settings.token,
      chain: settings.chain,
      // free 経路 (JPYC relay・無徴収) は customer 固定 / JPYC recover は merchant 固定
      // (確定モデル: 決済は店舗が手数料を吸収) / それ以外 (USDC 等) は店主の選択。
      gas: effectiveGasMode,
      amount: mode === 'amount' ? chargeAmount : undefined,
      // 値引き (在るときだけ)。amount に含まれる額で、控え・履歴の小計と値引きに使う (請求額は amount のまま)。
      discount: mode === 'amount' ? discount.param : undefined,
      mode: payMode,
      split: splitsForUrl,
      // crossChain は USDC のみ意味あり (JPYC は Gateway / CCTP V2 非対応)。
      // settings に false を持っていても token=jpyc なら URL に出ても無害だが、
      // 旧 QR との互換性を最大化するため token=usdc 時のみ出力する。
      crossChain: settings.token === 'usdc' ? crossChainAllowed(settings.chain, settings.crossChain) : undefined,
      // convert 適用時のみ、期限と顧客への文脈表示 (元価格 + レート) を URL に乗せる。
      // 期限は画面上の目安。期限切れでも QR / exp は保持し、明示的な再計算で更新する。
      expiresAt: convert?.expiresAt,
      priceRefAmount: convert?.anchorAmount,
      fxRate: convert?.fxRate,
      // 記帳補助メタ (任意・空は undefined で URL に出さない)。決済側の履歴に記録される。
      storeName: settings.storeName || undefined,
      // インボイス登録番号 (任意・形式外は buildPayUrl が出さない)。顧客の控えに出す表示専用。
      invoiceNo: settings.invoiceNo || undefined,
      productName: settings.productName || undefined,
      memo: settings.memo || undefined,
      taxRate: settings.taxRate ?? undefined,
      taxCategory: settings.taxCategory ?? undefined,
      receiptNo: receiptNo || undefined,
    };
    return buildPayUrl(origin, params);
  }, [
    hydrated,
    effectiveReceiver,
    origin,
    amountValid,
    settings.token,
    settings.chain,
    effectiveGasMode,
    settings.crossChain,
    settings.storeName,
    settings.invoiceNo,
    settings.productName,
    settings.memo,
    settings.taxRate,
    settings.taxCategory,
    receiptNo,
    mode,
    chargeAmount,
    discount.param,
    payMode,
    splitsForUrl,
    convert,
  ]);

  // --- 決済モードの 3 つ目「お店がガス代を肩代わりして送る」(flag 裏・plans/store-gas-wallet.md §19) ---
  // 選んでいる (requested) と、いまの通貨・チェーンで使える (active) を分ける。使えるのは画面に表示する
  // 金額ありの QR だけ (金額なし・分割受取・為替換算では押せなくして理由を出す・黙って通常の QR にしない)。
  const storeRequested = storePaysRequested(settings);
  const storeCfgActive = storePaysActive(settings);
  const { setOn: setStoreDeviceOn } = storeDevice;
  useEffect(() => {
    // 設定を読み込む前の既定値 (OFF) で、送っている支払いの「次の QR を出せない間」や「もう一度送る」を消さない。
    // 選んでいるか (requested) で知らせる。いまの通貨・チェーンで使えるかは会計ごとに止める (理由 'token') ので、レジの
    // 商品で USDC に暗黙に切り替わっても送る設定は OFF にしない (送れなかった支払いの「もう一度送る」を黙って消さない)。
    if (hydrated) setStoreDeviceOn(storeRequested);
  }, [hydrated, storeRequested, setStoreDeviceOn]);
  const storeBillWei = useMemo(() => {
    if (mode !== 'amount' || !amountValid) return 0n;
    try {
      return parseUnits(chargeAmount, deploymentForSlug(settings.token, settings.chain).decimals);
    } catch {
      return 0n;
    }
  }, [mode, amountValid, chargeAmount, settings.token, settings.chain]);
  // この会計のチェーンでお店負担に使う値 (受取先が OpenPay の受取口でないかの判定に使う)。
  const storeConfig = storeDeviceChainConfig(chainForSlug(settings.chain).id);
  const storeBlocked:
    | 'token'
    | 'no_locks'
    | 'config'
    | 'no_wallet'
    | 'static'
    | 'split'
    | 'fx'
    | 'receiver'
    | 'min_amount'
    | null = !storeRequested
    ? null
    : !storeCfgActive
      ? 'token'
      : storeDevice.blocked !== null
        ? storeDevice.blocked
        : storeDevice.gasAddress === null
          ? 'no_wallet'
          : mode !== 'amount'
            ? 'static'
            : splitsForUrl
              ? 'split'
              : convert
                ? 'fx'
                : effectiveReceiver &&
                    [storeConfig?.forwarder, storeConfig?.feeReceiver].some(
                      (a) => a && a.toLowerCase() === effectiveReceiver.toLowerCase(),
                    )
                  ? 'receiver'
                  : amountValid && storeBillWei < STORE_DEVICE_MIN_AMOUNT_WEI
                    ? 'min_amount'
                    : null;
  const storeForSale = storeRequested && storeBlocked === null && storeDevice.enabled;
  // お店負担の QR を出す・出している (通常の QR を店員が選んだときを除く)。
  const storeQrMode = storeRequested && !forceNormalQr;
  // お客様が開く /checkout の中身 (1 品・feeKind は付けない = parse が fail-closed で弾くため・金額は上の検証済みの値)。
  // 受け渡しの id は作った後に足す。
  const storeCheckout =
    storeQrMode && effectiveReceiver && origin && amountValid && mode === 'amount'
      ? {
          to: effectiveReceiver,
          token: settings.token,
          chain: settings.chain,
          gas: effectiveGasMode,
          mode: 'gasless' as const,
          items: [
            {
              name: settings.productName.trim() || t('storeDevice.itemName'),
              qty: 1,
              // 値引き前の 1 行 + 値引き (#749 の /checkout の値引き・支払額 = 値引き後 = storeBillWei)。
              price: amount,
              ...(settings.memo.trim() ? { memo: settings.memo.trim() } : {}),
            },
          ],
          ...(discount.param ? { discount: discount.param } : {}),
          taxRate: settings.taxRate ?? undefined,
          taxCategory: settings.taxCategory ?? undefined,
          receiptNo: receiptNo || undefined,
          storeName: settings.storeName.trim() || undefined,
          invoiceNo: settings.invoiceNo || undefined,
          submit: 'store' as const,
        }
      : null;
  // QR を出す判断の時点と、受け渡しを作り終えた時点で会計・設定が同じか (作っている間に金額・受取先・決済モード等を
  // 変えたら、その QR は出さずに受け渡しを締め切る = 請求額の違う QR・黙って通常の QR にしない)。
  const storeOpenKey = JSON.stringify([
    storeRequested,
    storeForSale,
    storeBillWei.toString(),
    storeCheckout,
    payUrl,
  ]);
  const storeOpenKeyRef = useRef(storeOpenKey);
  // QR を閉じたら進める (出し直しの途中で閉じたとき、遅れて返った受け渡しで QR を開き直さない)。
  const storeOpenAttemptRef = useRef(0);
  useEffect(() => {
    storeOpenKeyRef.current = storeOpenKey;
  }, [storeOpenKey]);

  // 受取先の欄 (AddressInput) も名前を解決して知らせてくるが、上の useResolveAddress を正本にする
  // (同じ hook で同じ値・二重に state を持たない・RegisterMode と同じ)。
  const handleResolved = useCallback(() => {}, []);

  // (jpyc + 非 polygon) の不整合は useQrSettings の sanitize で阻止済 → throw 不到達。
  const deployment = deploymentForSlug(settings.token, settings.chain);
  const chain = chainForSlug(settings.chain);

  // ポスター / モーダル / オフライン QR で共有する表示ラベル (単一情報源)。
  const amountLabelText =
    mode === 'amount'
      ? t('posterFixedAmount', { amount: groupAmountDigits(chargeAmount), symbol: deployment.displaySymbol })
      : t('posterOpenAmount', { symbol: deployment.displaySymbol });
  const tokenChainLabelText = `${deployment.displaySymbol} · ${
    settings.token === 'usdc' && crossChainAllowed(settings.chain) && settings.crossChain
      ? buyerUsdcChainNames().join(' / ')
      : chain.name
  }`;

  // QrPreviewModal を開いた時点 (qrValue=payUrl 確定) で「前回の受け取り QR」を保存。
  // 圏外時に OfflineLastQr が端末内で再描画する。flag OFF でも保存は無害 (読む側が inert)。
  useEffect(() => {
    // お店負担の QR (画面に表示している間だけ使える) は「前回の受け取り QR」に残さない。
    if (!qrModalOpen || !payUrl || storeQrMode) return;
    saveLastQr({
      payUrl,
      amountLabel: amountLabelText,
      tokenChainLabel: tokenChainLabelText,
      storeName: settings.storeName.trim() || undefined,
      ts: Date.now(),
    });
  }, [
    qrModalOpen,
    payUrl,
    amountLabelText,
    tokenChainLabelText,
    settings.storeName,
    saveLastQr,
    storeQrMode,
  ]);

  // 固定額 QR が表す請求額 (wei)。parseUnits(deployment.decimals) で QR が encode
  // する amount と整合させる (RecoverFeeNotice と同じ解釈・新たな parse は導入しない)。
  // amount 無効や static モードでは 0n (= watch しない)。
  const billAmountWei = useMemo(() => {
    if (mode !== 'amount' || !amountValid) return 0n;
    try {
      const wei = parseUnits(chargeAmount, deployment.decimals);
      return wei > 0n ? wei : 0n;
    } catch {
      return 0n;
    }
  }, [mode, amountValid, chargeAmount, deployment.decimals]);

  // 着金監視は受取先である店舗残高を見るため、顧客請求額ではなく実経路の店舗純受取額を渡す。
  // JPYC recover は PaymentForm / useJpycEip3009Payment と同じ recoverFeeValue を使い、
  // merchant 固定の控除額を反映する。これにより小口で 2 JPYC floor が 2% を超えても
  // 正規着金を見逃さない。その他経路は従来どおり請求額を期待値とする。
  const expectedAmountWei = useMemo(() => {
    if (!isJpycRecover || billAmountWei <= 0n) return billAmountWei;
    const feeValue = recoverFeeValue(
      billAmountWei,
      effectiveGasMode,
      deployment.chainId,
    );
    return billAmountWei > feeValue ? billAmountWei - feeValue : 0n;
  }, [
    isJpycRecover,
    billAmountWei,
    effectiveGasMode,
    deployment.chainId,
  ]);

  // 店員が決済 QR を提示している間 (モーダル open + 固定額 + 受取先/金額 valid)、
  // 受取先残高をポーリングし「おおよその着金」を検知する advisory ヒント。
  // static / EIP-681 QR は固定の期待額が無いため watch しない (enabled=false)。
  const { status: incomingStatus, receivedWei } = useIncomingPaymentWatch({
    receiver: effectiveReceiver,
    tokenAddress: deployment.address,
    chainId: deployment.chainId,
    expectedAmountWei,
    // お店負担の QR では止める (支払いの行方の正本は端末の送信の結果)。
    enabled: qrModalOpen && mode === 'amount' && receiverValid && amountValid && !storeQrMode,
  });

  const qrFilename = useMemo(() => {
    // storeName が空だと fileSafe は 'openpay' に倒れ、同一店舗の複数 QR (商品違い・
    // 受取先違い) が全部同名 PNG になり DL フォルダで取り違える。productName があれば
    // {store}-{product}-{token}-{chain}-{amount} の segment として挟んで識別性を上げる。
    const product = settings.productName?.trim()
      ? fileSafe(settings.productName)
      : undefined;
    const parts = [
      fileSafe(settings.storeName),
      ...(product ? [product] : []),
      settings.token,
      settings.chain,
      mode === 'amount' && chargeAmount ? chargeAmount.replace('.', '-') : 'open',
    ];
    return parts.join('-');
  }, [
    settings.storeName,
    settings.productName,
    settings.token,
    settings.chain,
    mode,
    chargeAmount,
  ]);

  // 互換 QR (EIP-681) — standard + amount のときだけ併発行 (gasless / split は
  // EIP-681 で表現不可)。standard でも OpenPay の決済 UI を経由する派生 QR とは
  // 別建てで「純粋な ERC20 transfer」も同時提供する利便性のため (店舗の主動線は
  // OpenPay decentpath、EIP-681 は MetaMask Mobile 等の直接 scan 用 fallback)。
  // amount は sanitizeAmount で常に decimals 内に切り詰められているため、builder は
  // throw しない。
  const eip681Uri = useMemo(() => {
    if (
      !hydrated ||
      !effectiveReceiver ||
      !isStandard ||
      mode !== 'amount' ||
      !amountValid
    ) {
      return '';
    }
    return buildEip681TransferUri({
      tokenAddress: deployment.address,
      chainId: deployment.chainId,
      to: effectiveReceiver,
      amount: chargeAmount,
      decimals: deployment.decimals,
    });
  }, [
    hydrated,
    effectiveReceiver,
    isStandard,
    mode,
    amountValid,
    deployment.address,
    deployment.chainId,
    deployment.decimals,
    chargeAmount,
  ]);

  function selectToken(tok: TokenSymbol) {
    // token を手動切替したら convert (FX 換算ロック) は解除して通常 QR に戻す。
    clearSelection();
    // token を切り替えると chain も既定 (USDC→base, JPYC→polygon) にリセット。
    // jpyc は polygon 固定なので、互換性のため reset 必須。usdc は default に
    // 戻すことで、ユーザの直前の chain 選択 (例: arbitrum) を意図せず引き継がない。
    // 離れる token の (chain, payMode) は tokenPrefs に記憶する (レジの暗黙切替が復元に使う)。
    // このタブの切替自体は従来どおり既定チェーンへ戻す。
    saveSettings((s) => ({
      ...s,
      token: tok,
      chain: DEFAULT_CHAIN_FOR_SYMBOL[tok],
      tokenPrefs: rememberTokenPrefs(s),
    }));
    // 旧 token (例 JPYC decimals=18) で打った長い小数を新 token (USDC decimals=6) の
    // 範囲へ truncate。amount を超過状態のまま残すと EIP-681 section が disable 表示
    // され UX が壊れるため、入力値を新 token に合わせる。
    setAmount((current) =>
      truncateAmount(current, defaultDeploymentForSymbol(tok).decimals),
    );
  }

  function selectChain(slug: ChainSlug) {
    // (token, chain) の deployment が gasless 非対応 (paymasterMode=unavailable) なら
    // payMode を standard に強制 set。これがないと「gasless 選択中 → 非対応 chain 選択」
    // 時に URL parser で reject される QR が生成されてしまう。
    const dep = deploymentForSlug(settings.token, slug);
    setSettings((s) => ({
      ...s,
      chain: slug,
      payMode: isGaslessSupported(dep) ? s.payMode : 'standard',
      crossChain: crossChainAllowed(slug, s.crossChain),
    }));
  }

  // --- 「他トークン建てで受け取る」(FX 換算・画面上の期限目安付き) ---
  // 換算先トークン (現 token の反対)。FX 換算はチェーン非依存。
  const convertTargetSymbol = counterpartSymbol(settings.token);
  const convertTargetDisplay = displaySymbolFor(convertTargetSymbol);
  const rateOk = !!marketRates && rateIsSane(marketRates.usdcJpy);
  // convert ボタンを出す条件: 受取先確定・固定額モードで有効額・split 無し・レート取得済・未 convert。
  // receiverValid を要求するのは、exp(now+180s) を焼く時点で QR が即生成できる状態に限定するため
  // (受取先未設定で convert すると入力が遅い間に「生成前に画面上の期限超過」となる QR を
  // 作れてしまう)。exp は未署名なのでサーバ強制の期限ではない。
  const canShowConvert =
    receiverValid && mode === 'amount' && amountValid && !splitsForUrl && !convert && !storeRequested && !discount.open;
  const convertAnchorDisplay = convert
    ? displaySymbolFor(convert.anchorSymbol)
    : convertTargetDisplay;

  // 金額入力の真下に出す参考円換算 (店員が即座に「いくら相当か」を掴むため)。
  // JPYC は ¥ ペッグ (=入力額そのもの) ゆえ冗長なので非表示。USDC のときのみ
  // 市場レート (Coinbase・sane 検証済) で概算円を表示。あくまで参考値・QR が encode する
  // 額は入力した USDC のまま (convert とは別経路で、ここでは額を一切書き換えない)。
  const fiatHint = useMemo(() => {
    if (mode !== 'amount' || settings.token !== 'usdc') return null;
    if (!marketRates || !rateIsSane(marketRates.usdcJpy)) return null;
    const value = Number(chargeAmount);
    if (!Number.isFinite(value) || value <= 0) return null;
    const yen = Math.round(value * marketRates.usdcJpy);
    return t('fiatApprox', { yen: yen.toLocaleString('en-US') });
  }, [mode, settings.token, marketRates, chargeAmount, t]);
  // USDC のときだけ、金額の下に参考レートを添える (作成画面の上の市場レートの帯の代わり・表示だけ)。
  const rateHint = useMemo(() => {
    if (settings.token !== 'usdc' || !marketRates || !rateIsSane(marketRates.usdcJpy)) return null;
    return t('usdcRateHint', {
      rate: marketRates.usdcJpy.toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }),
    });
  }, [settings.token, marketRates, t]);

  // 「QRコードを表示する」(右サイドバーとモバイル下部バーの 2 か所)。flag OFF では今までどおりそのまま開く。
  // flag ON: お店の端末が支払いを送っている・結果を待っている間は出さない (同じ会計を二重に払わせない・状態は
  // タブの上に出る)。お店負担を選んでいれば受け渡しを作ってからその QR を、そうでなければ締め切っていない受け渡しを
  // 締め切ってから通常の QR を出す (署名が入っていたら端末が送るので出さない)。
  const { device } = storeDevice;
  const openQrModal = useCallback<Dispatch<SetStateAction<boolean>>>(
    (value) => {
      if (!env.enableStoreGasWallet || value !== true) {
        setQrModalOpen(value);
        return;
      }
      if (device.busy) return;
      setForceNormalQr(false);
      const key = storeOpenKeyRef.current;
      if (storeRequested) {
        // 使えない会計・準備中 (ガス用ウォレットの確認待ち等) は出さない (ボタンも押せない・理由を出す)。
        if (!storeForSale || !effectiveReceiver || !storeCheckout) return;
        void openStoreQr(key, getAddress(effectiveReceiver), storeBillWei, storeCheckout, amountLabelText);
        return;
      }
      void device.releaseForNormal().then((ok) => {
        // 締め切りを待つ間にお店負担へ切り替えた等 → 通常の QR は出さない (押し直してもらう)。
        if (!ok || storeOpenKeyRef.current !== key) return;
        setStoreQr(null);
        setQrModalOpen(true);
      });
    },
    // openStoreQr は描画ごとに作り直すが、中身は引数と ref だけを使う。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [device, storeRequested, storeForSale, effectiveReceiver, storeBillWei, storeCheckout, amountLabelText],
  );
  /** 受け渡しを作り、作った時点の会計で QR を組み立てて出す。作る間に会計・設定が変わったら出さずに締め切る。 */
  async function openStoreQr(
    key: string,
    merchant: Address,
    wei: bigint,
    checkout: NonNullable<typeof storeCheckout>,
    amountText: string,
  ): Promise<boolean> {
    const attempt = storeOpenAttemptRef.current;
    // チェーンは QR の写し (checkout) と同じもの (受け渡しとお客様の URL のチェーンが食い違わない)。
    const session = await device.start(merchant, wei, chainForSlug(checkout.chain).id);
    // 作れなかった (理由は状態に出る)・前の会計の署名の送信を優先した → QR は開かない。
    if (!session) return false;
    if (storeOpenKeyRef.current !== key || storeOpenAttemptRef.current !== attempt) {
      device.stop();
      return false;
    }
    setStoreQr({ id: session.id, url: buildCheckoutUrl(origin, { ...checkout, handoffId: session.id }), amountText });
    setQrModalOpen(true);
    return true;
  }
  function closeQrModal() {
    storeOpenAttemptRef.current += 1;
    setQrModalOpen(false);
    setForceNormalQr(false);
    if (storeQr) {
      // 署名を待っていた受け渡しは締め切る (署名が入っていれば送る・結果はタブの上に出る)。
      device.stop();
      setStoreQr(null);
    }
  }
  async function reissueStoreQr() {
    // 出し直す間は前の (薄くした) QR のまま。出せなければ閉じる (通常の QR に変えない)。
    const opened =
      !!effectiveReceiver &&
      storeForSale &&
      !!storeCheckout &&
      (await openStoreQr(
        storeOpenKeyRef.current,
        getAddress(effectiveReceiver),
        storeBillWei,
        storeCheckout,
        amountLabelText,
      ));
    if (!opened) {
      setStoreQr(null);
      setQrModalOpen(false);
    }
  }
  async function showNormalQr() {
    // 店員が選んだときだけ通常の QR (署名を待っていた受け渡しを締め切ってから・署名が入っていたら出さない)。
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
  const storeQrShown = storeQr !== null && !forceNormalQr;
  const sdState = device.state;
  // QR を薄くする: この QR の受け渡しが署名を待っている (受付時間が十分残る) とき以外 (署名を受け取った後・受付時間の
  // 終わり・出し直しの途中 = 次のお客様に読ませない)。
  const storeQrDimmed =
    storeQrShown &&
    !(sdState.phase === 'waiting' && !sdState.stale && sdState.session.id === storeQr.id);
  // 押せない理由 (お店負担を選んでいてこの会計では使えない)。準備中は理由なしで押せない。
  // お店の端末が送っている・結果を待っている・判断の最中も押せない (理由はタブの上の状態に出る)。
  const storeShowQrBlocked =
    env.enableStoreGasWallet && device.busy
      ? ''
      : storeRequested && storeBlocked !== null
      ? t(`storeDevice.blocked.${storeBlocked}`, { chain: storeDeviceChainNames(storeDevice.chainIds) })
      : storeRequested && !storeForSale
        ? ''
        : undefined;

  // QR を出せない理由 (未入力の項目)。下部の会計バーと PC の会計パネルで同じものを出す。
  const notReadyKey = payUrl ? null : qrNotReadyKey(amountInputValid, receiverValid, discount.invalid);
  // 下部バーは幅が狭いので短い言い方 (「受取先が未設定」・会計画面の要約と同じ言葉)。右の会計パネルは指示の文。
  const notReadyText = notReadyKey ? t(`notReadyShort.${notReadyKey}`) : null;

  // モバイル: grid-cols-1 (= minmax(0,1fr)) を明示しないと単一列が auto track となり、下部固定バー
  // (nowrap の「QRコードを表示する」+ 金額) の max-content まで広がって横はみ出す。
  // デスクトップ: 左列も raw 1fr だと minmax(auto,1fr) で content の min-content まで伸び、金額指定
  // モードで金額入力欄等が左列を広げ右の QR 列を min(300px) まで圧迫する (据え置きでは起きない)。
  // 両軸とも minmax(0,1fr) (min-width:0) に固定し、列幅をコンテナ内で安定させる。
  return (
    <>
      {/* 圏外時のみ描画される「前回の受け取り QR」(オンライン時は null)。ページ最上部に置く。
          中身が無いときは枠ごと消す (空の枠の余白でタブと会計カードの間が空かない)。 */}
      <div className="mb-4 empty:hidden print:hidden">
        {/* お店負担を選んでいる・お店の端末が送っている・締め切っていない受け渡しが残っている間は、保存した通常の QR を
            出さない (店員が選ばずに通常の QR を出さない・圏外で締め切れなかったお店負担の QR と二重に払わせない)。
            flag OFF では今までどおり。 */}
        {!(env.enableStoreGasWallet && (storeRequested || device.busy || device.hasPendingSale())) && (
          <OfflineLastQr />
        )}
      </div>
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(300px,360px)] lg:items-start lg:gap-6 print:block print:gap-0">
        <div className="space-y-4 print:hidden">
        {/* 会計のカード: 先頭にお店の設定の要約 (どの店名・受取先・通貨とチェーン・支払い方法で出すか)、その下に金額。
            一度決めたら変えない設定は「お店の設定」シートに畳む (2026-10 磨き上げ P2)。 */}
        <QrAmountSection
          header={
            <ShopSummaryRow
              storeName={settings.storeName}
              receiver={effectiveReceiver}
              token={settings.token}
              tokenLabel={deployment.displaySymbol}
              chainSlug={settings.chain}
              chainName={chain.name}
              payLabel={
                storeRequested
                  ? t('storeDevice.posterBadge')
                  : payMode === 'gasless'
                    ? t('posterPayModeGasless')
                    : t('shopSummary.payStandard')
              }
              payTone={storeRequested || payMode === 'gasless' ? 'gasless' : 'standard'}
              onOpenSettings={() => setSettingsOpen(true)}
              labels={{
                settings: t('shopSettings.open'),
                noStoreName: t('shopSummary.noStoreName'),
                noReceiver: t('shopSummary.noReceiver'),
              }}
            />
          }
          settings={settings}
          setSettings={setSettings}
          deployment={deployment}
          mode={mode}
          setMode={setMode}
          amount={amount}
          setAmount={setAmount}
          resetConvert={resetConvert}
          fiatHint={fiatHint}
          rateHint={rateHint}
          canShowConvert={canShowConvert}
          rateOk={rateOk}
          convert={convert}
          convertExpired={convertExpired}
          convertRemaining={convertRemaining}
          convertTargetDisplay={convertTargetDisplay}
          convertAnchorDisplay={convertAnchorDisplay}
          applyConvert={applyConvert}
          recalcConvert={recalcConvert}
          revertConvert={revertConvert}
          fxWarning={fxWarning}
          acknowledgeFxWarning={acknowledgeFxWarning}
          recoverBillAmount={recoverBillAmount}
          recoverGasMode={recoverGasMode}
          discount={discountAvailable ? discount : null}
          chargeText={discount.wei !== null ? amountLabelText : null}
        />

        {/* 受取先が未設定のときだけ、会計画面に受取先の欄を出す (QR を出す唯一の前提・設定済みならシートの中)。 */}
        {receiverInline && (
          <section
            aria-labelledby="qr-receiver-inline-heading"
            className="rounded-2xl bg-white p-5 shadow-card ring-1 ring-slate-200/70"
          >
            <h2 id="qr-receiver-inline-heading" className="text-sm font-semibold text-slate-800">
              {t('receiverInline.title')}
            </h2>
            <p className="mb-3 mt-0.5 text-xs text-slate-500">{t('receiverInline.hint')}</p>
            <QrReceiverFields
              settings={settings}
              deployment={deployment}
              chain={chain}
              effectiveReceiver={effectiveReceiver}
              receiverValid={receiverValid}
              autofill={autofill}
              handleResolved={handleResolved}
              bare
            />
          </section>
        )}

        {/* ▸ 明細 (任意): 商品名・メモ・税・管理番号。会計ごとに変わるので設定には畳まず、金額の下の 1 行に。
            QR は manual variant (未入力なら URL 不変)。 */}
        <AccountingSection
          variant="manual"
          productName={settings.productName}
          onProductNameChange={(v) =>
            setSettings((s) => ({ ...s, productName: v }))
          }
          memo={settings.memo}
          onMemoChange={(v) => setSettings((s) => ({ ...s, memo: v }))}
          taxRate={settings.taxRate}
          taxCategory={settings.taxCategory}
          onTaxChange={(next) => setSettings((s) => ({ ...s, ...next }))}
          receiptNo={receiptNo}
          onReceiptNoChange={setReceiptNo}
          labels={{
            title: t('accountingFieldsTitle'),
            hint: t('accountingFieldsHint'),
            productName: t('productNameLabel'),
            productNamePlaceholder: t('productNamePlaceholder'),
            memo: t('memoLabel'),
            memoPlaceholder: t('memoPlaceholder'),
            tax: t('taxLabel'),
            taxCustom: t('taxCustomLabel'),
            receiptNo: t('receiptNoLabel'),
            receiptNoPlaceholder: t('receiptNoPlaceholder'),
          }}
        />

        {/* お店がガス代を肩代わりして送る: この端末のガス用ウォレット (作る・残高・戻す)。 */}
        {env.enableStoreGasWallet && storeRequested && (
          <StoreGasWalletPanel onAddressChange={storeDevice.setGasAddress} />
        )}

        {/* A2HS 導線: 初回 QR モーダルを開いた後 (ピークモーメント) にだけ出す。
            standalone / dismiss 済では PwaInstallHint 側で自動非表示。 */}
        {hasOpenedQr && (
          <PwaInstallHint
            title={t('installHintTitle')}
            iosStep3={t('installHintIosStep3')}
          />
        )}
      </div>

      <QrPreviewSection
        payUrl={payUrl}
        receiverValid={receiverValid}
        amountValid={amountInputValid}
        discountInvalid={discount.invalid}
        amountText={
          mode === 'static'
            ? amountLabelText
            : amountValid
              ? amountLabelText
              : null
        }
        fiatHint={fiatHint}
        sampleAmount={settings.token === 'usdc' ? '5' : '1000'}
        setAmount={setAmount}
        setQrModalOpen={openQrModal}
        {...(storeShowQrBlocked !== undefined ? { showQrBlocked: storeShowQrBlocked } : {})}
        // お店負担の QR を作れなかったとき、店員が選んで通常の QR を出せる (モーダルが開いていないので、ここに出す)。
        {...(storeRequested && sdState.phase === 'create_failed'
          ? { secondaryAction: { label: t('storeDevice.showNormalQr'), onClick: () => void showNormalQr() } }
          : {})}
      />

      {/* お店の設定 (受取先・通貨とチェーン・支払い方法・控えとポスター)。値の変え方は今までの handler のまま。 */}
      <ShopSettingsSheet
        open={settingsOpen}
        onClose={() => {
          setSettingsOpen(false);
          // シートで受取先を決めたら、会計画面の受取先の欄は役目を終える (同じ欄を 2 か所に出さない)。
          if (receiverValid) setReceiverInline(false);
        }}
        title={t('shopSettings.title')}
        doneLabel={t('shopSettings.done')}
      >
        <ShopSettingsSection title={t('shopSettings.sections.receive')}>
          <QrReceiverFields
            settings={settings}
            deployment={deployment}
            chain={chain}
            effectiveReceiver={effectiveReceiver}
            receiverValid={receiverValid}
            autofill={autofill}
            handleResolved={handleResolved}
          />
          <QrStoreNameField settings={settings} setSettings={setSettings} />
        </ShopSettingsSection>
        <ShopSettingsSection title={t('shopSettings.sections.currency')}>
          <TokenChooser selected={settings.token} onSelect={selectToken} />
          <ChainChooser
            slugs={settings.token === 'usdc' ? USDC_CHAINS : JPYC_CHAINS}
            selected={settings.chain}
            onSelect={selectChain}
            gridClassName="grid grid-cols-2 gap-2"
            showId={false}
          />
        </ShopSettingsSection>
        <ShopSettingsSection title={t('shopSettings.sections.payment')}>
          <QrSettingsSection
            settings={settings}
            setSettings={setSettings}
            deployment={deployment}
            hideGasMode={hideGasMode}
            isJpycRecover={isJpycRecover}
            isStandard={isStandard}
            splitParsed={splitParsed}
            splitsForUrl={splitsForUrl}
          />
        </ShopSettingsSection>
        <ShopSettingsSection title={t('shopSettings.sections.receipt')}>
          <QrReceiptPosterFields settings={settings} setSettings={setSettings} />
        </ShopSettingsSection>
      </ShopSettingsSheet>

      {/* 全画面プレビュー (ポスター調 + 印刷/コピー/SVG/PNG + × 閉じる)。決済QR/レジ共通。 */}
      {/* お店負担を選んでいる間は、お店負担の QR (受け渡し済み) か、店員が選んだ通常の QR だけを出す。 */}
      {payUrl && (!storeQrMode || storeQr) && (
        <QrPreviewModal
          open={qrModalOpen}
          convertExpired={convertExpired || storeQrDimmed}
          onClose={closeQrModal}
          labels={{
            title: t('qrModalTitle'),
            close: t('qrModalClose'),
            convertExpired: convert ? t('qrModalConvertExpired') : undefined,
            eyebrow: t('posterEyebrow'),
            print: t('printPoster'),
            copy: t('qrCopy'),
            copied: t('qrCopied'),
            downloadSvg: t('downloadSvg'),
            downloadPng: t('downloadPng'),
            // お店負担の QR は端末が通信して送るので「圏外でも提示できます」は出さない。
            localGenNote: storeQrShown ? undefined : t('localGenNote'),
            payTo: t('qrPayTo'),
            showUrl: t('qrShowUrl'),
            step1: t('posterStepScan'),
            step2: t('posterStepConfirm'),
            step3: t('posterStepDone'),
          }}
          qrValue={storeQrShown ? storeQr.url : payUrl}
          qrRef={qrRef}
          storeName={settings.storeName.trim() || t('posterDefaultStoreName')}
          amountText={storeQrShown ? storeQr.amountText : amountLabelText}
          payModeBadge={storeQrShown ? { text: t('storeDevice.posterBadge'), tone: 'gasless' } : {
            text:
              payMode === 'gasless'
                ? t('posterPayModeGasless')
                : settings.chain === 'arc' ? t('posterPayModeArc') : t('posterPayModeStandard', {
                    nativeToken: chain.nativeCurrency.symbol,
                  }),
            tone: payMode === 'gasless' ? 'gasless' : 'standard',
          }}
          // お店負担の QR は画面に表示している間だけ使える (印刷・保存・URL のコピー・互換 QR は出さない)。
          {...(storeQrShown
            ? { hideUrl: true, actionsNote: t('storeDevice.actionsNote') }
            : {
                copied,
                onCopy: () => copy(payUrl),
                onPrint: () => window.print(),
                onDownloadSvg: () => downloadSvg(`${qrFilename}.svg`, qrRef),
                onDownloadPng: () => downloadPng(`${qrFilename}.png`, qrRef),
              })}
          deviceStatus={
            env.enableStoreGasWallet && sdState.phase !== 'idle' ? (
              <StoreDeviceRegisterStatus
                state={sdState}
                formatAmount={formatStoreDeviceAmount}
                onCheckNow={() => void device.checkNow()}
                onRetry={device.retry}
                onReissue={() => void reissueStoreQr()}
                onShowNormal={() => void showNormalQr()}
                onDismiss={device.dismiss}
              />
            ) : undefined
          }
          note={settings.posterNote.trim() || t('posterDefaultNote')}
          chainText={tokenChainLabelText}
          receiverShort={
            effectiveReceiver ? shortAddress(effectiveReceiver) : ''
          }
          // ポスターを「読まずに分かる」形にする token/chain 情報 (labels-as-props)。
          // chainSlug は public/chains/{slug}.svg と一致 (settings.chain = ChainSlug)。
          asset={{
            tokenSymbol: settings.token,
            chainSlug: settings.chain,
            chainLabel: chain.name,
          }}
          eip681={
            eip681Uri && !storeQrShown
              ? {
                  uri: eip681Uri,
                  copied: eip681Copied,
                  onCopy: () => eip681Copy(eip681Uri),
                  title: t('eip681Title'),
                  badge: t('eip681SummaryBadge'),
                  description: t('eip681Description'),
                  copy: t('eip681Copy'),
                  copiedLabel: t('eip681Copied'),
                }
              : undefined
          }
          // 着金検知ヒント (advisory)。watching=監視中 / received=おおよその着金検知。
          // idle (未監視・固定額でない等) は prop を渡さず非表示。received は受信額を
          // 表示通貨でフォーマットして添える (正本は Explorer・ここはあくまでヒント)。
          paymentStatus={
            incomingStatus === 'received'
              ? {
                  state: 'received' as const,
                  text: t('paymentReceived', {
                    amount: formatTokenAmount(receivedWei, deployment),
                  }),
                  note: t('paymentReceivedNote'),
                }
              : incomingStatus === 'watching'
                ? { state: 'watching' as const, text: t('paymentWatching'), note: t('paymentWatchingNote') }
                : undefined
          }
        />
      )}

      {/* モバイル下部固定 会計バー: 請求金額 + 「QRコードを表示する」を常時固定。レジの下部バーと
          揃え、店員が金額を確認してから QR を提示できるようにする (amount モードは固定額、
          static モードは「金額を入力」表示)。グローバル BottomNav (fixed bottom-0 z-20・md:hidden)
          の上に重ねるため < md は bottom-14 で nav 分浮かせ、md 以上 (nav 非表示) は bottom-0。
          lg は右サイドバー CTA を使うので非表示。payUrl 真のときのみ (Step3 と同じゲート)。 */}
      <QrMobileBar
        payUrl={payUrl}
        amount={chargeAmount}
        mode={mode}
        deployment={deployment}
        amountLabelText={amountLabelText}
        notReady={notReadyText}
        fiatHint={fiatHint}
        setQrModalOpen={openQrModal}
        {...(storeShowQrBlocked !== undefined ? { showQrBlocked: storeShowQrBlocked } : {})}
      />
      </div>
    </>
  );
}
