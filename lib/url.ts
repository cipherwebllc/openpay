// /pay クエリ仕様:
//   to     (必須, 0x) — 主受取人
//   token  ("jpyc" | "usdc")
//   chain  ("base" | "arbitrum" | "optimism" | "polygon", 任意)
//          省略時: usdc → base, jpyc → polygon (DEFAULT_CHAIN_FOR_SYMBOL)
//          (token, chain) ペアに deployment が存在しない組合せは parse エラー
//   gas    ("customer" | "merchant", 省略時 customer) ※ merchant の場合のみ URL に出力
//   amount (任意, 人間可読 — 据え置き QR では省略)
//   mode   ("gasless" | "standard", 省略時 gasless) ※ standard のときのみ URL に出力
//          旧名 "direct" (mode=direct, fee=0) は廃止。"direct" を受けたら "standard"
//          (fee=0.5%) に正規化する legacy alias を parser で提供。
//   split  (任意, "0xB:30,0xC:20" 形式) — 追加受取人と分配 %。to が残余 % を取得
//
// OpenPay 利用手数料は常に店主負担 (顧客には不可視)。`gas` パラメタはネットワーク手数料の負担者
// (gasless モード固有):
//   gas=customer (default): 顧客がネットワーク手数料を上乗せ支払い (画面に明示表示)
//   gas=merchant:           店主がネットワーク手数料も吸収、顧客は請求金額のみ支払う
//   mode=standard 時は OpenPay は gas に touch しないため gas パラメタは irrelevant
//   (build/parse 共に出力しない / 無視する)。
//
// 旧 `fee=include`/`fee=exclude` パラメタは廃止 (parser は silently ignore)。
//
// /tip/[address] クエリ仕様:
//   token   ("jpyc" | "usdc")        必須
//   chain   ChainSlug (任意、規則は /pay と同じ)
//   name    (任意, 表示名 60 文字まで切詰)
//   message (任意, 説明文 200 文字まで切詰)
//   color   (任意, "#rrggbb" 形式)
//   preset  (任意, "100,500,1000" カンマ区切り decimal、最大 6 件)
//
// Tip widget は gas=customer 固定 (preset セマンティクス: クリエイターが preset 額から運営手数料控除後を受け取る、ファンが gas を上乗せ支払い)。
import { getAddress, isAddress, parseUnits } from 'viem';
import type { Address } from 'viem';
import {
  isValidChainSlug,
  type ChainSlug,
} from './chains';
import type { GasMode, PayMode } from './fee';
import {
  DEFAULT_CHAIN_FOR_SYMBOL,
  defaultDeploymentForSymbol,
  deploymentsForSymbol,
  isValidTokenSymbol,
  type TokenSymbol,
} from './tokens';

// PayMode は lib/fee.ts で定義 (fee 計算が depend するため fee.ts を SoT に)。
// URL 利用者向けに re-export して既存 import path を維持する。
export type { PayMode };

export type SplitEntry = {
  to: Address;
  // 1〜99 の整数 %。合計が 100 未満であること (残余を主 to が取得)。
  percent: number;
};

export const SPLIT_MAX_ENTRIES = 3;

export type PayParams = {
  to: Address;
  token: TokenSymbol;
  // chain slug。省略時は build/parse 双方で token の default が使われる
  // (usdc → base, jpyc → polygon)。parsePayParams の戻り値では常に値が入る。
  chain?: ChainSlug;
  gas: GasMode;
  amount?: string;
  mode: PayMode;
  split?: SplitEntry[];
};

function buildSplitParam(split: SplitEntry[]): string {
  return split.map((s) => `${s.to}:${s.percent}`).join(',');
}

// QR ジェネレーター UI で扱う「未確定の draft 入力」(空欄を許容、% は文字列)。
// SplitEntry とは別物 — draft は user 入力の途中状態を表す。
export type SplitDraft = { address: string; percent: string };

