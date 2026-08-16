'use client';

// 「プロフ」タブ内のデジタル商品管理。SIWE owner の商品一覧・作成/編集・販売停止と、
// 販売開始に必須の販売者情報を同じ場所で管理する。商品本文は一覧 API へ載せず、編集時だけ
// owner 限定 detail API から取得する。保存後は server の値を再取得し、楽観更新しない。

import { useMemo, useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { HOSTED_PRODUCT_CATEGORIES } from '@/lib/x402/storeMeta';
import Link from 'next/link';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Copy, PackageOpen, Pencil, Store } from 'lucide-react';
import { env } from '@/lib/env';
import { useSiweSession } from '@/hooks/useSiweSession';
import { useStoreCacheScope } from '@/hooks/useStoreCacheScope';
import { useOrigin } from '@/hooks/useOrigin';

type HostedLabel =
  | 'download'
  | 'pdf'
  | 'zip'
  | 'prompt'
  | 'api'
  | 'external';

type ProductSummary = {
  id: string;
  payTo: string;
  title: string;
  desc?: string;
  emoji?: string;
  imageUrl?: string;
  galleryUrls?: readonly string[];
  priceJpyc: string;
  contentKind: 'url' | 'text';
  label: HostedLabel;
  category?: string;
  tags?: readonly string[];
  handle?: string;
  featured?: boolean;
  saleActive: boolean;
  usdcEnabled?: true;
  contentAvailable: boolean;
  updatedAt?: number;
};

type HostedContent = {
  kind: 'url' | 'text';
  value: string;
};

type SellerDisclosure = {
  name: string;
  contact: string;
  disclosure?: string;
  updatedAt: number;
};

type ProductForm = {
  payTo: string;
  title: string;
  desc: string;
  emoji: string;
  imageUrl: string;
  galleryUrls: string;
  priceJpyc: string;
  contentKind: 'url' | 'text';
  label: HostedLabel;
  category: string;
  tags: string;
  listingHandle: string;
  featured: boolean;
  content: string;
  saleActive: boolean;
  usdcEnabled: boolean;
};

type EditingProductState = {
  saleActive: boolean;
  usdcEnabled: boolean;
};

type SellerForm = {
  name: string;
  contact: string;
  disclosure: string;
};

type ProductsResponse = {
  ok: true;
  products: ProductSummary[];
  max: number;
};

type SellerResponse = {
  ok: true;
  seller: SellerDisclosure | null;
};

type ProductDetailResponse = {
  ok: true;
  product: ProductSummary;
  content: HostedContent | null;
};

const HOSTED_LABELS: readonly HostedLabel[] = [
  'download',
  'pdf',
  'zip',
  'prompt',
  'api',
  'external',
];

const EMPTY_PRODUCT_FORM: ProductForm = {
  payTo: '',
  title: '',
  desc: '',
  emoji: '',
  imageUrl: '',
  galleryUrls: '',
  priceJpyc: '',
  contentKind: 'url',
  label: 'download',
  category: '',
  tags: '',
  listingHandle: '',
  featured: false,
  content: '',
  saleActive: false,
  usdcEnabled: true,
};

const EMPTY_SELLER_FORM: SellerForm = {
  name: '',
  contact: '',
  disclosure: '',
};

const inputClass =
  'mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/15 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-400';

class StoreRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail?: string,
  ) {
    super(code);
    this.name = 'StoreRequestError';
  }
}

function errorCode(error: unknown): string {
  return error instanceof StoreRequestError ? error.code : 'request_failed';
}

// parseHostedInput / parseSellerDisclosureInput の detail (安定した英語句) を i18n key へ
// 対応付ける。未知 detail は requestError の code 表示に落とす — 本番実害 (2026-07-30):
// detail を捨てて invalid_product だけ出すと、出品者は何を直せばよいか分からない。
const DETAIL_MESSAGE_KEYS: Record<string, string> = {
  'payTo must not be the fee receiver': 'detailPayToFeeReceiver',
  'payTo must not be the forwarder': 'detailPayToForwarder',
  'invalid title': 'detailInvalidTitle',
  'invalid desc': 'detailInvalidDesc',
  'invalid imageUrl': 'detailInvalidImageUrl',
  'too many gallery images': 'detailTooManyGalleryImages',
  'invalid gallery image': 'detailInvalidGalleryImage',
  'invalid price': 'detailInvalidPrice',
  'price out of range': 'detailInvalidPrice',
  'content url must be https': 'detailInvalidUrl',
  'invalid content text': 'detailInvalidText',
  'invalid name': 'detailInvalidSellerName',
  'invalid contact': 'detailInvalidSellerContact',
  'invalid disclosure': 'detailInvalidDisclosure',
  'disclosure too long': 'detailInvalidDisclosure',
};

