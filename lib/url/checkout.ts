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
// 複数商品カートでは per-item の税/メモを履歴に残すため 6 セグへ拡張可:
// "encName:qty:price:taxRate:taxCategory:encMemo" (在るときのみ・旧 3 セグと後方互換)。
//
// webhook payload は Tip と互換シェイプ (type 識別子だけ "openpay.checkout.success")。
// マーチャントは 1 つの handler で Tip / Checkout 両対応可能。
import { getAddress, isAddress, parseUnits } from 'viem';
import type { Address } from 'viem';
import type { ChainSlug } from '../chains';
import type { GasMode, PayMode } from '../fee';
import {
  isMobileOrderFeeKind,
  type FeePayer,
  type MobileOrderFeeKind,
} from '../mobileOrderFee';
import { stripControlChars, truncateSafe } from '../sanitize';
import {
  parseTaxCategoryParam,
  parseTaxRateParam,
  type TaxCategory,
} from '../tax';
import {
  DEFAULT_CHAIN_FOR_SYMBOL,
  defaultDeploymentForSymbol,
  isValidTokenSymbol,
  symbolHasDeployment,
  type TokenSymbol,
} from '../tokens';
import {
  appendTaxReceiptParams,
  DECIMAL_PATTERN,
  gaslessSupportError,
  parseGasParam,
  parseTaxReceiptParams,
  resolveChainSlugParam,
  resolveModeAlias,
  sanitizeText,
  sanitizeUrl,
  type SearchParamsLike,
} from './shared';

export type CheckoutItem = {
  name: string;
  qty: number;       // 1〜999 の整数
  price: string;     // 人間可読 decimal (例: "25.00")。token decimals 内に収まる
  // --- 複数商品カート対応で追加 (任意・per-item 税/メモ)。決済側の履歴に明細を残すため
  //     URL に乗せる。在るときだけ 6 セグ encoding に拡張 (旧 3 セグと後方互換)。
  taxRate?: number;
  taxCategory?: TaxCategory;
  memo?: string;
};

// /checkout の手数料種別。mobile-order の storefront/preorder に加え、レジ (店頭POS) 由来を示す
// 'register' を持つ。register は CheckoutForm が **standard 経路で** recover の OpenPay利用料 % を
// 課金する合図 (RegisterMode のみ設定・relay 経路は既存 recover が処理するので合図不要)。
export type CheckoutFeeKind = MobileOrderFeeKind | 'register';
function isCheckoutFeeKind(v: unknown): v is CheckoutFeeKind {
  return isMobileOrderFeeKind(v) || v === 'register';
}

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
  // --- 記帳補助メタ (任意・チェックアウト単位の共通税)。レジモードが設定する。 ---
  // 税率 (%)。0 (非課税/対象外) もありうる。
  taxRate?: number;
  taxCategory?: TaxCategory;
  receiptNo?: string;
  // --- モバイル注文システム利用料 (任意・MobileOrderView のみが設定)。 ---
  // feeKind が present のとき CheckoutForm が経路非依存 (relay/standard 両方) に 1%(店頭)/3%(事前)
  // を分割する (実際の発火は flag env.enableMobileOrderFee と AND)。不在 = 従来動作 (手数料ゼロ・
  // /pay QR や通常 checkout リンクは feeKind を持たないので一切影響しない)。
  // feePayer は preorder のときのみ意味を持つ (merchant=店舗負担 / customer=顧客上乗せ)。
  // 'register' (レジ・RegisterMode 由来) は standard 経路で recover の OpenPay利用料 % を店舗負担で
  // 課金する合図 (feePayer は無関係)。
  feeKind?: CheckoutFeeKind;
  feePayer?: FeePayer;
  // --- 受取予定時刻 (任意・Phase 4・preorder のスロット選択・MobileOrderView のみが設定)。 ---
  // 絶対 ms。webhook payload へ素通しされ受注に保存・厨房/ホールが表示する (advisory・money-path 非該当)。
  pickupAt?: number;
};

export const CHECKOUT_MAX_ITEMS = 10;
export const CHECKOUT_QTY_MAX = 999;
const CHECKOUT_NAME_MAX = 80;
const CHECKOUT_ITEM_MEMO_MAX = 80;
const CHECKOUT_ORDER_ID_MAX = 64;
const CHECKOUT_DESCRIPTION_MAX = 200;
const CHECKOUT_EMAIL_MAX = 240;