export type SplitDraftsParseResult = {
  // 全 draft が valid な時のみ entries が入る (URL に組み込まれる)。
  // 1 件でも error があれば null (all-or-nothing)。
  entries: SplitEntry[] | null;
  // 検証通過した entries の % 合計 (主受取人の取り分計算に使う、表示用途)。
  sum: number;
  // 最初に発生したエラーの種別 (i18n key 引きに使う)。
  error: 'addr' | 'pct' | 'sum' | 'dup' | null;
};

// QrGenerator UI から SplitDraft[] を受け取り、URL 用の SplitEntry[] へ
// 変換する。空欄ペアは無視し、% 合計が 100 に達しない & 主 to との重複が
// 無いことを保証する。1 件でも不正があれば entries=null (URL に部分組込
// 拒否、UI 側で error 表示)。
export function parseSplitDrafts(
  drafts: ReadonlyArray<SplitDraft>,
  primary: Address | null,
): SplitDraftsParseResult {
  const entries: SplitEntry[] = [];
  const seen = new Set<string>();
  let sum = 0;
  let firstError: SplitDraftsParseResult['error'] = null;

  for (const d of drafts) {
    const a = d.address.trim();
    const p = d.percent.trim();
    if (a.length === 0 && p.length === 0) continue;
    if (!isAddress(a)) {
      firstError ??= 'addr';
      continue;
    }
    if (!/^\d+$/.test(p)) {
      firstError ??= 'pct';
      continue;
    }
    const percent = Number(p);
    if (percent < 1 || percent > 99) {
      firstError ??= 'pct';
      continue;
    }
    const checksum = getAddress(a);
    const lower = checksum.toLowerCase();
    if (primary && lower === primary.toLowerCase()) {
      firstError ??= 'dup';
      continue;
    }
    if (seen.has(lower)) {
      firstError ??= 'dup';
      continue;
    }
    seen.add(lower);
    sum += percent;
    entries.push({ to: checksum, percent });
  }

  if (sum >= 100) return { entries: null, sum, error: 'sum' };
  if (firstError) return { entries: null, sum, error: firstError };
  return { entries, sum, error: null };
}

// "0xB:30,0xC:20" を SplitEntry[] へパース。1 つでも不正なら全体を捨てる
// (Pimlico へ意図しない受取人を含む UserOp を投げないため "all-or-nothing")。
function parseSplitParam(raw: string): SplitEntry[] | null {
  const tokens = raw.split(',').map((t) => t.trim()).filter((t) => t.length > 0);
  if (tokens.length === 0 || tokens.length > SPLIT_MAX_ENTRIES) return null;
  const entries: SplitEntry[] = [];
  let total = 0;
  const seen = new Set<string>();
  for (const t of tokens) {
    const idx = t.lastIndexOf(':');
    if (idx <= 0 || idx === t.length - 1) return null;
    const addr = t.slice(0, idx);
    const pctStr = t.slice(idx + 1);
    if (!isAddress(addr)) return null;
    const checksum = getAddress(addr).toLowerCase();
    if (seen.has(checksum)) return null;
    seen.add(checksum);
    if (!/^\d+$/.test(pctStr)) return null;
    const percent = Number(pctStr);
    if (percent < 1 || percent > 99) return null;
    total += percent;
    if (total >= 100) return null;
    entries.push({ to: getAddress(addr), percent });
  }
  return entries;
}

// (symbol, slug) ペアに deployment が存在するかをチェック。
// 例: (jpyc, arbitrum) は deployment が無いので false。
function hasDeployment(symbol: TokenSymbol, slug: ChainSlug): boolean {
  return deploymentsForSymbol(symbol).some((d) => {
    // slug → chainId は env 依存だが、deploymentsForSymbol の出力 chainId を
    // chains 経由で逆引きすると依存が増えるため、ここではシンボル + slug の
    // 関係 (jpyc=polygon のみ、usdc=全 chain) をホワイトリストとして表現。
    if (symbol === 'jpyc') return slug === 'polygon';
    return ['base', 'arbitrum', 'optimism', 'polygon'].includes(slug);
  });
}

