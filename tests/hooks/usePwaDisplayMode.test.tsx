import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

// matchMedia は jsdom default で undefined → 各テストで mock を差し込む。
type Listener = (e: { matches: boolean }) => void;

function setupMatchMedia(initialMatches: boolean) {
  const listeners = new Set<Listener>();
  const mql = {
    matches: initialMatches,
    addEventListener: vi.fn((_: string, l: Listener) => {
      listeners.add(l);
    }),
    removeEventListener: vi.fn((_: string, l: Listener) => {
      listeners.delete(l);
    }),
  };
  window.matchMedia = vi.fn().mockReturnValue(mql);
  return {
    mql,
    fire(matches: boolean) {
      mql.matches = matches;
      listeners.forEach((l) => l({ matches }));
    },
  };
}

beforeEach(() => {
  // iOS legacy 検出のため navigator.standalone を毎回 reset。
  const nav = window.navigator as Navigator & { standalone?: boolean };
  delete nav.standalone;
});

describe('usePwaDisplayMode', () => {
  it('matchMedia matches=false かつ navigator.standalone 無し → false', async () => {
    setupMatchMedia(false);
    // dynamic import で hook を毎テスト fresh import (matchMedia 差替後に評価させる)
    const { usePwaDisplayMode } = await import('@/hooks/usePwaDisplayMode');
    const { result } = renderHook(() => usePwaDisplayMode());
    expect(result.current.isStandalone).toBe(false);
  });

  it('matchMedia matches=true → true', async () => {
    setupMatchMedia(true);
    const { usePwaDisplayMode } = await import('@/hooks/usePwaDisplayMode');
    const { result } = renderHook(() => usePwaDisplayMode());
    expect(result.current.isStandalone).toBe(true);
  });

  it('navigator.standalone=true (iOS legacy) → true', async () => {
    setupMatchMedia(false);
    const nav = window.navigator as Navigator & { standalone?: boolean };
    nav.standalone = true;
    const { usePwaDisplayMode } = await import('@/hooks/usePwaDisplayMode');
    const { result } = renderHook(() => usePwaDisplayMode());
    expect(result.current.isStandalone).toBe(true);
  });

  it('display-mode change イベントで値が更新される', async () => {
    const env = setupMatchMedia(false);
    const { usePwaDisplayMode } = await import('@/hooks/usePwaDisplayMode');
    const { result } = renderHook(() => usePwaDisplayMode());
    expect(result.current.isStandalone).toBe(false);
    act(() => {
      env.fire(true);
    });
    expect(result.current.isStandalone).toBe(true);
  });

  it('SSR-safe: useState 初期値は常に false (PWA standalone 起動でも client first render は false → useEffect で更新) — hydration mismatch regression fence', async () => {
    // useState(readStandalone) lazy init を使うと SSR は false、client は true で
    // SSR HTML と client first render が食い違って React hydration mismatch が出る
    // 本物バグの再発防止。useState の初期値が matchMedia 状態に依存しないことを
    // matchMedia true / standalone true の両条件下で確認する。
    setupMatchMedia(true);
    const nav = window.navigator as Navigator & { standalone?: boolean };
    nav.standalone = true;
    const { usePwaDisplayMode } = await import('@/hooks/usePwaDisplayMode');

    // React 内部の useState(initial) は initial = false で固定。effect 走行後に
    // 真値 (true) へ更新される。final assertion は renderHook が effect を flush
    // する前提で true を期待する (現実の hydration では mismatch 警告にならない
    // 経路: SSR HTML false → client first render false → effect で true へ遷移)。
    const { result } = renderHook(() => usePwaDisplayMode());
    expect(result.current.isStandalone).toBe(true);
    // 初期値の証明: hook 内 useState の initial 引数が関数参照でないこと、つまり
    // readStandalone を lazy init として呼んでいないことを source レベルで担保。
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve('./hooks/usePwaDisplayMode.ts'), 'utf8');
    expect(src).toMatch(/useState<boolean>\(false\)/);
    expect(src).not.toMatch(/useState<boolean>\(readStandalone\)/);
  });

  it('unmount で listener が解除される', async () => {
    const env = setupMatchMedia(false);
    const { usePwaDisplayMode } = await import('@/hooks/usePwaDisplayMode');
    const { unmount } = renderHook(() => usePwaDisplayMode());
    expect(env.mql.addEventListener).toHaveBeenCalledTimes(1);
    unmount();
    expect(env.mql.removeEventListener).toHaveBeenCalledTimes(1);
  });
});
