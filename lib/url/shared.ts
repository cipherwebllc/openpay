// /pay・/tip・/checkout の URL builder/parser で共有する基盤ヘルパ群。
// ここに置くのは {pay, tip, checkout} の 2 つ以上から使われる symbol だけ
// (単一セクション固有のものは各セクションモジュールに置く)。
// import 方向: shared は外部依存 (viem / chains / tokens / sanitize) のみに依存し、
// pay/tip/checkout からは決して import しない (循環回避)。
import { isValidChainSlug, type ChainSlug } from '../chains';
import type { GasMode, PayMode } from '../fee';
import { stripControlChars, truncateSafe } from '../sanitize';
import {
  parseTaxCategoryParam,
  parseTaxRateParam,
  type TaxCategory,
} from '../tax';
import {
  DEFAULT_CHAIN_FOR_SYMBOL,
  deploymentForSlug,
  isGaslessSupported,
  type TokenSymbol,
} from '../tokens';

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

// gas パラメタ解決: merchant のみ明示認識、それ以外 (customer / 不明値 / 未指定 / 旧 fee=)
// は customer 扱い。pay/checkout 双方の parser で同一ロジックなので集約する。
export function parseGasParam(gasRaw: string | null): GasMode {
  return gasRaw === 'merchant' ? 'merchant' : 'customer';
}

// mode の legacy alias 解決: 旧名 "direct" は "standard" に正規化。standard/direct 以外
// (未指定 / 不明値含む) は既定 gasless。pay/checkout で同一の最終 ternary を共有する。
// ⚠️ pay.ts は本 ternary の前段で不明 mode を error で弾く別ゲートを持つ (checkout は持たない)。
// その検証差はここでは吸収しない — 呼出側が各々処理する。
export function resolveModeAlias(modeRaw: string | null): PayMode {
  return modeRaw === 'standard' || modeRaw === 'direct' ? 'standard' : 'gasless';
}

// (token, chain) が gasless mode を提供できない (Pimlico paymaster 未対応) 場合の
// エラーメッセージを返す (gasless 要求かつ非対応のときだけ message、それ以外は null)。
// standard mode 要求は常に通す。pay/checkout で条件・文言が同一。
// ⚠️ 呼出側の返却シェイプは異なる (pay は errorKind:'invalid' を持つ) ため、本 helper は
// string|null のみ返し、各呼出側が自分の返却形へ包む。
export function gaslessSupportError(
  token: TokenSymbol,
  chainSlug: ChainSlug,
  mode: PayMode,
): string | null {
  if (
    mode === 'gasless' &&
    !isGaslessSupported(deploymentForSlug(token, chainSlug))
  ) {
    return `${token} on ${chainSlug} は gasless mode 非対応です (mode=standard を指定してください)`;
  }
  return null;
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

// 同一オリジンの内部パス (例: `/ja/@shop`) だけを許可する。`back=` のような
// 「戻り先」クエリは attacker-controllable なので、そのまま <Link href> に渡すと
// open-redirect / scheme インジェクションになり得る。`/` 始まりの相対パスのみ通し、
// protocol-relative (`//`) / バックスラッシュ / 制御文字 / 過長は拒否 (不正は null)。
export function safeInternalPath(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) return null;
  if (!value.startsWith('/')) return null; // 絶対 URL・相対 (./ や handle) は拒否
  if (value.startsWith('//') || value.startsWith('/\\')) return null; // protocol-relative 等
  if ([...value].some((c) => c.charCodeAt(0) < 0x20)) return null; // 制御文字
  return value;
}

export function sanitizeText(value: string, max: number): string | undefined {
  // 空文字は省略扱い、上限超は切詰。制御文字 strip は lib/sanitize.ts に集約。
  const cleaned = stripControlChars(value);
  if (cleaned.length === 0) return undefined;
  return truncateSafe(cleaned, max);
}

// 記帳補助メタ (税率 / 税区分 / レシート番号) を URL に追記する。pay/checkout の build で同一。
// taxRate は 0 (非課税/対象外) もあるため undefined 判定。receiptNo は sanitize + cap。
export function appendTaxReceiptParams(
  sp: URLSearchParams,
  meta: { taxRate?: number; taxCategory?: TaxCategory; receiptNo?: string },
): void {
  if (meta.taxRate !== undefined) {
    sp.set('tax', String(meta.taxRate));
  }
  if (meta.taxCategory) {
    sp.set('taxcat', meta.taxCategory);
  }
  if (meta.receiptNo) {
    const v = sanitizeText(meta.receiptNo, PAY_RECEIPT_NO_MAX);
    if (v) sp.set('rcpt', v);
  }
}

// 記帳補助メタ (税率 / 税区分 / レシート番号) を URL から parse する。pay/checkout の parser で同一。
export function parseTaxReceiptParams(searchParams: SearchParamsLike): {
  taxRate: number | undefined;
  taxCategory: TaxCategory | undefined;
  receiptNo: string | undefined;
} {
  const rcptRaw = searchParams.get('rcpt');
  const taxRaw = searchParams.get('tax');
  const taxcatRaw = searchParams.get('taxcat');
  return {
    taxRate: parseTaxRateParam(taxRaw),
    taxCategory: parseTaxCategoryParam(taxcatRaw),
    receiptNo: rcptRaw ? sanitizeText(rcptRaw, PAY_RECEIPT_NO_MAX) : undefined,
  };
}

// checkout/tip の callback URL (webhook / success_url / cancel_url / thanksUrl) のうち、
// 現在の origin と host が異なる「第三者ホスト」の重複なし一覧を返す。攻撃者が仕込んだ
// off-origin コールバックは (a) 決済者データを第三者へ POST し (b) 決済後に第三者ページへ
// 遷移し得るため、CheckoutForm/TipForm の payer 向け開示と /scan の interstitial 判定で
// この 1 実装を共有する (SoT)。host 比較は new URL でパースし小文字化・大小無視。空/不正/
// 同一 host は無視する。originHost は "example.com:3000" のような host (protocol/path なし)。
export function offOriginCallbackHosts(
  urls: ReadonlyArray<string | undefined | null>,
  originHost: string,
): string[] {
  const normOrigin = originHost.trim().toLowerCase();
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of urls) {
    if (!raw) continue;
    if (!URL.canParse(raw)) continue;
    const host = new URL(raw).host.toLowerCase();
    if (host.length === 0 || host === normOrigin) continue;
    if (seen.has(host)) continue;
    seen.add(host);
    result.push(host);
  }
  return result;
}
