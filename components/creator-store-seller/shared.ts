// CreatorStoreSellerPanel と表示部品 (creator-store-seller/*) が共有する型と入力欄 class。

import type { HostedLabel } from '@/lib/x402/hostedStore';
import type { StoreLicenseProduct } from '@/lib/licenseUi';
import type { StoreUsageTerms } from '@/lib/store/usageTerms';
import type { ProductForm } from '@/lib/store/productForm';

// 出品フォームの型の本体は lib/store/productForm.ts (AI 出品アシスタントの許可リストが lib/ から ProductForm を網羅するため)。
export type { ProductForm } from '@/lib/store/productForm';

/**
 * フォームの一部の書き換え (updateProduct)。関数なら最新のフォームから作る (画像のアップロードの結果を足すとき、描画のときの
 * 値で上書きしない)。
 */
export type ProductFormPatch = Partial<ProductForm> | ((current: ProductForm) => Partial<ProductForm>);

export type ProductSummary = StoreLicenseProduct & {
  registration?: { status: 'pending' | 'registered' | 'failed' };
  id: string;
  payTo: string;
  title: string;
  desc?: string;
  emoji?: string;
  imageUrl?: string;
  deliveryUrl?: string;
  galleryUrls?: readonly string[];
  details?: string;
  specs?: readonly { label: string; value: string }[];
  demoUrl?: string;
  usage?: StoreUsageTerms;
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

export type HostedContent = {
  kind: 'url' | 'text';
  value: string;
};

export type SellerDisclosure = {
  name: string;
  contact: string;
  disclosure?: string;
  updatedAt: number;
};

export type EditingProductState = {
  saleActive: boolean;
  usdcEnabled: boolean;
};

export type SellerForm = {
  name: string;
  contact: string;
  disclosure: string;
};

export type ProductsResponse = {
  ok: true;
  products: ProductSummary[];
  max: number;
};

export type SellerResponse = {
  ok: true;
  seller: SellerDisclosure | null;
  /** GET だけが返す: AI 出品アシスタントの入口を出すか (server のフラグ ON かつ運営者)。 */
  listingAssistant?: boolean;
  /** GET だけが返す: 画像の欄 (アップロード) を出すか (段階・権限・秘密と Blob の設定がそろったとき)。 */
  imageUpload?: boolean;
};

export type ProductDetailResponse = {
  ok: true;
  product: ProductSummary;
  content: HostedContent | null;
};

export const inputClass =
  'mt-1 min-h-11 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-base placeholder:text-slate-500 focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/15 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-400 sm:text-sm';

// 表示部品は親 (controller) が持つ mutation の状態を受け取るだけで、自前の mutation を作らない。
export type MutationView<Variables> = {
  isPending: boolean;
  isError: boolean;
  error: unknown;
  submittedAt: number;
  variables?: Variables;
  mutate: (variables: Variables) => void;
};