export function buildPayPath(params: PayParams): string {
  const sp = new URLSearchParams();
  sp.set('to', params.to);
  sp.set('token', params.token);
  // chain は default と異なる時のみ出力 (旧 QR 互換)。
  // 未指定 (undefined) は default 扱いで、URL には出さない。
  if (params.chain && params.chain !== DEFAULT_CHAIN_FOR_SYMBOL[params.token]) {
    sp.set('chain', params.chain);
  }
  // customer (default) は URL に出さない。merchant のみ明示。
  // standard mode では gas は irrelevant なので出力しない (出ても parser が無視する)。
  if (params.gas === 'merchant' && params.mode !== 'standard') {
    sp.set('gas', 'merchant');
  }
  if (params.amount && params.amount.length > 0) {
    sp.set('amount', params.amount);
  }
  // gasless は既定値なので URL に出さず、旧 QR との互換性を保つ。
  if (params.mode === 'standard') {
    sp.set('mode', 'standard');
  }
  if (params.split && params.split.length > 0) {
    sp.set('split', buildSplitParam(params.split));
  }
  return `/pay?${sp.toString()}`;
}

export function buildPayUrl(origin: string, params: PayParams): string {
  return `${origin}${buildPayPath(params)}`;
}

export type ParsedPayParams =
  | { ok: true; params: PayParams }
  | { ok: false; error: string };

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

export function parsePayParams(searchParams: SearchParamsLike): ParsedPayParams {
  const to = searchParams.get('to');
  const token = searchParams.get('token');
  const chainRaw = searchParams.get('chain');
  const gasRaw = searchParams.get('gas');
  const amount = searchParams.get('amount');
  const mode = searchParams.get('mode');
  const split = searchParams.get('split');

  if (!to) return { ok: false, error: '宛先アドレス (to) が指定されていません' };
  if (!isAddress(to)) return { ok: false, error: '宛先アドレス (to) が不正です' };
  if (!token || !isValidTokenSymbol(token)) {
    return { ok: false, error: 'token は jpyc または usdc を指定してください' };
  }
  // mode=direct は旧名 (fee=0)。既発行 QR を破壊しないため legacy alias として受理し、
  // 後段で standard (fee=0.5%) へ正規化する。
  if (
    mode !== null &&
    mode !== 'gasless' &&
    mode !== 'standard' &&
    mode !== 'direct'
  ) {
    return {
      ok: false,
      error: 'mode は gasless または standard を指定してください',
    };
  }

  // chain 解決: 明示があれば使う、無ければ token の default。
  let chainSlug: ChainSlug;
  if (chainRaw === null || chainRaw.length === 0) {
    chainSlug = DEFAULT_CHAIN_FOR_SYMBOL[token];
  } else if (isValidChainSlug(chainRaw)) {
    chainSlug = chainRaw;
  } else {
    return {
      ok: false,
      error:
        'chain は base / arbitrum / optimism / polygon のいずれかを指定してください',
    };
  }
  // (token, chain) 組合せに deployment があるか確認 (例: jpyc + arbitrum は不可)
  if (!hasDeployment(token, chainSlug)) {
    return {
      ok: false,
      error: `${token} は ${chainSlug} に対応していません`,
    };
  }

  // gas は merchant のみ明示認識、それ以外 (customer / 不明値 / 未指定 / 旧 fee=) は customer 扱い。
  const gas: GasMode = gasRaw === 'merchant' ? 'merchant' : 'customer';
  let parsedSplit: SplitEntry[] | undefined = undefined;
  if (split !== null && split.length > 0) {
    const r = parseSplitParam(split);
    if (r === null) {
      return {
        ok: false,
        error:
          'split は "0xB:30,0xC:20" 形式 (整数 %、合計 < 100、最大 3 件、宛先重複不可) で指定してください',
      };
    }
    // 主 to との重複も禁止
    const primary = getAddress(to).toLowerCase();
    if (r.some((e) => e.to.toLowerCase() === primary)) {
      return {
        ok: false,
        error: 'split に主 to と同じアドレスを含めることはできません',
      };
    }
    parsedSplit = r;
  }

  const normalizedMode: PayMode =
    mode === 'standard' || mode === 'direct' ? 'standard' : 'gasless';

  return {
    ok: true,
    params: {
      to: getAddress(to),
      token,
      chain: chainSlug,
      gas,
      amount: amount && amount.length > 0 ? amount : undefined,
      mode: normalizedMode,
      split: parsedSplit,
    },
  };
}

