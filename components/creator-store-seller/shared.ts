// CreatorStoreSellerPanel と表示部品 (creator-store-seller/*) が共有する型と入力欄 class。

import type { HostedLabel } from '@/lib/x402/hostedStore';
import type { StoreLicenseProduct } from '@/lib/licenseUi';
import type { LicenseFormFields } from '@/components/CreatorStoreLicenseFields';

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

export type ProductForm = LicenseFormFields & {
  productKind: 'digital' | 'license';
  payTo: string;
  title: string;
  desc: string;
  emoji: string;
  imageUrl: string;
  deliveryUrl: string;
  galleryUrls: string;
  details: string;
  specs: string;
  demoUrl: string;
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
};

export type ProductDetailResponse = {
  ok: true;
  product: ProductSummary;
  content: HostedContent | null;
};

export const inputClass =
  'mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/15 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-400';

// 表示部品は親 (controller) が持つ mutation の状態を受け取るだけで、自前の mutation を作らない。
export type MutationView<Variables> = {
  isPending: boolean;
  isError: boolean;
  error: unknown;
  submittedAt: number;
  variables?: Variables;
  mutate: (variables: Variables) => void;
};
