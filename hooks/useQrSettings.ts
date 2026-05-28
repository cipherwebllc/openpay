'use client';

import { isJpycChainSlug, isValidChainSlug, type ChainSlug } from '@/lib/chains';
import type { GasMode, PayMode } from '@/lib/fee';
import { stripControlChars } from '@/lib/sanitize';
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
  // 既定 customer (gas spike を店主が被らない安全側)。
  // payMode='standard' のとき gasMode は無視される (OpenPay は gas に touch しないため)。
  gasMode: GasMode;
  // 決済モード:
  //   gasless:  OpenPay が gas を肩代わり (default)
  //   standard: 顧客が wallet で自前 gas を支払う
  payMode: PayMode;
  // 追加受取人 (最大 3、合計 % < 100)。空配列 = 単独受取人。
  // standard mode では UI 側で split を無効化するが、設定としては保持可能 (mode 切替時に復元される)。
  splits: SplitDraft[];
  // 店舗向け表示。DB を持たず、端末ローカルのレジ/印刷設定として保存する。
  storeName: string;
  posterNote: string;
  // レジ用クイック金額。token ごとに独立 (JPYC=円・USDC=ドルで桁が異なるため、
  // 単一リストを共有すると JPYC の 1000 が USDC では $1000 になってしまう)。
  quickAmounts: Record<TokenSymbol, string[]>;
  // Cross-chain 受信 (Gateway / CCTP V2) を allow するかの店主側 opt-out。
  // default true (顧客 wallet が target chain と異なっても自動 cross-chain で
  // 受取れるよう PaymentForm が代替経路を提示)。false にすると URL に
  // crossChain=false が付き、PaymentForm が hint を出さない。USDC のみ意味あり。
  crossChain: boolean;
};

const STORAGE_KEY = 'openpay:qr-settings:v2';

// token 別のクイック金額既定値。JPYC は円・USDC はドルの小口想定。
const DEFAULT_QUICK_AMOUNTS: Record<TokenSymbol, string[]> = {
  jpyc: ['500', '1000', '1500', '3000'],
  usdc: ['5', '10', '20', '50'],
};

// 旧 schema (token 跨ぎ共有) 時代の単一既定リスト。旧 hook は未カスタムの
// returning user にもこの値を localStorage へ永続化していたため、「カスタムして
// いない」を示す sentinel として扱う。これと一致する旧 array は activeToken へ
// 移さず token 別既定へ倒す (USDC を最後に使っていた人へ ¥500→$500 を引き継がせない)。
const LEGACY_SHARED_DEFAULT_QUICK_AMOUNTS = ['500', '1000', '1500', '3000'];

function isLegacySharedDefault(list: string[]): boolean {
  return (
    list.length === LEGACY_SHARED_DEFAULT_QUICK_AMOUNTS.length &&
    list.every((v, i) => v === LEGACY_SHARED_DEFAULT_QUICK_AMOUNTS[i])
  );
}

const DEFAULT_SETTINGS: QrSettings = {
  receiver: '',
  token: 'jpyc',
  chain: 'polygon',
  gasMode: 'customer',
  payMode: 'gasless',
  splits: [],
  storeName: '',
  posterNote: '',
  quickAmounts: {
    jpyc: [...DEFAULT_QUICK_AMOUNTS.jpyc],
    usdc: [...DEFAULT_QUICK_AMOUNTS.usdc],
  },
  crossChain: true,
};

export const STORE_NAME_MAX = 48;
export const POSTER_NOTE_MAX = 96;
export const QUICK_AMOUNT_MAX = 8;

function sanitizeText(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  return stripControlChars(value).slice(0, max);
}

function sanitizeAmountList(loaded: unknown, fallback: string[]): string[] {
  if (!Array.isArray(loaded)) return [...fallback];
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
  return values.length > 0 ? values : [...fallback];
}

// 旧 schema (単一 array、token 跨ぎで共有) からの migration を含む。
// 旧 array は最後に使っていた token (activeToken) のリストとして移す — その値は
// 当該 token の桁感で入力されているため (円 or ドル)。もう片方は既定に倒す。
// activeToken を渡さないと、USDC を最後に使っていた店主のカスタム値が JPYC 側へ
// 押し込まれ、USDC ボタンが既定にリセットされて永続化される regression になる。
function sanitizeQuickAmounts(
  loaded: unknown,
  activeToken: TokenSymbol,
): Record<TokenSymbol, string[]> {
  if (Array.isArray(loaded)) {
    const result: Record<TokenSymbol, string[]> = {
      jpyc: [...DEFAULT_QUICK_AMOUNTS.jpyc],
      usdc: [...DEFAULT_QUICK_AMOUNTS.usdc],
    };
    const migrated = sanitizeAmountList(
      loaded,
      DEFAULT_QUICK_AMOUNTS[activeToken],
    );
    // 未カスタム (旧共有既定そのまま) なら token 別既定のまま。カスタム値だけ移す。
    if (!isLegacySharedDefault(migrated)) {
      result[activeToken] = migrated;
    }
    return result;
  }
  if (loaded && typeof loaded === 'object') {
    const o = loaded as Record<string, unknown>;
    return {
      jpyc: sanitizeAmountList(o.jpyc, DEFAULT_QUICK_AMOUNTS.jpyc),
      usdc: sanitizeAmountList(o.usdc, DEFAULT_QUICK_AMOUNTS.usdc),
    };
  }
  return {
    jpyc: [...DEFAULT_QUICK_AMOUNTS.jpyc],
    usdc: [...DEFAULT_QUICK_AMOUNTS.usdc],
  };
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
  // (token, chain) が gasless 非対応 (paymasterMode=unavailable) なのに payMode=gasless
  // が saved 状態として残っていたら payMode=standard に migrate。/pay URL parser
  // が同組合せを reject するので、UI 側の見かけと実際の URL を一致させる。
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
    quickAmounts: sanitizeQuickAmounts(loaded.quickAmounts, token),
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
