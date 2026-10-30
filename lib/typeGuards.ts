// 値の型と形を見る小さな判定 (非 money 側の共有 helper・全レビュー第 8 回 F-6 / PR-17)。
// 同じ実装の複製を集めただけで、判定の意味は集める前と同じ (tests/lib/typeGuards.test.ts が境界の入力で固定する)。
// money-path (relay / settle / fee / 注文の検証 / x402 支払い / forwarder) の同名 helper は掟 12 のとおり
// 各ファイルに残している (lib/x402/* の isRecord 等)。ここを変えても money-path の判定は変わらない。
// 名前の似た lib/paymentFlowGuards.ts (支払いフローの状態判定) とは別物。

/**
 * null でも配列でもない object。prototype は見ないので、null prototype の object・Date・Map も通す。
 * 関数 (typeof が 'function') は通さない。
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * WHATWG URL として読めて、scheme が https: のもの。http:・javascript:・data:・相対 URL は false。
 * host 末尾のドット・port・userinfo (user:pass@) は拒否しない。URL parser に任せるので、前後の空白や
 * `https:example.com` も https として通る (lib/mobileOrder.ts の isHttpsUrl は正規表現で長さとこれらを
 * 拒否する別の判定で、ここへは寄せていない)。
 */
export function isHttpsUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === 'https:';
}
