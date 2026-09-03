import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

// Node 26 は実験的な global localStorage を持ち (--localstorage-file 必須)、その影響で
// vitest の jsdom 環境が window.localStorage を生やさなくなる (2026-08-02 実測: 全 suite が
// setup の localStorage.clear() で全滅)。欠けている場合のみ per-file の in-memory 実装を
// 与える (worker/ファイル間で共有しない = テスト隔離を保つ)。従来環境 (CI 含む) では
// jsdom 実装が存在するため no-op。
// 実装は Storage.prototype にメソッドを定義し、インスタンスは Object.create(prototype) で
// 作る — `vi.spyOn(Storage.prototype, 'setItem')` で quota 障害等を注入する既存テスト
// (circlePending / history / paymentIntentStorage) がそのまま効くようにするため。
(() => {
  if (typeof window === 'undefined' || window.localStorage) return;
  const StorageCtor = (
    window as unknown as { Storage?: { prototype: Storage } }
  ).Storage;
  const proto = StorageCtor?.prototype;
  if (!proto) return;
  const stores = new WeakMap<object, Map<string, string>>();
  const dataOf = (self: object) => {
    let data = stores.get(self);
    if (!data) {
      data = new Map();
      stores.set(self, data);
    }
    return data;
  };
  Object.defineProperties(proto, {
    length: {
      configurable: true,
      get(this: object) {
        return dataOf(this).size;
      },
    },
    clear: {
      configurable: true,
      writable: true,
      value(this: object) {
        dataOf(this).clear();
      },
    },
    getItem: {
      configurable: true,
      writable: true,
      value(this: object, key: string) {
        const data = dataOf(this);
        const k = String(key);
        return data.has(k) ? data.get(k)! : null;
      },
    },
    key: {
      configurable: true,
      writable: true,
      value(this: object, index: number) {
        return [...dataOf(this).keys()][index] ?? null;
      },
    },
    removeItem: {
      configurable: true,
      writable: true,
      value(this: object, key: string) {
        dataOf(this).delete(String(key));
      },
    },
    setItem: {
      configurable: true,
      writable: true,
      value(this: object, key: string, value: string) {
        dataOf(this).set(String(key), String(value));
      },
    },
  });
  // Node 26 は global に自前の Storage / sessionStorage を持つ。テスト内の裸の
  // `Storage` / `sessionStorage` が node 側を指すと、`vi.spyOn(Storage.prototype, …)`
  // が window 側インスタンスに効かない (spy 素通り) ため、window に per-file
  // インスタンスを強制配備し globalThis も window と同一物に揃える。
  for (const name of ['localStorage', 'sessionStorage'] as const) {
    Object.defineProperty(window, name, {
      value: Object.create(proto),
      configurable: true,
    });
    Object.defineProperty(globalThis, name, {
      value: window[name],
      configurable: true,
    });
  }
  Object.defineProperty(globalThis, 'Storage', {
    value: StorageCtor,
    configurable: true,
    writable: true,
  });
})();

// jsdom は matchMedia を実装しないため、既定の no-op スタブを各テスト前に用意する
// (matches=false = 非 standalone / 非モバイル)。PwaInstallHint は広く render される
// (QrGenerator / HistoryView / ScanShell) 一方で usePwaDisplayMode 経由で matchMedia を
// 呼ぶ。個別に stub したいテスト (PwaInstallHint / ScanShell) は body 内で上書きする。
beforeEach(() => {
  if (typeof window !== 'undefined' && !window.matchMedia) {
    window.matchMedia = vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
  }
});

afterEach(() => {
  cleanup();
  // `// @vitest-environment node` を宣言したファイル (Lua ランナー系: wasmoon の
  // emscripten glue は jsdom 下だと document.baseURI から scriptDirectory を組み立てて
  // createRequire に食わせ、初期化に失敗する) では window が無い。DOM 前提の後始末が
  // node 環境のテストを巻き込んで落とすのを断つ — jsdom 側では従来どおり実行される。
  if (typeof window === 'undefined') return;
  window.localStorage.clear();
  // 次テストが既定 stub から始まるよう matchMedia をリセット (matches=true を残さない)。
  delete (window as unknown as { matchMedia?: unknown }).matchMedia;
});
