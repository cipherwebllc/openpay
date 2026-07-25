// /pay クエリ仕様:
//   to     (必須, 0x) — 主受取人
//   token  ("jpyc" | "usdc")
//   chain  ("base" | "arbitrum" | "optimism" | "polygon", 任意)
//          省略時: usdc → base, jpyc → polygon (DEFAULT_CHAIN_FOR_SYMBOL)
//          (token, chain) ペアに deployment が存在しない組合せは parse エラー
//   gas    ("customer" | "merchant", 省略時 customer) ※ merchant の場合のみ URL に出力
//   amount (任意, 人間可読 — 据え置き QR では省略)
//   mode   ("gasless" | "standard", 省略時 gasless) ※ standard のときのみ URL に出力
//          旧名 "direct" は廃止。"direct" を受けたら "standard" に正規化する
//          legacy alias を parser で提供 (既発行 QR の互換維持)。
//   split  (任意, "0xB:30,0xC:20" 形式) — 追加受取人と分配 %。to が残余 % を取得
//
// `gas` パラメタはネットワーク手数料の負担者 (gasless モード固有):
//   gas=customer (default): 顧客がネットワーク手数料を上乗せ支払い (画面に明示表示)
//   gas=merchant:           店主がネットワーク手数料も吸収、顧客は請求金額のみ支払う
//   mode=standard 時は OpenPay は gas に touch しないため gas パラメタは irrelevant
//   (build/parse 共に出力しない / 無視する)。
//
// 旧 `fee=include`/`fee=exclude` パラメタは廃止 (parser は silently ignore)。
import { getAddress, isAddress } from 'viem';
import type { Address } from 'viem';
import type { ChainSlug } from '../chains';
import type { GasMode, PayMode } from '../fee';
import { rateIsSane } from '../fx';
import { type TaxCategory } from '../tax';
import {
  DEFAULT_CHAIN_FOR_SYMBOL,
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
  type SearchParamsLike,
} from './shared';

export type SplitEntry = {
  to: Address;
  // 1〜99 の整数 %。合計が 100 未満であること (残余を主 to が取得)。
  percent: number;
};

export const SPLIT_MAX_ENTRIES = 3;

// /pay・/checkout の記帳補助メタ (任意) の length cap。URL/QR 肥大化と自由入力の攻撃面を制限。
export const PAY_PRODUCT_NAME_MAX = 80;
export const PAY_MEMO_MAX = 200;
export const PAY_STORE_NAME_MAX = 48;

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
  // cross-chain 受信を許可するかの flag (Circle Gateway / CCTP V2 経由)。
  // default true (店主側で許可、buyer 側が target chain 以外で USDC を持っている
  // 時に PaymentForm が代替 path を提示する)。
  // false 時のみ URL に `crossChain=false` として出力 (default の URL は不変、
  // 旧 QR との互換性維持)。USDC のみ意味があり、JPYC では PaymentForm が無視する。
  crossChain?: boolean;
  // --- 動的 QR (FX 換算・画面上の期限目安付き) 用の付帯情報 ---
  // 支払いの正本は token+amount。以下は「画面上の期限目安」と「顧客への文脈表示
  // (元の価格建て+レート)」のためだけに使い、既定 URL には出さない (在るときだけ
  // serialize)。QR パラメータは未署名で支払者が改変できるため、exp は /pay UI 内で
  // 陳腐なレートの利用を止めるだけの advisory であり、サーバ強制の有効期限ではない。
  // UI 上の期限目安 (unix 秒)。超過時に正規の /pay 画面が支払いをブロックする。
  expiresAt?: number;
  // 元の価格建ての人間可読額 (例 "1000")。anchor token は token の counterpart として導出。
  priceRefAmount?: string;
  // 生成時の usdcJpy (例 "156.32")。顧客表示用。
  fxRate?: string;
  // --- 記帳補助メタデータ (任意・表示/会計用)。在るときだけ URL に出る (旧 QR 不変)。 ---
  // 店舗名 (予約済 storeName field を URL に乗せ、決済側の履歴に記録できるようにする)。
  storeName?: string;
  // 商品名 / 用途名。
  productName?: string;
  // 会計補助メモ。
  memo?: string;
  // 税率 (%)。0 (非課税/対象外) もありうるので undefined と区別する。
  taxRate?: number;
  // 内部税区分 (CSV/freee マッピング鍵)。
  taxCategory?: TaxCategory;
  // 管理番号 / レシート番号。
  receiptNo?: string;
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
  // default (undefined または true) は URL に出さず旧 QR と完全互換。
  // false (= 店主が cross-chain 拒否) を明示するときだけ出力。
  if (params.crossChain === false) {
    sp.set('crossChain', 'false');
  }
  // 動的 QR 付帯情報 (在るときだけ出力・既定 URL は不変)。
  if (params.expiresAt !== undefined) {
    sp.set('exp', String(params.expiresAt));
  }
  if (params.priceRefAmount && params.priceRefAmount.length > 0) {
    sp.set('refAmt', params.priceRefAmount);
  }
  if (params.fxRate && params.fxRate.length > 0) {
    sp.set('fxRate', params.fxRate);
  }
  // 記帳補助メタ (在るときだけ・sanitize + cap)。
  if (params.storeName) {
    const v = sanitizeText(params.storeName, PAY_STORE_NAME_MAX);
    if (v) sp.set('store', v);
  }
  if (params.productName) {
    const v = sanitizeText(params.productName, PAY_PRODUCT_NAME_MAX);
    if (v) sp.set('pname', v);
  }
  if (params.memo) {
    const v = sanitizeText(params.memo, PAY_MEMO_MAX);
    if (v) sp.set('memo', v);
  }
  // 記帳補助メタ (税率/税区分/レシート番号) は checkout と共通の shared helper で追記。
  appendTaxReceiptParams(sp, params);
  return `/pay?${sp.toString()}`;
}

