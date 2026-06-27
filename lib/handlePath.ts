// pathname が @handle (クリエイターの link-in-bio / 店舗) ページかを判定する純関数。
// locale 直後などのセグメントが `@` (または URL encode された `%40`) 始まりなら handle ページ。
// 共通 chrome (AlphaNotice など) を creator ページで隠す判定に使う。依存ゼロ = client bundle に安全。
// null/undefined (router provider 無し = テスト等) は false = 通常ページ扱い。
export function isHandlePagePath(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  return pathname
    .split('/')
    .some((seg) => seg.startsWith('@') || seg.toLowerCase().startsWith('%40'));
}
