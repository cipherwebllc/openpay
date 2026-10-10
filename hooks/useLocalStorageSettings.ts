'use client';

// LocalStorage 永続化 + sanitize 付き hydration の共通 hook。
// useQrSettings / useTipSettings / useMobileOrderDraft / useProductPresets / useHandleProfileDraft の共通基盤。
// - 初回 mount で保存値を読み → sanitize → hydrated=true。hydrated=false の間は書かない (既定値で保存値を消さない)。
// - 保存値が無い・旧形式や不正値を含む (sanitize で変わる) ときは、読み込み直後に 1 度書いて移行を保存に残す。
//   このときも土台は書く直前に読み直した保存値 (を sanitize したもの) で、読み込んでから書くまでに別のタブが書いた
//   値を既定値で消さない。
//
// 同じ設定を複数のタブで開いても、古いタブの値で別のタブの変更を上書きしない (第 7 回レビュー D10)。
// - 同期の単位は設定の 1 段目のキー。ただし組で意味を持つキー (受取先とその由来・通貨とチェーンと支払い方法 など。
//   各 hook が rules.groups で宣言する) は組を 1 つの単位にする: 片方だけを別のタブの値にすると意味が変わるため。
// - 単位ごとに「このタブが保存値と最後に揃えた値」(base) を持つ。settings と base が食い違う単位だけが、このタブで
//   変えた (まだ保存していない) 項目。
// - 保存は「最新の保存値を読み直す → このタブで変えた単位だけを重ねる → 書く」。Web Locks があれば key ごとの
//   ロックの中で行い、別のタブの読み直しと書き込みが交差しない (ほぼ同時に書いても片方の変更が消えない)。
//   Web Locks が無い・拒否されたときは同じ書き込みをロックなしで行う (設定全体を書いていた従来より悪くならない)。
//   書けたときだけ base を進める (保存に失敗したら、次の変更のときにもう一度書く)。重ねた結果の組み合わせが崩れる
//   (宣言していない組の片方ずつが混ざり sanitize で直される) なら書かず、このタブの未保存の変更を取り下げて最新の
//   保存値を取り込む (再読み込みで黙って直される値を保存しない)。
// - 別のタブの変更を取り込むのは、このタブが前面に戻ったとき (focus / visibilitychange) だけ。storage イベントや
//   BroadcastChannel で即座には取り込まない: 別のタブで受取先を打っている途中の値 (ENS 名の打ちかけ等) が、この
//   タブで客に見せている QR に流れ込むため。前面に戻ったとき (= 店主がこのタブを操作するとき) には打ち終わっている。
//   書いた直後にも取り込まない (接続ウォレットの切り替えに追従する自動補完など、前面にないタブも書くため)。
//   会計の途中 (呼び出し側が holdImport で知らせる: 金額を入れた・カートに商品がある・QR を見せている) は取り込みを
//   保留し、会計が終わったら 1 度取り込む。金額やカートは通貨を持たない数字なので、途中で別のタブの通貨・受取先を
//   取り込むと、同じ数字のまま別の通貨・別の宛先の QR になる (500 円のつもりが 500 ドル)。
// - 取り込むのは、sanitize を通しても変わらず、rules.importable を満たす (受取先なら確定した値 = 空欄・打ちかけでない)
//   単位だけ。受取先が空欄になると接続ウォレットからの自動補完が走り、受取先が別のウォレットに変わってしまうため。
//   このタブに未保存の変更がある単位には触れず、取り込むと組み合わせが崩れるなら取り込まない。消えた・壊れた保存値も
//   取り込まない。取り込まなかった単位は base も進めないので、このタブが古い値で書き戻すことはない。

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import { logger } from '@/lib/logger';
import { safeGet, safeSet } from '@/lib/storage';

type Stored = Record<string, unknown>;

/**
 * 別のタブとの同期の決まり (各 hook がモジュールの定数で渡す・参照が変わると読み直しになる)。
 * - groups: 組で意味を持つキー。保存も取り込みも組ごとに行う (片方だけが別のタブの値にならない)。
 * - importable: 別のタブの値をこのタブに取り込んでよいか (sanitize とは別の「確定した値か」)。false の値を含む組は取り込まない。
 */
export type SettingsSyncRules<T> = {
  groups?: readonly (readonly (keyof T & string)[])[];
  importable?: { readonly [K in keyof T]?: (value: T[K]) => boolean };
};

const NO_RULES: SettingsSyncRules<never> = {};

type Synced<T> = {
  settings: T;
  /** 保存値のうち、このタブの settings が最後に揃えた値 (キーごと)。 */
  base: Stored;
};

/** 保存値を JSON の object として読む。無い・読めない・object でない (配列・文字列・null) は null。 */
function readStored(key: string): Stored | null {
  const value = safeGet<unknown>(key, null);
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Stored)
    : null;
}

/** JSON として同じ値か (object のキーの順序と undefined のプロパティは区別しない = 保存したときと同じ見方)。 */
function sameJson(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

function canonicalJson(value: unknown): string | undefined {
  return JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, (v as Stored)[k]]),
        )
      : v,
  );
}