// ---------------------------------------------------------------------------
// /tip/[address] helpers
// ---------------------------------------------------------------------------

export type TipParams = {
  to: Address;
  token: TokenSymbol;
  // chain slug (PayParams と同じ規則)。省略時は token の default。
  chain?: ChainSlug;
  name?: string;
  message?: string;
  color?: string;
  presets?: string[];
  // 送信成功時に表示するサンキューメッセージ (200 文字まで)
  thanks?: string;
  // 送信成功時に表示するリンク URL (例: 限定 Discord 招待 / Patreon ページ)
  thanksUrl?: string;
  // 送信成功時に POST する webhook URL
  webhook?: string;
};

const TIP_NAME_MAX = 60;
const TIP_MESSAGE_MAX = 200;
const TIP_THANKS_MAX = 200;
const TIP_PRESET_MAX = 6;
export const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;
export const DECIMAL_PATTERN = /^\d+(\.\d+)?$/;
// http/https のみ許可。URL.canParse を使うので try/catch 不要。
// localhost / 127.0.0.1 は webhook テスト用途で許可するが、本番では
// クリエイターが制御していない URL を貼ると意図しない POST 先になり得る点に注意。
function sanitizeUrl(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  if (!URL.canParse(trimmed)) return undefined;
  const parsed = new URL(trimmed);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return undefined;
  }
  return parsed.toString();
}

function sanitizeText(value: string, max: number): string | undefined {
  // C0 制御文字 (タブ含む) と DEL を排除し、長さ上限で切り詰める。空文字は省略扱い。
  const cleaned = value.replace(/[\x00-\x1f\x7f]/g, '').trim();
  if (cleaned.length === 0) return undefined;
  return cleaned.length > max ? cleaned.slice(0, max) : cleaned;
}

function sanitizePresets(raw: string): string[] | undefined {
  // カンマ区切り。空白を許容、不正トークンは捨て、上限件数で切る。
  const seen = new Set<string>();
  const tokens = raw
    .split(',')
    .map((t) => t.trim())
    .filter((t) => {
      if (t.length === 0 || !DECIMAL_PATTERN.test(t) || Number(t) <= 0) {
        return false;
      }
      if (seen.has(t)) return false;
      seen.add(t);
      return true;
    });
  if (tokens.length === 0) return undefined;
  return tokens.slice(0, TIP_PRESET_MAX);
}

export function buildTipPath(params: TipParams): string {
  const sp = new URLSearchParams();
  sp.set('token', params.token);
  if (params.chain && params.chain !== DEFAULT_CHAIN_FOR_SYMBOL[params.token]) {
    sp.set('chain', params.chain);
  }
  if (params.name) {
    const v = sanitizeText(params.name, TIP_NAME_MAX);
    if (v) sp.set('name', v);
  }
  if (params.message) {
    const v = sanitizeText(params.message, TIP_MESSAGE_MAX);
    if (v) sp.set('message', v);
  }
  if (params.color && COLOR_PATTERN.test(params.color)) {
    sp.set('color', params.color.toLowerCase());
  }
  if (params.presets && params.presets.length > 0) {
    const seen = new Set<string>();
    const valid = params.presets
      .filter((p) => {
        if (!DECIMAL_PATTERN.test(p) || Number(p) <= 0) return false;
        if (seen.has(p)) return false;
        seen.add(p);
        return true;
      })
      .slice(0, TIP_PRESET_MAX);
    if (valid.length > 0) sp.set('preset', valid.join(','));
  }
  if (params.thanks) {
    const v = sanitizeText(params.thanks, TIP_THANKS_MAX);
    if (v) sp.set('thanks', v);
  }
  if (params.thanksUrl) {
    const v = sanitizeUrl(params.thanksUrl);
    if (v) sp.set('thanksUrl', v);
  }
  if (params.webhook) {
    const v = sanitizeUrl(params.webhook);
    if (v) sp.set('webhook', v);
  }
  return `/tip/${params.to}?${sp.toString()}`;
}

