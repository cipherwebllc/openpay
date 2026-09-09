/** 商品共有・ストアカードと descriptor が使う @handle の購入 deep link。 */
export function storeProductPath(handle: string, productId: string, locale?: string): string {
  return `${locale ? '/' + locale : ''}/@${encodeURIComponent(handle)}?product=${encodeURIComponent(productId)}`;
}
