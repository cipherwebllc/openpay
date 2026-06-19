// 受注閲覧トークン (店員端末を資金鍵なしで厨房/ホール/受注に繋ぐ) の純ロジック。
// KV キー / トークン形式の検証のみ (生成は node crypto を使う route 側・KV I/O も route 側)。
// flag NEXT_PUBLIC_ENABLE_ORDER_TOKEN 既定 OFF で全経路 inert。
//
// 設計の核 (plans/restaurant-pos-roadmap.md Phase 5):
//   - トークンは **受注の閲覧 + 進捗操作のみ** を認可する bearer 資格情報。送金・受取先変更は
//     一切できない (feed route 以外は受理しない・資金鍵を持たない) → 店員の売上スキミングを構造的に防ぐ。
//   - 受取アドレス (= 受注リストのキー) ごとに 1 トークン。再発行で旧トークンは即失効。
//   - 双方向キー: optoken:<merchant>=token (オーナー再表示/再発行用) と rev:<token>=merchant
//     (店員リクエストの token→merchant 解決用)。再発行時は旧 rev を消す。
//   - **非財務の資格情報ゆえ平文保存** (オーナーがいつでもリンクを再表示できる UX を優先・KV 流出時の
//     被害は「受注の閲覧/状態トグル」に限定され資金は安全)。秘匿性は再発行(失効)で担保。

// 32 byte (256-bit) ランダム = base64url で 43 文字。推測不能。
export const ORDER_TOKEN_BYTES = 32;
const ORDER_TOKEN_LEN = 43; // base64url(32 bytes) の文字数 (padding 無し)
const ORDER_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/** オーナー側: 受取アドレス → 現行トークン (再表示・再発行で参照)。 */
export function orderTokenKey(merchant: string): string {
  return `order:optoken:${merchant.toLowerCase()}`;
}

/** 店員側: トークン → 受取アドレス (feed の認可解決)。 */
export function orderTokenRevKey(token: string): string {
  return `order:optoken:rev:${token}`;
}

/** 提示されたトークンが正しい形式か (KV ルックアップ前の安価なゲート・不正入力での無駄引きを防ぐ)。 */
export function isOrderTokenLike(v: unknown): v is string {
  return typeof v === 'string' && v.length === ORDER_TOKEN_LEN && ORDER_TOKEN_RE.test(v);
}
