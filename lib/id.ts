// 衝突回避だけが目的の短いランダム ID (暗号強度は不要)。React key / 明細行 / プリセット等で使う。
// crypto.randomUUID があれば使い、無ければ Math.random ベースの fallback。
export function randomId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `id-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}
