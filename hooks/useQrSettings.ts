'use client';

import { isJpycChainSlug, isValidChainSlug, type ChainSlug } from '@/lib/chains';
import type { GasMode, PayMode } from '@/lib/fee';
import {
  DEFAULT_CHAIN_FOR_SYMBOL,
  deploymentForSlug,
  isGaslessSupported,
  type TokenSymbol,
} from '@/lib/tokens';
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
  // Cross-chain 受信 (Gateway / CCTP V2) を allow するかの店主側 opt-out。
  // default true (顧客 wallet が target chain と異なっても自動 cross-chain で
  // 受取れるよう PaymentForm が代替経路を提示)。false にすると URL に
  // crossChain=false が付き、PaymentForm が hint を出さない。USDC のみ意味あり。
  crossChain: boolean;
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
  crossChain: true,
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

// (token, chain) ペアの妥当性を保つ。
// - jpyc: polygon (既定) + kaia (PoC、2026-05 公式 deploy) を許容、それ以外は polygon
// - usdc: 4 chain (base/arbitrum/optimism/polygon) を許容、kaia は対象外
// 不正な組合せが入った場合は token の default chain に倒す。
export function normalizeChainForToken(
  token: TokenSymbol,
  chain: string | undefined,
): ChainSlug {
  if (token === 'jpyc') {
    return chain && isJpycChainSlug(chain) ? chain : 'polygon';
  }
  // usdc: kaia には Circle native USDC が deploy されていないため除外
  if (chain && isValidChainSlug(chain) && chain !== 'kaia') return chain;
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
  const chain = normalizeChainForToken(token, loaded.chain);
  // (token, chain) が gasless 非対応 (例: USDC + Ethereum L1) なのに payMode=gasless
  // が saved 状態として残っていたら payMode=standard に migrate。/pay URL parser
  // が gasless+ethereum を reject するので、UI 側の見かけと実際の URL を一致させる。
  const rawPayMode = resolvePayMode(loaded);
  const payMode: PayMode =
    rawPayMode === 'gasless' && !isGaslessSupported(deploymentForSlug(token, chain))
      ? 'standard'
      : rawPayMode;
  return {
    receiver:
      typeof loaded.receiver === 'string'
        ? loaded.receiver
        : DEFAULT_SETTINGS.receiver,
    token,
    chain,
    gasMode:
      loaded.gasMode === 'customer' || loaded.gasMode === 'merchant'
        ? loaded.gasMode
        : DEFAULT_SETTINGS.gasMode,
    payMode,
    splits: sanitizeSplits(loaded.splits),
    storeName: sanitizeText(loaded.storeName, STORE_NAME_MAX),
    posterNote: sanitizeText(loaded.posterNote, POSTER_NOTE_MAX),
    quickAmounts: sanitizeQuickAmounts(loaded.quickAmounts),
    // boolean を厳密 check。旧 schema (crossChain 未定義) は true に倒す (default ON)。
    crossChain:
      typeof loaded.crossChain === 'boolean'
        ? loaded.crossChain
        : DEFAULT_SETTINGS.crossChain,
  };
}

export function useQrSettings() {
  return useLocalStorageSettings<QrSettings>(STORAGE_KEY, DEFAULT_SETTINGS, sanitize);
}