/** 2 つの object で値 (JSON として) が違うキー。片方にしか無いキーも含む。 */
function changedKeys(a: Stored, b: Stored): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].filter((k) => !sameJson(a[k], b[k]));
}

function assign(target: Stored, key: string, source: Stored): void {
  if (source[key] === undefined) delete target[key];
  else target[key] = source[key];
}

/** keys を同期の単位 (宣言された組・それ以外は 1 キー) に広げる。 */
function unitsOf<T>(keys: readonly string[], rules: SettingsSyncRules<T>): string[][] {
  const units: string[][] = [];
  const seen = new Set<string>();
  for (const k of keys) {
    if (seen.has(k)) continue;
    const unit = [...(rules.groups?.find((g) => (g as readonly string[]).includes(k)) ?? [k])];
    for (const u of unit) seen.add(u);
    units.push(unit);
  }
  return units;
}

/** next で sanitize に直されるキーのうち、local でも ground (土台にした保存値) でも直されなかったもの = 重ねて崩れたものがあるか。 */
function mixBreaks<T>(next: Stored, local: Stored, ground: Stored, sanitize: (loaded: Partial<T>) => T): boolean {
  const sn = sanitize(next as Partial<T>) as Stored;
  const sl = sanitize(local as Partial<T>) as Stored;
  const sg = sanitize(ground as Partial<T>) as Stored;
  return Object.keys(sn).some(
    (k) => !sameJson(sn[k], next[k]) && sameJson(sl[k], local[k]) && sameJson(sg[k], ground[k]),
  );
}

/**
 * 保存値 (remote) のうち、このタブが揃えた値 (base) から変わった単位を取り込む。純関数 (state の更新関数の中で呼ぶ)。
 * - このタブに未保存の変更がある単位は取り込まない (組ごとこのタブの値のまま・後で組ごと書かれる)。
 * - sanitize を通すと変わる値 (不正値・消えた必須キー) や rules.importable を満たさない値を含む単位は取り込まない。
 * - 取り込んだ結果、sanitize で直される項目が増える (組み合わせが崩れる) なら何も取り込まない。
 */
function mergeRemote<T>(
  cur: Synced<T>,
  remote: Stored,
  sanitize: (loaded: Partial<T>) => T,
  rules: SettingsSyncRules<T>,
): Synced<T> {
  const settings = cur.settings as Stored;
  const changed = changedKeys(remote, cur.base);
  if (changed.length === 0) return cur;
  const canonical = sanitize(remote as Partial<T>) as Stored;
  const importable = rules.importable as Record<string, ((value: unknown) => boolean) | undefined> | undefined;

  const nextSettings: Stored = { ...settings };
  const nextBase: Stored = { ...cur.base };
  let applied = false;
  for (const unit of unitsOf(changed, rules)) {
    if (unit.some((k) => !sameJson(settings[k], cur.base[k]))) continue;
    const valid = unit.every(
      (k) => sameJson(canonical[k], remote[k]) && (importable?.[k]?.(remote[k]) ?? true),
    );
    if (!valid) continue;
    for (const k of unit) {
      assign(nextSettings, k, remote);
      assign(nextBase, k, remote);
    }
    applied = true;
  }
  if (!applied) return cur;
  const before = sanitize(settings as Partial<T>) as Stored;
  const after = sanitize(nextSettings as Partial<T>) as Stored;
  const broken = Object.keys(after).some(
    (k) => !sameJson(after[k], nextSettings[k]) && sameJson(before[k], settings[k]),
  );
  if (broken) return cur;
  return { settings: nextSettings as T, base: nextBase };
}

function lockName(storageKey: string): string {
  return `openpay:settings-write:${storageKey}`;
}

