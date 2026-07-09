'use client';

// 「プロフ」タブ (@handle ビルダー) の下書き状態を localStorage 永続化する。
// チップタブの useTipSettings (単一 token+chain) とは別キーで**分離** — @handle は本質的に
// マルチ受取方法なので共有すると噛み合わないため (plans/handle-linkbio-mvp.md §5-1)。

import { COLOR_PATTERN, DECIMAL_PATTERN, TIP_PRESET_MAX } from '@/lib/url';
import { DEFAULT_TIP_PRESETS } from '@/lib/url';
import { MAX_PROFILE_LINKS, MAX_SOCIAL_LINKS } from '@/lib/handle';
import { resolveHandleTheme, type HandleTheme } from '@/lib/handleTheme';
import { useLocalStorageSettings } from './useLocalStorageSettings';

// ビルダーの下書きリンク (公開前の生入力)。emoji/featured は Phase 1 の表現力追加。
export interface DraftLink {
  label: string;
  url: string;
  emoji?: string;
  featured?: boolean;
}

// 受取方法は JPYC Polygon / JPYC Kaia の ON/OFF (+ env.enableJpycAvalanche=ON で JPYC Avalanche)。
// USDC (cross-chain) は着金チェーンを選べず Base 固定になるためビルダーから提供終了
// (チップタブで個別作成→リンク集へ)。
export interface HandleProfileDraft {
  to: string; // 生入力 (アドレス or ENS)・submit 時に再解決
  name: string;
  color: string;
  jpycPolygon: boolean;
  jpycKaia: boolean;
  // Avalanche は env.enableJpycAvalanche=ON のときだけビルダーで提供 (Phase 2・既定 OFF)。
  jpycAvalanche: boolean;
  presetsJpyc: string[];
  bio: string;
  avatar: string;
  socials: string[]; // SNS プロフィール URL (アイコンはドメイン自動判定)
  links: DraftLink[];
  // 着せ替えテーマ (clean 既定)。公開ページ/プレビューの見た目を切替える。
  theme: HandleTheme;
}

const STORAGE_KEY = 'openpay:handle-profile-draft:v1';

function defaultPresets(): { jpyc: string[] } {
  return { jpyc: [...DEFAULT_TIP_PRESETS.jpyc] };
}

export const DEFAULT_PROFILE_DRAFT: HandleProfileDraft = {
  to: '',
  name: '',
  color: '#2563eb',
  jpycPolygon: true,
  jpycKaia: true,
  jpycAvalanche: false, // opt-in (flag ON でも既定 OFF)
  presetsJpyc: defaultPresets().jpyc,
  bio: '',
  avatar: '',
  socials: [],
  links: [],
  theme: 'clean',
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

function sanitizeLinks(loaded: unknown): DraftLink[] {
  if (!Array.isArray(loaded)) return [];
  const out: DraftLink[] = [];
  // featured は最大 1 本。localStorage が破損して複数 true でも先頭 1 本だけ残す。
  let featuredTaken = false;
  for (const l of loaded) {
    if (!l || typeof l !== 'object') continue;
    const ll = l as Record<string, unknown>;
    const link: DraftLink = {
      label: typeof ll.label === 'string' ? ll.label : '',
      url: typeof ll.url === 'string' ? ll.url : '',
    };
    if (typeof ll.emoji === 'string' && ll.emoji.trim()) link.emoji = ll.emoji;
    if (ll.featured === true && !featuredTaken) {
      link.featured = true;
      featuredTaken = true;
    }
    out.push(link);
    if (out.length >= MAX_PROFILE_LINKS) break;
  }
  return out;
}

function sanitizeSocials(loaded: unknown): string[] {
  if (!Array.isArray(loaded)) return [];
  const out: string[] = [];
  for (const s of loaded) {
    if (typeof s !== 'string') continue;
    out.push(s); // 入力途中の値も下書きとしては保持 (検証は submit 側)
    if (out.length >= MAX_SOCIAL_LINKS) break;
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
    jpycAvalanche: bool(loaded.jpycAvalanche, false),
    presetsJpyc: sanitizePresetList(loaded.presetsJpyc, d.jpyc),
    bio: str(loaded.bio, ''),
    avatar: str(loaded.avatar, ''),
    socials: sanitizeSocials(loaded.socials),
    links: sanitizeLinks(loaded.links),
    theme: resolveHandleTheme(loaded.theme),
  };
}

export function useHandleProfileDraft() {
  return useLocalStorageSettings<HandleProfileDraft>(
    STORAGE_KEY,
    DEFAULT_PROFILE_DRAFT,
    sanitize,
  );
}
