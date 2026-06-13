// /pay・/tip・/checkout の URL builder/parser で共有する基盤ヘルパ群。
// ここに置くのは {pay, tip, checkout} の 2 つ以上から使われる symbol だけ
// (単一セクション固有のものは各セクションモジュールに置く)。
// import 方向: shared は外部依存 (viem / chains / tokens / sanitize) のみに依存し、
// pay/tip/checkout からは決して import しない (循環回避)。
import { isValidChainSlug, type ChainSlug } from '../chains';
import { stripControlChars, truncateSafe } from '../sanitize';
import { DEFAULT_CHAIN_FOR_SYMBOL, type TokenSymbol } from '../tokens';

/** URLSearchParams / Next の ReadonlyURLSearchParams どちらも構造的に受け取れる */
export type SearchParamsLike = { get(name: string): string | null };

/** Next.js App Router の `searchParams` (Promise) 解決後の生形式。 */
export type RouteSearch = Record<string, string | string[] | undefined>;

/** Next.js の `Record<string, string | string[] | undefined>` を `SearchParamsLike` に橋渡し。 */
export function searchParamsFromNext(raw: RouteSearch): SearchParamsLike {
  return {
    get(name: string): string | null {
      const v = raw[name];
      if (Array.isArray(v)) return v[0] ?? null;
      return v ?? null;
    },
  };
}

// chain query 解決: 明示があれば検証して採用、無ければ token の default。
// pay/tip/checkout 全 parser で同一ロジックなので集約する。
export function resolveChainSlugParam(
  chainRaw: string | null,
  token: TokenSymbol,
): { ok: true; slug: ChainSlug } | { ok: false; error: string } {
  if (chainRaw === null || chainRaw.length === 0) {
    return { ok: true, slug: DEFAULT_CHAIN_FOR_SYMBOL[token] };
  }
  if (isValidChainSlug(chainRaw)) {
    return { ok: true, slug: chainRaw };
  }
  return {
    ok: false,
    error:
      'chain は base / arbitrum / optimism / polygon / kaia / ethereum のいずれかを指定してください',
  };
}

export const DECIMAL_PATTERN = /^\d+(\.\d+)?$/;

// /pay・/checkout の記帳補助メタ (任意) の length cap (receiptNo)。pay と checkout の
// 両方で receiptNo の上限として使うため shared に置く。
export const PAY_RECEIPT_NO_MAX = 64;

// amountStr の小数桁が token の decimals を超えると viem の parseUnits は **黙って丸める**
// (例: USDC=6dp で "0.0000009" → 0.000001)。結果、画面表示額と実送金額が乖離する。これを
// 防ぐため精度超過を検出し、呼出側は invalid 扱い (送信 block + 案内) にする。DECIMAL_PATTERN
// 通過を前提 (小数点が高々 1 個)。
export function exceedsTokenPrecision(
  amountStr: string,
  decimals: number,
): boolean {
  const dot = amountStr.indexOf('.');
  if (dot === -1) return false;
  return amountStr.length - dot - 1 > decimals;
}

// http/https のみ許可。URL.canParse を使うので try/catch 不要。
// localhost / 127.0.0.1 は webhook テスト用途で許可するが、本番では
// クリエイターが制御していない URL を貼ると意図しない POST 先になり得る点に注意。
export function sanitizeUrl(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  if (!URL.canParse(trimmed)) return undefined;
  const parsed = new URL(trimmed);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return undefined;
  }
  return parsed.toString();
}

export function sanitizeText(value: string, max: number): string | undefined {
  // 空文字は省略扱い、上限超は切詰。制御文字 strip は lib/sanitize.ts に集約。
  const cleaned = stripControlChars(value);
  if (cleaned.length === 0) return undefined;
  return truncateSafe(cleaned, max);
}
