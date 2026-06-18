'use client';

// 商品プリセット (簡易レジ用) を LocalStorage に保存する hook。
// - ノンカストディ / 登録不要の思想を維持 (サーバ DB なし)。
// - 初期サンプルを seed するが、ユーザが削除/編集可能 (削除後は復活しない)。
// - 表示順は配列順 (sortOrder は index をミラーして永続/外部消費用に保持)。
// - レシート番号 (管理番号) の日次連番採番も同じ store に持つ。
//
// useLocalStorageSettings の sanitize は useEffect の依存に入るため、参照が安定する
// よう **モジュールレベル関数** で渡す (inline 関数だと毎 render で再 load される)。

import { useCallback, useMemo } from 'react';
import { pad } from '@/lib/pad';
import { randomId } from '@/lib/id';
import { isTaxCategory, type TaxCategory } from '@/lib/tax';
import { validOptionGroups, type OptionGroup } from '@/lib/menuOptions';
import { sanitizeTokenSymbol } from '@/hooks/useQrSettings';
import { type TokenSymbol } from '@/lib/tokens';
import { useLocalStorageSettings } from './useLocalStorageSettings';

export type ProductPreset = {
  id: string;
  name: string;
  /** 人間可読 decimal (token 単位、例 "500")。 */
  unitPrice: string;
  token: TokenSymbol;
  taxRate: number | null;
  taxCategory: TaxCategory | null;
  memo: string | null;
  /** 商品画像 URL (https のみ・任意)。レジ一覧サムネ + モバイルオーダーのメニュー画像で共有。 */
  image?: string;
  /** カテゴリー名 (任意・自由入力)。モバイルオーダー公開ページで見出し別にグループ化。 */
  category?: string;
  /** おすすめ (任意)。レジ/モバイルオーダーで「おすすめ」として強調表示する。 */
  recommended?: boolean;
  /** オプション (任意)。サイズ/トッピング (lib/menuOptions)。モバイルオーダー/レジで選択 → 実効単価。 */
  options?: OptionGroup[];
  /** 表示順 (= 配列 index をミラー)。 */
  sortOrder: number;
  enabled: boolean;
};

type ProductPresetStore = {
  presets: ProductPreset[];
  /** レシート番号の日次連番 (R-YYYYMMDD-NNN)。 */
  receipt: { day: string; n: number };
};

const STORAGE_KEY = 'openpay:product-presets:v1';
export const PRESET_NAME_MAX = 80;
export const PRESET_MEMO_MAX = 200;
export const PRESET_CATEGORY_MAX = 24;
export const PRESET_MAX = 100;
const RECEIPT_PREFIX = 'R';

// 初期サンプル (ユーザは削除/編集可能・削除後の復活なし)。
const SEED_PRESETS: ReadonlyArray<Omit<ProductPreset, 'id' | 'sortOrder'>> = [
  { name: 'コーヒー', unitPrice: '500', token: 'jpyc', taxRate: 10, taxCategory: 'taxable_10', memo: null, enabled: true },
  { name: 'Tシャツ', unitPrice: '3000', token: 'jpyc', taxRate: 10, taxCategory: 'taxable_10', memo: null, enabled: true },
  { name: 'イベント参加費', unitPrice: '1000', token: 'jpyc', taxRate: 10, taxCategory: 'taxable_10', memo: null, enabled: true },
  { name: 'Tip', unitPrice: '300', token: 'jpyc', taxRate: 0, taxCategory: 'out_of_scope', memo: null, enabled: true },
];

function dayKey(now: Date): string {
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
}

function clampStr(v: unknown, max: number): string {
  if (typeof v !== 'string') return '';
  const t = v.trim();
  return t.length > max ? t.slice(0, max) : t;
}

// 単価: [\d.] のみ残し decimal でなければ空。
function sanitizePrice(v: unknown): string {
  if (typeof v !== 'string') return '';
  const cleaned = v.replace(/[^\d.]/g, '');
  return /^\d+(\.\d+)?$/.test(cleaned) ? cleaned : '';
}

