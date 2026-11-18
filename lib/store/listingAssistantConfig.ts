import 'server-only';

// AI 出品アシスタントの設定 (サーバーの機能フラグと Gemini の key)。server-only (掟 9: key を client 共有の lib/env.ts に入れない)。
// 検証・Gemini の呼び出し (lib/store/listingAssistantServer.ts) と分けるのは、出品者の GET (app/api/store/seller) が
// フラグだけを見るため — 保存の検証 (hostedStore) を mock する兄弟のテストに、案の検証の依存を持ち込まない。

import { parseBoolFlag } from '@/lib/env';

/** サーバーの機能フラグ (既定 OFF)。Store のフラグ (ENABLE_CREATOR_STORE) との AND は route が見る。 */
export function listingAssistantEnabled(): boolean {
  return parseBoolFlag('ENABLE_STORE_LISTING_ASSISTANT', process.env.ENABLE_STORE_LISTING_ASSISTANT);
}

/** Gemini API の key (課金なしの project の key)。未設定・空白だけなら null (= 503 not_configured)。 */
export function geminiApiKey(): string | null {
  const key = process.env.GEMINI_API_KEY?.trim();
  return key ? key : null;
}
