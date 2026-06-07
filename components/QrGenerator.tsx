'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import type { Address } from 'viem';
import {
  ChevronRight,
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
import { ChainChooser } from './ChainChooser';
import { TokenChooser } from './TokenChooser';
import { Field } from './Field';
import { StepCard } from './StepCard';
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
  defaultConvertChainSlug,
  DEFAULT_CHAIN_FOR_SYMBOL,
  defaultDeploymentForSymbol,
  deploymentForSlug,
  displaySymbolFor,
  isGaslessSupported,
  type TokenSymbol,
} from '@/lib/tokens';
import {
  convertAnchorAmount,
  formatRemaining,
  isExpired,
  QR_EXPIRY_SECONDS,
  rateIsSane,
  secondsRemaining,
} from '@/lib/fx';
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
import { pickEffectiveAddress, shortAddress } from '@/lib/format';
import { normalizeAmountList, truncateAmount } from '@/lib/amount';
import { triggerDownload } from '@/lib/download';

type Mode = 'amount' | 'static';

// 「他トークン建てで受け取る」(FX 換算) を適用した状態。生成時のレートで amount を
// 確定済みなので、元の価格 (anchor) と適用レート・有効期限を保持し URL に焼き込む。
// localStorage には永続化しない (時限的なので、ページ再訪で期限切れ QR を復元しない)。
type ConvertState = {
  anchorAmount: string;
  anchorSymbol: TokenSymbol;
  anchorChain: ChainSlug;
  // convert 前の payMode (revert で復元する。convert で gasless 非対応 chain に
  // 倒れて standard 強制された場合に元へ戻すため)。
  anchorPayMode: PayMode;
  fxRate: string;
  expiresAt: number; // unix 秒
};

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

  const t = useTranslations('QrGenerator');
  // 管理番号 (レシート番号) はトランザクション固有なので settings に永続せず local state。
  const [receiptNo, setReceiptNo] = useState('');

  // 「他トークン建てで受け取る」用の為替レート (USDC→JPY)。convert 押下時に参照。
  const { data: marketRates } = useMarketRates();
  // convert 適用状態 (null = 通常 QR)。
  const [convert, setConvert] = useState<ConvertState | null>(null);
  // convert 中のみ 1 秒刻みで進める now (カウントダウン用)。convert null では更新しない。
  const [convertNowMs, setConvertNowMs] = useState(0);

  useEffect(() => {
    if (!convert) return;
    setConvertNowMs(Date.now());
    const id = setInterval(() => setConvertNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [convert]);

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

  const payUrl = useMemo(() => {
    if (!hydrated || !effectiveReceiver || !origin || !amountValid) return '';
    const params: PayParams = {
      to: effectiveReceiver,
      token: settings.token,
      chain: settings.chain,
      // free 経路 (JPYC relay・無徴収) では負担者の概念が無いため customer 固定。
      gas: isFreeGasless ? 'customer' : settings.gasMode,
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
    settings.gasMode,
    isFreeGasless,
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
    const parts = [
      fileSafe(settings.storeName),
      settings.token,
      settings.chain,
      mode === 'amount' && amount ? amount.replace('.', '-') : 'open',
    ];
    return parts.join('-');
  }, [settings.storeName, settings.token, settings.chain, mode, amount]);

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
    setConvert(null);
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
  const convertRemaining = convert
    ? secondsRemaining(convert.expiresAt, convertNowMs)
    : 0;
  const convertExpired = convert
    ? isExpired(convert.expiresAt, convertNowMs)
    : false;
  const convertAnchorDisplay = convert
    ? displaySymbolFor(convert.anchorSymbol)
    : convertTargetDisplay;

  // 店主の価格入力を現レートで換算し、token を換算先へ切替・amount を確定・期限を焼き込む。
  function applyConvert() {
    if (!marketRates || !rateIsSane(marketRates.usdcJpy)) return;
    const target = counterpartSymbol(settings.token);
    const res = convertAnchorAmount({
      anchorAmount: amount,
      anchorSymbol: settings.token,
      targetSymbol: target,
      usdcJpy: marketRates.usdcJpy,
    });
    if (!res.ok) return;
    const targetChain = defaultConvertChainSlug(settings.chain, target);
    const dep = deploymentForSlug(target, targetChain);
    // convert と同時に nowMs を実時刻にして、初回描画で残り時間が巨大値で
    // フラッシュするのを防ぐ (effect も後追いで更新する)。
    setConvertNowMs(Date.now());
    setConvert({
      anchorAmount: amount,
      anchorSymbol: settings.token,
      anchorChain: settings.chain,
      anchorPayMode: settings.payMode,
      fxRate: String(marketRates.usdcJpy),
      expiresAt: Math.floor(Date.now() / 1000) + QR_EXPIRY_SECONDS,
    });
    setSettings((s) => ({
      ...s,
      token: target,
      chain: targetChain,
      // 換算先が gasless 非対応 chain なら standard に倒す (URL parser reject 回避)。
      payMode: isGaslessSupported(dep) ? s.payMode : 'standard',
    }));
    setAmount(res.amount);
  }

  // 同じ anchor 価格を最新レートで再換算し、期限を 3 分リセット (token は据え置き)。
  function recalcConvert() {
    if (!convert || !marketRates || !rateIsSane(marketRates.usdcJpy)) return;
    const res = convertAnchorAmount({
      anchorAmount: convert.anchorAmount,
      anchorSymbol: convert.anchorSymbol,
      targetSymbol: settings.token,
      usdcJpy: marketRates.usdcJpy,
    });
    if (!res.ok) return;
    setConvertNowMs(Date.now());
    setConvert({
      ...convert,
      fxRate: String(marketRates.usdcJpy),
      expiresAt: Math.floor(Date.now() / 1000) + QR_EXPIRY_SECONDS,
    });
    setAmount(res.amount);
  }

  // 元の価格建て (anchor token + chain + amount + payMode) に戻す。
  function revertConvert() {
    if (!convert) return;
    const { anchorAmount, anchorSymbol, anchorChain, anchorPayMode } = convert;
    setConvert(null);
    setSettings((s) => ({
      ...s,
      token: anchorSymbol,
      chain: anchorChain,
      payMode: anchorPayMode,
    }));
    setAmount(anchorAmount);
  }

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

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_minmax(300px,360px)] lg:items-start print:block print:gap-0">
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
                        setConvert(null);
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
                    <input
                      type="text"
                      inputMode="decimal"
                      value={amount}
                      onChange={(e) => {
                        setAmount(truncateAmount(e.target.value, deployment.decimals));
                        setConvert(null);
                      }}
                      placeholder={settings.token === 'jpyc' ? '1000' : '10.00'}
                      className="w-full rounded-lg border border-slate-300 bg-white px-3 py-3 text-3xl font-bold focus:border-brand focus:outline-none"
                      autoFocus
                    />
                    {activeQuickAmounts.length > 0 && (
                      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                        {activeQuickAmounts.map((q) => (
                          <button
                            key={q}
                            type="button"
                            onClick={() => {
                              setAmount(q);
                              setConvert(null);
                            }}
                            className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:border-brand hover:text-brand-dark"
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
              <details className="group rounded-2xl border border-slate-200 bg-white p-4">
                <summary className="flex cursor-pointer list-none items-center justify-between text-sm font-medium text-slate-700">
                  <span>{t('quickAmountsLabel')}</span>
                  <ChevronRight
                    className="h-4 w-4 text-slate-400 transition-transform group-open:rotate-90"
                    aria-hidden
                  />
                </summary>
                <div className="mt-3 space-y-2">
                  {tokenQuickAmounts.map((q, i) => (
                    <div key={i} className="flex gap-2">
                      <input
                        type="text"
                        inputMode="decimal"
                        value={q}
                        onChange={(e) => updateQuickAmount(i, e.target.value)}
                        placeholder={t('quickAmountPlaceholder')}
                        className="min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-brand focus:outline-none"
                      />
                      <button
                        type="button"
                        onClick={() => removeQuickAmount(i)}
                        aria-label={t('quickAmountRemove')}
                        className="rounded-md border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-500 hover:border-red-300 hover:text-red-600"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                  {tokenQuickAmounts.length < QUICK_AMOUNT_MAX && (
                    <button
                      type="button"
                      onClick={addQuickAmount}
                      className="mt-1 rounded-md border border-dashed border-slate-300 px-3 py-1.5 text-xs text-slate-600 hover:border-brand hover:text-brand-dark"
                    >
                      {t('quickAmountAdd')}
                    </button>
                  )}
                </div>
              </details>
            )}

            {/* 他トークン建てで受け取る (FX 換算・有効期限付き動的 QR)。
                例: JPYC 1000 入力 → USDC 建てで受け取る → 現レートで USDC 額を確定し
                3 分間有効な QR を生成。スワップ無し (顧客が払った USDC をそのまま受領)。 */}
            {canShowConvert && rateOk && (
              <button
                type="button"
                onClick={applyConvert}
                className="w-full rounded-lg border border-brand/40 bg-brand/5 px-3 py-2.5 text-sm font-semibold text-brand-dark transition hover:bg-brand/10"
              >
                {t('convertButton', { symbol: convertTargetDisplay })}
              </button>
            )}
            {canShowConvert && !rateOk && (
              <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-400">
                {t('convertRateUnavailable')}
              </p>
            )}
            {convert && (
              <div
                className={`space-y-1.5 rounded-lg border px-3 py-3 ${
                  convertExpired
                    ? 'border-amber-300 bg-amber-50'
                    : 'border-emerald-200 bg-emerald-50'
                }`}
              >
                <p className="text-sm font-semibold text-slate-800">
                  {t('convertActiveSummary', {
                    anchorAmount: convert.anchorAmount,
                    anchorSymbol: convertAnchorDisplay,
                    amount,
                    symbol: deployment.displaySymbol,
                  })}
                </p>
                <p className="text-xs text-slate-600">
                  {t('convertRate', { rate: convert.fxRate })}
                </p>
                {convertExpired ? (
                  <p className="text-xs font-medium text-amber-700">
                    {t('convertExpired')}
                  </p>
                ) : (
                  <p className="text-xs text-slate-600">
                    {t('convertRemaining', {
                      time: formatRemaining(convertRemaining),
                    })}
                  </p>
                )}
                {settings.token === 'usdc' && (
                  <p className="text-xs text-slate-500">
                    {t('convertCrossChainNote')}
                  </p>
                )}
                <div className="flex flex-wrap gap-2 pt-1">
                  <button
                    type="button"
                    onClick={recalcConvert}
                    className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:border-brand hover:text-brand-dark"
                  >
                    {t('convertRecalc')}
                  </button>
                  <button
                    type="button"
                    onClick={revertConvert}
                    className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:border-brand hover:text-brand-dark"
                  >
                    {t('convertRevert', { symbol: convertAnchorDisplay })}
                  </button>
                </div>
              </div>
            )}
          </div>
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
                  gasMode={settings.gasMode}
                  payMode={payMode}
                  showGasMode={!isFreeGasless}
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
                            ? 'cursor-not-allowed border-slate-200 bg-slate-50 text-slate-400'
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
              ) : !isFreeGasless ? (
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
                <Field
                  label={t('splitLabel', {
                    primaryPercent: 100 - splitParsed.sum,
                  })}
                >
                  <p className="mb-2 text-xs text-slate-500">
                    {t('splitDescription', { max: SPLIT_MAX_ENTRIES })}
                  </p>
                  <div className="space-y-2">
                    {settings.splits.map((s, i) => (
                      <div key={i} className="flex flex-wrap items-start gap-2">
                        <input
                          type="text"
                          value={s.address}
                          onChange={(e) =>
                            updateSplit(i, { address: e.target.value.trim() })
                          }
                          placeholder="0x..."
                          className="min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-xs focus:border-brand focus:outline-none"
                          spellCheck={false}
                          autoCapitalize="off"
                          autoCorrect="off"
                        />
                        <input
                          type="text"
                          inputMode="numeric"
                          value={s.percent}
                          onChange={(e) =>
                            updateSplit(i, {
                              percent: e.target.value.replace(/[^\d]/g, ''),
                            })
                          }
                          placeholder="%"
                          className="w-16 rounded-lg border border-slate-300 bg-white px-2 py-2 text-center text-sm focus:border-brand focus:outline-none"
                          maxLength={2}
                          aria-label={t('splitPercentLabel')}
                        />
                        <button
                          type="button"
                          onClick={() => removeSplit(i)}
                          aria-label={t('splitRemove')}
                          className="rounded-md border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-500 hover:border-red-300 hover:text-red-600"
                        >
                          ×
                        </button>
                      </div>
                    ))}
                  </div>
                  {settings.splits.length < SPLIT_MAX_ENTRIES && (
                    <button
                      type="button"
                      onClick={addSplit}
                      className="mt-2 rounded-md border border-dashed border-slate-300 px-3 py-1.5 text-xs text-slate-600 hover:border-brand hover:text-brand-dark"
                    >
                      {t('splitAdd')}
                    </button>
                  )}
                  {splitParsed.error && (
                    <p className="mt-2 text-xs text-red-600">
                      {t(`splitError.${splitParsed.error}`)}
                    </p>
                  )}
                  {splitsForUrl && splitsForUrl.length > 0 && (
                    <p className="mt-2 text-xs text-emerald-700">
                      {t('splitSummary', {
                        count: splitsForUrl.length,
                        primaryPercent: 100 - splitParsed.sum,
                      })}
                    </p>
                  )}
                </Field>
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
                  className="hidden w-full items-center justify-center gap-2 rounded-xl bg-brand px-5 py-4 text-base font-bold text-white shadow-sm transition hover:bg-brand-dark lg:inline-flex"
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
              <p className="rounded-lg bg-slate-50 px-4 py-6 text-sm text-slate-400">
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
          }}
          qrValue={payUrl}
          qrRef={qrRef}
          storeName={settings.storeName.trim() || t('posterDefaultStoreName')}
          amountText={
            mode === 'amount'
              ? t('posterFixedAmount', {
                  amount,
                  symbol: deployment.displaySymbol,
                })
              : t('posterOpenAmount', { symbol: deployment.displaySymbol })
          }
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
          chainText={`${deployment.displaySymbol} · ${
            settings.token === 'usdc' && settings.crossChain
              ? buyerUsdcChainNames().join(' / ')
              : chain.name
          }`}
          receiverShort={
            effectiveReceiver ? shortAddress(effectiveReceiver) : ''
          }
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
          className="sticky bottom-14 z-20 -mx-4 flex items-center gap-3 border-t border-slate-200 bg-white px-4 py-3 shadow-[0_-1px_4px_rgba(0,0,0,0.04)] md:bottom-0 lg:hidden print:hidden"
        >
          <div className="min-w-0 flex-1">
            <div className="text-[11px] text-slate-400">
              {t('bottomAmountLabel')}
            </div>
            <div className="truncate font-mono text-lg font-bold text-slate-900">
              {mode === 'amount'
                ? t('posterFixedAmount', {
                    amount,
                    symbol: deployment.displaySymbol,
                  })
                : t('posterOpenAmount', { symbol: deployment.displaySymbol })}
            </div>
          </div>
          <button
            type="button"
            onClick={() => setQrModalOpen(true)}
            className="inline-flex shrink-0 items-center justify-center gap-2 rounded-xl bg-brand px-5 py-3 text-base font-bold text-white shadow-sm transition hover:bg-brand-dark"
          >
            <QrCodeIcon className="h-5 w-5" aria-hidden />
            {t('showQr')}
          </button>
        </div>
      )}
    </div>
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
                    : 'border border-slate-300 bg-white text-slate-400'
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
    <div className="rounded-xl border border-slate-200 bg-white">
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
        <span className="text-slate-400" aria-hidden>
          {open ? '▲' : '▼'}
        </span>
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
}: {
  gasMode: GasMode;
  payMode: PayMode;
  // 負担者 (顧客/店主) を summary に出すのは recover 有効時のみ。free / USDC では
  // 負担者の概念が無いため、ガスレスは「OpenPay がガス負担」一本で表示する。
  showGasMode: boolean;
}) {
  // 高度な設定 accordion 内には payMode / gas / split のみ (quickAmount は Step ①、
  // 手数料徴収先は fee=0 のため撤去済)。summary では payMode (+ recover 有効時のみ gas
  // 負担者) を日本語/英語の自然文で表示する。token / chain は Step 1、receiver は
  // Step 2 summary に出るのでここでは重複させない。font-mono は外し、開発者向け
  // 内部値に見えないようにする。
  const t = useTranslations('QrGenerator');
  const label =
    payMode === 'standard'
      ? t('advancedSummary.standard')
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
      <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
        {label}
      </p>
      {children}
    </div>
  );
}