const ERROR_MESSAGE_KEYS: Record<string, string> = {
  usdc_pay_to_contract_wallet: 'usdcContractWalletError',
};

function errorDetailKey(error: unknown): string | null {
  if (!(error instanceof StoreRequestError) || !error.detail) return null;
  return DETAIL_MESSAGE_KEYS[error.detail] ?? null;
}

function errorMessageKey(error: unknown): string | null {
  if (!(error instanceof StoreRequestError)) return null;
  return ERROR_MESSAGE_KEYS[error.code] ?? null;
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  // 非 JSON の障害応答で HTTP status を失う波及を断つ。ok:true を必須にするため偽成功にはしない。
  const body = (await response.json().catch(() => null)) as
    | (Record<string, unknown> & { ok?: boolean; error?: string })
    | null;
  if (!response.ok || body?.ok !== true) {
    throw new StoreRequestError(
      response.status,
      typeof body?.error === 'string' ? body.error : `http_${response.status}`,
      typeof body?.detail === 'string' ? body.detail : undefined,
    );
  }
  return body as unknown as T;
}

function sellerFormOf(seller: SellerDisclosure | null): SellerForm {
  return seller
    ? {
        name: seller.name,
        contact: seller.contact,
        disclosure: seller.disclosure ?? '',
      }
    : EMPTY_SELLER_FORM;
}

function copyWithLegacySelection(value: string): boolean {
  if (typeof document.execCommand !== 'function') return false;
  const previousFocus =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  try {
    textarea.focus();
    textarea.select();
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    textarea.remove();
    previousFocus?.focus();
  }
}

async function copyProductLink(value: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      // Clipboard の許可拒否が共有導線全体へ波及しないよう、旧ブラウザ用の選択コピーへ退避する。
    }
  }
  return copyWithLegacySelection(value);
}

function ProductShareButton({
  url,
  copyLabel,
  copiedLabel,
}: {
  url: string;
  copyLabel: string;
  copiedLabel: string;
}) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timeout = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timeout);
  }, [copied]);

  const copy = async () => {
    if (await copyProductLink(url)) setCopied(true);
  };

  return (
    <button
      type="button"
      onClick={() => void copy()}
      className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:border-brand hover:text-brand"
    >
      <Copy className="h-3.5 w-3.5" aria-hidden />
      {copied ? copiedLabel : copyLabel}
    </button>
  );
}

export function CreatorStoreSellerPanel({
  handle = null,
}: {
  handle?: string | null;
}) {
  if (!env.enableCreatorStoreUi) return null;
  return <EnabledCreatorStoreSellerPanel handle={handle} />;
}

function EnabledCreatorStoreSellerPanel({
  handle,
}: {
  handle: string | null;
}) {
  const t = useTranslations('CreatorStoreSeller');
  const guideLocale = useLocale();
  const {
    isSignedIn,
    sessionAddress,
    signIn,
    isSigningIn,
    signInError,
  } = useSiweSession();
  useStoreCacheScope(sessionAddress);

  return (
    <section
      aria-labelledby="creator-store-seller-heading"
      className="rounded-3xl bg-white p-6 shadow-card ring-1 ring-slate-200/70 sm:p-8 print:hidden"
    >
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand/10 text-brand">
          <Store className="h-5 w-5" aria-hidden />
        </span>
        <div className="min-w-0">
          <h2
            id="creator-store-seller-heading"
            className="text-lg font-semibold text-slate-800"
          >
            {t('heading')}
          </h2>
          <p className="mt-1 text-sm leading-relaxed text-slate-500">
            {t('intro')}
          </p>
          <p className="mt-1 text-sm">
            <Link
              href={`/${guideLocale}/guide/store`}
              prefetch={false}
              className="font-medium text-brand underline underline-offset-2 hover:text-brand-dark"
            >
              {t('guideLink')}
            </Link>
          </p>
        </div>
      </div>

      {!isSignedIn || !sessionAddress ? (
        <div className="mt-5">
          <p className="text-sm text-slate-600">{t('signInPrompt')}</p>
          <button
            type="button"
            onClick={() => {
              // 拒否理由は hook の signInError で表示し、click handler の未処理 rejection だけを断つ。
              void signIn(t('signInStatement')).catch(() => undefined);
            }}
            disabled={isSigningIn}
            className="mt-3 rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isSigningIn ? t('signingIn') : t('signIn')}
          </button>
          {signInError ? (
            <p className="mt-2 text-sm text-red-600">{t('signInError')}</p>
          ) : null}
        </div>
      ) : (
        // sessionAddress を key にして wallet 切替時に本文を含む全 local state を破棄する。
        <SignedInSellerPanel
          key={sessionAddress.toLowerCase()}
          sessionAddress={sessionAddress}
          handle={handle}
        />
      )}
    </section>
  );
}

