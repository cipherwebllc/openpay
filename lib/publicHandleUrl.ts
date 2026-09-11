/** 公開 handle の共有 URL。origin 未確定時は相対 URL を使う。 */
export function getPublicHandleUrl(origin: string, handle: string): string {
  return origin ? `${origin}/@${handle}` : `/@${handle}`;
}
