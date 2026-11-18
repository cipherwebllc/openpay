// 出品フォーム (components/CreatorStoreSellerPanel.tsx) の入力欄の型。型だけを持ち、実体は持たない。
// components/creator-store-seller/shared.ts と components/CreatorStoreLicenseFields.tsx が同じ名前で再 export する。
// lib/ に置く理由: AI 出品アシスタント (lib/store/listingAssistant.ts) が「Google に送る欄の許可リスト」を
// ProductForm の key で網羅する (欄を足すと typecheck が落ちる) — lib/ は components/ を import しない (層の向き・ESLint)。

import type { HostedLabel } from '@/lib/x402/storeWire';
import type { LICENSE_STANDARD_TERMS } from '@/lib/license/standardTerms';
import type { UsagePermission } from '@/lib/store/usageTerms';

export type LicenseFormFields = {
  payTo: string;
  supply: string;
  transferable: boolean;
  termsPreset: typeof LICENSE_STANDARD_TERMS.version | undefined;
  termsUrl: string;
  termsVersion: string;
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
  /** 利用条件の選択。'' = 記載しない。 */
  usageCommercial: UsagePermission | '';
  usageModify: UsagePermission | '';
  usageRedistribute: UsagePermission | '';
  usageNote: string;
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
