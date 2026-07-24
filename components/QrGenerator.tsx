'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { env } from '@/lib/env';
import type { Address } from 'viem';
import { parseUnits } from 'viem';
import { RecoverFeeNotice } from './RecoverFeeNotice';
import {
  ChevronDown,
  Coins,
  Fuel,
  QrCode as QrCodeIcon,
  Store,
  Zap,
} from 'lucide-react';
import { AddressInput } from './AddressInput';
import { ReceiverWalletChip } from './ReceiverWalletChip';
import { AccountingSection } from './AccountingSection';
import { QrPreviewModal } from './QrPreviewModal';
import { PwaInstallHint } from './PwaInstallHint';
import { OfflineLastQr } from './OfflineLastQr';
import { ChainChooser } from './ChainChooser';
import { TokenChooser } from './TokenChooser';
import { Field } from './Field';
import { StepCard } from './StepCard';
import { QuickAmountEditor } from './qr/QuickAmountEditor';
import { ConvertPanel } from './qr/ConvertPanel';
import { SplitEditor } from './qr/SplitEditor';
import {
  POSTER_NOTE_MAX,
  QUICK_AMOUNT_MAX,
  STORE_NAME_MAX,
  useQrSettings,
} from '@/hooks/useQrSettings';
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
  SPLIT_MAX_ENTRIES,
  type PayParams,
  type SplitDraft,
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
  addressExplorerUrl,
  buyerUsdcChainNames,
  chainForSlug,
  JPYC_CHAINS,
  USDC_CHAINS,
  type ChainSlug,
} from '@/lib/chains';
import type { GasMode, PayMode } from '@/lib/fee';
import { jpycForwarderFor } from '@/lib/relay/forwarderConfig';
import { resolveJpycGaslessProvider } from '@/lib/jpycGaslessProvider';
import { isLikelyName } from '@/lib/nameDetection';
import { pickEffectiveAddress, shortAddress, formatTokenAmount } from '@/lib/format';
import { useIncomingPaymentWatch } from '@/hooks/useIncomingPaymentWatch';
import { normalizeAmountList, truncateAmount } from '@/lib/amount';
import { triggerDownload } from '@/lib/download';

type Mode = 'amount' | 'static';

const FILENAME_FALLBACK = 'openpay';

