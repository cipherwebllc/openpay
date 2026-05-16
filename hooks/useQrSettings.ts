'use client';

import { isValidChainSlug, type ChainSlug } from '@/lib/chains';
import type { GasMode, PayMode } from '@/lib/fee';
import { DEFAULT_CHAIN_FOR_SYMBOL, type TokenSymbol } from '@/lib/tokens';
import type { SplitDraft } from '@/lib/url';
import { useLocalStorageSettings } from './useLocalStorageSettings';

type QrSettings = {
  receiver: string;
  token: TokenSymbol;
  // 送金チェーン (slug)。usdc では 4 chain から選択可能、jpyc は polygon 固定。
  chain: ChainSlug;
  // ネットワーク手数料 (gas) の負担者: customer (顧客上乗せ) / merchant (店主吸収)。
  // OpenPay 利用手数料は両モードとも常に店主負担。既定 customer (gas spike を店主が被らない安全側)。
  // payMode='standard' のとき gasMode は無視される (OpenPay は gas に touch しないため)。
  gasMode: GasMode;
  // 決済モード:
  //   gasless:  OpenPay が gas を肩代わり、OpenPay 利用手数料 1.0% (default)
  //   standard: 顧客が wallet で自前 gas を支払、OpenPay 利用手数料 0.5%
  payMode: PayMode;
  // 追加受取人 (最大 3、合計 % < 100)。空配列 = 単独受取人。
  // standard mode では UI 側で split を無効化するが、設定としては保持可能 (mode 切替時に復元される)。
  splits: SplitDraft[];
  // 店舗向け表示。DB を持たず、端末ローカルのレジ/印刷設定として保存する。
  storeName: string;
  posterNote: string;
  quickAmounts: string[];
};

const STORAGE_KEY = 'openpay:qr-settings:v2';

const DEFAULT_SETTINGS: QrSettings = {
  receiver: '',
  token: 'jpyc',
  chain: 'polygon',
  gasMode: 'customer',
  payMode: 'gasless',
  splits: [],
  storeName: '',
  posterNote: '',
  quickAmounts: ['500', '1000', '1500', '3000'],
};

export const STORE_NAME_MAX = 48;
export const POSTER_NOTE_MAX = 96;
export const QUICK_AMOUNT_MAX = 8;

function sanitizeText(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  return value.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, max);
}

function sanitizeQuickAmounts(loaded: unknown): string[] {
  if (!Array.isArray(loaded)) return DEFAULT_SETTINGS.quickAmounts;
  const seen = new Set<string>();
  const values: string[] = [];
  for (const entry of loaded) {
    if (typeof entry !== 'string') continue;
    const cleaned = entry.replace(/[^\d.]/g, '');
    if (!/^\d+(\.\d+)?$/.test(cleaned)) continue;
    if (Number(cleaned) <= 0) continue;
    if (seen.has(cleaned)) continue;
    seen.add(cleaned);
    values.push(cleaned);
    if (values.length >= QUICK_AMOUNT_MAX) break;
  }
  return values.length > 0 ? values : DEFAULT_SETTINGS.quickAmounts;
}

function sanitizeSplits(loaded: unknown): SplitDraft[] {
  if (!Array.isArray(loaded)) return [];
  return loaded
    .filter(
      (e): e is SplitDraft =>
        typeof e === 'object' &&
        e !== null &&
        typeof (e as SplitDraft).address === 'string' &&
        typeof (e as SplitDraft).percent === 'string',
    )
    .slice(0, 3);
}

// (token, chain) ペアの妥当性を保つ。jpyc は polygon 固定、usdc は 4 chain 許容。
// 不正な組合せが入った場合は token の default chain に倒す。
export function normalizeChainForToken(
  token: TokenSymbol,
  chain: string | undefined,
): ChainSlug {
  if (token === 'jpyc') return 'polygon';
  if (chain && isValidChainSlug(chain)) return chain;
  return DEFAULT_CHAIN_FOR_SYMBOL[token];
}

export function sanitizeTokenSymbol(
  value: unknown,
  fallback: TokenSymbol,
): TokenSymbol {
  return value === 'jpyc' || value === 'usdc' ? value : fallback;
}

// localStorage には旧 schema (directTransfer: boolean) の値が残っている可能性が
// あるため、payMode が未指定で directTransfer=true なら 'standard' に migrate。
// それ以外は default 'gasless' に倒す。
function resolvePayMode(loaded: Partial<QrSettings> & { directTransfer?: unknown }): PayMode {
  if (loaded.payMode === 'gasless' || loaded.payMode === 'standard') {
    return loaded.payMode;
  }
  if (loaded.directTransfer === true) return 'standard';
  return DEFAULT_SETTINGS.payMode;
}

function sanitize(loaded: Partial<QrSettings>): QrSettings {
  const token = sanitizeTokenSymbol(loaded.token, DEFAULT_SETTINGS.token);
  return {
    receiver:
      typeof loaded.receiver === 'string'
        ? loaded.receiver
        : DEFAULT_SETTINGS.receiver,
    token,
    chain: normalizeChainForToken(token, loaded.chain),
    gasMode:
      loaded.gasMode === 'customer' || loaded.gasMode === 'merchant'
        ? loaded.gasMode
        : DEFAULT_SETTINGS.gasMode,
    payMode: resolvePayMode(loaded),
    splits: sanitizeSplits(loaded.splits),
    storeName: sanitizeText(loaded.storeName, STORE_NAME_MAX),
    posterNote: sanitizeText(loaded.posterNote, POSTER_NOTE_MAX),
    quickAmounts: sanitizeQuickAmounts(loaded.quickAmounts),
  };
}

export function useQrSettings() {
  return useLocalStorageSettings<QrSettings>(STORAGE_KEY, DEFAULT_SETTINGS, sanitize);
}