function SignedInSellerPanel({
  sessionAddress,
  handle,
}: {
  sessionAddress: string;
  handle: string | null;
}) {
  const t = useTranslations('CreatorStoreSeller');
  const tCatalog = useTranslations('StoreCatalog');
  const locale = useLocale();
  const origin = useOrigin();
  const [sellerDraft, setSellerDraft] = useState<SellerForm | null>(null);
  const [sellerSaved, setSellerSaved] = useState(false);
  // 新規商品の掲載先は「いま編集中のプロフ (prop handle)」を既定にする —
  // @cipherweb 編集中の登録が @openpay_jp にも出る誤帰属の修正 (2026-08-04 user 裁定)。
  const emptyForm = useMemo<ProductForm>(
    () => ({
      ...EMPTY_PRODUCT_FORM,
      payTo: sessionAddress,
      listingHandle: handle ?? '',
    }),
    [handle, sessionAddress],
  );
  const [productForm, setProductForm] = useState<ProductForm>(emptyForm);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingProductState, setEditingProductState] =
    useState<EditingProductState | null>(null);
  const [productSaved, setProductSaved] = useState(false);

  const productsQuery = useQuery({
    queryKey: ['creator-store', 'products', sessionAddress],
    queryFn: async (): Promise<ProductsResponse> => {
      const body = await requestJson<ProductsResponse>(
        '/api/store/products',
        { cache: 'no-store' },
      );
      if (!Array.isArray(body.products) || !Number.isSafeInteger(body.max)) {
        throw new StoreRequestError(500, 'invalid_response');
      }
      return body;
    },
    retry: false,
    gcTime: 0,
  });

  const sellerQuery = useQuery({
    queryKey: ['creator-store', 'seller', sessionAddress],
    queryFn: async (): Promise<SellerResponse> =>
      requestJson<SellerResponse>('/api/store/seller', {
        cache: 'no-store',
      }),
    retry: false,
    gcTime: 0,
  });

  const seller = sellerQuery.data?.seller ?? null;
  const sellerComplete = seller !== null;
  const sellerForm = sellerDraft ?? sellerFormOf(seller);
  const products = productsQuery.data?.products ?? [];
  const maxProducts = productsQuery.data?.max ?? 12;
  const atLimit = products.length >= maxProducts;
  const productShareBaseUrl =
    handle && origin ? `${origin}/${locale}/@${handle}` : null;

  const updateSeller = (patch: Partial<SellerForm>) => {
    setSellerSaved(false);
    setSellerDraft((current) => ({
      ...(current ?? sellerFormOf(seller)),
      ...patch,
    }));
  };

  const updateProduct = (patch: Partial<ProductForm>) => {
    setProductSaved(false);
    setProductForm((current) => ({ ...current, ...patch }));
  };

  const saveSeller = useMutation({
    gcTime: 0,
    mutationFn: async (form: SellerForm) =>
      requestJson<SellerResponse>('/api/store/seller', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: form.name,
          contact: form.contact,
          disclosure: form.disclosure.trim() || null,
        }),
      }),
    onSuccess: async () => {
      const refreshed = await sellerQuery.refetch();
      if (refreshed.isSuccess) {
        setSellerDraft(null);
        setSellerSaved(true);
      }
    },
  });

  const loadProduct = useMutation({
    gcTime: 0,
    mutationFn: async (id: string) => {
      const detail = await requestJson<ProductDetailResponse>(
        `/api/store/products/${id}`,
        {
          cache: 'no-store',
        },
      );
      if (!detail.content) {
        throw new StoreRequestError(409, 'content_unavailable');
      }
      return { ...detail, content: detail.content };
    },
    onSuccess: ({ product, content }) => {
      setEditingId(product.id);
      setEditingProductState({
        saleActive: product.saleActive,
        usdcEnabled: product.usdcEnabled === true,
      });
      setProductSaved(false);
      setProductForm({
        payTo: product.payTo,
        title: product.title,
        desc: product.desc ?? '',
        emoji: product.emoji ?? '',
        imageUrl: product.imageUrl ?? '',
        galleryUrls: product.galleryUrls?.join('\n') ?? '',
        priceJpyc: product.priceJpyc,
        contentKind: content.kind,
        label: product.label,
        category: product.category ?? '',
        tags: (product.tags ?? []).join(', '),
        listingHandle: product.handle ?? '',
        featured: product.featured === true,
        content: content.value,
        saleActive: product.saleActive,
        usdcEnabled: product.usdcEnabled === true,
      });
    },
  });

  const saveProduct = useMutation({
    gcTime: 0,
    mutationFn: async ({
      id,
      form,
    }: {
      id: string | null;
      form: ProductForm;
    }) =>
      requestJson<{ ok: true; product: ProductSummary }>(
        id ? `/api/store/products/${id}` : '/api/store/products',
        {
          method: id ? 'PATCH' : 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            title: form.title,
            desc: form.desc.trim() || null,
            emoji: form.emoji.trim() || null,
            imageUrl: form.imageUrl.trim() || null,
            galleryUrls: form.galleryUrls
              .split(/\r?\n/)
              .map((url) => url.trim())
              .filter(Boolean),
            priceJpyc: form.priceJpyc,
            contentKind: form.contentKind,
            label: form.label,
            category: form.category || null,
            // カンマ区切り入力 → 配列 (検証は server 権威・storeMeta.parseHostedTags)
            tags: form.tags
              .split(/[,、]/)
              .map((tag) => tag.trim())
              .filter(Boolean),
            handle: form.listingHandle || null,
            featured: form.featured,
            content: form.content,
            saleActive: form.saleActive,
            // 新規 UI の既定 ON も含め、server の暗黙 default に依存せず常に明示する。
            usdcEnabled: form.usdcEnabled,
          }),
        },
      ),
    onSuccess: async () => {
      const refreshed = await productsQuery.refetch();
      if (refreshed.isSuccess) {
        setEditingId(null);
        setEditingProductState(null);
        setProductForm(emptyForm);
        setProductSaved(true);
      }
    },
  });

  const toggleSale = useMutation({
    mutationFn: async ({
      id,
      saleActive,
    }: {
      id: string;
      saleActive: boolean;
    }) =>
      requestJson<{ ok: true; product: ProductSummary }>(
        `/api/store/products/${id}`,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ saleActive }),
        },
      ),
    onSuccess: async () => {
      await productsQuery.refetch();
    },
  });

  const cancelEdit = () => {
    setEditingId(null);
    setEditingProductState(null);
    setProductForm(emptyForm);
    loadProduct.reset();
    saveProduct.reset();
  };

  const canChangeUsdc =
    editingId === null ||
    (editingProductState?.saleActive === false && productForm.saleActive);

  if (productsQuery.isPending || sellerQuery.isPending) {
    return <p className="mt-5 text-sm text-slate-500">{t('loading')}</p>;
  }

  if (productsQuery.isError || sellerQuery.isError) {
    return (
      <div className="mt-5 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
        <p>{t('loadError')}</p>
        <button
          type="button"
          onClick={() => {
            void productsQuery.refetch();
            void sellerQuery.refetch();
          }}
          className="mt-2 font-semibold underline hover:text-red-900"
        >
          {t('retry')}
        </button>
      </div>
    );
  }

  return (
    <div className="mt-6 space-y-6">
      <section
        aria-labelledby="creator-store-seller-disclosure-heading"
        className="rounded-2xl border border-slate-200 bg-slate-50/70 p-4 sm:p-5"
      >
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h3
              id="creator-store-seller-disclosure-heading"
              className="text-base font-semibold text-slate-800"
            >
              {t('sellerHeading')}
            </h3>
            <p className="mt-1 text-xs leading-relaxed text-slate-500">
              {t('sellerIntro')}
            </p>
          </div>
          <span
            className={`rounded-full px-2.5 py-1 text-xs font-semibold ${
              sellerComplete
                ? 'bg-emerald-100 text-emerald-800'
                : 'bg-amber-100 text-amber-800'
            }`}
          >
            {sellerComplete ? t('sellerRegistered') : t('sellerUnregistered')}
          </span>
        </div>

        <form
          className="mt-4 grid gap-4 sm:grid-cols-2"
          onSubmit={(event) => {
            event.preventDefault();
            saveSeller.mutate(sellerForm);
          }}
        >
          <label
            htmlFor="creator-store-seller-name"
            className="block text-sm font-medium text-slate-700"
          >
            {t('sellerNameLabel')}
            <input
              id="creator-store-seller-name"
              type="text"
              required
              maxLength={60}
              value={sellerForm.name}
              onChange={(event) => updateSeller({ name: event.target.value })}
              className={inputClass}
            />
          </label>
          <label
            htmlFor="creator-store-seller-contact"
            className="block text-sm font-medium text-slate-700"
          >
            {t('sellerContactLabel')}
            <input
              id="creator-store-seller-contact"
              type="text"
              required
              maxLength={200}
              value={sellerForm.contact}
              onChange={(event) =>
                updateSeller({ contact: event.target.value })
              }
              className={inputClass}
            />
          </label>
          <div className="sm:col-span-2">
            <label
              htmlFor="creator-store-seller-disclosure"
              className="block text-sm font-medium text-slate-700"
            >
              {t('sellerDisclosureLabel')}
            </label>
            <textarea
              id="creator-store-seller-disclosure"
              aria-describedby="creator-store-seller-disclosure-hint"
              rows={4}
              maxLength={1000}
              value={sellerForm.disclosure}
              onChange={(event) =>
                updateSeller({ disclosure: event.target.value })
              }
              className={inputClass}
            />
            <p
              id="creator-store-seller-disclosure-hint"
              className="mt-1 text-xs leading-relaxed text-slate-500"
            >
              {t('sellerDisclosureHint')}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
            <button
              type="submit"
              disabled={saveSeller.isPending}
              className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand-dark disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saveSeller.isPending ? t('saving') : t('saveSeller')}
            </button>
            {sellerSaved ? (
              <p className="text-sm font-medium text-emerald-700">
                {t('sellerSaved')}
              </p>
            ) : null}
            {saveSeller.isError ? (
              <p className="text-sm text-red-600">
                {(() => {
                  const detailKey = errorDetailKey(saveSeller.error);
                  return detailKey
                    ? t(detailKey)
                    : t('requestError', {
                        error: errorCode(saveSeller.error),
                      });
                })()}
              </p>
            ) : null}
          </div>
        </form>
      </section>

      <section aria-labelledby="creator-store-products-heading">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h3
              id="creator-store-products-heading"
              className="text-base font-semibold text-slate-800"
            >
              {t('productsHeading')}
            </h3>
            <p className="mt-1 text-xs text-slate-500">
              {t('productsCount', {
                count: products.length,
                max: maxProducts,
              })}
            </p>
          </div>
          {atLimit && !editingId ? (
            <p className="text-xs font-medium text-amber-700">
              {t('productLimitReached', { max: maxProducts })}
            </p>
          ) : null}
        </div>

        {products.length === 0 ? (
          <div className="mt-4 rounded-xl border border-dashed border-slate-300 px-4 py-6 text-center">
            <PackageOpen
              className="mx-auto h-6 w-6 text-slate-400"
              aria-hidden
            />
            <p className="mt-2 text-sm text-slate-500">
              {t('emptyProducts')}
            </p>
          </div>
        ) : (
          <ul className="mt-4 grid gap-3 md:grid-cols-2">
            {products.map((product) => {
              const cannotStart =
                !product.saleActive &&
                (!sellerComplete || !product.contentAvailable);
              const toggling =
                toggleSale.isPending &&
                toggleSale.variables?.id === product.id;
              return (
                <li
                  key={product.id}
                  className="rounded-xl border border-slate-200 bg-white p-4"
                >
                  <div className="flex items-start gap-3">
                    <span
                      aria-hidden
                      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-slate-100 text-xl"
                    >
                      {product.emoji ?? '📦'}
                    </span>
                    <div className="min-w-0 flex-1">
                      <h4 className="break-words text-sm font-semibold text-slate-800">
                        {product.title}
                      </h4>
                      {product.desc ? (
                        <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-slate-500">
                          {product.desc}
                        </p>
                      ) : null}
                      <div className="mt-2 flex flex-wrap gap-1.5 text-xs">
                        <span className="rounded-full bg-brand/10 px-2 py-0.5 font-semibold text-brand-dark">
                          {t('priceValue', { price: product.priceJpyc })}
                        </span>
                        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-slate-600">
                          {t(`contentKinds.${product.contentKind}`)}
                        </span>
                        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-slate-600">
                          {t(`labels.${product.label}`)}
                        </span>
                        {!product.contentAvailable ? (
                          <span className="rounded-full bg-red-100 px-2 py-0.5 font-semibold text-red-700">
                            {t('contentUnavailable')}
                          </span>
                        ) : null}
                      </div>
                    </div>
                  </div>

                  <div className="mt-4 flex flex-wrap items-center gap-3">
                    <label className="flex items-center gap-2 text-sm font-medium text-slate-700">
                      <input
                        type="checkbox"
                        checked={product.saleActive}
                        disabled={toggling || cannotStart}
                        onChange={(event) =>
                          toggleSale.mutate({
                            id: product.id,
                            saleActive: event.target.checked,
                          })
                        }
                      />
                      <span>
                        {product.saleActive
                          ? t('saleActive')
                          : t('saleInactive')}
                      </span>
                    </label>
                    <button
                      type="button"
                      disabled={
                        loadProduct.isPending || !product.contentAvailable
                      }
                      onClick={() => loadProduct.mutate(product.id)}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:border-brand hover:text-brand disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      <Pencil className="h-3.5 w-3.5" aria-hidden />
                      {t('editProduct')}
                    </button>
                    {product.saleActive &&
                    product.contentAvailable &&
                    productShareBaseUrl ? (
                      <ProductShareButton
                        url={`${productShareBaseUrl}?product=${encodeURIComponent(product.id)}`}
                        copyLabel={t('copyShareLink')}
                        copiedLabel={t('shareLinkCopied')}
                      />
                    ) : null}
                  </div>
                  {cannotStart && !sellerComplete ? (
                    <p className="mt-2 text-xs leading-relaxed text-amber-700">
                      {t('sellerRequiredForSale')}
                    </p>
                  ) : null}
                  {!product.contentAvailable ? (
                    <p className="mt-2 text-xs leading-relaxed text-red-700">
                      {t('contentUnavailableHint')}
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}

        {toggleSale.isError ? (
          <p className="mt-3 text-sm text-red-600">
            {(() => {
              const messageKey = errorMessageKey(toggleSale.error);
              return messageKey
                ? t(messageKey)
                : t('requestError', {
                    error: errorCode(toggleSale.error),
                  });
            })()}
          </p>
        ) : null}
      </section>

      <section
        aria-labelledby="creator-store-product-form-heading"
        className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-5"
      >
        <h3
          id="creator-store-product-form-heading"
          className="text-base font-semibold text-slate-800"
        >
          {editingId ? t('editProductHeading') : t('newProductHeading')}
        </h3>
        <p className="mt-1 text-xs leading-relaxed text-slate-500">
          {t('productFormIntro')}
        </p>

        <form
          className="mt-4 grid gap-4 sm:grid-cols-2"
          onSubmit={(event) => {
            event.preventDefault();
            saveProduct.mutate({ id: editingId, form: productForm });
          }}
        >
          <label
            htmlFor="creator-store-product-title"
            className="block text-sm font-medium text-slate-700 sm:col-span-2"
          >
            {t('titleLabel')}
            <input
              id="creator-store-product-title"
              type="text"
              required
              maxLength={60}
              value={productForm.title}
              onChange={(event) =>
                updateProduct({ title: event.target.value })
              }
              className={inputClass}
            />
          </label>
          <label
            htmlFor="creator-store-product-desc"
            className="block text-sm font-medium text-slate-700 sm:col-span-2"
          >
            {t('descLabel')}
            <textarea
              id="creator-store-product-desc"
              rows={2}
              maxLength={200}
              value={productForm.desc}
              onChange={(event) =>
                updateProduct({ desc: event.target.value })
              }
              className={inputClass}
            />
          </label>
          <label
            htmlFor="creator-store-product-emoji"
            className="block text-sm font-medium text-slate-700"
          >
            {t('emojiLabel')}
            <input
              id="creator-store-product-emoji"
              type="text"
              maxLength={8}
              value={productForm.emoji}
              onChange={(event) =>
                updateProduct({ emoji: event.target.value })
              }
              className={inputClass}
            />
          </label>
          <label
            htmlFor="creator-store-product-image-url"
            className="block text-sm font-medium text-slate-700"
          >
            {t('imageUrlLabel')}
            <input
              id="creator-store-product-image-url"
              type="url"
              maxLength={512}
              placeholder="https://"
              value={productForm.imageUrl}
              onChange={(event) =>
                updateProduct({ imageUrl: event.target.value })
              }
              className={inputClass}
            />
          </label>
          {/* アップロード先の案内 (レジ商品プリセットの imageHint と同文言・2026-08-05 user 指示)。
              label の外に置き、input の a11y 名 (「画像 URL (任意)」) に混ざらないようにする。 */}
          <p className="-mt-3 text-xs text-slate-500 sm:col-span-2">
            {t('imageUrlHint')}{' '}
            <Link
              href={`/${locale}/guide/image-url`}
              prefetch={false}
              className="font-medium text-emerald-700 underline underline-offset-2 hover:text-emerald-900"
            >
              {t('imageGuideLink')}
            </Link>
          </p>
          <label
            htmlFor="creator-store-product-gallery-urls"
            className="block text-sm font-medium text-slate-700 sm:col-span-2"
          >
            {t('galleryUrlsLabel')}
            <textarea
              id="creator-store-product-gallery-urls"
              rows={4}
              value={productForm.galleryUrls}
              onChange={(event) =>
                updateProduct({ galleryUrls: event.target.value })
              }
              className={inputClass}
            />
          </label>
          <label
            htmlFor="creator-store-product-price"
            className="block text-sm font-medium text-slate-700"
          >
            {t('priceLabel')}
            <input
              id="creator-store-product-price"
              type="text"
              inputMode="numeric"
              pattern="[0-9]+"
              required
              maxLength={7}
              value={productForm.priceJpyc}
              onChange={(event) =>
                updateProduct({ priceJpyc: event.target.value })
              }
              className={inputClass}
            />
          </label>
          {/* 税込総額での登録案内 (Terms 13 条 (4) 2026-08-05 改定と同期・label 外 = a11y 名不変)。 */}
          <p className="-mt-3 text-xs text-slate-500">
            {t('priceHint')}
          </p>
          <label
            htmlFor="creator-store-product-kind"
            className="block text-sm font-medium text-slate-700"
          >
            {t('contentKindLabel')}
            <select
              id="creator-store-product-kind"
              value={productForm.contentKind}
              onChange={(event) => {
                const contentKind = event.target.value as 'url' | 'text';
                updateProduct({
                  contentKind,
                  label: contentKind === 'url' ? 'download' : 'prompt',
                });
              }}
              className={inputClass}
            >
              <option value="url">{t('contentKinds.url')}</option>
              <option value="text">{t('contentKinds.text')}</option>
            </select>
          </label>
          <label
            htmlFor="creator-store-product-label"
            className="block text-sm font-medium text-slate-700"
          >
            {t('labelLabel')}
            <select
              id="creator-store-product-label"
              value={productForm.label}
              onChange={(event) =>
                updateProduct({
                  label: event.target.value as HostedLabel,
                })
              }
              className={inputClass}
            >
              {HOSTED_LABELS.map((label) => (
                <option key={label} value={label}>
                  {t(`labels.${label}`)}
                </option>
              ))}
            </select>
          </label>
          <label
            htmlFor="creator-store-product-category"
            className="block text-sm font-medium text-slate-700"
          >
            {t('categoryLabel')}
            <select
              id="creator-store-product-category"
              value={productForm.category}
              onChange={(event) =>
                updateProduct({ category: event.target.value })
              }
              className={inputClass}
            >
              <option value="">{t('categoryNone')}</option>
              {HOSTED_PRODUCT_CATEGORIES.map((category) => (
                <option key={category} value={category}>
                  {tCatalog(`categories.${category}`)}
                </option>
              ))}
            </select>
          </label>
          <label
            htmlFor="creator-store-product-listing-handle"
            className="block text-sm font-medium text-slate-700"
          >
            {t('listingHandleLabel')}
            <select
              id="creator-store-product-listing-handle"
              value={productForm.listingHandle}
              onChange={(event) =>
                updateProduct({ listingHandle: event.target.value })
              }
              className={inputClass}
            >
              <option value="">{t('listingHandleAll')}</option>
              {handle ? <option value={handle}>@{handle}</option> : null}
              {/* 編集中商品が別 handle 帰属のとき、その値を失わない選択肢を出す */}
              {productForm.listingHandle &&
              productForm.listingHandle !== handle ? (
                <option value={productForm.listingHandle}>
                  @{productForm.listingHandle}
                </option>
              ) : null}
            </select>
          </label>
          <label className="flex items-start gap-2 text-sm text-slate-700 sm:col-span-2">
            <input
              type="checkbox"
              checked={productForm.featured}
              onChange={(event) =>
                updateProduct({ featured: event.target.checked })
              }
              className="mt-0.5 h-4 w-4 rounded border-slate-300"
            />
            <span>
              <span className="font-medium">{t('featuredLabel')}</span>
              <span className="mt-0.5 block text-xs text-slate-500">
                {t('featuredHint')}
              </span>
            </span>
          </label>
          <label
            htmlFor="creator-store-product-tags"
            className="block text-sm font-medium text-slate-700"
          >
            {t('tagsLabel')}
            <input
              id="creator-store-product-tags"
              type="text"
              value={productForm.tags}
              onChange={(event) => updateProduct({ tags: event.target.value })}
              placeholder={t('tagsPlaceholder')}
              className={inputClass}
            />
          </label>
          <div className="sm:col-span-2">
            <label
              htmlFor="creator-store-product-content"
              className="block text-sm font-medium text-slate-700"
            >
              {productForm.contentKind === 'url'
                ? t('contentUrlLabel')
                : t('contentTextLabel')}
            </label>
            {productForm.contentKind === 'url' ? (
              <input
                id="creator-store-product-content"
                aria-describedby="creator-store-product-content-hint"
                type="url"
                required
                maxLength={512}
                value={productForm.content}
                onChange={(event) =>
                  updateProduct({ content: event.target.value })
                }
                className={inputClass}
              />
            ) : (
              <textarea
                id="creator-store-product-content"
                aria-describedby="creator-store-product-content-hint"
                rows={8}
                required
                maxLength={20_000}
                value={productForm.content}
                onChange={(event) =>
                  updateProduct({ content: event.target.value })
                }
                className={inputClass}
              />
            )}
            <p
              id="creator-store-product-content-hint"
              className="mt-1 text-xs leading-relaxed text-slate-500"
            >
              {productForm.contentKind === 'url'
                ? t('contentUrlHint')
                : t('contentTextHint')}
            </p>
          </div>

          <div className="sm:col-span-2">
            <label
              htmlFor="creator-store-product-usdc-enabled"
              className="inline-flex items-center gap-2 text-sm font-medium text-slate-700"
            >
              <input
                id="creator-store-product-usdc-enabled"
                type="checkbox"
                aria-describedby="creator-store-product-usdc-hint"
                checked={productForm.usdcEnabled}
                disabled={!canChangeUsdc}
                onChange={(event) =>
                  updateProduct({ usdcEnabled: event.target.checked })
                }
                className="mt-0.5 h-4 w-4 rounded border-slate-300"
              />
              <span>{t('usdcEnabledLabel')}</span>
            </label>
            <p
              id="creator-store-product-usdc-hint"
              className="mt-1 text-xs leading-relaxed text-slate-500"
            >
              {editingId
                ? t('usdcRepublishHint')
                : t('usdcNewProductHint')}
            </p>
            {productForm.usdcEnabled ? (
              <div className="mt-3 space-y-2 rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-xs leading-relaxed text-slate-700">
                <p>{t('usdcPayToNotice')}</p>
                <code className="block break-all font-mono text-[11px] text-slate-800">
                  {productForm.payTo}
                </code>
                <p>{t('usdcRiskNotice')}</p>
              </div>
            ) : null}
          </div>

          <div className="sm:col-span-2">
            <label className="inline-flex items-center gap-2 text-sm font-medium text-slate-700">
              <input
                type="checkbox"
                checked={productForm.saleActive}
                disabled={!productForm.saleActive && !sellerComplete}
                onChange={(event) => {
                  const saleActive = event.target.checked;
                  updateProduct({
                    saleActive,
                    ...(editingProductState && !saleActive
                      ? {
                          usdcEnabled: editingProductState.usdcEnabled,
                        }
                      : {}),
                  });
                }}
              />
              <span>{t('startSellingAfterSave')}</span>
            </label>
            {!sellerComplete && !productForm.saleActive ? (
              <p className="mt-1 text-xs leading-relaxed text-amber-700">
                {t('sellerRequiredForSale')}
              </p>
            ) : null}
          </div>

          <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
            <button
              type="submit"
              disabled={
                saveProduct.isPending || (atLimit && editingId === null)
              }
              className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand-dark disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saveProduct.isPending
                ? t('saving')
                : editingId
                  ? t('saveProduct')
                  : t('createProduct')}
            </button>
            {editingId ? (
              <button
                type="button"
                onClick={cancelEdit}
                disabled={saveProduct.isPending}
                className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-600 hover:border-slate-400 disabled:opacity-50"
              >
                {t('cancelEdit')}
              </button>
            ) : null}
            {productSaved ? (
              <p className="text-sm font-medium text-emerald-700">
                {t('productSaved')}
              </p>
            ) : null}
          </div>
          {loadProduct.isError || saveProduct.isError ? (
            <p className="text-sm text-red-600 sm:col-span-2">
              {(() => {
                const cause = loadProduct.error ?? saveProduct.error;
                const detailKey = errorDetailKey(cause);
                const messageKey = errorMessageKey(cause);
                return detailKey
                  ? t(detailKey)
                  : messageKey
                    ? t(messageKey)
                    : t('requestError', { error: errorCode(cause) });
              })()}
            </p>
          ) : null}
        </form>
      </section>
    </div>
  );
}