// 主要 OS (macOS APFS / Windows NTFS / Linux ext4) は UTF-8 ファイル名を許容する
// ため日本語店舗名 (例「神田珈琲」) もそのまま残す。除去対象は path separator・
// Windows 予約文字・制御文字・空白・ダッシュ連続のみ。これを ASCII 限定の
// 正規化にすると日本語名が常に fallback に潰れて merchant が混乱する。
function fileSafe(value: string): string {
  const normalized = value
    .replace(/[-\\/:*?"<>|\s\x00-\x1f\x7f]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || FILENAME_FALLBACK;
}

function svgMarkup(ref: React.RefObject<HTMLDivElement | null>): string | null {
  const svg = ref.current?.querySelector('svg');
  return svg ? new XMLSerializer().serializeToString(svg) : null;
}

function downloadSvg(filename: string, ref: React.RefObject<HTMLDivElement | null>) {
  const markup = svgMarkup(ref);
  if (!markup) return;
  const url = URL.createObjectURL(
    new Blob([markup], { type: 'image/svg+xml;charset=utf-8' }),
  );
  triggerDownload(url, filename);
  URL.revokeObjectURL(url);
}

function downloadPng(filename: string, ref: React.RefObject<HTMLDivElement | null>) {
  const markup = svgMarkup(ref);
  if (!markup) return;
  const img = new Image();
  img.onload = () => {
    // QR は常に正方形 (qrcode.react 出力)、img.width = img.height
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.width;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, img.width, img.width);
    ctx.drawImage(img, 0, 0);
    triggerDownload(canvas.toDataURL('image/png'), filename);
  };
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
}

export function QrGenerator() {
  const { settings, setSettings, hydrated } = useQrSettings();
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
  const bottomBarRef = useRef<HTMLDivElement>(null);
  // 高度な設定 (payMode / gas / split) は default 閉じる。
  const [accordionOpen, setAccordionOpen] = useState(false);
  const [resolvedReceiver, setResolvedReceiver] = useState<Address | null>(null);
  // ② 受取先は初期設定後あまり変えないため折りたたみ。hydrate 後に一度だけ
  // 「受取先未設定なら開く / 設定済なら閉じる」を決める (step2Initialized 後は手動)。
  const [step2Open, setStep2Open] = useState(true);
  const [step2Initialized, setStep2Initialized] = useState(false);
  // QR は即時表示せず「QRコードを表示する」ボタン → 全画面モーダルで提示。
  const [qrModalOpen, setQrModalOpen] = useState(false);
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
  // FX 換算 (他トークン建て受取・有効期限付き) の状態とハンドラ。convert / カウントダウン /
  // applyConvert・recalcConvert・revertConvert を hook 内に保持する (挙動は従来と同一)。
  const {
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
    settings,
    amount,
    marketRates: marketRates ?? null,
    setSettings,
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
      crossChain: settings.token === 'usdc' ? settings.crossChain : undefined,
      // convert 適用時のみ、期限と顧客への文脈表示 (元価格 + レート) を URL に乗せる。
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

  function setSplits(next: SplitDraft[]) {
    setSettings((s) => ({ ...s, splits: next }));
  }
  function addSplit() {
    // UI 側 ({splits.length < MAX && ...}) で button が消えるため通常 unreachable。
    if (settings.splits.length >= SPLIT_MAX_ENTRIES) return;
    setSplits([...settings.splits, { address: '', percent: '' }]);
  }
  function removeSplit(idx: number) {
    setSplits(settings.splits.filter((_, i) => i !== idx));
  }
  function updateSplit(idx: number, patch: Partial<SplitDraft>) {
    setSplits(
      settings.splits.map((s, i) => (i === idx ? { ...s, ...patch } : s)),
    );
  }

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
    settings.token === 'usdc' && settings.crossChain
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

  // 固定額 QR が表す金額 (wei)。着金検知ヒント (useIncomingPaymentWatch) と同じ
  // parseUnits(deployment.decimals) で、QR が encode する amount と整合させる
  // (RecoverFeeNotice と同じ解釈・新たな parse は導入しない)。amount 無効や
  // static モードでは 0n (= watch しない)。
  const expectedAmountWei = useMemo(() => {
    if (mode !== 'amount' || !amountValid) return 0n;
    try {
      const wei = parseUnits(amount, deployment.decimals);
      return wei > 0n ? wei : 0n;
    } catch {
      return 0n;
    }
  }, [mode, amountValid, amount, deployment.decimals]);

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

  // WebKit (モバイル Safari・SNS アプリ内ブラウザ) では position:sticky な下部バーの子テキストを
  // JS で書き換えても合成レイヤーが再ラスタライズされず古い表示が残ることがある (RegisterMode
  // と同根)。表示金額/通貨/モードが変わるたび transform を 1 フレーム入れて再描画を強制する。
  useEffect(() => {
    const el = bottomBarRef.current;
    if (!el) return;
    el.style.transform = 'translateZ(0)';
    const id = requestAnimationFrame(() => {
      if (el) el.style.transform = '';
    });
    return () => cancelAnimationFrame(id);
  }, [amount, mode, deployment.displaySymbol]);
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
    resetConvert();
    // token を切り替えると chain も既定 (USDC→base, JPYC→polygon) にリセット。
    // jpyc は polygon 固定なので、互換性のため reset 必須。usdc は default に
    // 戻すことで、ユーザの直前の chain 選択 (例: arbitrum) を意図せず引き継がない。
    setSettings((s) => ({
      ...s,
      token: tok,
      chain: DEFAULT_CHAIN_FOR_SYMBOL[tok],
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
    }));
  }

  // --- 「他トークン建てで受け取る」(FX 換算・有効期限付き) ---
  // 換算先トークン (現 token の反対)。FX 換算はチェーン非依存。
  const convertTargetSymbol = counterpartSymbol(settings.token);
  const convertTargetDisplay = displaySymbolFor(convertTargetSymbol);
  const rateOk = !!marketRates && rateIsSane(marketRates.usdcJpy);
  // convert ボタンを出す条件: 受取先確定・固定額モードで有効額・split 無し・レート取得済・未 convert。
  // receiverValid を要求するのは、exp(now+180s) を焼く時点で QR が即生成できる状態に限定するため
  // (受取先未設定で convert すると入力が遅い間に「生成前に期限切れ」の QR を作れてしまう)。
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

  // クイック金額は token (JPYC=円 / USDC=ドル) ごとに独立。エディタ・適用とも
  // 現在の token のサブリストだけを操作する。
  const tokenQuickAmounts = settings.quickAmounts[settings.token];

  function updateQuickAmount(idx: number, value: string) {
    setSettings((s) => ({
      ...s,
      quickAmounts: {
        ...s.quickAmounts,
        [s.token]: s.quickAmounts[s.token].map((q, i) =>
          i === idx ? truncateAmount(value, deployment.decimals) : q,
        ),
      },
    }));
  }

  function addQuickAmount() {
    setSettings((s) => ({
      ...s,
      quickAmounts: {
        ...s.quickAmounts,
        [s.token]: [...s.quickAmounts[s.token], ''],
      },
    }));
  }

  function removeQuickAmount(idx: number) {
    setSettings((s) => {
      const next = s.quickAmounts[s.token].filter((_, i) => i !== idx);
      return {
        ...s,
        quickAmounts: {
          ...s.quickAmounts,
          [s.token]: next.length > 0 ? next : [''],
        },
      };
    });
  }

  // 現在の token decimals に合わせて truncate してから表示・適用する。truncate 後に
  // 重複した値は除外 (例: 0.1234567890123 と 0.1234567890124 を保存 → USDC では
  // どちらも 0.123456 に潰れるので片方のみ残す)。
  const activeQuickAmounts = useMemo(
    () => normalizeAmountList(tokenQuickAmounts, deployment.decimals),
    [tokenQuickAmounts, deployment.decimals],
  );

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
        <StepCard step={1} icon={Coins} title={t('steps.amount')}>
          <div className="space-y-4">
            {/* token + chain は金額のシンボル表示にも影響するので金額と同じ① に。 */}
            <Field label={t('tokenLabel')}>
              <TokenChooser selected={settings.token} onSelect={selectToken} />
            </Field>

            <Field label={t('chainLabel')}>
              <ChainChooser
                slugs={settings.token === 'usdc' ? USDC_CHAINS : JPYC_CHAINS}
                selected={settings.chain}
                onSelect={selectChain}
                gridClassName={
                  settings.token === 'usdc'
                    ? 'grid grid-cols-2 gap-2 sm:grid-cols-3'
                    : 'grid grid-cols-2 gap-2'
                }
              />
            </Field>

            <Field label={t('amountLabel', { symbol: deployment.displaySymbol })}>
              <div className="flex flex-col gap-2">
                <div className="inline-flex w-full rounded-lg border border-slate-200 bg-slate-100 p-1">
                  {(
                    [
                      ['amount', t('modeAmount')],
                      ['static', t('modeStatic')],
                    ] as const
                  ).map(([m, label]) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => {
                        setMode(m as Mode);
                        resetConvert();
                      }}
                      className={`flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition ${
                        mode === m
                          ? 'bg-white text-brand-dark shadow-sm'
                          : 'text-slate-500 hover:text-slate-800'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {mode === 'amount' ? (
                  <div className="space-y-3">
                    {/* 金額ヒーロー: 入力欄を「表示器」化して数字を主役に。通貨記号は控えめな
                        接尾、その真下に参考円 (USDC のみ・JPYC は ¥ ペッグで冗長ゆえ非表示)。
                        枠線は container 側に寄せ、focus で brand + 浮き影。 */}
                    <div className="rounded-2xl border-2 border-slate-200 bg-gradient-to-br from-white to-brand/[0.03] px-5 py-4 transition focus-within:border-brand focus-within:shadow-card">
                      <div className="flex items-baseline gap-2">
                        <input
                          type="text"
                          inputMode="decimal"
                          value={amount}
                          onChange={(e) => {
                            setAmount(
                              truncateAmount(e.target.value, deployment.decimals),
                            );
                            resetConvert();
                          }}
                          placeholder={settings.token === 'jpyc' ? '1000' : '10.00'}
                          aria-label={t('amountLabel', {
                            symbol: deployment.displaySymbol,
                          })}
                          className="min-w-0 flex-1 bg-transparent text-right text-4xl font-bold tabular-nums tracking-tight text-slate-900 placeholder:text-slate-300 focus:outline-none sm:text-5xl"
                          autoFocus
                        />
                        <span className="shrink-0 text-xl font-semibold text-slate-500">
                          {deployment.displaySymbol}
                        </span>
                      </div>
                      {fiatHint && (
                        <div className="mt-1 text-right text-sm font-medium text-slate-500">
                          {fiatHint}
                        </div>
                      )}
                    </div>
                    {activeQuickAmounts.length > 0 && (
                      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                        {activeQuickAmounts.map((q) => (
                          <button
                            key={q}
                            type="button"
                            onClick={() => {
                              setAmount(q);
                              resetConvert();
                            }}
                            className="rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm font-semibold text-slate-700 transition hover:-translate-y-0.5 hover:border-brand hover:text-brand-dark hover:shadow-card active:translate-y-0"
                          >
                            {q} {deployment.displaySymbol}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                ) : (
                  <p className="rounded-lg bg-slate-50 px-3 py-3 text-sm text-slate-500">
                    {t('staticHint')}
                  </p>
                )}
              </div>
            </Field>

            {/* クイック金額の編集 (任意・token ごと独立)。金額入力の近くで設定できる
                よう高度な設定から①へ移設。 */}
            {mode === 'amount' && (
              <QuickAmountEditor
                items={tokenQuickAmounts}
                max={QUICK_AMOUNT_MAX}
                onUpdate={updateQuickAmount}
                onAdd={addQuickAmount}
                onRemove={removeQuickAmount}
              />
            )}

            <ConvertPanel
              canShowConvert={canShowConvert}
              rateOk={rateOk}
              convert={convert}
              convertExpired={convertExpired}
              convertRemaining={convertRemaining}
              convertTargetDisplay={convertTargetDisplay}
              convertAnchorDisplay={convertAnchorDisplay}
              amount={amount}
              displaySymbol={deployment.displaySymbol}
              isUsdc={settings.token === 'usdc'}
              onApply={applyConvert}
              onRecalc={recalcConvert}
              onRevert={revertConvert}
              fxWarning={fxWarning}
              onAcknowledgeFxWarning={acknowledgeFxWarning}
            />
          </div>
          <RecoverFeeNotice
            billAmount={recoverBillAmount}
            chainId={deployment.chainId}
            gasMode={recoverGasMode}
          />
        </StepCard>

        {/* ② 受取先: 受取ウォレット / 店舗名 / ポスター補足文。初期設定後あまり
            変えないので折りたたみ (未設定なら開く・設定済は閉じて1行サマリ)。 */}
        <StepCard
          step={2}
          icon={Store}
          title={t('steps.receiver')}
          collapsible
          open={step2Open}
          onToggle={() => setStep2Open((o) => !o)}
          collapsedSummary={
            <Step2Summary
              storeName={settings.storeName}
              receiver={effectiveReceiver}
              fallback={t('steps.receiverNotSet')}
            />
          }
        >
          <div className="space-y-4">
            <Field label={t('receiverLabel')}>
              <AddressInput
                value={settings.receiver}
                onChange={autofill.handleManualChange}
                onResolved={handleResolved}
              />
              <ReceiverWalletChip
                canUse={autofill.canUseConnected}
                matches={autofill.matchesConnected}
                onUse={autofill.useConnectedWallet}
                useLabel={t('useConnectedWallet')}
                matchLabel={t('receiverMatchesWallet')}
              />
              {settings.receiver &&
                !receiverValid &&
                !isLikelyName(settings.receiver) && (
                  <p className="mt-1 text-xs text-red-600">
                    {t('addressInvalid')}
                  </p>
                )}
              {/* a1 利用料の注記: 受取先が接続ウォレットと違うとき、ガスレス利用料の請求/支払いは
                  その受取先アドレスでサインインする必要がある (請求は着金先に紐づくため)。a1 点灯時のみ。 */}
              {env.enableUsageFee &&
                autofill.canUseConnected &&
                effectiveReceiver && (
                  <p className="mt-1 text-xs text-amber-700">
                    {tFee('receiverMismatchNote')}
                  </p>
                )}
              {/* 受取先確定後に Explorer の /address/ へ link (チェーン上が source of
                  truth であることを店主に毎回視認させる)。 */}
              {effectiveReceiver && (
                <a
                  href={addressExplorerUrl(deployment.chainId, effectiveReceiver)}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="mt-2 inline-flex text-xs text-brand underline underline-offset-2 hover:opacity-80"
                >
                  {t('merchantExplorerLink', { chainName: chain.name })}
                </a>
              )}
            </Field>

            <Field label={t('storeNameLabel')}>
              <input
                type="text"
                value={settings.storeName}
                onChange={(e) =>
                  setSettings((s) => ({ ...s, storeName: e.target.value }))
                }
                placeholder={t('storeNamePlaceholder')}
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-brand focus:outline-none"
                maxLength={STORE_NAME_MAX}
              />
            </Field>

            <Field label={t('posterNoteLabel')}>
              <input
                type="text"
                value={settings.posterNote}
                onChange={(e) =>
                  setSettings((s) => ({ ...s, posterNote: e.target.value }))
                }
                placeholder={t('posterNotePlaceholder')}
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-brand focus:outline-none"
                maxLength={POSTER_NOTE_MAX}
              />
            </Field>
          </div>
        </StepCard>

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

            <SettingsAccordion
              open={accordionOpen}
              onToggle={() => setAccordionOpen((o) => !o)}
              summaryLabel={t('advancedSettings')}
              summary={
                <SettingsSummary
                  gasMode={effectiveGasMode}
                  payMode={payMode}
                  showGasMode={!hideGasMode}
                  jpycRecover={isJpycRecover}
                />
              }
            >
              <Field label={t('payModeLabel')}>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {(['gasless', 'standard'] as PayMode[]).map((pm) => {
                    const active = settings.payMode === pm;
                    const isGasless = pm === 'gasless';
                    const ModeIcon = isGasless ? Zap : Fuel;
                    const iconColor = isGasless ? 'text-emerald-600' : 'text-amber-600';
                    // gasless 非対応 chain (paymasterMode=unavailable) では gasless
                    // button を disable。click は selectChain 側で防御済だが、UI
                    // 上でも明示的に grey-out して standard 強制を視覚化する。
                    const disabled = isGasless && !isGaslessSupported(deployment);
                    return (
                      <button
                        key={pm}
                        type="button"
                        disabled={disabled}
                        aria-disabled={disabled}
                        onClick={() => {
                          if (disabled) return;
                          setSettings((s) => ({ ...s, payMode: pm }));
                        }}
                        className={`rounded-lg border px-3 py-3 text-left text-sm transition ${
                          disabled
                            ? 'cursor-not-allowed border-slate-200 bg-slate-50 text-slate-500'
                            : active
                            ? 'border-brand bg-brand/5 text-brand-dark'
                            : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'
                        }`}
                      >
                        <div className="flex items-center gap-2 font-semibold">
                          <ModeIcon
                            className={`h-4 w-4 flex-none ${iconColor}`}
                            aria-hidden
                          />
                          <span>
                            {isGasless
                              ? t('payModeGaslessTitle')
                              : t('payModeStandardTitle')}
                          </span>
                          {isGasless && (
                            <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-700">
                              {t('payModeGaslessBadge')}
                            </span>
                          )}
                        </div>
                        <div className="mt-0.5 text-xs text-slate-500">
                          {isGasless
                            ? t('payModeGaslessDesc')
                            : t('payModeStandardDesc')}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </Field>

              {isStandard ? (
                <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-3 text-xs text-amber-800">
                  {t('standardHint')}
                </div>
              ) : isJpycRecover ? (
                // JPYC recover は店舗が手数料を吸収する固定モデル (per-QR トグル撤去)。
                // 利用料の開示は直上 payModeGaslessDesc が担うため固定ヒントは出さない
                // (2026-07 user 指示で撤去)。gas トグルを出さない分岐だけ維持する。
                null
              ) : !hideGasMode ? (
                <Field label={t('gasLabel')}>
                  <div className="grid grid-cols-2 gap-2">
                    {(['customer', 'merchant'] as GasMode[]).map((g) => {
                      const active = settings.gasMode === g;
                      return (
                        <button
                          key={g}
                          type="button"
                          onClick={() =>
                            setSettings((s) => ({ ...s, gasMode: g }))
                          }
                          className={`rounded-lg border px-3 py-3 text-left text-sm transition ${
                            active
                              ? 'border-brand bg-brand/5 text-brand-dark'
                              : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'
                          }`}
                        >
                          <div className="font-semibold">
                            {g === 'customer'
                              ? t('gasCustomerTitle')
                              : t('gasMerchantTitle')}
                          </div>
                          <div className="mt-0.5 text-xs text-slate-500">
                            {g === 'customer'
                              ? t('gasCustomerDesc')
                              : t('gasMerchantDesc')}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </Field>
              ) : null}

              {!isStandard && (
                <SplitEditor
                  splits={settings.splits}
                  max={SPLIT_MAX_ENTRIES}
                  sum={splitParsed.sum}
                  error={splitParsed.error}
                  summaryCount={splitsForUrl ? splitsForUrl.length : null}
                  onUpdate={updateSplit}
                  onAdd={addSplit}
                  onRemove={removeSplit}
                />
              )}

              {/* Cross-chain 受信許可 toggle (USDC のみ意味あり、JPYC では disable)。
                  Default ON。Off にすると PaymentForm が代替経路 hint を出さない
                  (店主が「同一 chain で受け取りたい」と明示する用途)。 */}
              {settings.token === 'usdc' && (
                <AdvancedSection label={t('crossChainHeading')}>
                  <label className="flex cursor-pointer items-start gap-3">
                    <input
                      type="checkbox"
                      checked={settings.crossChain}
                      onChange={(e) =>
                        setSettings((s) => ({
                          ...s,
                          crossChain: e.target.checked,
                        }))
                      }
                      className="mt-0.5 h-4 w-4 rounded border-slate-300"
                    />
                    <span className="text-xs">
                      <span className="font-semibold text-slate-700">
                        {t('crossChainToggleLabel')}
                      </span>
                      <span className="block text-slate-500">
                        {t('crossChainToggleDescription')}
                      </span>
                    </span>
                  </label>
                </AdvancedSection>
              )}

              {/* fee=0 のため徴収先 section は撤去 (Phase 1 alpha)。 */}
            </SettingsAccordion>

        {/* A2HS 導線: 初回 QR モーダルを開いた後 (ピークモーメント) にだけ出す。
            standalone / dismiss 済では PwaInstallHint 側で自動非表示。 */}
        {hasOpenedQr && (
          <PwaInstallHint
            title={t('installHintTitle')}
            iosStep3={t('installHintIosStep3')}
          />
        )}
      </div>

      <div className="space-y-4 print:hidden lg:sticky lg:top-20">
        <StepCard
          step={3}
          icon={QrCodeIcon}
          title={t('steps.qr')}
          variant="qr-prominent"
        >
          <p className="-mt-2 mb-3 text-xs text-slate-500">
            {t('qrDescription')}
          </p>
          <div className="flex flex-col items-center gap-4">
            {payUrl ? (
              // 即時表示せず、目立つボタン → 全画面モーダルで提示 (店員が金額を確認
              // してからお客様に画面を見せる対面フロー)。
              // ボタンは lg (右サイドバー) のみ表示。モバイルは下部固定バーが担うので
              // ここでは出さず、「QRコードを表示する」が2つ並ぶのを防ぐ (誘導文だけ出す)。
              <>
                <button
                  type="button"
                  onClick={() => setQrModalOpen(true)}
                  className="hidden w-full items-center justify-center gap-2 rounded-xl bg-brand px-5 py-4 text-base font-bold text-white shadow-card transition hover:-translate-y-0.5 hover:bg-brand-dark hover:shadow-card-hover active:translate-y-0 lg:inline-flex"
                >
                  <QrCodeIcon className="h-5 w-5" aria-hidden />
                  {t('showQr')}
                </button>
                <p className="text-center text-sm text-slate-500 lg:hidden">
                  {t('qrMobileBarHint')}
                </p>
              </>
            ) : receiverValid && amountValid ? (
              // receiver + amount valid だが payUrl 未確定の遷移状態 (origin 空 = SSR /
              // hydrate 直後の数フレーム間)。「生成中」で混乱を回避する。
              <p className="rounded-lg bg-slate-50 px-4 py-6 text-sm text-slate-500">
                {t('qrPlaceholderGenerating')}
              </p>
            ) : (
              <QrEmptyState
                title={t('qrEmptyState.title')}
                needLabel={t('qrEmptyState.needLabel')}
                items={[
                  {
                    label: t('qrEmptyState.needAmount'),
                    done: amountValid,
                  },
                  {
                    label: t('qrEmptyState.needAddress'),
                    done: receiverValid,
                  },
                ]}
                // 受取先は済だが金額が空のとき、サンプル金額ワンタップで
                // 最初の QR を出して操作感を掴ませる導線。
                sample={
                  receiverValid && !amountValid
                    ? {
                        label: t('qrEmptyState.trySample', {
                          amount: settings.token === 'usdc' ? '5' : '1000',
                        }),
                        onUse: () =>
                          setAmount(settings.token === 'usdc' ? '5' : '1000'),
                      }
                    : undefined
                }
              />
            )}
          </div>
        </StepCard>
      </div>

      {/* 全画面プレビュー (ポスター調 + 印刷/コピー/SVG/PNG + × 閉じる)。決済QR/レジ共通。 */}
      {payUrl && (
        <QrPreviewModal
          open={qrModalOpen}
          onClose={() => setQrModalOpen(false)}
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
            pegPill: t('posterPegPill'),
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
                : t('posterPayModeStandard', {
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
      {payUrl && (
        <div
          ref={bottomBarRef}
          className="sticky bottom-14 z-20 -mx-4 flex items-center gap-3 border-t border-slate-200/80 bg-white/95 px-4 py-3 shadow-[0_-6px_20px_-6px_rgba(15,23,42,0.14)] backdrop-blur md:bottom-0 lg:hidden print:hidden"
        >
          <div className="min-w-0 flex-1">
            <div className="text-[11px] text-slate-500">
              {t('bottomAmountLabel')}
            </div>
            <div className="flex items-baseline gap-2">
              <span className="truncate font-mono text-lg font-bold text-slate-900">
                {amountLabelText}
              </span>
              {fiatHint && (
                <span className="shrink-0 text-xs font-medium text-slate-500">
                  {fiatHint}
                </span>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={() => setQrModalOpen(true)}
            className="inline-flex shrink-0 items-center justify-center gap-2 rounded-xl bg-brand px-5 py-3 text-base font-bold text-white shadow-card transition hover:-translate-y-0.5 hover:bg-brand-dark hover:shadow-card-hover active:translate-y-0"
          >
            <QrCodeIcon className="h-5 w-5" aria-hidden />
            {t('showQr')}
          </button>
        </div>
      )}
      </div>
    </>
  );
}

// ② 受取先を折りたたんだ時の 1 行サマリ。設定済なら「店舗名 · 0x1234…abcd」、
// 未設定なら fallback 文言。
function Step2Summary({
  storeName,
  receiver,
  fallback,
}: {
  storeName: string;
  receiver: Address | null;
  fallback: string;
}) {
  if (!receiver) return <span>{fallback}</span>;
  const addr = shortAddress(receiver);
  const name = storeName.trim();
  return <span className="font-mono">{name ? `${name} · ${addr}` : addr}</span>;
}

// 必要な項目を checkmark 付きで明示する empty state。初見店主が「何を
// 入れれば QR が出るか」を一目で理解できるようにする (review #2 + #8)。
function QrEmptyState({
  title,
  needLabel,
  items,
  sample,
}: {
  title: string;
  needLabel: string;
  items: { label: string; done: boolean }[];
  // 受取先は済だが金額未入力のとき、サンプル金額ワンタップで最初の QR を出す導線。
  sample?: { label: string; onUse: () => void };
}) {
  return (
    <div className="flex w-full max-w-xs flex-col items-center gap-3 rounded-lg bg-slate-50 px-4 py-6 text-center">
      <p className="text-sm font-medium text-slate-700">{title}</p>
      <div className="w-full">
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
          {needLabel}
        </p>
        <ul className="space-y-1.5 text-left">
          {items.map((item) => (
            <li
              key={item.label}
              className="flex items-center gap-2 text-sm"
            >
              <span
                aria-hidden
                className={`inline-flex h-4 w-4 flex-none items-center justify-center rounded-full text-[10px] font-bold ${
                  item.done
                    ? 'bg-emerald-500 text-white'
                    : 'border border-slate-300 bg-white text-slate-500'
                }`}
              >
                {item.done ? '✓' : ''}
              </span>
              <span className={item.done ? 'text-slate-500 line-through' : 'text-slate-700'}>
                {item.label}
              </span>
            </li>
          ))}
        </ul>
      </div>
      {sample && (
        <button
          type="button"
          onClick={sample.onUse}
          className="rounded-lg border border-brand/40 bg-brand/5 px-3 py-1.5 text-xs font-semibold text-brand-dark hover:border-brand"
        >
          {sample.label}
        </button>
      )}
    </div>
  );
}

function SettingsAccordion({
  open,
  onToggle,
  summary,
  summaryLabel,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  summary: React.ReactNode;
  summaryLabel: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl bg-white shadow-card ring-1 ring-slate-200/70">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
      >
        <div className="flex flex-1 flex-col">
          <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            {summaryLabel}
          </span>
          {!open && (
            <span className="mt-0.5 text-xs text-slate-600">{summary}</span>
          )}
        </div>
        <ChevronDown
          className={`h-4 w-4 flex-none text-slate-500 transition-transform duration-200 ${
            open ? 'rotate-180' : ''
          }`}
          aria-hidden
        />
      </button>
      {open && (
        <div className="space-y-4 border-t border-slate-200 px-4 py-4">
          {children}
        </div>
      )}
    </div>
  );
}

function SettingsSummary({
  gasMode,
  payMode,
  showGasMode,
  jpycRecover,
}: {
  gasMode: GasMode;
  payMode: PayMode;
  // 負担者 (顧客/店主) を summary にトグル選択として出すのは USDC recover 等のみ。
  // free (概念なし) / JPYC recover (merchant 固定) では選択トグルを出さない。
  showGasMode: boolean;
  // JPYC recover (確定モデルで店舗が手数料を吸収する固定) のとき true。固定であることを
  // 明示する専用ラベルを出す (USDC のトグル選択 merchant とは文言を分ける)。
  jpycRecover: boolean;
}) {
  // 高度な設定 accordion 内には payMode / gas / split のみ (quickAmount は Step ①、
  // 手数料徴収先は fee=0 のため撤去済)。summary では payMode (+ 負担者) を日本語/英語の
  // 自然文で表示する。token / chain は Step 1、receiver は Step 2 summary に出るので
  // ここでは重複させない。font-mono は外し、開発者向け内部値に見えないようにする。
  const t = useTranslations('QrGenerator');
  const label =
    payMode === 'standard'
      ? t('advancedSummary.standard')
      : jpycRecover
        ? t('advancedSummary.gaslessMerchantFixed')
        : !showGasMode
          ? t('advancedSummary.gaslessFree')
          : gasMode === 'customer'
            ? t('advancedSummary.gaslessCustomerGas')
            : t('advancedSummary.gaslessMerchantGas');
  return <span>{label}</span>;
}

function AdvancedSection({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="border-t border-dashed border-slate-200 pt-3">
      <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
        {label}
      </p>
      {children}
    </div>
  );
}
