// メニューオプション (サイズ/トッピング) の純ロジック。lib の leaf (mobileOrder/presets を import しない)。
//
// 設計 (plans/restaurant-pos-roadmap.md §3-B): **定義は構造化・運搬は軽量** という非対称設計。
//   - 店主は preset/menu に OptionGroup[] を構造化定義 (サイズ=single / トッピング=multi・各 choice に
//     非負 priceDelta)。
//   - 顧客/店員が選ぶと cart line の **実効単価 = base + Σ(選択 priceDelta)**、表示名に選択内容の
//     サフィックスを付与する (例: 「牛丼（大盛り・えび）」)。
//   - これで CheckoutItem / encodeItems / StoredOrderItem のスキーマも URL も money-path も **無改変**。
//     合計は実効単価で正しく、受注/履歴/レシートは名前にオプションが出る。
// flag NEXT_PUBLIC_ENABLE_MENU_OPTIONS 既定 OFF で全経路 inert (UI が options を読まない・data は温存)。

export type OptionChoice = {
  id: string;
  label: string;
  /** 単価への加算 (非負 decimal・"0"=価格不変。例 "100")。 */
  priceDelta: string;
};

export type OptionGroup = {
  id: string;
  name: string; // "サイズ" / "トッピング" 等
  type: 'single' | 'multi'; // single=1 つ選択 (サイズ) / multi=複数可 (トッピング)
  required?: boolean; // true=最低 1 つ選択必須
  choices: OptionChoice[];
};

export const OPTION_GROUPS_MAX = 6; // 1 商品あたりのオプショングループ上限
export const OPTION_CHOICES_MAX = 12; // 1 グループあたりの選択肢上限
export const OPTION_NAME_MAX = 24; // グループ名 / 選択肢ラベルの文字数上限
const OPTION_ID_MAX = 64;

// 非負 decimal (整数部 1-12 桁・小数部 0-18 桁)。price は正だが priceDelta は "0" を許可。
// 入力検証 (priceDelta) 用の fat-finger ガード (桁上限あり)。
const NON_NEG_DECIMAL = /^\d{1,12}(\.\d{1,18})?$/;
// 桁上限なしの decimal 判定 (effectiveUnitPrice の防御 norm 用)。BigInt scaling は任意桁を扱えるため、
// 検証済みの大きな base 価格を spurious に 0 へ落とさない (桁上限は入力検証側の責務)。
const DECIMAL_ANY = /^\d+(\.\d+)?$/;
// 行表示名の上限 (= lib/url/checkout CHECKOUT_NAME_MAX)。これを超えると checkout が name 末尾を
// 切り、オプションのサフィックスが欠落するため、composeLineName 側でこの範囲に収める。
const COMPOSED_NAME_MAX = 80;

function isStr(v: unknown, max: number): v is string {
  return typeof v === 'string' && v.trim().length > 0 && v.length <= max;
}

/**
 * untrusted な値 → OptionGroup[] | undefined。不正な choice/group は **drop し有効分のみ残す**
 * (tax と同じ寛容さ・オプションが壊れても商品自体は基本価格で注文可能に degrade)。全 drop で
 * 空になれば undefined (= オプション無し item)。validMenuItem / sanitizePreset の単一情報源。
 */
export function validOptionGroups(raw: unknown): OptionGroup[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const groups: OptionGroup[] = [];
  const seenGroupIds = new Set<string>();
  for (const g of raw) {
    if (groups.length >= OPTION_GROUPS_MAX) break;
    if (!g || typeof g !== 'object') continue;
    const o = g as Record<string, unknown>;
    if (!isStr(o.id, OPTION_ID_MAX) || !isStr(o.name, OPTION_NAME_MAX)) continue;
    if (seenGroupIds.has(o.id)) continue;
    const type = o.type === 'multi' ? 'multi' : o.type === 'single' ? 'single' : null;
    if (!type) continue;
    if (!Array.isArray(o.choices)) continue;
    const choices: OptionChoice[] = [];
    const seenChoiceIds = new Set<string>();
    for (const c of o.choices) {
      if (choices.length >= OPTION_CHOICES_MAX) break;
      if (!c || typeof c !== 'object') continue;
      const co = c as Record<string, unknown>;
      if (!isStr(co.id, OPTION_ID_MAX) || !isStr(co.label, OPTION_NAME_MAX)) continue;
      if (seenChoiceIds.has(co.id)) continue;
      // priceDelta: 未指定/空は "0" (価格不変=意図的・サイズで値段が変わらない等)。**不正値は無料化
      // せず choice ごと drop** (改竄/誤入力の published メニューで有料選択肢が黙って無料になる事故防止)。
      let priceDelta: string;
      if (co.priceDelta === undefined || co.priceDelta === '') {
        priceDelta = '0';
      } else if (typeof co.priceDelta === 'string' && NON_NEG_DECIMAL.test(co.priceDelta)) {
        priceDelta = co.priceDelta;
      } else {
        continue; // 不正な priceDelta → この choice を drop (黙って無料にしない)
      }
      seenChoiceIds.add(co.id);
      choices.push({ id: co.id, label: co.label.trim(), priceDelta });
    }
    if (choices.length === 0) continue; // 有効な選択肢が無いグループは drop
    seenGroupIds.add(o.id);
    const group: OptionGroup = { id: o.id, name: o.name.trim(), type, choices };
    if (o.required === true) group.required = true;
    groups.push(group);
  }
  return groups.length > 0 ? groups : undefined;
}

