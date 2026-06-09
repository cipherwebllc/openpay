// @handle 恒久クリエイターリンク (open-pay.jp/@alice) の純関数。
//
// handle の正規化・形式検証・予約語判定と、保存設定 (PublishableTipConfig) ↔ TipParams /
// tip クエリの相互変換を集約する。KV / SIWE には依存しない (= 単体テスト可能)。サーバ側の
// KV 操作は lib/handleStore.ts、API は app/api/handle/*、解決ページは [locale]/[handle]。
//
// セキュリティ前提:
//   - handle は ASCII 小文字英数字 + `_` のみ (homograph / IDN を排除)。
//   - 設定の意味的妥当性は既存の parseTipParams を再利用して担保 (token/chain/gasless 整合)。
//   - 予約語 = 既存ルート名 + locale + ブランド系 (成りすまし/混同の一次防御)。

import { type Address } from 'viem';
import type { TokenSymbol } from '@/lib/tokens';
import type { ChainSlug } from '@/lib/chains';
import { buildTipPath, parseTipParams, type TipParams } from '@/lib/url';

// 1 wallet が保有できる handle の上限 (squatting 抑制・D2)。
export const MAX_HANDLES_PER_WALLET = 3;

// 形式: ASCII 小文字英数字 + アンダースコア、3〜30 文字。
export const HANDLE_PATTERN = /^[a-z0-9_]{3,30}$/;

// 予約語: 既存ルート名 + locale + ブランド/紛らわしい語。handle namespace は `@` 接頭辞で
// static route と分離されるため衝突防止というより成りすまし/混同の一次防御。
export const RESERVED_HANDLES: ReadonlySet<string> = new Set<string>([
  // 既存ルート / 特殊パス
  'api', 'og', '_next', 'admin', 'billing', 'checkout', 'create',
  'disclaimer', 'experimental', 'explore', 'history', 'pay', 'privacy',
  'scan', 'terms', 'tip', 'tokutei',
  // locale
  'ja', 'en',
  // ブランド / 役割 (成りすまし防止)
  'openpay', 'open_pay', 'official', 'support', 'help', 'admin_',
  'moderator', 'mod', 'staff', 'team', 'root', 'system', 'security',
  'jpyc', 'usdc', 'wallet', 'account', 'login', 'logout', 'signin',
  'signout', 'settings', 'dashboard', 'about', 'contact', 'home', 'www',
  'app',
]);

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
export function validateHandle(raw: string): HandleValidation {
  const handle = normalizeHandle(raw);
  if (!isValidHandleFormat(handle)) return { ok: false, reason: 'format' };
  if (isReserved(handle)) return { ok: false, reason: 'reserved' };
  return { ok: true, handle };
}

// 保存するチップ設定 (TipParams の JSON 化シェイプ。to は serializable な string)。
export interface PublishableTipConfig {
  to: string;
  token: TokenSymbol;
  chain?: ChainSlug;
  name?: string;
  message?: string;
  color?: string;
  presets?: string[];
  thanks?: string;
  thanksUrl?: string;
  webhook?: string;
  crossChain?: boolean;
}

export interface HandleRecord {
  owner: string; // 所有 wallet (checksum address)
  config: PublishableTipConfig;
  createdAt: number;
  updatedAt: number;
}

// config → TipParams (TipForm / OGP に渡す)。to は保存時に検証済みなので Address とみなす。
export function configToTipParams(config: PublishableTipConfig): TipParams {
  return { ...config, to: config.to as Address };
}

// config → tip クエリ (parseTipParams で再検証するため。buildTipPath と対称)。
export function configToSearchParams(
  config: PublishableTipConfig,
): URLSearchParams {
  const path = buildTipPath(configToTipParams(config));
  const qi = path.indexOf('?');
  return new URLSearchParams(qi >= 0 ? path.slice(qi + 1) : '');
}

// 検証済み TipParams → 保存 config (to を string 化)。reserve 時に parseTipParams を
// 通した結果を正規形として保存するために使う。
export function tipParamsToConfig(params: TipParams): PublishableTipConfig {
  return { ...params, to: params.to };
}

export type ValidatedConfig =
  | { ok: true; config: PublishableTipConfig }
  | { ok: false; error: string };

// API が受け取った任意の config を、既存 parseTipParams で意味的に検証して正規化する。
// to/token/chain/gasless 整合・sanitize はすべて parseTipParams に委譲 (tip URL と同一規則)。
// 不正は error を返す (throw しない)。保存するのは parse 済みの正規形。
export function validateTipConfig(raw: unknown): ValidatedConfig {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, error: 'config required' };
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.to !== 'string' || typeof r.token !== 'string') {
    return { ok: false, error: 'to and token are required' };
  }
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
  const candidate: PublishableTipConfig = {
    to: r.to,
    token: r.token as TokenSymbol,
    chain: typeof r.chain === 'string' ? (r.chain as ChainSlug) : undefined,
    name: str(r.name),
    message: str(r.message),
    color: str(r.color),
    presets: Array.isArray(r.presets)
      ? r.presets.filter((p): p is string => typeof p === 'string')
      : undefined,
    thanks: str(r.thanks),
    thanksUrl: str(r.thanksUrl),
    webhook: str(r.webhook),
    crossChain: typeof r.crossChain === 'boolean' ? r.crossChain : undefined,
  };
  // configToSearchParams + parseTipParams で tip URL と全く同じ検証を通す。
  const parsed = parseTipParams(candidate.to, configToSearchParams(candidate));
  if (!parsed.ok) return { ok: false, error: parsed.error };
  return { ok: true, config: tipParamsToConfig(parsed.params) };
}

const STRING_KEYS = [
  'name',
  'message',
  'color',
  'thanks',
  'thanksUrl',
  'webhook',
] as const;

// KV JSON → HandleRecord の型ガード。owner/to は address 形・config は構造のみ検証
// (token / chain の意味的整合は呼出側が parseTipParams で再検証する)。malformed は null。
export function parseHandleRecord(json: string | null): HandleRecord | null {
  if (!json) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const rec = raw as Record<string, unknown>;
  const config = rec.config;
  if (
    typeof rec.owner !== 'string' ||
    typeof rec.createdAt !== 'number' ||
    typeof rec.updatedAt !== 'number' ||
    typeof config !== 'object' ||
    config === null
  ) {
    return null;
  }
  const c = config as Record<string, unknown>;
  if (typeof c.to !== 'string' || typeof c.token !== 'string') return null;
  for (const k of STRING_KEYS) {
    if (c[k] !== undefined && typeof c[k] !== 'string') return null;
  }
  if (c.chain !== undefined && typeof c.chain !== 'string') return null;
  if (c.crossChain !== undefined && typeof c.crossChain !== 'boolean') {
    return null;
  }
  if (
    c.presets !== undefined &&
    (!Array.isArray(c.presets) || c.presets.some((p) => typeof p !== 'string'))
  ) {
    return null;
  }
  return rec as unknown as HandleRecord;
}

export function serializeHandleRecord(record: HandleRecord): string {
  return JSON.stringify(record);
}
