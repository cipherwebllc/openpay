'use client';

import { crossChainAllowed } from '@/lib/url/shared';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import type { Address } from 'viem';
import { parseUnits } from 'viem';
import { AccountingSection } from './AccountingSection';
import { QrPreviewModal } from './QrPreviewModal';
import { PwaInstallHint } from './PwaInstallHint';
import { OfflineLastQr } from './OfflineLastQr';
import { QrAmountSection, type Mode } from './qr/QrAmountSection';
import { QrReceiverSection } from './qr/QrReceiverSection';
import { QrSettingsSection } from './qr/QrSettingsSection';
import { QrMobileBar, QrPreviewSection } from './qr/QrPreviewSection';
import { downloadPng, downloadSvg, fileSafe } from './qr/qrDownload';
import { rememberTokenPrefs, useQrSettings } from '@/hooks/useQrSettings';
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
  type ChainSlug,
} from '@/lib/chains';
import type { GasMode, PayMode } from '@/lib/fee';
import { jpycForwarderFor } from '@/lib/relay/forwarderConfig';
import { recoverFeeValue } from '@/lib/relay/recoverFee';
import { resolveJpycGaslessProvider } from '@/lib/jpycGaslessProvider';
import { pickEffectiveAddress, shortAddress, formatTokenAmount } from '@/lib/format';
import { useIncomingPaymentWatch } from '@/hooks/useIncomingPaymentWatch';
import { truncateAmount } from '@/lib/amount';

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
  // 高度な設定 (payMode / gas / split) は default 閉じる。
  const [accordionOpen, setAccordionOpen] = useState(false);
  const [resolvedReceiver, setResolvedReceiver] = useState<Address | null>(null);
  // ② 受取先は初期設定後あまり変えないため折りたたみ。hydrate 後に一度だけ
  // 「受取先未設定なら開く / 設定済なら閉じる」を決める (step2Initialized 後は手動)。
  const [step2Open, setStep2Open] = useState(true);
  const [step2Initialized, setStep2Initialized] = useState(false);
  // QR は即時表示せず「QRコードを表示する」ボタン → 全画面モーダルで提示。
  const [qrModalOpen, setQrModalOpen] = useState(false);
  // onClose は modal の focus effect の依存。残高更新や入力で再 focus させない。
  const closeQrModal = useCallback(() => setQrModalOpen(false), []);
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

  const effectiveReceiver = useMemo(
    () => pickEffectiveAddress(settings.receiver, resolvedReceiver),
    [settings.receiver, resolvedReceiver],
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

  // Step 2 の初期 open 状態を hydrate 後に一度だけ決定する。
  useEffect(() => {
    if (!hydrated || step2Initialized) return;
    setStep2Open(effectiveReceiver === null);
    setStep2Initialized(true);
  }, [hydrated, effectiveReceiver, step2Initialized]);

  const receiverValid = effectiveReceiver !== null;
  const amountValid =
    mode === 'static' ||
    (mode === 'amount' && DECIMAL_PATTERN.test(amount) && Number(amount) > 0);
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
    if (!amountValid || mode !== 'amount' || settings.token !== 'jpyc') return null;
    const dep = deploymentForSlug(settings.token, settings.chain);
    try {
      const wei = parseUnits(amount, dep.decimals);
      return wei > 0n ? wei : null;
    } catch {
      return null;
    }
  }, [amountValid, mode, settings.token, settings.chain, amount]);
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
      amount: mode === 'amount' ? amount : undefined,
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
    settings.productName,
    settings.memo,
    settings.taxRate,
    settings.taxCategory,
    receiptNo,
    mode,
    amount,
    payMode,
    splitsForUrl,
    convert,
  ]);

  const handleResolved = useCallback((addr: Address | null) => {
    setResolvedReceiver(addr);
  }, []);

  // (jpyc + 非 polygon) の不整合は useQrSettings の sanitize で阻止済 → throw 不到達。
  const deployment = deploymentForSlug(settings.token, settings.chain);
  const chain = chainForSlug(settings.chain);

  // ポスター / モーダル / オフライン QR で共有する表示ラベル (単一情報源)。
  const amountLabelText =
    mode === 'amount'
      ? t('posterFixedAmount', { amount, symbol: deployment.displaySymbol })
      : t('posterOpenAmount', { symbol: deployment.displaySymbol });
  const tokenChainLabelText = `${deployment.displaySymbol} · ${
    settings.token === 'usdc' && crossChainAllowed(settings.chain) && settings.crossChain
      ? buyerUsdcChainNames().join(' / ')
      : chain.name
  }`;

  // QrPreviewModal を開いた時点 (qrValue=payUrl 確定) で「前回の受け取り QR」を保存。
  // 圏外時に OfflineLastQr が端末内で再描画する。flag OFF でも保存は無害 (読む側が inert)。
  useEffect(() => {
    if (!qrModalOpen || !payUrl) return;
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
  ]);

  // 固定額 QR が表す請求額 (wei)。parseUnits(deployment.decimals) で QR が encode
  // する amount と整合させる (RecoverFeeNotice と同じ解釈・新たな parse は導入しない)。
  // amount 無効や static モードでは 0n (= watch しない)。
  const billAmountWei = useMemo(() => {
    if (mode !== 'amount' || !amountValid) return 0n;
    try {
      const wei = parseUnits(amount, deployment.decimals);
      return wei > 0n ? wei : 0n;
    } catch {
      return 0n;
    }
  }, [mode, amountValid, amount, deployment.decimals]);

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
    enabled: qrModalOpen && mode === 'amount' && receiverValid && amountValid,
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
      mode === 'amount' && amount ? amount.replace('.', '-') : 'open',
    ];
    return parts.join('-');
  }, [
    settings.storeName,
    settings.productName,
    settings.token,
    settings.chain,
    mode,
    amount,
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
      amount,
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
    amount,
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
    receiverValid && mode === 'amount' && amountValid && !splitsForUrl && !convert;
  const convertAnchorDisplay = convert
    ? displaySymbolFor(convert.anchorSymbol)
    : convertTargetDisplay;

  // 金額入力の真下に出す参考円換算 (店員が即座に「いくら相当か」を掴むため)。
  // JPYC は ¥ ペッグ (=入力額そのもの) ゆえ冗長なので非表示。USDC のときのみ
  // CoinGecko レート (sane 検証済) で概算円を表示。あくまで参考値・QR が encode する
  // 額は入力した USDC のまま (convert とは別経路で、ここでは額を一切書き換えない)。
  const fiatHint = useMemo(() => {
    if (mode !== 'amount' || settings.token !== 'usdc') return null;
    if (!marketRates || !rateIsSane(marketRates.usdcJpy)) return null;
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) return null;
    const yen = Math.round(value * marketRates.usdcJpy);
    return t('fiatApprox', { yen: yen.toLocaleString('en-US') });
  }, [mode, settings.token, marketRates, amount, t]);

  // モバイル: grid-cols-1 (= minmax(0,1fr)) を明示しないと単一列が auto track となり、下部固定バー
  // (nowrap の「QRコードを表示する」+ 金額) の max-content まで広がって横はみ出す。
  // デスクトップ: 左列も raw 1fr だと minmax(auto,1fr) で content の min-content まで伸び、金額指定
  // モードで金額入力欄等が左列を広げ右の QR 列を min(300px) まで圧迫する (据え置きでは起きない)。
  // 両軸とも minmax(0,1fr) (min-width:0) に固定し、列幅をコンテナ内で安定させる。
  return (
    <>
      {/* 圏外時のみ描画される「前回の受け取り QR」(オンライン時は null)。ページ最上部に置く。 */}
      <div className="mb-4 print:hidden">
        <OfflineLastQr />
      </div>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(300px,360px)] lg:items-start print:block print:gap-0">
        <div className="space-y-5 print:hidden">
        {/* ① 金額: 通貨 / 受取チェーン / 請求金額。店員が毎回触る金額を先頭に置く
            (受取先は初期設定後あまり変えないため ② へ・折りたたみ)。 */}
        <QrAmountSection
          settings={settings}
          setSettings={setSettings}
          deployment={deployment}
          mode={mode}
          setMode={setMode}
          amount={amount}
          setAmount={setAmount}
          resetConvert={resetConvert}
          fiatHint={fiatHint}
          selectToken={selectToken}
          selectChain={selectChain}
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
        />

        {/* ② 受取先: 受取ウォレット / 店舗名 / ポスター補足文。初期設定後あまり
            変えないので折りたたみ (未設定なら開く・設定済は閉じて1行サマリ)。 */}
        <QrReceiverSection
          settings={settings}
          setSettings={setSettings}
          deployment={deployment}
          chain={chain}
          step2Open={step2Open}
          setStep2Open={setStep2Open}
          effectiveReceiver={effectiveReceiver}
          receiverValid={receiverValid}
          autofill={autofill}
          handleResolved={handleResolved}
        />

        {/* ▸ 記帳・会計 (任意): ② の後の独立折りたたみ。3 モード共通 AccountingSection。
            QR は manual variant (商品名/メモ/税/管理番号を手入力・未入力なら URL 不変)。 */}
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

        <QrSettingsSection
          settings={settings}
          setSettings={setSettings}
          deployment={deployment}
          accordionOpen={accordionOpen}
          setAccordionOpen={setAccordionOpen}
          effectiveGasMode={effectiveGasMode}
          payMode={payMode}
          hideGasMode={hideGasMode}
          isJpycRecover={isJpycRecover}
          isStandard={isStandard}
          splitParsed={splitParsed}
          splitsForUrl={splitsForUrl}
        />

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
        amountValid={amountValid}
        settings={settings}
        setAmount={setAmount}
        setQrModalOpen={setQrModalOpen}
      />

      {/* 全画面プレビュー (ポスター調 + 印刷/コピー/SVG/PNG + × 閉じる)。決済QR/レジ共通。 */}
      {payUrl && (
        <QrPreviewModal
          open={qrModalOpen}
          onClose={closeQrModal}
          labels={{
            title: t('qrModalTitle'),
            close: t('qrModalClose'),
            eyebrow: t('posterEyebrow'),
            print: t('printPoster'),
            copy: t('qrCopy'),
            copied: t('qrCopied'),
            downloadSvg: t('downloadSvg'),
            downloadPng: t('downloadPng'),
            localGenNote: t('localGenNote'),
            step1: t('posterStepScan'),
            step2: t('posterStepConfirm'),
            step3: t('posterStepDone'),
          }}
          qrValue={payUrl}
          qrRef={qrRef}
          storeName={settings.storeName.trim() || t('posterDefaultStoreName')}
          amountText={amountLabelText}
          payModeBadge={{
            text:
              payMode === 'gasless'
                ? t('posterPayModeGasless')
                : settings.chain === 'arc' ? t('posterPayModeArc') : t('posterPayModeStandard', {
                    nativeToken: chain.nativeCurrency.symbol,
                  }),
            tone: payMode === 'gasless' ? 'gasless' : 'standard',
          }}
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
          copied={copied}
          onCopy={() => copy(payUrl)}
          onPrint={() => window.print()}
          onDownloadSvg={() => downloadSvg(`${qrFilename}.svg`, qrRef)}
          onDownloadPng={() => downloadPng(`${qrFilename}.png`, qrRef)}
          eip681={
            eip681Uri
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
                }
              : incomingStatus === 'watching'
                ? { state: 'watching' as const, text: t('paymentWatching') }
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
        amount={amount}
        mode={mode}
        deployment={deployment}
        amountLabelText={amountLabelText}
        fiatHint={fiatHint}
        setQrModalOpen={setQrModalOpen}
      />
      </div>
    </>
  );
}
