'use client';

// LocalStorage 永続化 + sanitize 付き hydration の共通 hook。
// useQrSettings / useTipSettings / useMobileOrderDraft / useProductPresets / useHandleProfileDraft の共通基盤。
// - 初回 mount で保存値を読み → sanitize → hydrated=true。hydrated=false の間は書かない (既定値で保存値を消さない)。
// - 保存値が無い・旧形式や不正値を含む (sanitize で変わる) ときは、読み込み直後に 1 度書いて移行を保存に残す。
//   このときも土台は書く直前に読み直した保存値 (を sanitize したもの) で、読み込んでから書くまでに別のタブが書いた
//   値を既定値で消さない。
//
// 同じ設定を複数のタブで開いても、古いタブの値で別のタブの変更を上書きしない (第 7 回レビュー D10)。
// - 設定の 1 段目のキーごとに「このタブが保存値と最後に揃えた値」(base) を持つ。settings と base が食い違うキー
//   だけが、このタブで変えた (まだ保存していない) 項目。
// - 保存は「最新の保存値を読み直す → このタブで変えたキーだけを重ねる → 書く」。Web Locks があれば key ごとの
//   ロックの中で行い、別のタブの読み直しと書き込みが交差しない (ほぼ同時に書いても片方の変更が消えない)。
//   Web Locks が無い・拒否されたときは同じ書き込みをロックなしで行う (設定全体を書いていた従来より悪くならない)。
//   書けたときだけ base を進める (保存に失敗したら、次の変更のときにもう一度書く)。
// - 別のタブの変更を取り込むのは、このタブが前面に戻ったとき (focus / visibilitychange) だけ。storage イベントや
//   BroadcastChannel で即座には取り込まない: 別のタブで受取先を打っている途中の値 (ENS 名の打ちかけ等) が、この
//   タブで客に見せている QR に流れ込むため。前面に戻ったとき (= 店主がこのタブを操作するとき) には打ち終わっている。
//   書いた直後にも取り込まない (接続ウォレットの切り替えに追従する自動補完など、前面にないタブも書くため)。
// - 取り込むのは sanitize を通しても変わらない (= 検証済みの) 値だけ。このタブの未保存の変更には触れず、取り込むと
//   項目の組み合わせが崩れる (sanitize で直される項目が増える) なら取り込まない。消えた・壊れた保存値も取り込まない
//   (受取先が空欄に戻ると接続ウォレットからの自動補完が走り、受取先が別のウォレットに変わってしまうため)。
//   取り込まなかった値は base も進めないので、このタブが古い値で書き戻すことはない。

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

/**
 * 保存値 (remote) のうち、このタブが揃えた値 (base) から変わったキーを取り込む。純関数 (state の更新関数の中で呼ぶ)。
 * - sanitize を通すと変わる値 (不正値・消えた必須キー) は取り込まない。
 * - このタブの未保存の変更があるキーは settings を変えず base だけ進める (このタブの変更が後で書かれて勝つ)。
 * - 取り込んだ結果、sanitize で直される項目が増える (組み合わせが崩れる) なら何も取り込まない。
 */
function mergeRemote<T>(
  cur: Synced<T>,
  remote: Stored,
  sanitize: (loaded: Partial<T>) => T,
): Synced<T> {
  const settings = cur.settings as Stored;
  const changed = changedKeys(remote, cur.base);
  if (changed.length === 0) return cur;
  const canonical = sanitize(remote as Partial<T>) as Stored;
  const accepted = changed.filter((k) => sameJson(canonical[k], remote[k]));
  if (accepted.length === 0) return cur;

  const nextSettings: Stored = { ...settings };
  const nextBase: Stored = { ...cur.base };
  for (const k of accepted) {
    if (sameJson(settings[k], cur.base[k])) assign(nextSettings, k, remote);
    assign(nextBase, k, remote);
  }
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
    const keys = changedKeys(local, base);
    const migrate = migrateRef.current;
    if (keys.length === 0 && !migrate) return;
    const latest = readStored(storageKey);
    let next: Stored;
    if (!latest) {
      // 保存値が無い・壊れているときは設定全体を書く (初めて開いたとき・従来と同じ)。
      next = { ...local };
    } else {
      // 移行がまだなら、読み込んでから誰も書いていなければ読み込んだ値 (の sanitize 済み) を、書いていれば最新の保存値を
      // sanitize したもの (別のタブの新しい値が残る) を土台にする。その上にこのタブで変えたキーだけを重ねる。
      const ground = !migrate
        ? latest
        : sameJson(latest, loadedRef.current)
          ? base
          : (sanitize(latest as Partial<T>) as Stored);
      next = { ...ground };
      for (const k of keys) assign(next, k, local);
    }
    if (!safeSet(storageKey, next)) return;
    migrateRef.current = false;
    // 書いたキーだけを保存済みにする (それ以外のキーの別のタブの変更は、前面に戻ったときに取り込む)。
    setSynced((cur) => {
      const base: Stored = { ...cur.base };
      for (const k of keys) assign(base, k, next);
      return { settings: cur.settings, base };
    });
  }, [storageKey, sanitize]);

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

  useEffect(() => {
    if (!hydrated) return;
    const pull = () => {
      if (document.visibilityState === 'hidden') return;
      const stored = readStored(storageKey);
      if (!stored) return;
      setSynced((cur) => mergeRemote(cur, stored, sanitize));
    };
    window.addEventListener('focus', pull);
    document.addEventListener('visibilitychange', pull);
    return () => {
      window.removeEventListener('focus', pull);
      document.removeEventListener('visibilitychange', pull);
    };
  }, [hydrated, storageKey, sanitize]);

  return { settings: synced.settings, setSettings, hydrated };
}
