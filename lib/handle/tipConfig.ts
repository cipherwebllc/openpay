// 保存チップ設定 ↔ TipParams / tip クエリの相互変換と、書き込み時の検証。
// 意味的な検証は tip URL と同じ parseTipParams に委譲する (token/chain/gasless 整合)。
import type { Address } from 'viem';
import type { TokenSymbol } from '@/lib/tokens';
import type { ChainSlug } from '@/lib/chains';
import { buildTipPath, parseTipParams, type TipParams } from '@/lib/url';
import { isHandleTheme, type HandleTheme } from '@/lib/handleThemeKey';
import type { HandleReceiveMethod, HandleTipConfig } from './schema';

// 1 handle が公開できる受取方法の上限 (token 2 × chain 数の現実的な上限)。
export const MAX_RECEIVE_METHODS = 6;

// 保存するチップ設定 (TipParams の JSON 化シェイプ。to は serializable な string)。
export interface PublishableTipConfig {
  to: string;
  token: TokenSymbol;
  chain?: ChainSlug;
  name?: string;
  message?: string;
  color?: string;
  theme?: HandleTheme;
  presets?: string[];
  thanks?: string;
  thanksUrl?: string;
  webhook?: string;
  crossChain?: boolean;
}

export const CLEARABLE_HANDLE_TIP_FIELDS = ['message', 'thanks', 'thanksUrl', 'webhook'] as const;
export type ClearableHandleTipField = (typeof CLEARABLE_HANDLE_TIP_FIELDS)[number];

// wire 専用: 保存/描画用 HandleTipConfig には null を持ち込まない。
export type HandleTipConfigUpdate = Omit<HandleTipConfig, ClearableHandleTipField> &
  Partial<Record<ClearableHandleTipField, string | null>>;

// 既定の受取方法 (ユーザ決定): JPYC Polygon / JPYC Kaia。
// USDC は opt-in (ビルダーで Base か Arc のどちらか 1 つ・2026-09-17 排他化)。検証/公開ページは
// 旧レコードの usdc method (複数含む) を後方互換で受け続ける。
export const DEFAULT_RECEIVE_METHODS: readonly HandleReceiveMethod[] = [
  { token: 'jpyc', chain: 'polygon' },
  { token: 'jpyc', chain: 'kaia' },
] as const;

// config → TipParams (TipForm / OGP に渡す)。to は保存時に検証済みなので Address とみなす。
export function configToTipParams(config: PublishableTipConfig): TipParams {
  const parsed = parseTipParams(config.to, configToSearchParams(config));
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.params;
}

// config → tip クエリ (parseTipParams で再検証するため。buildTipPath と対称)。
export function configToSearchParams(
  config: PublishableTipConfig,
): URLSearchParams {
  const path = buildTipPath({ ...config, to: config.to as Address });
  const qi = path.indexOf('?');
  return new URLSearchParams(qi >= 0 ? path.slice(qi + 1) : '');
}