function encodeItem(it: CheckoutItem): string {
  const base = `${encodeURIComponent(it.name)}:${it.qty}:${it.price}`;
  // per-item の税/メモが在るときだけ 6 セグへ拡張。無ければ従来 3 セグ (旧 QR 互換)。
  const hasMeta =
    it.taxRate !== undefined ||
    it.taxCategory !== undefined ||
    (it.memo !== undefined && it.memo.length > 0);
  if (!hasMeta) return base;
  const tax = it.taxRate !== undefined ? String(it.taxRate) : '';
  const cat = it.taxCategory ?? '';
  const memo = it.memo ? encodeURIComponent(it.memo) : '';
  return `${base}:${tax}:${cat}:${memo}`;
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
    // 3 = legacy (name:qty:price)、6 = 複数商品カート (+taxRate:taxCategory:memo)。
    if (parts.length !== 3 && parts.length !== 6) return null;
    const [encodedName, qtyStr, priceStr, taxStr, catStr, memoStr] = parts;
    if (encodedName.length === 0) return null;
    let decoded: string;
    try {
      decoded = decodeURIComponent(encodedName);
    } catch {
      return null;
    }
    // 空文字は invalid、上限超は切詰。
    const name = stripControlChars(decoded);
    if (name.length === 0) return null;
    const trimmedName = truncateSafe(name, CHECKOUT_NAME_MAX);
    const v = validateItemFields(qtyStr, priceStr, decimals);
    if (!v.ok) return null;
    const item: CheckoutItem = { name: trimmedName, qty: v.qty, price: priceStr };
    if (parts.length === 6) {
      // 不正な税/メモは黙って落とす (決済の正本は qty/price なので止めない)。
      const taxRate = parseTaxRateParam(taxStr || null);
      if (taxRate !== undefined) item.taxRate = taxRate;
      const taxCategory = parseTaxCategoryParam(catStr || null);
      if (taxCategory !== undefined) item.taxCategory = taxCategory;
      if (memoStr && memoStr.length > 0) {
        let m: string;
        try {
          m = decodeURIComponent(memoStr);
        } catch {
          return null;
        }
        const cleaned = stripControlChars(m);
        if (cleaned.length > 0) item.memo = truncateSafe(cleaned, CHECKOUT_ITEM_MEMO_MAX);
      }
    }
    items.push(item);
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
  // モバイル注文システム利用料の種別/負担者 (present のときだけ・MobileOrderView が設定)。
  // feePayer は preorder のときのみ有意 (storefront は常に店舗負担なので出力しない)。
  if (params.feeKind) {
    sp.set('fee_kind', params.feeKind);
    if (params.feeKind === 'preorder' && params.feePayer) {
      sp.set('fee_payer', params.feePayer);
    }
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
  // 記帳補助メタ (在るときだけ・税は checkout 単位の共通値)。pay と共通の shared helper で追記。
  appendTaxReceiptParams(sp, params);
  // 受取予定時刻 (在るときだけ・正の安全整数 ms)。preorder のスロット選択。
  if (
    typeof params.pickupAt === 'number' &&
    Number.isSafeInteger(params.pickupAt) &&
    params.pickupAt > 0
  ) {
    sp.set('pickup_at', String(params.pickupAt));
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
  const feeKindRaw = searchParams.get('fee_kind');
  const feePayerRaw = searchParams.get('fee_payer');
  const pickupAtRaw = searchParams.get('pickup_at');

  if (!to) return { ok: false, error: '宛先アドレス (to) が指定されていません' };
  if (!isAddress(to)) return { ok: false, error: '宛先アドレス (to) が不正です' };
  if (!token || !isValidTokenSymbol(token)) {
    return { ok: false, error: 'token は jpyc または usdc を指定してください' };
  }

  const chainResult = resolveChainSlugParam(chainRaw, token);
  if (!chainResult.ok) {
    return { ok: false, error: chainResult.error };
  }
  const chainSlug = chainResult.slug;
  if (!symbolHasDeployment(token, chainSlug)) {
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

  const gas: GasMode = parseGasParam(gasRaw);
  // mode は /pay と同じ legacy alias (direct → standard) を適用。それ以外の不明値は
  // checkout では default の gasless に倒す (請求書文脈では UI を壊さない方が大事)。
  // ⚠️ pay.ts と違い不明 mode を error で弾くゲートは持たない (silently gasless)。
  const mode: PayMode = resolveModeAlias(modeRaw);

  // (token, chain) が gasless mode を提供できない場合は gasless 要求を reject。
  // /pay と同じく、standard mode 要求は通す。条件/文言は pay と共通 helper。
  const gaslessErr = gaslessSupportError(token, chainSlug, mode);
  if (gaslessErr) {
    return { ok: false, error: gaslessErr };
  }

  // 記帳補助メタ (税率/税区分/レシート番号) は pay と共通の shared helper で parse。
  const { taxRate, taxCategory, receiptNo } = parseTaxReceiptParams(searchParams);

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
      taxRate,
      taxCategory,
      receiptNo,
      // モバイル注文システム利用料 (strict 検証・不正値は undefined = 従来動作)。feePayer は
      // 有効な feeKind があるときのみ採用 (feeKind 無しの孤立 feePayer は無視)。
      feeKind: isCheckoutFeeKind(feeKindRaw) ? feeKindRaw : undefined,
      feePayer:
        isMobileOrderFeeKind(feeKindRaw) &&
        (feePayerRaw === 'merchant' || feePayerRaw === 'customer')
          ? feePayerRaw
          : undefined,
      // 受取予定時刻 (任意・正の安全整数 ms のみ・0/不正は undefined = serialize の > 0 と対称)。
      pickupAt:
        pickupAtRaw &&
        /^\d+$/.test(pickupAtRaw) &&
        Number.isSafeInteger(Number(pickupAtRaw)) &&
        Number(pickupAtRaw) > 0
          ? Number(pickupAtRaw)
          : undefined,
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
    const name = stripControlChars(d.name);
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
    const trimmedName = truncateSafe(name, CHECKOUT_NAME_MAX);
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