export function useLocalStorageSettings<T extends object>(
  storageKey: string,
  defaultValue: T,
  sanitize: (loaded: Partial<T>) => T,
  rules: SettingsSyncRules<T> = NO_RULES as SettingsSyncRules<T>,
  holdImport = false,
) {
  const [synced, setSynced] = useState<Synced<T>>(() => ({ settings: defaultValue, base: {} }));
  const [hydrated, setHydrated] = useState(false);
  // 描画が確定した最新の状態 (ロックの中の書き込みが読む)。
  const syncedRef = useRef(synced);
  // ロック待ちの書き込みがある (重ねて頼まない・ロックの中で最新の状態をまとめて書く)。
  const writeQueuedRef = useRef(false);
  // 読み込んだときの保存値と、読み込み直後の移行の書き込みがまだか。
  const loadedRef = useRef<Stored | null>(null);
  const migrateRef = useRef(false);
  // 会計の途中で取り込みを保留しているか (holdImport の最新値) と、保留中に前面に戻った (会計が終わったら取り込む) か。
  const holdImportRef = useRef(holdImport);
  const importDeferredRef = useRef(false);

  const setSettings = useCallback<Dispatch<SetStateAction<T>>>((update) => {
    setSynced((cur) => {
      const settings =
        typeof update === 'function' ? (update as (prev: T) => T)(cur.settings) : update;
      return settings === cur.settings ? cur : { settings, base: cur.base };
    });
  }, []);

  useEffect(() => {
    const stored = readStored(storageKey);
    const settings = sanitize((stored ?? {}) as Partial<T>);
    loadedRef.current = stored;
    migrateRef.current = stored === null || !sameJson(settings, stored);
    setSynced({ settings, base: settings as Stored });
    setHydrated(true);
  }, [storageKey, sanitize]);

  const writeNow = useCallback(() => {
    const { settings, base } = syncedRef.current;
    const local = settings as Stored;
    const keys = unitsOf(changedKeys(local, base), rules).flat();
    const migrate = migrateRef.current;
    if (keys.length === 0 && !migrate) return;
    const latest = readStored(storageKey);
    let next: Stored;
    if (!latest) {
      // 保存値が無い・壊れているときは設定全体を書く (初めて開いたとき・従来と同じ)。
      next = { ...local };
    } else {
      // 移行がまだなら、読み込んでから誰も書いていなければ読み込んだ値 (の sanitize 済み) を、書いていれば最新の保存値を
      // sanitize したもの (別のタブの新しい値が残る) を土台にする。その上にこのタブで変えた単位だけを重ねる。
      const ground = !migrate
        ? latest
        : sameJson(latest, loadedRef.current)
          ? base
          : (sanitize(latest as Partial<T>) as Stored);
      next = { ...ground };
      for (const k of keys) assign(next, k, local);
      // 別のタブの値と混ざった (このタブの値だけではない) ときだけ、重ねた組み合わせが崩れていないかを確かめる。
      if (changedKeys(next, local).length > 0 && mixBreaks(next, local, ground, sanitize)) {
        // 崩れた組み合わせは書かない (再読み込みで sanitize が黙って直し、どちらの変更とも違う値になる)。このタブの
        // 未保存の変更を取り下げ、最新の保存値を取り込む (画面には実際に保存されている値を出す)。
        logger.warn('settings write conflict', { key: storageKey, keys });
        // 会計の途中なら保存値の取り込みは会計が終わってから (下の holdImport)。
        const held = holdImportRef.current;
        if (held) importDeferredRef.current = true;
        setSynced((cur) => {
          const reverted: Stored = { ...(cur.settings as Stored) };
          for (const k of keys) assign(reverted, k, cur.base);
          const withdrawn = { settings: reverted as T, base: cur.base };
          return held ? withdrawn : mergeRemote(withdrawn, latest, sanitize, rules);
        });
        return;
      }
    }
    if (!safeSet(storageKey, next)) return;
    migrateRef.current = false;
    // 書いた単位だけを保存済みにする (それ以外の別のタブの変更は、前面に戻ったときに取り込む)。
    setSynced((cur) => {
      const nextBase: Stored = { ...cur.base };
      for (const k of keys) assign(nextBase, k, next);
      return { settings: cur.settings, base: nextBase };
    });
  }, [storageKey, sanitize, rules]);

  const scheduleWrite = useCallback(() => {
    const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
    if (!locks?.request) {
      writeNow();
      return;
    }
    if (writeQueuedRef.current) return;
    writeQueuedRef.current = true;
    void (async () => {
      try {
        await locks.request(lockName(storageKey), () => {
          writeQueuedRef.current = false;
          writeNow();
        });
      } catch (error) {
        // ロックを拒否されても (sandbox の iframe 等) 設定の保存そのものは止めない: ロックなしで同じ書き込みをする。
        logger.warn('settings lock failed', { key: storageKey, error });
        writeQueuedRef.current = false;
        writeNow();
      }
    })();
  }, [storageKey, writeNow]);

  useEffect(() => {
    syncedRef.current = synced;
    if (!hydrated) return;
    if (!migrateRef.current && changedKeys(synced.settings as Stored, synced.base).length === 0) return;
    scheduleWrite();
  }, [synced, hydrated, scheduleWrite]);

  const pullNow = useCallback(() => {
    const stored = readStored(storageKey);
    if (!stored) return;
    setSynced((cur) => mergeRemote(cur, stored, sanitize, rules));
  }, [storageKey, sanitize, rules]);

  // 会計が終わったら (holdImport が外れたら)、保留していた取り込みを 1 度行う。
  useEffect(() => {
    holdImportRef.current = holdImport;
    if (holdImport || !importDeferredRef.current) return;
    importDeferredRef.current = false;
    pullNow();
  }, [holdImport, pullNow]);

  useEffect(() => {
    if (!hydrated) return;
    const pull = () => {
      if (document.visibilityState === 'hidden') return;
      if (holdImportRef.current) {
        importDeferredRef.current = true;
        return;
      }
      pullNow();
    };
    window.addEventListener('focus', pull);
    document.addEventListener('visibilitychange', pull);
    return () => {
      window.removeEventListener('focus', pull);
      document.removeEventListener('visibilitychange', pull);
    };
  }, [hydrated, pullNow]);

  return { settings: synced.settings, setSettings, hydrated };
}