export function buildTipUrl(origin: string, params: TipParams): string {
  return `${origin}${buildTipPath(params)}`;
}

export type ParsedTipParams =
  | { ok: true; params: TipParams }
  | { ok: false; error: string };

export function parseTipParams(
  addressParam: string,
  searchParams: SearchParamsLike,
): ParsedTipParams {
  if (!addressParam) {
    return { ok: false, error: '宛先アドレスが指定されていません' };
  }
  if (!isAddress(addressParam)) {
    return { ok: false, error: '宛先アドレスが不正です' };
  }
  const token = searchParams.get('token');
  if (!token || !isValidTokenSymbol(token)) {
    return { ok: false, error: 'token は jpyc または usdc を指定してください' };
  }
  const chainRaw = searchParams.get('chain');
  let chainSlug: ChainSlug;
  if (chainRaw === null || chainRaw.length === 0) {
    chainSlug = DEFAULT_CHAIN_FOR_SYMBOL[token];
  } else if (isValidChainSlug(chainRaw)) {
    chainSlug = chainRaw;
  } else {
    return {
      ok: false,
      error:
        'chain は base / arbitrum / optimism / polygon のいずれかを指定してください',
    };
  }
  if (!hasDeployment(token, chainSlug)) {
    return {
      ok: false,
      error: `${token} は ${chainSlug} に対応していません`,
    };
  }

  const name = searchParams.get('name');
  const message = searchParams.get('message');
  const color = searchParams.get('color');
  const preset = searchParams.get('preset');
  const thanks = searchParams.get('thanks');
  const thanksUrl = searchParams.get('thanksUrl');
  const webhook = searchParams.get('webhook');

  const sanitizedColor =
    color && COLOR_PATTERN.test(color) ? color.toLowerCase() : undefined;

  return {
    ok: true,
    params: {
      to: getAddress(addressParam),
      token,
      chain: chainSlug,
      name: name ? sanitizeText(name, TIP_NAME_MAX) : undefined,
      message: message ? sanitizeText(message, TIP_MESSAGE_MAX) : undefined,
      color: sanitizedColor,
      presets: preset ? sanitizePresets(preset) : undefined,
      thanks: thanks ? sanitizeText(thanks, TIP_THANKS_MAX) : undefined,
      thanksUrl: thanksUrl ? sanitizeUrl(thanksUrl) : undefined,
      webhook: webhook ? sanitizeUrl(webhook) : undefined,
    },
  };
}

// ---------------------------------------------------------------------------
// /checkout helpers (Stripe Checkout 相当の line items + 注文 metadata)
// ---------------------------------------------------------------------------
//
// /checkout クエリ仕様:
//   to              (必須, 0x) — 受取マーチャント
//   token           ("jpyc" | "usdc")
//   chain           (任意, ChainSlug、省略時は token の default)
//   items           (必須, "encName:qty:price,..." 形式) — 1〜10 件
//   order_id        (任意, マーチャントの注文 ID、64 文字まで)
//   description     (任意, 説明文 200 文字まで)
//   customer_email  (任意, 240 文字まで、prefill 用 — クライアントは送信しない)
//   gas             ("customer" | "merchant", 省略時 customer)
//   mode            ("gasless" | "standard", 省略時 gasless) ※ standard のときのみ URL に出力
//   success_url     (任意, http(s) — 決済成功後 redirect 先)
//   cancel_url      (任意, http(s) — 「中止して戻る」リンク)
//   webhook         (任意, http(s) — 成功時 POST 先)
//
// items の encoding: name は encodeURIComponent で URI-encode してから ":" qty
// ":" price で結合し、複数 items は "," で連結。decode 側は "," → ":" の順に
// split して decodeURIComponent + sanitizeText する。これにより name に ":" や
// "," を含めても 衝突しない。
//
// webhook payload は Tip と互換シェイプ (type 識別子だけ "openpay.checkout.success")。
// マーチャントは 1 つの handler で Tip / Checkout 両対応可能。

