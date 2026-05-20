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

  it('unmount で listener が解除される', async () => {
    const env = setupMatchMedia(false);
    const { usePwaDisplayMode } = await import('@/hooks/usePwaDisplayMode');
    const { unmount } = renderHook(() => usePwaDisplayMode());
    expect(env.mql.addEventListener).toHaveBeenCalledTimes(1);
    unmount();
    expect(env.mql.removeEventListener).toHaveBeenCalledTimes(1);
  });
});