export function buildPayUrl(origin: string, params: PayParams): string {
  return `${origin}${buildPayPath(params)}`;
}

export type ParsedPayParams =
  | { ok: true; params: PayParams }
  | { ok: false; errorKind: 'empty' | 'invalid'; error: string };

// `/pay` URL に乗っている query key の集合。bare /pay (search 空) と
// 「to は無いが他は付いている (URL 半壊)」を区別するために使う。
const PAY_PARAM_KEYS = [
  'to',
  'token',
  'chain',
  'gas',
  'amount',
  'mode',
  'split',
  'crossChain',
  'exp',
  'refAmt',
  'fxRate',
  'store',
  'pname',
  'memo',
  'tax',
  'taxcat',
  'rcpt',
] as const;

export function parsePayParams(searchParams: SearchParamsLike): ParsedPayParams {
  const to = searchParams.get('to');
  const token = searchParams.get('token');
  const chainRaw = searchParams.get('chain');
  const gasRaw = searchParams.get('gas');
  const amount = searchParams.get('amount');
  const mode = searchParams.get('mode');
  const split = searchParams.get('split');
  const crossChainRaw = searchParams.get('crossChain');
  const expRaw = searchParams.get('exp');
  const refAmtRaw = searchParams.get('refAmt');
  const fxRateRaw = searchParams.get('fxRate');
  const storeRaw = searchParams.get('store');
  const pnameRaw = searchParams.get('pname');
  const memoRaw = searchParams.get('memo');

  if (!to) {
    // bare /pay (search 空) と「to なし + 他 param あり」を区別する。
    // 前者は誤って /pay を直訪したユーザに friendly landing を出すための signal、
    // 後者は QR 生成側の URL バグなので赤エラーを残す。
    const hasAnyParam = PAY_PARAM_KEYS.some(
      (k) => searchParams.get(k) !== null,
    );
    return {
      ok: false,
      errorKind: hasAnyParam ? 'invalid' : 'empty',
      error: '宛先アドレス (to) が指定されていません',
    };
  }
  if (!isAddress(to))
    return {
      ok: false,
      errorKind: 'invalid',
      error: '宛先アドレス (to) が不正です',
    };
  if (!token || !isValidTokenSymbol(token)) {
    return {
      ok: false,
      errorKind: 'invalid',
      error: 'token は jpyc または usdc を指定してください',
    };
  }
  // mode=direct は旧名 (fee=0)。既発行 QR を破壊しないため legacy alias として受理し、
  // 後段で standard へ正規化する。
  if (
    mode !== null &&
    mode !== 'gasless' &&
    mode !== 'standard' &&
    mode !== 'direct'
  ) {
    return {
      ok: false,
      errorKind: 'invalid',
      error: 'mode は gasless または standard を指定してください',
    };
  }

  const chainResult = resolveChainSlugParam(chainRaw, token);
  if (!chainResult.ok) {
    return { ok: false, errorKind: 'invalid', error: chainResult.error };
  }
  const chainSlug = chainResult.slug;
  // (token, chain) 組合せに deployment があるか確認 (例: jpyc + arbitrum は不可)
  if (!symbolHasDeployment(token, chainSlug)) {
    return {
      ok: false,
      errorKind: 'invalid',
      error: `${token} は ${chainSlug} に対応していません`,
    };
  }

  // gas は merchant のみ明示認識、それ以外 (customer / 不明値 / 未指定 / 旧 fee=) は customer 扱い。
  const gas: GasMode = parseGasParam(gasRaw);
  let parsedSplit: SplitEntry[] | undefined = undefined;
  if (split !== null && split.length > 0) {
    const r = parseSplitParam(split);
    if (r === null) {
      return {
        ok: false,
        errorKind: 'invalid',
        error:
          'split は "0xB:30,0xC:20" 形式 (整数 %、合計 < 100、最大 3 件、宛先重複不可) で指定してください',
      };
    }
    // 主 to との重複も禁止
    const primary = getAddress(to).toLowerCase();
    if (r.some((e) => e.to.toLowerCase() === primary)) {
      return {
        ok: false,
        errorKind: 'invalid',
        error: 'split に主 to と同じアドレスを含めることはできません',
      };
    }
    parsedSplit = r;
  }

  const normalizedMode: PayMode = resolveModeAlias(mode);

  // (token, chain) が gasless mode を提供できない (Pimlico paymaster 未対応) なら
  // gasless 要求を reject。standard mode 要求は通す。条件/文言は checkout と共通 helper。
  // 2026-05 時点で全 USDC chain が ERC20 paymaster 対応のため、現状ここで弾かれる
  // ケースは buyer-only chain のみ。
  const gaslessErr = gaslessSupportError(token, chainSlug, normalizedMode);
  if (gaslessErr) {
    return { ok: false, errorKind: 'invalid', error: gaslessErr };
  }

  // crossChain は明示的 "false" のみ false、それ以外 (未指定 / "true" / 不明値)
  // は default の true として扱う。本仕様により旧 QR は影響を受けず、phase 2
  // 投入後に店主が opt-out したいケースでのみ URL に出る。
  const crossChain: boolean = crossChainRaw !== 'false';

  // 動的 QR 付帯情報を validate して degrade (壊れていても支払いは止めない)。
  // exp: 安全な正整数のみ採用。不正/欠落/桁あふれ (Number.MAX_SAFE_INTEGER 超 → Infinity 等)
  // は undefined (= 期限なし = 従来 QR と同じ挙動・壊れた exp で支払いを止めない)。
  // 未署名パラメータなので、ここで値を parse しても支払者へのサーバ側強制にはならない。
  // 実効的な期限には店舗が発行する QR パラメータ全体の署名とサーバ検証が必要であり、
  // 本件では「検証したように見えるだけ」のガードを足さず /pay UI の目安としてのみ扱う。
  const expNum =
    expRaw && /^[0-9]+$/.test(expRaw) ? Number(expRaw) : Number.NaN;
  const expiresAt =
    Number.isSafeInteger(expNum) && expNum > 0 ? expNum : undefined;
  // refAmt: 人間可読 decimal のみ。表示専用 (malformed なら文脈非表示に degrade)。
  const priceRefAmount =
    refAmtRaw && DECIMAL_PATTERN.test(refAmtRaw) ? refAmtRaw : undefined;
  // fxRate: 数値かつ sanity band 内のみ。表示専用。
  const fxRate =
    fxRateRaw && rateIsSane(Number(fxRateRaw)) ? fxRateRaw : undefined;

  // 記帳補助メタ (任意・sanitize + cap)。不正/欠落は undefined (= 従来 QR と同じ挙動)。
  const storeName = storeRaw ? sanitizeText(storeRaw, PAY_STORE_NAME_MAX) : undefined;
  const productName = pnameRaw
    ? sanitizeText(pnameRaw, PAY_PRODUCT_NAME_MAX)
    : undefined;
  const memo = memoRaw ? sanitizeText(memoRaw, PAY_MEMO_MAX) : undefined;
  // 記帳補助メタ (税率/税区分/レシート番号) は checkout と共通の shared helper で parse。
  const { taxRate, taxCategory, receiptNo } = parseTaxReceiptParams(searchParams);

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
      crossChain,
      expiresAt,
      priceRefAmount,
      fxRate,
      storeName,
      productName,
      memo,
      taxRate,
      taxCategory,
      receiptNo,
    },
  };
}