export type CheckoutItem = {
  name: string;
  qty: number;       // 1〜999 の整数
  price: string;     // 人間可読 decimal (例: "25.00")。token decimals 内に収まる
};

export type CheckoutParams = {
  to: Address;
  token: TokenSymbol;
  chain?: ChainSlug;
  gas: GasMode;
  // 決済モード (PayParams と同じ意味論)。standard では gas は無視される。
  // build 時は省略可 (省略時 default gasless)。parse 結果では常に値が入る。
  mode?: PayMode;
  items: CheckoutItem[];
  orderId?: string;
  description?: string;
  customerEmail?: string;
  successUrl?: string;
  cancelUrl?: string;
  webhook?: string;
};

export const CHECKOUT_MAX_ITEMS = 10;
export const CHECKOUT_QTY_MAX = 999;
const CHECKOUT_NAME_MAX = 80;
const CHECKOUT_ORDER_ID_MAX = 64;
const CHECKOUT_DESCRIPTION_MAX = 200;
const CHECKOUT_EMAIL_MAX = 240;

function encodeItem(it: CheckoutItem): string {
  return `${encodeURIComponent(it.name)}:${it.qty}:${it.price}`;
}

export function encodeItems(items: ReadonlyArray<CheckoutItem>): string {
  return items.map(encodeItem).join(',');
}

// qty / price フィールドの共通検証 (URL parser と draft parser の両方で使う)。
// reason は draft parser がエラー対象 row の UI 表示用に区別する単位。
type ItemFieldsValidation =
  | { ok: true; qty: number }
  | { ok: false; reason: 'qty' | 'price' };

function validateItemFields(
  qtyStr: string,
  priceStr: string,
  decimals: number,
): ItemFieldsValidation {
  if (!/^\d+$/.test(qtyStr)) return { ok: false, reason: 'qty' };
  const qty = Number(qtyStr);
  if (qty < 1 || qty > CHECKOUT_QTY_MAX) return { ok: false, reason: 'qty' };
  if (!DECIMAL_PATTERN.test(priceStr)) return { ok: false, reason: 'price' };
  const dotIdx = priceStr.indexOf('.');
  const fracDigits = dotIdx === -1 ? 0 : priceStr.length - dotIdx - 1;
  if (fracDigits > decimals) return { ok: false, reason: 'price' };
  // 0 / 0.0 / 00.000 等は無効 (実質ゼロ価格は意味なし)
  if (/^0+(\.0+)?$/.test(priceStr)) return { ok: false, reason: 'price' };
  return { ok: true, qty };
}

// 不正値があれば全体を捨てる (all-or-nothing)。decimals は token によって異なる
// ため呼出側から渡す。decodeURIComponent は malformed %XX で throw するため、
// その場合は null を返してエラーパスへ。
function parseItemsParam(raw: string, decimals: number): CheckoutItem[] | null {
  const tokens = raw.split(',').map((t) => t.trim()).filter((t) => t.length > 0);
  if (tokens.length === 0 || tokens.length > CHECKOUT_MAX_ITEMS) return null;
  const items: CheckoutItem[] = [];
  for (const t of tokens) {
    const parts = t.split(':');
    if (parts.length !== 3) return null;
    const [encodedName, qtyStr, priceStr] = parts;
    if (encodedName.length === 0) return null;
    let decoded: string;
    try {
      decoded = decodeURIComponent(encodedName);
    } catch {
      return null;
    }
    // C0 制御文字 (タブ含む) と DEL を排除し、長さ上限で切詰。空文字は invalid。
    const name = decoded.replace(/[\x00-\x1f\x7f]/g, '').trim();
    if (name.length === 0) return null;
    const trimmedName =
      name.length > CHECKOUT_NAME_MAX ? name.slice(0, CHECKOUT_NAME_MAX) : name;
    const v = validateItemFields(qtyStr, priceStr, decimals);
    if (!v.ok) return null;
    items.push({ name: trimmedName, qty: v.qty, price: priceStr });
  }
  return items;
}

