// /pay クエリ仕様:
//   to     (必須, 0x) — 主受取人
//   token  ("jpyc" | "usdc")
//   gas    ("customer" | "merchant", 省略時 customer) ※ merchant の場合のみ URL に出力
//   amount (任意, 人間可読 — 据え置き QR では省略)
//   mode   ("gasless" | "direct", 省略時 gasless) ※ direct のときのみ URL に出力
//   split  (任意, "0xB:30,0xC:20" 形式) — 追加受取人と分配 %。to が残余 % を取得
//
// 運営手数料は常に店主負担 (顧客には不可視)。`gas` パラメタはネットワーク手数料の負担者:
//   gas=customer (default): 顧客がネットワーク手数料を上乗せ支払い (画面に明示表示)
//   gas=merchant:           店主がネットワーク手数料も吸収、顧客は請求金額のみ支払う
//
// 旧 `fee=include`/`fee=exclude` パラメタは廃止 (parser は silently ignore)。
//
// /tip/[address] クエリ仕様:
//   token   ("jpyc" | "usdc")        必須
//   name    (任意, 表示名 60 文字まで切詰)
//   message (任意, 説明文 200 文字まで切詰)
//   color   (任意, "#rrggbb" 形式)
//   preset  (任意, "100,500,1000" カンマ区切り decimal、最大 6 件)
//
// Tip widget は gas=customer 固定 (preset セマンティクス: クリエイターが preset 額から運営手数料控除後を受け取る、ファンが gas を上乗せ支払い)。
import { getAddress, isAddress } from 'viem';
import type { Address } from 'viem';
import type { GasMode } from './fee';
import { isValidTokenSymbol, type TokenSymbol } from './tokens';

export type PayMode = 'gasless' | 'direct';

export type SplitEntry = {
  to: Address;
  // 1〜99 の整数 %。合計が 100 未満であること (残余を主 to が取得)。
  percent: number;
};

export const SPLIT_MAX_ENTRIES = 3;

export type PayParams = {
  to: Address;
  token: TokenSymbol;
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

export function buildPayPath(params: PayParams): string {
  const sp = new URLSearchParams();
  sp.set('to', params.to);
  sp.set('token', params.token);
  // customer (default) は URL に出さない。merchant のみ明示。
  if (params.gas === 'merchant') {
    sp.set('gas', 'merchant');
  }
  if (params.amount && params.amount.length > 0) {
    sp.set('amount', params.amount);
  }
  // gasless は既定値なので URL に出さず、旧 QR との互換性を保つ。
  if (params.mode === 'direct') {
    sp.set('mode', 'direct');
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
type SearchParamsLike = { get(name: string): string | null };

export function parsePayParams(searchParams: SearchParamsLike): ParsedPayParams {
  const to = searchParams.get('to');
  const token = searchParams.get('token');
  const gasRaw = searchParams.get('gas');
  const amount = searchParams.get('amount');
  const mode = searchParams.get('mode');
  const split = searchParams.get('split');

  if (!to) return { ok: false, error: '宛先アドレス (to) が指定されていません' };
  if (!isAddress(to)) return { ok: false, error: '宛先アドレス (to) が不正です' };
  if (!token || !isValidTokenSymbol(token)) {
    return { ok: false, error: 'token は jpyc または usdc を指定してください' };
  }
  if (mode !== null && mode !== 'gasless' && mode !== 'direct') {
    return { ok: false, error: 'mode は gasless または direct を指定してください' };
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

  return {
    ok: true,
    params: {
      to: getAddress(to),
      token,
      gas,
      amount: amount && amount.length > 0 ? amount : undefined,
      mode: mode === 'direct' ? 'direct' : 'gasless',
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
  const tokens = raw
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0 && DECIMAL_PATTERN.test(t) && Number(t) > 0);
  if (tokens.length === 0) return undefined;
  return tokens.slice(0, TIP_PRESET_MAX);
}

export function buildTipPath(params: TipParams): string {
  const sp = new URLSearchParams();
  sp.set('token', params.token);
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
    const valid = params.presets
      .filter((p) => DECIMAL_PATTERN.test(p) && Number(p) > 0)
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

// 通貨ごとの既定 preset (URL に preset 指定がない時に使う)。
//
// 設計基準: 最小 preset の実効手数料率が 5% 以下になる金額帯を選ぶ。
// 旧値 (JPYC 100 / USDC 1) はフロア手数料 (15 JPYC / 0.2 USDC) に対し
// 実効 15% / 20% となり、ユーザに「割高」シグナルを与えてしまっていた。
//
//   JPYC 300:  15 JPYC fee →  5.0%   USDC 5:  0.2 USDC fee → 4.0%
//   JPYC 1000: 15 JPYC fee →  1.5%   USDC 20: 0.24 USDC fee → 1.2%
//   JPYC 3000: 30 JPYC fee →  1.0%   USDC 50: 0.6 USDC fee → 1.2%
//
// クリエイターは TipEmbedGenerator で任意の preset を上書き可能、ファンも
// custom amount で 100 JPYC / 1 USDC のようなカジュアル tip を引き続き送れる。
export const DEFAULT_TIP_PRESETS: Record<TokenSymbol, string[]> = {
  jpyc: ['300', '1000', '3000'],
  usdc: ['5', '20', '50'],
};
