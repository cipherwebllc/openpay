import { loadOrderDeliveries, type OrderDelivery } from '@/lib/orderDelivery';

// テスト専用の見え方: sessionStorage に残る受注の控え (未配達の注文) を「最新 1 件」にまとめて見る。
// 本番の呼び元 (useJpycEip3009Payment) は loadOrderDeliveries を直接使い、注文の文脈で 1 件を選ぶ。
// 同じことをする lib の薄いラッパ (loadOrderDelivery) は本番から呼ばれず削除した (第 7 回レビュー F11)。
export function latestOrderDelivery():
  | { kind: 'empty' }
  | { kind: 'unavailable' }
  | { kind: 'ready'; record: OrderDelivery } {
  const loaded = loadOrderDeliveries();
  const record = loaded.records[0];
  if (record) return { kind: 'ready', record };
  return loaded.unavailable ? { kind: 'unavailable' } : { kind: 'empty' };
}
