'use client';

// 「プロフ」タブ内のデジタル商品管理。SIWE owner の商品一覧・作成/編集・販売停止と、
// 販売開始に必須の販売者情報を同じ場所で管理する。商品本文は一覧 API へ載せず、編集時だけ
// owner 限定 detail API から取得する。保存後は server の値を再取得し、楽観更新しない。

import { useMemo, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { deliveryFormatOf } from '@/lib/store/deliveryFormat';
import Link from 'next/link';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Store } from 'lucide-react';
import { env } from '@/lib/env';
import { useAccount } from 'wagmi';
import { ConnectButton } from '@/components/ConnectButton';
import { useSiweSession } from '@/hooks/useSiweSession';
import { useStoreCacheScope } from '@/hooks/useStoreCacheScope';
import { useOrigin } from '@/hooks/useOrigin';
import { LICENSE_STANDARD_TERMS } from '@/lib/license/standardTerms';
import type { LicenseCreationTermsInput } from '@/lib/license/definition';
import { validLicenseForm } from '@/components/CreatorStoreLicenseFields';
import { SellerDisclosureSection } from './creator-store-seller/SellerDisclosureSection';
import { ProductListSection } from './creator-store-seller/ProductListSection';
import { ProductEditorSection } from './creator-store-seller/ProductEditorSection';
import { requestJson, StoreRequestError } from './creator-store-seller/request';
import type { EditingProductState, ProductDetailResponse, ProductForm, ProductSummary, ProductsResponse, SellerDisclosure, SellerForm, SellerResponse } from './creator-store-seller/shared';