export function buildCheckoutPath(params: CheckoutParams): string {
  const sp = new URLSearchParams();
  sp.set('to', params.to);
  sp.set('token', params.token);
  if (params.chain && params.chain !== DEFAULT_CHAIN_FOR_SYMBOL[params.token]) {
    sp.set('chain', params.chain);
  }
  sp.set('items', encodeItems(params.items));
  // standard mode では gas は irrelevant なので出力しない (出ても parser が無視する)。
  const effectiveMode: PayMode = params.mode ?? 'gasless';
  if (params.gas === 'merchant' && effectiveMode !== 'standard') {
    sp.set('gas', 'merchant');
  }
  if (effectiveMode === 'standard') {
    sp.set('mode', 'standard');
  }
  if (params.orderId) {
    const v = sanitizeText(params.orderId, CHECKOUT_ORDER_ID_MAX);
    if (v) sp.set('order_id', v);
  }
  if (params.description) {
    const v = sanitizeText(params.description, CHECKOUT_DESCRIPTION_MAX);
    if (v) sp.set('description', v);
  }
  if (params.customerEmail) {
    const v = sanitizeText(params.customerEmail, CHECKOUT_EMAIL_MAX);
    if (v) sp.set('customer_email', v);
  }
  if (params.successUrl) {
    const v = sanitizeUrl(params.successUrl);
    if (v) sp.set('success_url', v);
  }
  if (params.cancelUrl) {
    const v = sanitizeUrl(params.cancelUrl);
    if (v) sp.set('cancel_url', v);
  }
  if (params.webhook) {
    const v = sanitizeUrl(params.webhook);
    if (v) sp.set('webhook', v);
  }
  return `/checkout?${sp.toString()}`;
}

export function buildCheckoutUrl(origin: string, params: CheckoutParams): string {
  return `${origin}${buildCheckoutPath(params)}`;
}

export type ParsedCheckoutParams =
  | { ok: true; params: CheckoutParams }
  | { ok: false; error: string };

export function parseCheckoutParams(
  searchParams: SearchParamsLike,
): ParsedCheckoutParams {
  const to = searchParams.get('to');
  const token = searchParams.get('token');
  const chainRaw = searchParams.get('chain');
  const itemsRaw = searchParams.get('items');
  const gasRaw = searchParams.get('gas');
  const modeRaw = searchParams.get('mode');
  const orderId = searchParams.get('order_id');
  const description = searchParams.get('description');
  const customerEmail = searchParams.get('customer_email');
  const successUrl = searchParams.get('success_url');
  const cancelUrl = searchParams.get('cancel_url');
  const webhook = searchParams.get('webhook');

  if (!to) return { ok: false, error: '宛先アドレス (to) が指定されていません' };
  if (!isAddress(to)) return { ok: false, error: '宛先アドレス (to) が不正です' };
  if (!token || !isValidTokenSymbol(token)) {
    return { ok: false, error: 'token は jpyc または usdc を指定してください' };
  }

  let chainSlug: ChainSlug;
  if (chainRaw === null || chainRaw.length === 0) {
    chainSlug = DEFAULT_CHAIN_FOR_SYMBOL[token];
  } else if (isValidChainSlug(chainRaw)) {
    chainSlug = chainRaw;
  } else {
    return {
      ok: false,
      error:
        'chain は base / arbitrum / optimism / polygon のいずれかを指定してください',
    };
  }
  if (!hasDeployment(token, chainSlug)) {
    return {
      ok: false,
      error: `${token} は ${chainSlug} に対応していません`,
    };
  }

  if (!itemsRaw || itemsRaw.length === 0) {
    return { ok: false, error: 'items を指定してください (最低 1 件)' };
  }
  // decimals は token に依存。defaultDeployment で取得 (USDC は全 chain 6 / JPYC は 18 で chain 不変)
  const decimals = defaultDeploymentForSymbol(token).decimals;
  const items = parseItemsParam(itemsRaw, decimals);
  if (items === null) {
    return {
      ok: false,
      error:
        'items は "name:qty:price,..." 形式 (qty 1〜999、price は token decimals 以内、最大 10 件) で指定してください',
    };
  }

  const gas: GasMode = gasRaw === 'merchant' ? 'merchant' : 'customer';
  // mode は /pay と同じ legacy alias (direct → standard) を適用。それ以外の不明値は
  // checkout では default の gasless に倒す (請求書文脈では UI を壊さない方が大事)。
  const mode: PayMode =
    modeRaw === 'standard' || modeRaw === 'direct' ? 'standard' : 'gasless';

  return {
    ok: true,
    params: {
      to: getAddress(to),
      token,
      chain: chainSlug,
      gas,
      mode,
      items,
      orderId: orderId ? sanitizeText(orderId, CHECKOUT_ORDER_ID_MAX) : undefined,
      description: description
        ? sanitizeText(description, CHECKOUT_DESCRIPTION_MAX)
        : undefined,
      customerEmail: customerEmail
        ? sanitizeText(customerEmail, CHECKOUT_EMAIL_MAX)
        : undefined,
      successUrl: successUrl ? sanitizeUrl(successUrl) : undefined,
      cancelUrl: cancelUrl ? sanitizeUrl(cancelUrl) : undefined,
      webhook: webhook ? sanitizeUrl(webhook) : undefined,
    },
  };
}

