// OpenPay の公式の連絡先 (LINE・Discord・X) の URL。全ページのフッター (components/SiteFooter.tsx) と
// スポンサー・広告掲載のご案内 (/sponsors) が同じ値を使う (二重に持たない・2026-11-18)。
// フッターは全ページの初回読み込みに乗るので、この file には URL の定数だけを置く (重い import を足さない)。

/** お問い合わせの行き先 (公開のメールアドレスは載せない・2026-10-25 user 裁定)。 */
export const OPENPAY_DISCORD_URL = 'https://discord.gg/Cfywb3aNWg';

/** OpenPay の LINE 公式アカウント (友だち追加・トークで問い合わせ・2026-11-25 user が作成)。 */
export const OPENPAY_LINE_URL = 'https://line.me/R/ti/p/@904kjwjn';

/** OpenPay の X (旧 Twitter)。 */
export const OPENPAY_X_URL = 'https://x.com/openpay_jp';