const EMPTY_PRODUCT_FORM: ProductForm = {
  productKind: 'digital',
  supply: '1',
  transferable: false,
  termsPreset: LICENSE_STANDARD_TERMS.version,
  termsUrl: '',
  termsVersion: '1',
  payTo: '',
  title: '',
  desc: '',
  emoji: '',
  imageUrl: '',
  deliveryUrl: '',
  galleryUrls: '',
  details: '',
  specs: '',
  demoUrl: '',
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

function sellerFormOf(seller: SellerDisclosure | null): SellerForm {
  return seller
    ? {
        name: seller.name,
        contact: seller.contact,
        disclosure: seller.disclosure ?? '',
      }
    : EMPTY_SELLER_FORM;
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
  const { isConnected, address } = useAccount();
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
          {isConnected && address ? (
            <>
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
            </>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-xs text-slate-500">{t('connectFirst')}</p>
              <ConnectButton variant="secondary" />
            </div>
          )}
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
  const [licenseValidationError, setLicenseValidationError] = useState(false);
  const isLicense = env.enableLicenseNftUi && productForm.productKind === 'license';
  const deliveryFormat = deliveryFormatOf(productForm);
  const licenseReadOnly = isLicense && editingId !== null;

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
  const products = (productsQuery.data?.products ?? []).filter((product) => env.enableLicenseNftUi || product.productKind !== 'license');
  const maxProducts = productsQuery.data?.max ?? 12;
  const atLimit = products.length >= maxProducts;

  const updateSeller = (patch: Partial<SellerForm>) => {
    setSellerSaved(false);
    setSellerDraft((current) => ({
      ...(current ?? sellerFormOf(seller)),
      ...patch,
    }));
  };

  const updateProduct = (patch: Partial<ProductForm>) => {
    setProductSaved(false);
    setLicenseValidationError(false);
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
        productKind: product.productKind ?? 'digital',
        supply: String(product.license?.supply ?? 1),
        transferable: product.license?.transferable ?? false,
        termsPreset: product.license
          ? product.license.termsUrl === LICENSE_STANDARD_TERMS.url && product.license.termsVersion === LICENSE_STANDARD_TERMS.version ? LICENSE_STANDARD_TERMS.version : undefined
          : LICENSE_STANDARD_TERMS.version,
        termsUrl: product.license?.termsUrl ?? '',
        termsVersion: product.license?.termsVersion ?? '1',
        payTo: product.payTo,
        title: product.title,
        desc: product.desc ?? '',
        details: product.details ?? '',
        specs: product.specs?.map(({ label, value }) => `${label}: ${value}`).join('\n') ?? '',
        demoUrl: product.demoUrl ?? '',
        emoji: product.emoji ?? '',
        imageUrl: product.imageUrl ?? '',
        deliveryUrl: product.deliveryUrl ?? '',
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
            details: form.details.trim() || null,
            specs: form.specs.trim() ? form.specs.split(/\r?\n/).filter((line) => line.trim()).map((line) => {
              // 区切りは「直後が / でない最初のコロン」。素の URL 行 (https://…) を {label:'https', value:'//…'} に
              // 誤分割して公開しない — 区切れない行は value 空で送り、server の 400 で「ラベル: 値」を促す。
              const match = /^([^:：]*)[:：](?!\/)(.*)$/.exec(line);
              return match
                ? { label: match[1].trim(), value: match[2].trim() }
                : { label: line.trim(), value: '' };
            }) : null,
            demoUrl: form.demoUrl.trim() || null,
            emoji: form.emoji.trim() || null,
            imageUrl: form.imageUrl.trim() || null,
            // Mutable delivery metadata stays outside the immutable license/content fields.
            // OFF omits it; ON preserves an empty string so editing can clear the destination.
            ...(env.enableStoreDeliveryTicketUi ? { deliveryUrl: form.deliveryUrl } : {}),
            galleryUrls: form.galleryUrls
              .split(/\r?\n/)
              .map((url) => url.trim())
              .filter(Boolean),
            ...(form.productKind === 'license' && id ? {} : {
              priceJpyc: form.priceJpyc,
              contentKind: form.contentKind,
              content: form.content,
            }),
            ...(form.productKind === 'license' && !id ? {
              productKind: 'license',
              payTo: form.payTo,
              license: {
                supply: Number(form.supply), transferable: form.transferable,
                ...(form.termsPreset === LICENSE_STANDARD_TERMS.version
                  ? { termsPreset: LICENSE_STANDARD_TERMS.version }
                  : { termsUrl: form.termsUrl.trim(), termsVersion: form.termsVersion.trim() }),
              } satisfies LicenseCreationTermsInput,
            } : {}),
            label: form.label,
            category: form.category || null,
            // カンマ区切り入力 → 配列 (検証は server 権威・storeMeta.parseHostedTags)
            tags: form.tags
              .split(/[,、]/)
              .map((tag) => tag.trim())
              .filter(Boolean),
            handle: form.listingHandle || null,
            featured: form.featured,
            ...(form.productKind === 'license' && id ? {} : { saleActive: form.productKind === 'license' ? false : form.saleActive }),
            // 新規 UI の既定 ON も含め、server の暗黙 default に依存せず常に明示する。
            usdcEnabled: form.productKind === 'license' ? false : form.usdcEnabled,
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
    setLicenseValidationError(false);
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

  // 3 つの表示部品には値と mutation を渡すだけにし、下書き・本文・送信処理はこの component に集める。
  // sessionAddress key の remount で私的な値がまとめて破棄される境界を、部品分割で崩さないため。
  return (
    <div className="mt-6 space-y-6">
      <SellerDisclosureSection
        seller={seller}
        sellerForm={sellerForm}
        sellerSaved={sellerSaved}
        isLicense={isLicense}
        updateSeller={updateSeller}
        saveSeller={saveSeller}
      />
      <ProductListSection
        products={products}
        maxProducts={maxProducts}
        atLimit={atLimit}
        editingId={editingId}
        sellerComplete={sellerComplete}
        handle={handle}
        origin={origin}
        locale={locale}
        toggleSale={toggleSale}
        loadProduct={loadProduct}
        productsQuery={productsQuery}
      />
      <ProductEditorSection
        productForm={productForm}
        editingId={editingId}
        editingProductState={editingProductState}
        isLicense={isLicense}
        licenseReadOnly={licenseReadOnly}
        deliveryFormat={deliveryFormat}
        handle={handle}
        locale={locale}
        sellerComplete={sellerComplete}
        canChangeUsdc={canChangeUsdc}
        atLimit={atLimit}
        licenseValidationError={licenseValidationError}
        productSaved={productSaved}
        updateProduct={updateProduct}
        cancelEdit={cancelEdit}
        saveProduct={saveProduct}
        loadProduct={loadProduct}
        onSubmit={(event) => {
          event.preventDefault();
          if (isLicense && !validLicenseForm(productForm, productForm.priceJpyc)) {
            setLicenseValidationError(true);
            return;
          }
          saveProduct.mutate({ id: editingId, form: productForm });
        }}
      />
    </div>
  );
}