// 検証済み TipParams → 保存 config (to を string 化)。reserve 時に parseTipParams を
// 通した結果を正規形として保存するために使う。
export function tipParamsToConfig(params: TipParams): PublishableTipConfig {
  const { mode: _mode, ...config } = params;
  return { ...config, to: params.to };
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
    theme: isHandleTheme(r.theme) ? r.theme : undefined,
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

// 受取方法 + 共有設定 → 単一 PublishableTipConfig (検証 / TipForm 描画の橋渡し)。
// presets は token 別なので該当 token のリストを選ぶ。crossChain は USDC のみ。
export function methodToPublishableConfig(
  config: HandleTipConfig,
  method: HandleReceiveMethod,
): PublishableTipConfig {
  return {
    to: config.to,
    token: method.token,
    chain: method.chain,
    name: config.name,
    message: config.message,
    color: config.color,
    ...(config.theme ? { theme: config.theme } : {}),
    presets: config.presets?.[method.token],
    thanks: config.thanks,
    thanksUrl: config.thanksUrl,
    webhook: config.webhook,
    crossChain: method.token === 'usdc' ? method.crossChain : undefined,
  };
}

export type ValidatedHandleConfig =
  | { ok: true; config: HandleTipConfig }
  | { ok: false; error: string };

// @handle のマルチ方法 tip 設定を検証する。各方法を PublishableTipConfig に展開して既存
// validateTipConfig (= parseTipParams 委譲) を通すため、token/chain/gasless 整合・sanitize は
// tip URL と完全に同一規則。gasless 非対応や不正な方法は除外し、有効方法が 0 なら error。
// 共有 identity (to/name/message/color/thanks…) は最初の有効方法の正規化結果を採用する。
export function validateHandleTipConfig(raw: unknown): ValidatedHandleConfig {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, error: 'config required' };
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.to !== 'string') {
    return { ok: false, error: 'to is required' };
  }
  const rawMethods = Array.isArray(r.methods) ? r.methods : [];
  if (rawMethods.length === 0) {
    return { ok: false, error: 'at least one receive method is required' };
  }
  if (rawMethods.length > MAX_RECEIVE_METHODS) {
    return { ok: false, error: 'too many receive methods' };
  }
  const presetsIn =
    r.presets && typeof r.presets === 'object' && !Array.isArray(r.presets)
      ? (r.presets as Record<string, unknown>)
      : {};
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
  const shared = {
    name: str(r.name),
    message: str(r.message),
    color: str(r.color),
    theme: isHandleTheme(r.theme) ? r.theme : undefined,
    thanks: str(r.thanks),
    thanksUrl: str(r.thanksUrl),
    webhook: str(r.webhook),
  };

  const seen = new Set<string>();
  const methods: HandleReceiveMethod[] = [];
  const presetsOut: Partial<Record<TokenSymbol, string[]>> = {};
  let canonical: PublishableTipConfig | null = null;

  for (const m of rawMethods) {
    if (typeof m !== 'object' || m === null) continue;
    const mm = m as Record<string, unknown>;
    if (typeof mm.token !== 'string' || typeof mm.chain !== 'string') continue;
    const token = mm.token as TokenSymbol;
    const tokenPresets = Array.isArray(presetsIn[token])
      ? (presetsIn[token] as unknown[]).filter(
          (p): p is string => typeof p === 'string',
        )
      : undefined;
    const candidate: PublishableTipConfig = {
      to: r.to,
      token,
      chain: mm.chain as ChainSlug,
      ...shared,
      presets: tokenPresets,
      crossChain: typeof mm.crossChain === 'boolean' ? mm.crossChain : undefined,
    };
    // 既存 tip URL と全く同じ検証 (gasless 非対応の (token,chain) はここで弾かれる)。
    const parsed = validateTipConfig(candidate);
    if (!parsed.ok) continue;
    const pc = parsed.config;
    const key = `${pc.token}:${pc.chain ?? ''}`;
    if (seen.has(key)) continue; // 同 token+chain は dedupe
    seen.add(key);
    methods.push({
      token: pc.token,
      chain: pc.chain as ChainSlug,
      crossChain: pc.token === 'usdc' ? pc.crossChain : undefined,
    });
    if (pc.presets && pc.presets.length > 0) presetsOut[pc.token] = pc.presets;
    if (!canonical) canonical = pc; // 最初の有効方法 = 正規化済み identity の源
  }

  if (!canonical || methods.length === 0) {
    return { ok: false, error: 'no valid receive method' };
  }
  const config: HandleTipConfig = {
    to: canonical.to,
    name: canonical.name,
    message: canonical.message,
    color: canonical.color,
    ...(canonical.theme ? { theme: canonical.theme } : {}),
    thanks: canonical.thanks,
    thanksUrl: canonical.thanksUrl,
    webhook: canonical.webhook,
    methods,
    presets: Object.keys(presetsOut).length > 0 ? presetsOut : undefined,
  };
  return { ok: true, config };
}