// CheckoutLinkGenerator UI 用の draft 入力 (空欄を許容、qty/price は文字列)。
// CheckoutItem は parse 済の確定型。
export type CheckoutItemDraft = {
  name: string;
  qty: string;
  price: string;
};

// all-or-nothing (parseSplitDrafts と同型): 1 件でも error なら items=null、
// 個別 row のエラーは errors[] で返して UI に「商品 #N: 〜」と出す。
export type CheckoutItemDraftsParseResult = {
  items: CheckoutItem[] | null;
  errors: Array<{ index: number; reason: 'empty' | 'qty' | 'price' }>;
};

export function parseCheckoutItemDrafts(
  drafts: ReadonlyArray<CheckoutItemDraft>,
  decimals: number,
): CheckoutItemDraftsParseResult {
  const items: CheckoutItem[] = [];
  const errors: Array<{ index: number; reason: 'empty' | 'qty' | 'price' }> = [];

  drafts.forEach((d, i) => {
    const name = d.name.replace(/[\x00-\x1f\x7f]/g, '').trim();
    const qtyStr = d.qty.trim();
    const priceStr = d.price.trim();
    // 全フィールドが空欄の draft は「未入力 row」として無視 (UI 上「商品を追加」して
    // 空のまま残す UX を許容)。1 つでも入力があれば validate 対象。
    if (name.length === 0 && qtyStr.length === 0 && priceStr.length === 0) return;
    if (name.length === 0 || qtyStr.length === 0 || priceStr.length === 0) {
      errors.push({ index: i, reason: 'empty' });
      return;
    }
    const v = validateItemFields(qtyStr, priceStr, decimals);
    if (!v.ok) {
      errors.push({ index: i, reason: v.reason });
      return;
    }
    const trimmedName =
      name.length > CHECKOUT_NAME_MAX ? name.slice(0, CHECKOUT_NAME_MAX) : name;
    items.push({ name: trimmedName, qty: v.qty, price: priceStr });
  });

  return {
    items: errors.length === 0 && items.length > 0 ? items : null,
    errors,
  };
}

// items 合計を bigint で計算 (token decimals を反映)。fee 計算は既存の calcBreakdown
// にこの bigint を渡せば良いので、checkout 専用の breakdown 関数は不要。
export function calcCheckoutTotal(
  items: ReadonlyArray<CheckoutItem>,
  decimals: number,
): bigint {
  let total = 0n;
  for (const it of items) {
    total += parseUnits(it.price, decimals) * BigInt(it.qty);
  }
  return total;
}

// 通貨ごとの既定 preset (URL に preset 指定がない時に使う)。
// tip 文脈で違和感のない常用額レンジを起点に置く。クリエイターは
// TipEmbedGenerator で任意の preset を上書き可能、ファンも custom amount で
// 100 JPYC / 1 USDC のようなカジュアル tip を送れる。
export const DEFAULT_TIP_PRESETS: Record<TokenSymbol, string[]> = {
  jpyc: ['300', '1000', '3000'],
  usdc: ['5', '20', '50'],
};
