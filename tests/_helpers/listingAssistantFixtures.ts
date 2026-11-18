// AI 出品アシスタントの test の共通の材料: 目印を入れた既存の商品・販売者情報、JPEG、Gemini の応答 (実際の形に近い fixture)。
import type { ProductForm } from '@/lib/store/productForm';
import type { SellerForm } from '@/components/creator-store-seller/shared';

/** 目印 (欄ごとに別の文字列)。送る欄の値には現れない文字列にする。 */
export const MARKERS = {
  content: 'MARK-PAID-CONTENT-41c7',
  deliveryUrl: 'https://mark-delivery-9d2e.example.com/files/a.zip',
  sellerName: 'MARK-SELLER-NAME-58ab',
  sellerContact: 'mark-seller-contact-7f10@example.com',
  sellerDisclosure: 'MARK-SELLER-DISCLOSURE-c3d4',
  payTo: '0x00000000000000000000000000000000000Ab0C9',
  priceJpyc: '987654',
  imageUrl: 'https://mark-image-1e2f.example.com/p.png',
  galleryUrls: 'https://mark-gallery-6a7b.example.com/g1.png',
  demoUrl: 'https://mark-demo-2c3d.example.com/demo',
  termsUrl: 'https://mark-terms-8e9f.example.com/terms',
  termsVersion: 'MARK-TERMS-VERSION-0a1b',
  listingHandle: 'markhandle5f6e',
  emoji: '🛸',
} as const;

/** 編集で読み込んだ既存の通常商品 (CreatorStoreSellerPanel の loadProduct が作る形)。送る欄は普通の値。 */
export function existingProductForm(over: Partial<ProductForm> = {}): ProductForm {
  return {
    productKind: 'digital',
    supply: '7',
    transferable: true,
    termsPreset: undefined,
    termsUrl: MARKERS.termsUrl,
    termsVersion: MARKERS.termsVersion,
    payTo: MARKERS.payTo,
    title: '木目調のスタンドライト',
    desc: 'Coo World の部屋に置ける 3D 素材です。',
    emoji: MARKERS.emoji,
    imageUrl: MARKERS.imageUrl,
    deliveryUrl: MARKERS.deliveryUrl,
    galleryUrls: MARKERS.galleryUrls,
    details: '内容物: スタンドライト 1 点\n\n使い方: 部屋に配置する',
    specs: '形式: GLB\nポリゴン数: 約 3,000',
    demoUrl: MARKERS.demoUrl,
    usageCommercial: 'allowed',
    usageModify: 'allowed',
    usageRedistribute: 'not_allowed',
    usageNote: 'クレジット表記は不要です',
    priceJpyc: MARKERS.priceJpyc,
    contentKind: 'text',
    label: 'download',
    category: '3d-game',
    tags: 'Coo World, 照明、3D',
    listingHandle: MARKERS.listingHandle,
    featured: true,
    content: MARKERS.content,
    saleActive: true,
    usdcEnabled: true,
    ...over,
  };
}

/** 新規の出品 (CreatorStoreSellerPanel の EMPTY_PRODUCT_FORM に受取先と掲載先が入った形)。 */
export function emptyProductForm(): ProductForm {
  return existingProductForm({
    supply: '1',
    transferable: false,
    termsUrl: '',
    termsVersion: '1',
    title: '',
    desc: '',
    emoji: '',
    imageUrl: '',
    deliveryUrl: '',
    galleryUrls: '',
    details: '',
    specs: '',
    demoUrl: '',
    usageCommercial: '',
    usageModify: '',
    usageRedistribute: '',
    usageNote: '',
    priceJpyc: '',
    contentKind: 'url',
    category: '',
    tags: '',
    featured: false,
    content: '',
    saleActive: false,
  });
}

export const SELLER_FORM: SellerForm = {
  name: MARKERS.sellerName,
  contact: MARKERS.sellerContact,
  disclosure: MARKERS.sellerDisclosure,
};

/** 送る欄 (仕様の PR 1: 商品名・説明・詳しい説明・仕様表・カテゴリ・タグ・通常商品の利用条件)。 */
export const SPEC_SEND_KEYS = [
  'title',
  'desc',
  'details',
  'specs',
  'category',
  'tags',
  'usageCommercial',
  'usageModify',
  'usageRedistribute',
  'usageNote',
].sort();

/** JPEG の先頭 (FF D8 FF E0) で始まる、復号後 byteLength の base64。 */
export function jpegBase64(byteLength = 64): string {
  const bytes = Buffer.alloc(byteLength, 0x11);
  bytes.set([0xff, 0xd8, 0xff, 0xe0].slice(0, byteLength));
  return bytes.toString('base64');
}

/** Coo World の作例 (設計の例文)。形式・点灯・商用条件は確認候補に置く。 */
export const COO_WORLD_DRAFT = {
  title: 'Coo Worldの空間を飾る木目調のスタンドライト',
  desc: 'Coo World の部屋に置ける、木目調のスタンドライトの 3D 素材です。',
  tags: ['Coo World', 'スタンドライト', '木目調'],
  en: 'A wood-grain standing lamp for your Coo World space.',
  x: 'Coo World の空間を飾る木目調のスタンドライトを出品しました。',
  checks: ['ファイル形式 (GLB など) が未記入です。', '点灯するか (光源の有無) が未記入です。', '商用利用の可否が未記入です。'],
};

type CandidateOverride = {
  text?: string;
  finishReason?: string;
  parts?: unknown[];
};

/**
 * generateContent の 200 の本文 (candidates[0].content.parts[0].text に JSON・finishReason・usageMetadata・
 * 思考の署名つきの part)。公式の API reference の GenerateContentResponse の欄名に合わせる。
 */
export function geminiBody(draft: unknown = COO_WORLD_DRAFT, over: CandidateOverride & Record<string, unknown> = {}) {
  const { text, finishReason, parts, ...rest } = over;
  return {
    candidates: [
      {
        content: {
          role: 'model',
          parts: parts ?? [{ text: text ?? JSON.stringify(draft), thoughtSignature: 'c2lnbmF0dXJl' }],
        },
        finishReason: finishReason ?? 'STOP',
        index: 0,
      },
    ],
    usageMetadata: {
      promptTokenCount: 812,
      candidatesTokenCount: 214,
      thoughtsTokenCount: 301,
      totalTokenCount: 1327,
      serviceTier: 'standard',
    },
    modelVersion: 'gemini-4-hydrogen',
    responseId: 'resp-0001',
    ...rest,
  };
}

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** Google の 429 (RESOURCE_EXHAUSTED・RetryInfo つき)。 */
export function geminiQuotaBody(retryDelay = '17s') {
  return {
    error: {
      code: 429,
      message: 'You exceeded your current quota.',
      status: 'RESOURCE_EXHAUSTED',
      details: [
        { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaMetric: 'generate_content_free_tier_requests' }] },
        { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay },
      ],
    },
  };
}

/** fetch の第 2 引数の本文 (Gemini 宛て) を JSON で読む。 */
export function sentGeminiBody(init: RequestInit | undefined): Record<string, unknown> {
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

/** Gemini 宛ての本文の、資料 (memo・facts) の JSON を取り出す (text の part の 2 行目以降)。 */
export function sentMaterial(body: Record<string, unknown>): { memo?: string; facts: Record<string, string> } {
  const contents = body.contents as { parts: { text?: string }[] }[];
  const text = contents[0].parts.find((part) => typeof part.text === 'string')?.text ?? '';
  return JSON.parse(text.slice(text.indexOf('\n') + 1)) as { memo?: string; facts: Record<string, string> };
}
