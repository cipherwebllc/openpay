'use client';

import { useEffect, useMemo, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { AlertTriangle, Loader2, X } from 'lucide-react';
import { useAccount, useSwitchChain } from 'wagmi';
import { ConnectButton } from '@/components/ConnectButton';
import { formatUnits } from 'viem';
import { hostedPurchaseFeeValue } from '@/lib/x402/hostedPurchaseWire';
import { STORE_REPORT_EMAIL } from '@/lib/x402/storeMeta';
import type { Address } from 'viem';
import { CreatorStorePurchaseConfirmation } from '@/components/CreatorStorePurchaseConfirmation';
import { CreatorStorePurchaseState } from '@/components/CreatorStorePurchaseState';
import { useHostedStorePurchase } from '@/hooks/useHostedStorePurchase';
import { useSiweSession } from '@/hooks/useSiweSession';
import { useStoreCacheScope } from '@/hooks/useStoreCacheScope';
import { buildHostedPurchaseSignPreview } from '@/lib/x402/hostedPurchaseWire';

export type CreatorStorePurchaseFlowProps = {
  open: boolean;
  product: {
    id: string;
    title: string;
    description?: string;
    imageUrl?: string;
    galleryUrls?: readonly string[];
    priceJpyc: string;
    merchant: Address;
  };
  sellerDisclosureHref: string;
  onClose: () => void;
};

export function CreatorStorePurchaseFlow({
  open,
  product,
  sellerDisclosureHref,
  onClose,
}: CreatorStorePurchaseFlowProps) {
  const t = useTranslations('CreatorStorePurchase');
  const locale = useLocale();
  const { address } = useAccount();
  const { switchChainAsync, isPending: isSwitchingChain } = useSwitchChain();
  const {
    isSignedIn,
    mismatch,
    sessionAddress,
    signIn,
    isSigningIn,
    signInError,
  } = useSiweSession();
  useStoreCacheScope(sessionAddress);
  const buyer = useHostedStorePurchase({
    resourceId: product.id,
    merchant: product.merchant,
    priceJpyc: product.priceJpyc,
    sessionAddress,
  });
  const [flowError, setFlowError] = useState<Error | null>(null);
  const [previewNowSec, setPreviewNowSec] = useState(() =>
    Math.floor(Date.now() / 1000),
  );

  // absolute server deadline を「quote取得時から10分」と誇張しない。review を開いたまま、
  // または閉じて再開した場合も、表示期限を現在時刻へ追随させる。
  useEffect(() => {
    if (!open || buyer.quote === null || buyer.phase !== 'review') return;
    const refreshPreviewClock = () => {
      setPreviewNowSec(Math.floor(Date.now() / 1000));
    };
    refreshPreviewClock();
    const interval = window.setInterval(refreshPreviewClock, 30_000);
    return () => window.clearInterval(interval);
  }, [open, buyer.quote, buyer.phase]);

  // reopen の最初の paint でも、停止中の ticker 値をそのまま見せない。
  const effectivePreviewNowSec = Math.max(
    previewNowSec,
    Math.floor(Date.now() / 1000),
  );
  const signPreview = useMemo(
    () =>
      buyer.quote
        ? buildHostedPurchaseSignPreview(
            buyer.quote,
            undefined,
            effectivePreviewNowSec,
          )
        : null,
    [buyer.quote, effectivePreviewNowSec],
  );

  if (!open) return null;

  const closeAndResetReview = () => {
    buyer.reset();
    setFlowError(null);
    onClose();
  };

  const signInForPurchase = () => {
    setFlowError(null);
    void signIn(t('signInStatement')).catch((error: unknown) => {
      setFlowError(
        error instanceof Error ? error : new Error(String(error)),
      );
    });
  };

  const prepareReview = () => {
    setFlowError(null);
    void buyer.prepare().catch((error: unknown) => {
      setFlowError(
        error instanceof Error ? error : new Error(String(error)),
      );
    });
  };

  const confirmPurchase = () => {
    setFlowError(null);
    void buyer.purchase().catch((error: unknown) => {
      setFlowError(
        error instanceof Error ? error : new Error(String(error)),
      );
    });
  };

  const switchToRequiredChain = () => {
    if (buyer.requiredChainId === null) return;
    setFlowError(null);
    void switchChainAsync({ chainId: buyer.requiredChainId }).catch(
      (error: unknown) => {
        setFlowError(
          error instanceof Error ? error : new Error(String(error)),
        );
      },
    );
  };

  const retrySignedPayment = () => {
    setFlowError(null);
    void buyer.retry().catch((error: unknown) => {
      setFlowError(
        error instanceof Error ? error : new Error(String(error)),
      );
    });
  };

  const startOver = () => {
    buyer.reset();
    setFlowError(null);
  };

  const showConfirmation =
    buyer.quote !== null &&
    signPreview !== null &&
    (buyer.phase === 'review' ||
      buyer.phase === 'signing' ||
      buyer.phase === 'submitting') &&
    !buyer.isWrongChain;
  const showState =
    buyer.phase === 'indeterminate' ||
    buyer.phase === 'provisioning' ||
    buyer.phase === 'ready' ||
    buyer.phase === 'needs-support' ||
    buyer.phase === 'failed-prebroadcast';
  const displayedError = flowError ?? buyer.error ?? signInError;

  return (
    <div
      className="fixed inset-0 z-[70] overflow-y-auto bg-slate-950/55 px-3 py-6 backdrop-blur-sm sm:px-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="creator-store-purchase-dialog-heading"
    >
      <div className="mx-auto w-full max-w-2xl">
        <div className="mb-3 flex items-center justify-between gap-3">
          <p
            id="creator-store-purchase-dialog-heading"
            className="rounded-full bg-white px-4 py-2 text-sm font-bold text-slate-800 shadow-lg"
          >
            {t('dialogLabel')}
          </p>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex min-h-11 items-center gap-2 rounded-full bg-white px-4 py-2 text-sm font-bold text-slate-700 shadow-lg hover:bg-slate-100"
          >
            <X className="h-4 w-4" aria-hidden />
            {t('close')}
          </button>
        </div>

        {showConfirmation && buyer.quote && signPreview ? (
          <>
            {displayedError ? (
              <ErrorNotice message={t('signatureError')} />
            ) : null}
            <CreatorStorePurchaseConfirmation
              product={{
                title: product.title,
                ...(product.description
                  ? { description: product.description }
                  : {}),
              }}
              priceJpyc={buyer.quote.merchantValueJpyc}
              feeJpyc={buyer.quote.feeValueJpyc}
              totalJpyc={buyer.quote.totalValueJpyc}
              sellerDisclosureHref={sellerDisclosureHref}
              supportHref={sellerDisclosureHref}
              signPreview={signPreview}
              isSubmitting={
                buyer.phase === 'signing' || buyer.phase === 'submitting'
              }
              onBack={closeAndResetReview}
              onConfirm={confirmPurchase}
            />
          </>
        ) : showState ? (
          <div className="rounded-3xl bg-white p-5 shadow-2xl sm:p-7">
            <CreatorStorePurchaseState
              paymentStatus={buyer.paymentStatus}
              accessStatus={buyer.accessStatus}
              ownershipReadBack={
                buyer.phase === 'ready' && buyer.content !== null
              }
              libraryHref={`/${locale}/store/library`}
              supportHref={sellerDisclosureHref}
            />
            {buyer.canRetrySignedPayment ? (
              <button
                type="button"
                disabled={buyer.isBusy}
                onClick={retrySignedPayment}
                className="mt-4 min-h-11 w-full rounded-xl border border-slate-300 px-5 py-3 text-sm font-bold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {t('retrySignedPayment')}
              </button>
            ) : null}
            {buyer.phase === 'failed-prebroadcast' ? (
              <button
                type="button"
                onClick={startOver}
                className="mt-4 min-h-11 w-full rounded-xl bg-brand px-5 py-3 text-sm font-bold text-white hover:bg-brand-dark"
              >
                {t('reviewAgain')}
              </button>
            ) : null}
          </div>
        ) : buyer.phase === 'review' && buyer.isWrongChain ? (
          <div className="rounded-3xl border border-amber-200 bg-white p-6 text-center shadow-2xl sm:p-8">
            <AlertTriangle
              className="mx-auto h-9 w-9 text-amber-600"
              aria-hidden
            />
            <h2 className="mt-3 text-xl font-black text-slate-900">
              {t('switchNetworkHeading')}
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-slate-600">
              {t('switchNetworkBody')}
            </p>
            <button
              type="button"
              disabled={isSwitchingChain}
              onClick={switchToRequiredChain}
              className="mt-5 min-h-11 rounded-xl bg-brand px-5 py-3 text-sm font-bold text-white hover:bg-brand-dark disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isSwitchingChain
                ? t('switchingNetwork')
                : t('switchNetwork')}
            </button>
            {displayedError ? (
              <p className="mt-3 text-xs text-red-600">
                {t('switchNetworkError')}
              </p>
            ) : null}
          </div>
        ) : (
          // ショーケース調 (plans/store-showcase-polish.md P3): 画像をフルブリードで
          // 主役化し、見出しの重複 (dialogLabel/購入の準備/商品名) を整理 — 商品名を
          // 主見出しに昇格し「購入の準備」は eyebrow へ。説明全文をここで表示する
          // (プロフカードの line-clamp-2 の受け皿)。金額開示・CTA・通報は不変。
          <div className="overflow-hidden rounded-3xl border border-slate-200 bg-white text-center shadow-2xl">
            <CreatorStorePurchaseGallery
              key={product.id}
              imageUrl={product.imageUrl}
              galleryUrls={product.galleryUrls}
              labelledBy="creator-store-purchase-product-title"
            />
            <div className="p-6 sm:p-8">
            <p className="text-xs font-bold uppercase tracking-[0.16em] text-brand">
              {t('startHeading')}
            </p>
            <h2
              id="creator-store-purchase-product-title"
              className="mt-1.5 text-xl font-black text-slate-900"
            >
              {product.title}
            </h2>
            {product.description ? (
              <p className="mx-auto mt-3 max-w-prose whitespace-pre-wrap break-words text-left text-sm leading-relaxed text-slate-600">
                {product.description}
              </p>
            ) : null}
            {/* 買い手の意思決定基準は合計 (2026-07-31 user 裁定)。式は購入 hook の
                server quote 照合と同一関数 = 表示と実請求の乖離なし。 */}
            <p className="mt-2 text-lg font-black text-slate-900">
              {t('payTotal', {
                total: formatUnits(
                  BigInt(product.priceJpyc) * 10n ** 18n +
                    hostedPurchaseFeeValue(
                      BigInt(product.priceJpyc) * 10n ** 18n,
                    ),
                  18,
                ),
              })}
            </p>
            <p className="mt-0.5 text-xs text-slate-500">
              {t('priceBreakdown', {
                price: product.priceJpyc,
                fee: formatUnits(
                  hostedPurchaseFeeValue(
                    BigInt(product.priceJpyc) * 10n ** 18n,
                  ),
                  18,
                ),
              })}
            </p>
            {!address ? (
              <div className="mt-5 space-y-3">
                <p className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-950">
                  {t('walletRequired')}
                </p>
                {/* @handle プロフはヘッダー (AppShell) を持たない専用レイアウトのため、
                    接続導線を購入フロー内に置く (TipForm と同じ部品・2026-07-30 本番実害)。 */}
                <div className="flex justify-center">
                  <ConnectButton />
                </div>
              </div>
            ) : !isSignedIn ? (
              <button
                type="button"
                disabled={isSigningIn}
                onClick={signInForPurchase}
                className="mt-5 min-h-11 rounded-xl bg-brand px-5 py-3 text-sm font-bold text-white hover:bg-brand-dark disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isSigningIn
                  ? t('signingIn')
                  : mismatch
                    ? t('reSignIn')
                    : t('signInAndReview')}
              </button>
            ) : (
              <button
                type="button"
                disabled={buyer.phase === 'loading-quote'}
                onClick={prepareReview}
                className="mt-5 inline-flex min-h-11 items-center gap-2 rounded-xl bg-brand px-5 py-3 text-sm font-bold text-white hover:bg-brand-dark disabled:cursor-not-allowed disabled:opacity-50"
              >
                {buyer.phase === 'loading-quote' ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                ) : null}
                {buyer.phase === 'loading-quote'
                  ? t('loadingQuote')
                  : t('reviewPurchase')}
              </button>
            )}
            {displayedError ? (
              <ErrorNotice
                message={
                  isSigningIn || signInError
                    ? t('signInError')
                    : t('prepareError')
                }
              />
            ) : null}
            {/* 通報導線 (Store 統合 P2・go-live 条件 G1): UGC を横断掲載する前提として、
                権利侵害等を運営へ知らせる最小導線 (mailto・商品 ID 自動挿入)。 */}
            <p className="mt-4 text-[11px]">
              <a
                href={`mailto:${STORE_REPORT_EMAIL}?subject=${encodeURIComponent(
                  `[OpenPay Store 通報] ${product.id}`,
                )}`}
                className="text-slate-400 underline-offset-2 hover:text-slate-600 hover:underline"
              >
                {t('reportProduct')}
              </a>
            </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function CreatorStorePurchaseGallery({
  imageUrl,
  galleryUrls,
  labelledBy,
}: {
  imageUrl?: string;
  galleryUrls?: readonly string[];
  labelledBy: string;
}) {
  const images = [
    ...(imageUrl ? [{ id: 'main', url: imageUrl }] : []),
    ...(galleryUrls ?? []).map((url, index) => ({
      id: `gallery-${index}`,
      url,
    })),
  ].map((image, position) => ({ ...image, position }));
  const [selectedImageId, setSelectedImageId] = useState<string | null>(null);
  const [failedImageIds, setFailedImageIds] = useState<readonly string[]>([]);
  const visibleImages = images.filter(
    (image) => !failedImageIds.includes(image.id),
  );
  const selectedImage =
    visibleImages.find((image) => image.id === selectedImageId) ??
    visibleImages[0] ??
    null;

  const hideFailedImage = (imageId: string) => {
    // 第三者画像 1 枚の障害を残りのギャラリー表示へ波及させない。
    setFailedImageIds((current) =>
      current.includes(imageId) ? current : [...current, imageId],
    );
  };

  if (!selectedImage) return null;

  return (
    <div>
      {/* 任意の第三者 https 画像。referrerPolicy で hotlink トラッキングを抑制する。
          パネル最上部のフルブリード (P3 ショーケース化・角丸は親の overflow-hidden)。 */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={selectedImage.url}
        alt=""
        aria-hidden
        width={640}
        height={360}
        referrerPolicy="no-referrer"
        className="aspect-[16/9] max-h-80 w-full bg-slate-100 object-cover"
        onError={() => hideFailedImage(selectedImage.id)}
      />
      {visibleImages.length >= 2 ? (
        <div
          role="group"
          aria-labelledby={labelledBy}
          className="mt-3 flex flex-wrap justify-center gap-2 px-4"
        >
          {visibleImages.map((image) => {
            const selected = image.id === selectedImage.id;
            return (
              <button
                key={image.id}
                type="button"
                aria-pressed={selected}
                onClick={() => setSelectedImageId(image.id)}
                className={`rounded-xl border bg-white p-1 transition-colors focus:outline-none focus:ring-2 focus:ring-brand/40 ${
                  selected
                    ? 'border-brand text-brand-dark ring-2 ring-brand/30'
                    : 'border-slate-200 text-slate-500 hover:border-slate-300'
                }`}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={image.url}
                  alt=""
                  aria-hidden
                  width={48}
                  height={48}
                  referrerPolicy="no-referrer"
                  loading="lazy"
                  className="h-12 w-12 rounded-lg object-cover"
                  onError={() => hideFailedImage(image.id)}
                />
                {/* 掟 8: button の a11y 名は aria-label ではなく、この可視番号から導出する。 */}
                <span className="mt-0.5 block text-center text-[10px] font-bold">
                  {image.position + 1}
                </span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function ErrorNotice({ message }: { message: string }) {
  return (
    <p
      role="alert"
      className="mb-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-800"
    >
      {message}
    </p>
  );
}
