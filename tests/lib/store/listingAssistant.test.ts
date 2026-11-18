// AI 出品アシスタントの許可リスト (Google に送る欄) と、フォームからの抽出。
// 有料の本文・納品 URL・販売者情報 (開示の欄) に別々の目印を入れた既存の商品から抽出し、目印が 1 つも出ないことを固定する。
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  LISTING_ASSISTANT_FACT_KEYS,
  LISTING_ASSISTANT_FIELD_POLICY,
  listingAssistantFactsOf,
  type ListingAssistantFacts,
} from '@/lib/store/listingAssistant';
import type { ProductForm } from '@/lib/store/productForm';
import type { ProductForm as PanelProductForm } from '@/components/creator-store-seller/shared';
import type { LicenseFormFields as PanelLicenseFormFields } from '@/components/CreatorStoreLicenseFields';
import type { LicenseFormFields } from '@/lib/store/productForm';
import {
  existingProductForm,
  MARKERS,
  SELLER_FORM,
  SPEC_SEND_KEYS,
} from '../../_helpers/listingAssistantFixtures';

describe('listing assistant: 許可リスト', () => {
  it('ProductForm の全 key をちょうど分類している (欄を足すと typecheck と この test が落ちる)', () => {
    // 型: 許可リストの key は ProductForm の key と一致し、画面の型 (再 export) も同じもの。
    expectTypeOf<keyof typeof LISTING_ASSISTANT_FIELD_POLICY>().toEqualTypeOf<keyof ProductForm>();
    expectTypeOf<PanelProductForm>().toEqualTypeOf<ProductForm>();
    expectTypeOf<PanelLicenseFormFields>().toEqualTypeOf<LicenseFormFields>();
    // 実行時: 完全な ProductForm (型が全 key を要求する) の key と、許可リストの key が同じ。
    expect(Object.keys(LISTING_ASSISTANT_FIELD_POLICY).sort()).toEqual(Object.keys(existingProductForm()).sort());
    expect(new Set(Object.values(LISTING_ASSISTANT_FIELD_POLICY))).toEqual(new Set(['send', 'never']));
  });

  it('send は公開用の説明の欄だけ', () => {
    expect([...LISTING_ASSISTANT_FACT_KEYS].sort()).toEqual(SPEC_SEND_KEYS);
    expectTypeOf<keyof ListingAssistantFacts>().toEqualTypeOf<
      'title' | 'desc' | 'details' | 'specs' | 'category' | 'tags' | 'usageCommercial' | 'usageModify' | 'usageRedistribute' | 'usageNote'
    >();
  });

  it.each([
    'content',
    'contentKind',
    'deliveryUrl',
    'payTo',
    'priceJpyc',
    'usdcEnabled',
    'productKind',
    'supply',
    'transferable',
    'termsPreset',
    'termsUrl',
    'termsVersion',
    'emoji',
    'label',
    'imageUrl',
    'galleryUrls',
    'demoUrl',
    'listingHandle',
    'featured',
    'saleActive',
  ] as const)('%s は never', (key) => {
    expect(LISTING_ASSISTANT_FIELD_POLICY[key]).toBe('never');
  });
});

describe('listing assistant: フォームからの抽出', () => {
  it('既存の商品 (有料の本文・納品 URL・開示の欄に目印) から作った送信の中身に目印が無く、key が許可リストとちょうど同じ', () => {
    // 画面の状態の全体 (商品のフォーム + 販売者情報のフォーム) のうち、抽出の入口は商品のフォームしか受け取らない。
    const panelState = { productForm: existingProductForm(), sellerForm: SELLER_FORM };
    const facts = listingAssistantFactsOf(panelState.productForm);

    expect(Object.keys(facts).sort()).toEqual(SPEC_SEND_KEYS);
    const sent = JSON.stringify({ memo: 'Coo World向けの木目調スタンドライト', facts });
    for (const marker of Object.values(MARKERS)) {
      expect(sent).not.toContain(marker);
    }
    expect(facts).toEqual({
      title: '木目調のスタンドライト',
      desc: 'Coo World の部屋に置ける 3D 素材です。',
      details: '内容物: スタンドライト 1 点\n\n使い方: 部屋に配置する',
      specs: '形式: GLB\nポリゴン数: 約 3,000',
      usageCommercial: 'allowed',
      usageModify: 'allowed',
      usageRedistribute: 'not_allowed',
      usageNote: 'クレジット表記は不要です',
      category: '3d-game',
      tags: 'Coo World, 照明、3D',
    });
  });

  it('利用ライセンス商品は普通の商品の利用条件を送らない (専用の利用条件を持ち、保存もされない)', () => {
    const facts = listingAssistantFactsOf(existingProductForm({ productKind: 'license' }));
    expect(facts).toMatchObject({ usageCommercial: '', usageModify: '', usageRedistribute: '', usageNote: '' });
    expect(Object.keys(facts).sort()).toEqual(SPEC_SEND_KEYS);
  });
});