// ── decimal 加算 (token-agnostic・BigInt scaling)。base / delta は検証済み within-precision ゆえ、
//    最大小数桁へスケールして整数加算 → trailing zero 除去で文字列へ戻す。 ──
function fracLen(s: string): number {
  const i = s.indexOf('.');
  return i === -1 ? 0 : s.length - i - 1;
}
function toScaled(s: string, scale: number): bigint {
  const [int, frac = ''] = s.split('.');
  const padded = (frac + '0'.repeat(scale)).slice(0, scale);
  return BigInt((int || '0') + (scale > 0 ? padded : ''));
}
function fromScaled(v: bigint, scale: number): string {
  if (scale === 0) return v.toString();
  const s = v.toString().padStart(scale + 1, '0');
  const int = s.slice(0, -scale);
  const frac = s.slice(-scale).replace(/0+$/, '');
  return frac.length > 0 ? `${int}.${frac}` : int;
}

/** 実効単価 = base + Σ(選択 choice の priceDelta)。decimal 文字列で返す (CheckoutItem.price へ)。
 *  base / delta は通常検証済みだが、編集途中 (未 sanitize) の preset から呼ばれても壊れないよう
 *  非 decimal は防御的に "0" 扱い (BigInt 変換の throw 回避)。 */
export function effectiveUnitPrice(
  basePrice: string,
  selectedChoices: OptionChoice[],
): string {
  // 桁上限なしで decimal 判定 (検証済みの大きな base 価格を spurious に 0 化しない)。
  // 真に非 decimal (空/文字) のみ 0 (BigInt throw 回避の最終防御・実経路では発生しない)。
  const norm = (s: string) => (DECIMAL_ANY.test(s) ? s : '0');
  const parts = [norm(basePrice), ...selectedChoices.map((c) => norm(c.priceDelta))];
  const scale = parts.reduce((m, p) => Math.max(m, fracLen(p)), 0);
  const sum = parts.reduce((acc, p) => acc + toScaled(p, scale), 0n);
  return fromScaled(sum, scale);
}

/** 選択内容のサフィックス文字列 (group 順・「・」区切り)。空なら ''。 */
export function optionSummary(selectedChoices: OptionChoice[]): string {
  return selectedChoices.map((c) => c.label).join('・');
}

/**
 * 行の表示名 = baseName（サフィックス）。選択が無ければ baseName のまま。
 * 全角括弧 + 中黒で固定 (受注/履歴/レシートに格納される確定文字列ゆえ locale 非依存)。
 * mobile / register 双方が同じ書式を使い、同一選択 → 同一名 になるようにする。
 */
export function composeLineName(baseName: string, selectedChoices: OptionChoice[]): string {
  const summary = optionSummary(selectedChoices);
  if (!summary) return baseName;
  const suffix = `（${summary}）`;
  // checkout は name を CHECKOUT_NAME_MAX で末尾切りするため、ここで上限内に収める。オプションは
  // 注文/レシートで欠落させてはいけないので **base を先に詰めて suffix を残す**。code point 単位で
  // 切る (サロゲート分割を避ける)。suffix だけで上限超なら suffix を詰める (異常に長いオプション)。
  const suffixCp = [...suffix];
  if (suffixCp.length >= COMPOSED_NAME_MAX) {
    return suffixCp.slice(0, COMPOSED_NAME_MAX).join('');
  }
  const room = COMPOSED_NAME_MAX - suffixCp.length;
  const baseCp = [...baseName];
  const base = baseCp.length > room ? baseCp.slice(0, room).join('') : baseName;
  return `${base}${suffix}`;
}

/** cart 行の識別キー: itemId + 選択 (group:choice をソート結合)。同一商品の別オプションを別行に。 */
export function selectionKey(
  itemId: string,
  selections: ReadonlyArray<{ groupId: string; choiceId: string }>,
): string {
  // 区切り文字 (#/:/,) が id に混じっても衝突しないよう各要素を encodeURIComponent (これらを全て
  // エスケープする)。キーは dedup 専用で parse しないため可逆性は不要。
  const enc = encodeURIComponent;
  const parts = selections.map((s) => `${enc(s.groupId)}:${enc(s.choiceId)}`).sort();
  return parts.length > 0 ? `${enc(itemId)}#${parts.join(',')}` : enc(itemId);
}

// UI の選択状態: groupId → choiceId (single) | choiceId[] (multi)。
export type OptionSelection = Record<string, string | string[]>;

export type ResolvedSelection =
  | {
      ok: true;
      choices: OptionChoice[];
      selections: { groupId: string; choiceId: string }[];
    }
  | { ok: false; missingGroupId: string };

/**
 * 選択状態を解決: groups 順に選ばれた choice を並べる。required グループ未選択なら ok:false
 * (最初の未選択 group id を返す)。不正な choiceId は黙って無視。
 */
export function resolveSelection(
  groups: OptionGroup[],
  sel: OptionSelection,
): ResolvedSelection {
  const choices: OptionChoice[] = [];
  const selections: { groupId: string; choiceId: string }[] = [];
  for (const g of groups) {
    const raw = sel[g.id];
    const picked: string[] =
      g.type === 'single'
        ? typeof raw === 'string' && raw
          ? [raw]
          : []
        : Array.isArray(raw)
          ? raw
          : [];
    if (g.required && picked.length === 0) {
      return { ok: false, missingGroupId: g.id };
    }
    // **定義順**で並べる (multi のクリック順に依存しない決定論的な名前/サフィックス)。
    for (const c of g.choices) {
      if (picked.includes(c.id)) {
        choices.push(c);
        selections.push({ groupId: g.id, choiceId: c.id });
      }
    }
  }
  return { ok: true, choices, selections };
}
