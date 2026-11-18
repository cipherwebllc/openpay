import 'server-only';

// AI 出品アシスタントの設定 (サーバーの機能フラグと Gemini の key)。server-only (掟 9: key を client 共有の lib/env.ts に入れない)。
// 検証・Gemini の呼び出し (lib/store/listingAssistantServer.ts) と分けるのは、出品者の GET (app/api/store/seller) が
// フラグだけを見るため — 保存の検証 (hostedStore) を mock する兄弟のテストに、案の検証の依存を持ち込まない。

// 不正な値の警告はプロセスごとに 1 回 (route と出品者の GET が要求ごとに読むので、毎回ログを埋めない)。
let warnedUnrecognizedFlag = false;

/**
 * サーバーの機能フラグ (既定 OFF)。`1` と `true` だけが ON。Store のフラグ (ENABLE_CREATOR_STORE) との AND は route が見る。
 * 不正な値は OFF とし、値そのものはログに出さない (lib/env.ts の parseBoolFlag は値を写す — 誤って秘密を入れた設定を
 * ログに残さないため使わない)。
 */
export function listingAssistantEnabled(): boolean {
  const raw = process.env.ENABLE_STORE_LISTING_ASSISTANT;
  if (raw === '1' || raw === 'true') return true;
  if (raw && raw !== '0' && raw !== 'false' && !warnedUnrecognizedFlag) {
    warnedUnrecognizedFlag = true;
    console.warn('[OpenPay] ENABLE_STORE_LISTING_ASSISTANT has an unrecognized value; treating as false.');
  }
  return false;
}

/** Gemini API の key (課金なしの project の key)。未設定・空白だけなら null (= 503 not_configured)。 */
export function geminiApiKey(): string | null {
  const key = process.env.GEMINI_API_KEY?.trim();
  return key ? key : null;
}