function sanitizeTaxRate(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

// 商品画像 URL: https のみ許可 (描画は <img src>・XSS/データ流出回避)・512 字上限。不可は undefined。
export const PRESET_IMAGE_MAX = 512;
function sanitizeImage(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t.length > 0 && t.length <= PRESET_IMAGE_MAX && /^https:\/\/\S+$/i.test(t)
    ? t
    : undefined;
}

function sanitizePreset(raw: unknown, index: number): ProductPreset | null {
  if (raw === null || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const name = clampStr(o.name, PRESET_NAME_MAX);
  const unitPrice = sanitizePrice(o.unitPrice);
  // name か unitPrice が欠けた壊れ row は drop。
  if (name.length === 0 || unitPrice.length === 0) return null;
  return {
    id: typeof o.id === 'string' && o.id.length > 0 ? o.id : randomId(),
    name,
    unitPrice,
    token: sanitizeTokenSymbol(o.token, 'jpyc'),
    taxRate: sanitizeTaxRate(o.taxRate),
    taxCategory: isTaxCategory(o.taxCategory) ? o.taxCategory : null,
    memo: typeof o.memo === 'string' ? clampStr(o.memo, PRESET_MEMO_MAX) || null : null,
    image: sanitizeImage(o.image),
    category: clampStr(o.category, PRESET_CATEGORY_MAX) || undefined,
    recommended: o.recommended === true ? true : undefined, // round-trip 最小化 (true のみ保持)
    options: validOptionGroups(o.options), // 不正は drop・無ければ undefined
    sortOrder: index,
    enabled: o.enabled !== false, // 既定 true
  };
}

function seedPresets(): ProductPreset[] {
  return SEED_PRESETS.map((p, i) => ({ ...p, id: randomId(), sortOrder: i }));
}

// presets key の有無で seed 判定: 不在 (初回) のみ seed、存在すれば (空配列でも) 尊重
// = 削除した seed は復活しない。
function sanitizeStore(loaded: Partial<ProductPresetStore>): ProductPresetStore {
  const presets = Array.isArray(loaded.presets)
    ? loaded.presets
        .map((p, i) => sanitizePreset(p, i))
        .filter((p): p is ProductPreset => p !== null)
        .slice(0, PRESET_MAX)
        .map((p, i) => ({ ...p, sortOrder: i })) // 配列順で再採番
    : seedPresets();
  const r = loaded.receipt;
  const receipt =
    r && typeof r === 'object' && typeof r.day === 'string' && typeof r.n === 'number'
      ? { day: r.day, n: r.n }
      : { day: '', n: 0 };
  return { presets, receipt };
}

const DEFAULT_STORE: ProductPresetStore = {
  presets: seedPresets(),
  receipt: { day: '', n: 0 },
};

export function useProductPresets() {
  const { settings, setSettings, hydrated } = useLocalStorageSettings<ProductPresetStore>(
    STORAGE_KEY,
    DEFAULT_STORE,
    sanitizeStore,
  );

  const presets = settings.presets;

  // 有効なプリセットのみ・配列順 (= 表示順)。RegisterMode のグリッド用。
  const enabledPresets = useMemo(
    () => presets.filter((p) => p.enabled),
    [presets],
  );

  const addPreset = useCallback(
    (input: Omit<ProductPreset, 'id' | 'sortOrder'>) => {
      setSettings((s) => {
        if (s.presets.length >= PRESET_MAX) return s;
        const preset: ProductPreset = {
          ...input,
          name: clampStr(input.name, PRESET_NAME_MAX),
          unitPrice: sanitizePrice(input.unitPrice),
          memo: input.memo ? clampStr(input.memo, PRESET_MEMO_MAX) || null : null,
          image: sanitizeImage(input.image),
          category: clampStr(input.category, PRESET_CATEGORY_MAX) || undefined,
          id: randomId(),
          sortOrder: s.presets.length,
        };
        return { ...s, presets: [...s.presets, preset] };
      });
    },
    [setSettings],
  );

  const updatePreset = useCallback(
    (id: string, patch: Partial<Omit<ProductPreset, 'id' | 'sortOrder'>>) => {
      setSettings((s) => ({
        ...s,
        presets: s.presets.map((p) => (p.id === id ? { ...p, ...patch } : p)),
      }));
    },
    [setSettings],
  );

  const removePreset = useCallback(
    (id: string) => {
      setSettings((s) => ({
        ...s,
        presets: s.presets
          .filter((p) => p.id !== id)
          .map((p, i) => ({ ...p, sortOrder: i })),
      }));
    },
    [setSettings],
  );

  // 配列順を表示順とし、隣と入れ替える (sortOrder は index ミラー)。
  const movePreset = useCallback(
    (id: string, dir: 'up' | 'down') => {
      setSettings((s) => {
        const idx = s.presets.findIndex((p) => p.id === id);
        if (idx === -1) return s;
        const swap = dir === 'up' ? idx - 1 : idx + 1;
        if (swap < 0 || swap >= s.presets.length) return s;
        const next = [...s.presets];
        [next[idx], next[swap]] = [next[swap], next[idx]];
        return { ...s, presets: next.map((p, i) => ({ ...p, sortOrder: i })) };
      });
    },
    [setSettings],
  );

  // 商品カタログを丸ごと置き換える (例: 別端末で公開中の @handle を編集するため、公開済み
  // storefront のメニューをこの端末へ読み込む)。配列順で sortOrder を再採番し PRESET_MAX で truncate。
  // ⚠️ 既存カタログ (レジと共有) を破壊的に上書きするため、呼び出し側で確認を取ること。
  const replaceAll = useCallback(
    (next: ProductPreset[]) => {
      setSettings((s) => ({
        ...s,
        presets: next.slice(0, PRESET_MAX).map((p, i) => ({ ...p, sortOrder: i })),
      }));
    },
    [setSettings],
  );

  // 管理番号の日次連番採番 (R-YYYYMMDD-NNN)。返り値は同期計算・カウンタは bump。
  const nextReceiptNo = useCallback((): string => {
    const day = dayKey(new Date());
    const cur = settings.receipt.day === day ? settings.receipt.n : 0;
    const n = cur + 1;
    setSettings((s) => {
      const base = s.receipt.day === day ? s.receipt.n : 0;
      return { ...s, receipt: { day, n: base + 1 } };
    });
    return `${RECEIPT_PREFIX}-${day}-${String(n).padStart(3, '0')}`;
  }, [settings.receipt, setSettings]);

  return {
    presets,
    enabledPresets,
    hydrated,
    addPreset,
    updatePreset,
    removePreset,
    movePreset,
    replaceAll,
    nextReceiptNo,
  };
}
