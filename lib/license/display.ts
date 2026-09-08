import 'server-only';

import { kvMget } from '@/lib/kv';
import type { StoreLicenseSummary } from '@/lib/licenseUi';
import type { HostedProduct } from '@/lib/x402/hostedStore';
import { licenseStockKey } from './stock';

function remainingFor(raw: string | null, definition: NonNullable<HostedProduct['license']>): number | null {
  // 在庫の欠損・世代違いを完売や未販売に偽装せず、表示だけを「確認できません」にする。
  if (raw === null) return null;
  try {
    const stock = JSON.parse(raw);
    if (stock?.gen !== definition.definitionHash || stock.supply !== definition.supply ||
      !Number.isSafeInteger(stock.sold) || stock.sold < 0 ||
      !Number.isSafeInteger(stock.reserved) || stock.reserved < 0 ||
      stock.sold + stock.reserved > stock.supply) return null;
    return stock.supply - stock.sold - stock.reserved;
  } catch {
    // 壊れた在庫の表示を既存の商品一覧・プロフィールへ波及させない。
    return null;
  }
}

// 公開表示に必要な定義と残数のみを投影する。購入 snapshot や在庫更新には使わない。
export async function licenseSummariesFor(products: readonly HostedProduct[]): Promise<Map<string, StoreLicenseSummary>> {
  const licenses = products.filter((product) => product.productKind === 'license' && product.license);
  if (licenses.length === 0) return new Map();
  const stocks = await kvMget(licenses.map((product) => licenseStockKey(product.id)));
  // KV の不正な応答形式を商品一覧全体の描画失敗へ波及させない。
  const values = stocks.ok && Array.isArray(stocks.value) && stocks.value.length === licenses.length
    ? stocks.value : null;
  return new Map(licenses.map((product, index) => {
    const definition = product.license!;
    return [product.id, {
      supply: definition.supply,
      remaining: values ? remainingFor(values[index], definition) : null,
      transferable: definition.transferable,
      termsUrl: definition.termsUrl,
      termsVersion: definition.termsVersion,
      tokenChainId: definition.tokenChainId,
    }];
  }));
}
