'use client';

import type { ChainSlug } from '@/lib/chains';
import { deploymentForSlug, isGaslessSupported, type TokenSymbol } from '@/lib/tokens';
import {
  COLOR_PATTERN,
  DECIMAL_PATTERN,
  DEFAULT_TIP_PRESETS,
  TIP_PRESET_MAX,
} from '@/lib/url';
import { useLocalStorageSettings } from './useLocalStorageSettings';
import { normalizeChainForToken, sanitizeTokenSymbol } from './useQrSettings';

type TipSettings = {
  receiver: string;
  token: TokenSymbol;
  // 送金チェーン (slug)。usdc は gasless 対応 chain 選択可、
  // jpyc は polygon / kaia から選択可。
  chain: ChainSlug;
  name: string;
  message: string;
  color: string;
  // チップ金額プリセットは token (JPYC=円 / USDC=ドル) ごとに独立。単一リストを
  // 共有すると JPYC の 300 が USDC では $300 になってしまうため。空リストの token は
  // 表示・URL 生成時に DEFAULT_TIP_PRESETS[token] へ fallback する。
  presets: Record<TokenSymbol, string[]>;
  thanks: string;
  thanksUrl: string;
  webhook: string;
  // creator が cross-chain (Circle Gateway / CCTP V2) で fan からの tip を受け取れる
  // ようにするかの opt-out flag。default true (= 受け取る)。USDC のみ意味あり、
  // JPYC では URL 出力時に無視される。false 時のみ URL に `crossChain=false` 出力。
  crossChain: boolean;
};

const STORAGE_KEY = 'openpay:tip-settings:v2';

const DEFAULT_SETTINGS: TipSettings = {
  receiver: '',
  token: 'jpyc',
  chain: 'polygon',
  name: '',
  message: '',
  color: '#2563eb',
  presets: {
    jpyc: [...DEFAULT_TIP_PRESETS.jpyc],
    usdc: [...DEFAULT_TIP_PRESETS.usdc],
  },
  thanks: '',
  thanksUrl: '',
  webhook: '',
  crossChain: true,
};

// strict 検証: trim → DECIMAL_PATTERN かつ Number>0 のみ採用 → dedup → 最大 TIP_PRESET_MAX。
// QR の lenient sanitizer (数字以外を除去) は使わない。旧 CSV の不正値 ('2000yen' / '-5'
// 等) を補正して有効額に化けさせると URL 出力が変わるため、不正値は除外に留める。
function sanitizeTipPresetList(loaded: unknown): string[] {
  if (!Array.isArray(loaded)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of loaded) {
    if (typeof entry !== 'string') continue;
    const v = entry.trim();
    if (!DECIMAL_PATTERN.test(v) || Number(v) <= 0) continue;
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
    if (out.length >= TIP_PRESET_MAX) break;
  }
  return out;
}

// 旧 schema (単一 CSV 文字列、token 跨ぎ共有) からの migration を含む。
// 旧 CSV は最後に使っていた token (activeToken) のリストとして移し、もう片方は
// token 別 default に倒す。新 schema は token 別 object をそのまま strict 検証。
// 空リストの token は DEFAULT_TIP_PRESETS[token] に倒す (editor が常に実 chip を表示)。
function sanitizeTipPresets(
  loaded: unknown,
  activeToken: TokenSymbol,
): Record<TokenSymbol, string[]> {
  const withDefaults = (): Record<TokenSymbol, string[]> => ({
    jpyc: [...DEFAULT_TIP_PRESETS.jpyc],
    usdc: [...DEFAULT_TIP_PRESETS.usdc],
  });
  if (typeof loaded === 'string') {
    const migrated = sanitizeTipPresetList(loaded.split(','));
    if (migrated.length === 0) return withDefaults();
    const result = withDefaults();
    result[activeToken] = migrated;
    return result;
  }
  if (loaded && typeof loaded === 'object') {
    const o = loaded as Record<string, unknown>;
    const jpyc = sanitizeTipPresetList(o.jpyc);
    const usdc = sanitizeTipPresetList(o.usdc);
    return {
      jpyc: jpyc.length > 0 ? jpyc : [...DEFAULT_TIP_PRESETS.jpyc],
      usdc: usdc.length > 0 ? usdc : [...DEFAULT_TIP_PRESETS.usdc],
    };
  }
  return withDefaults();
}

function sanitize(loaded: Partial<TipSettings>): TipSettings {
  const token = sanitizeTokenSymbol(loaded.token, DEFAULT_SETTINGS.token);
  // tip widget は gasless 必須。gasless 非対応 chain (例: buyer-only chain の Unichain)
  // が saved value に入っていても sanitize 段階で token の default chain (usdc → base)
  // にフォールバック。
  const normalized = normalizeChainForToken(token, loaded.chain);
  const chain = isGaslessSupported(deploymentForSlug(token, normalized))
    ? normalized
    : normalizeChainForToken(token, undefined);
  return {
    receiver:
      typeof loaded.receiver === 'string'
        ? loaded.receiver
        : DEFAULT_SETTINGS.receiver,
    token,
    chain,
    name:
      typeof loaded.name === 'string' ? loaded.name : DEFAULT_SETTINGS.name,
    message:
      typeof loaded.message === 'string'
        ? loaded.message
        : DEFAULT_SETTINGS.message,
    color:
      typeof loaded.color === 'string' && COLOR_PATTERN.test(loaded.color)
        ? loaded.color.toLowerCase()
        : DEFAULT_SETTINGS.color,
    presets: sanitizeTipPresets(loaded.presets, token),
    thanks:
      typeof loaded.thanks === 'string'
        ? loaded.thanks
        : DEFAULT_SETTINGS.thanks,
    thanksUrl:
      typeof loaded.thanksUrl === 'string'
        ? loaded.thanksUrl
        : DEFAULT_SETTINGS.thanksUrl,
    webhook:
      typeof loaded.webhook === 'string'
        ? loaded.webhook
        : DEFAULT_SETTINGS.webhook,
    // boolean を厳密 check。旧 schema (crossChain 未定義) は true に倒す (default ON)。
    crossChain:
      typeof loaded.crossChain === 'boolean'
        ? loaded.crossChain
        : DEFAULT_SETTINGS.crossChain,
  };
}

export function useTipSettings() {
  return useLocalStorageSettings<TipSettings>(STORAGE_KEY, DEFAULT_SETTINGS, sanitize);
}
