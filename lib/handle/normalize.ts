// handle 名の正規化・形式/予約語の判定と、1 wallet あたりの claim 上限。
// 保存 (KV) にも他の handle モジュールにも依存しない。

// 1 wallet が保有できる handle の上限 (squatting 抑制・D2)。
export const MAX_HANDLES_PER_WALLET = 3;

// 形式: ASCII 小文字英数字 + アンダースコア、3〜30 文字。
export const HANDLE_PATTERN = /^[a-z0-9_]{3,30}$/;

// 予約語: 既存ルート名 + locale + ブランド/紛らわしい語。handle namespace は `@` 接頭辞で
// static route と分離されるため衝突防止というより成りすまし/混同の一次防御。
// 新規 claim に適用する。追加前の既存 record は削除せず、解決・所有者による更新/解放も維持。
// 既存の衝突有無はコードからは分からない (別途 KV inventory が必要)。
export const RESERVED_HANDLES: ReadonlySet<string> = new Set<string>([
  // 既存ルート / 特殊パス (handle 形式になり得る全 top-level route 名を網羅)
  'api', 'og', '_next', 'admin', 'agent', 'billing', 'checkout', 'create',
  'directory', 'disclaimer', 'discovery', 'experimental', 'explore', 'guide', 'history',
  'kit', 'me', 'news', 'order', 'orders', 'pay', 'privacy', 'scan', 'store', 'terms', 'tip',
  'tokutei', 'transparency',
  // locale
  'ja', 'en',
  // ブランド / 役割 (成りすまし防止)
  'openpay', 'open_pay', 'official', 'support', 'help', 'admin_',
  'moderator', 'mod', 'staff', 'team', 'root', 'system', 'security',
  'jpyc', 'usdc', 'wallet', 'account', 'login', 'logout', 'signin',
  'signout', 'settings', 'dashboard', 'about', 'contact', 'home', 'www',
  'app',
]);

// URL のパスセグメントは `@` が `%40` にエンコードされて届くことがある (Next.js は
// dynamic route param を自動デコードしない)。`@` 接頭辞の判定や normalize の前に一度だけ
// 安全にデコードする。不正な `%` シーケンスは decode せず raw を返す (どのみち後段の
// `@`/形式チェックで弾かれる)。冪等: `@alice` / `alice` はそのまま返る。
export function decodeHandleSegment(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

// 先頭 `@` を除去し小文字化・trim。URL segment ('@alice') / 入力どちらも受ける。
export function normalizeHandle(raw: string): string {
  return raw.trim().replace(/^@+/, '').toLowerCase();
}

export function isValidHandleFormat(handle: string): boolean {
  return HANDLE_PATTERN.test(handle);
}

export function isReserved(handle: string): boolean {
  return RESERVED_HANDLES.has(handle);
}

export type HandleValidation =
  | { ok: true; handle: string }
  | { ok: false; reason: 'format' | 'reserved' };

// 正規化 + 形式 + 予約語をまとめて判定。API / availability / dashboard が共有する。
export function validateHandle(
  raw: string,
  { allowReserved = false }: { allowReserved?: boolean } = {},
): HandleValidation {
  const handle = normalizeHandle(raw);
  if (!isValidHandleFormat(handle)) return { ok: false, reason: 'format' };
  // 既存 handle の操作だけ予約語を許可する。所有確認・新規 claim 拒否は store が行う。
  if (!allowReserved && isReserved(handle)) return { ok: false, reason: 'reserved' };
  return { ok: true, handle };
}
