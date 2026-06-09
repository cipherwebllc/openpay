'use client';

// 「プロフ」タブ (@handle ビルダー) の下書き状態を localStorage 永続化する。
// チップタブの useTipSettings (単一 token+chain) とは別キーで**分離** — @handle は本質的に
// マルチ受取方法なので共有すると噛み合わないため (plans/handle-linkbio-mvp.md §5-1)。

import type { ChainSlug } from '@/lib/chains';
import { COLOR_PATTERN, DECIMAL_PATTERN, TIP_PRESET_MAX } from '@/lib/url';
import { DEFAULT_TIP_PRESETS } from '@/lib/url';
import { DEFAULT_CHAIN_FOR_SYMBOL } from '@/lib/tokens';
import { useLocalStorageSettings } from './useLocalStorageSettings';

// 受取方法は既定3つ (JPYC Polygon / JPYC Kaia / USDC cross-chain) の ON/OFF。
export interface HandleProfileDraft {
  to: string; // 生入力 (アドレス or ENS)・submit 時に再解決
  name: string;
  color: string;
  jpycPolygon: boolean;
  jpycKaia: boolean;
  usdcCrossChain: boolean; // USDC 受取方法を出すか (presence)
  // USDC method の crossChain 値。既定 true。旧レコード編集時に保存値 (opt-out=false) を
  // 保持するため presence とは別に持つ (update で勝手に true に戻さない)。
  usdcCrossChainFlag: boolean;
  usdcChain: ChainSlug; // USDC の受取 chain (既定 = usdc default)
  presetsJpyc: string[];
  presetsUsdc: string[];
  bio: string;
  avatar: string;
  links: { label: string; url: string }[];
}

const STORAGE_KEY = 'openpay:handle-profile-draft:v1';

function defaultPresets(): { jpyc: string[]; usdc: string[] } {
  return {
    jpyc: [...DEFAULT_TIP_PRESETS.jpyc],
    usdc: [...DEFAULT_TIP_PRESETS.usdc],
  };
}

export const DEFAULT_PROFILE_DRAFT: HandleProfileDraft = {
  to: '',
  name: '',
  color: '#2563eb',
  jpycPolygon: true,
  jpycKaia: true,
  usdcCrossChain: true,
  usdcCrossChainFlag: true,
  usdcChain: DEFAULT_CHAIN_FOR_SYMBOL.usdc,
  presetsJpyc: defaultPresets().jpyc,
  presetsUsdc: defaultPresets().usdc,
  bio: '',
  avatar: '',
  links: [],
};

function sanitizePresetList(loaded: unknown, fallback: string[]): string[] {
  if (!Array.isArray(loaded)) return [...fallback];
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

function sanitizeLinks(
  loaded: unknown,
): { label: string; url: string }[] {
  if (!Array.isArray(loaded)) return [];
  const out: { label: string; url: string }[] = [];
  for (const l of loaded) {
    if (!l || typeof l !== 'object') continue;
    const ll = l as Record<string, unknown>;
    out.push({
      label: typeof ll.label === 'string' ? ll.label : '',
      url: typeof ll.url === 'string' ? ll.url : '',
    });
    if (out.length >= 6) break;
  }
  return out;
}

function sanitize(loaded: Partial<HandleProfileDraft>): HandleProfileDraft {
  const str = (v: unknown, d: string) => (typeof v === 'string' ? v : d);
  const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
  const d = defaultPresets();
  return {
    to: str(loaded.to, ''),
    name: str(loaded.name, ''),
    color:
      typeof loaded.color === 'string' && COLOR_PATTERN.test(loaded.color)
        ? loaded.color.toLowerCase()
        : DEFAULT_PROFILE_DRAFT.color,
    jpycPolygon: bool(loaded.jpycPolygon, true),
    jpycKaia: bool(loaded.jpycKaia, true),
    usdcCrossChain: bool(loaded.usdcCrossChain, true),
    usdcCrossChainFlag: bool(loaded.usdcCrossChainFlag, true),
    usdcChain: (typeof loaded.usdcChain === 'string'
      ? loaded.usdcChain
      : DEFAULT_PROFILE_DRAFT.usdcChain) as ChainSlug,
    presetsJpyc: sanitizePresetList(loaded.presetsJpyc, d.jpyc),
    presetsUsdc: sanitizePresetList(loaded.presetsUsdc, d.usdc),
    bio: str(loaded.bio, ''),
    avatar: str(loaded.avatar, ''),
    links: sanitizeLinks(loaded.links),
  };
}

export function useHandleProfileDraft() {
  return useLocalStorageSettings<HandleProfileDraft>(
    STORAGE_KEY,
    DEFAULT_PROFILE_DRAFT,
    sanitize,
  );
}
