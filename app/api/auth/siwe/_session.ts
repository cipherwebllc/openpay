// SIWE セッション読み取りの app/ 側の入口 (facade・再エクスポートだけ)。実体は lib/siweSession.ts。
// `_auth.ts` に倣い `_` prefix で route 探索対象外。
//
// - app/ の route はここから import する (`@/lib/siweSession` の直接 import は eslint が止める)。
// - tests はここを vi.mock しない。mock 対象は実体の `@/lib/siweSession` だけ (eslint が止める)。
//   ここを mock しても、実体を直接 import する lib/* には届かないため。
export { readSession, requireSession } from '@/lib/siweSession';
export type { SessionReadResult, RequireSessionResult } from '@/lib/siweSession';
