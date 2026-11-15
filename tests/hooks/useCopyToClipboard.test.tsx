// useCopyToClipboard の契約テスト。
// D8: writeText の reject を呼び出し元へ波及させない (unhandled rejection を作らない・
// 偽の「コピーしました」表示を出さない) ことと、feedback timer を unmount で破棄する
// (unmount 後の setState / timer leak を作らない) ことを fence する。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useEffect } from 'react';
import { act, renderHook } from '@testing-library/react';
import {
  useCopyToClipboard,
  COPIED_FEEDBACK_MS,
} from '@/hooks/useCopyToClipboard';

let writeText: ReturnType<typeof vi.fn>;

beforeEach(() => {
  writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('useCopyToClipboard', () => {
  it('成功時は true を返し copied が feedbackMs 後に戻る', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useCopyToClipboard());
    expect(result.current.available).toBe(true);

    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.copy('https://open-pay.jp/pay?x=1');
    });
    expect(ok).toBe(true);
    expect(writeText).toHaveBeenCalledWith('https://open-pay.jp/pay?x=1');
    expect(result.current.copied).toBe(true);

    act(() => {
      vi.advanceTimersByTime(COPIED_FEEDBACK_MS);
    });
    expect(result.current.copied).toBe(false);
  });

  it('writeText が reject しても throw せず false を返し copied を立てない', async () => {
    writeText.mockRejectedValue(new Error('NotAllowedError'));
    const { result } = renderHook(() => useCopyToClipboard());

    let ok: boolean | undefined;
    // await 内で throw すれば act が再送出してこの test は fail する
    // (= 「呼び出し元へ波及しない」ことの検証)。
    await act(async () => {
      ok = await result.current.copy('secret');
    });
    expect(ok).toBe(false);
    expect(result.current.copied).toBe(false);
  });

  it('空文字 / clipboard 不在では writeText を呼ばず false', async () => {
    const { result } = renderHook(() => useCopyToClipboard());
    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.copy('');
    });
    expect(ok).toBe(false);
    expect(writeText).not.toHaveBeenCalled();

    Object.defineProperty(navigator, 'clipboard', {
      value: undefined,
      configurable: true,
      writable: true,
    });
    const { result: noClipboard } = renderHook(() => useCopyToClipboard());
    expect(noClipboard.current.available).toBe(false);
    await act(async () => {
      ok = await noClipboard.current.copy('x');
    });
    expect(ok).toBe(false);
    expect(writeText).not.toHaveBeenCalled();
  });

  it('unmount で feedback timer を破棄する (timer leak / unmount 後 setState なし)', async () => {
    vi.useFakeTimers();
    const { result, unmount } = renderHook(() => useCopyToClipboard());
    const before = vi.getTimerCount();

    await act(async () => {
      await result.current.copy('abc');
    });
    expect(vi.getTimerCount()).toBe(before + 1);

    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    unmount();
    expect(vi.getTimerCount()).toBe(before);
    act(() => {
      vi.advanceTimersByTime(COPIED_FEEDBACK_MS * 2);
    });
    expect(errors).not.toHaveBeenCalled();
  });

  // 2026-11-16 (トップの自分のページのコピー・P5b のレビュー)。
  // 既定: 押し直しても成功の表示を保つ (copied でボタンの名前を切り替える部品で、名前を揺らさない = 今までどおり)。
  it('既定: 成功の直後 (feedbackMs 以内) に押し直して成功しても、copied は途中で false にならない', async () => {
    const seen: boolean[] = [];
    const { result } = renderHook(() => {
      const state = useCopyToClipboard();
      seen.push(state.copied);
      return state;
    });
    await act(async () => {
      await result.current.copy('first');
    });
    expect(result.current.copied).toBe(true);
    const from = seen.length;
    let resolve!: () => void;
    writeText.mockImplementationOnce(() => new Promise<void>((r) => (resolve = r)));
    let pending!: Promise<boolean>;
    await act(async () => {
      pending = result.current.copy('second');
    });
    // 結果を待つ間も成功の表示のまま。
    expect(result.current.copied).toBe(true);
    await act(async () => {
      resolve();
      await pending;
    });
    expect(result.current.copied).toBe(true);
    expect(seen.slice(from)).not.toContain(false);
  });

  // resetOnAttempt: copied は最新の試行の結果 (トップの自分のページのコピーだけが使う)。
  const useResettingCopy = () => useCopyToClipboard(COPIED_FEEDBACK_MS, { resetOnAttempt: true });

  it('resetOnAttempt: 成功の直後 (feedbackMs 以内) に押し直して失敗したら、前の成功の copied を残さない', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(useResettingCopy);
    await act(async () => {
      await result.current.copy('first');
    });
    expect(result.current.copied).toBe(true);
    writeText.mockRejectedValueOnce(new Error('NotAllowedError'));
    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.copy('second');
    });
    expect(ok).toBe(false);
    expect(result.current.copied).toBe(false);
    // 前の成功の timer も残さない (後から copied を書き換えない)。
    expect(vi.getTimerCount()).toBe(0);
  });

  it('失敗の後に押し直して成功したら copied を立て、feedbackMs 後に戻す', async () => {
    vi.useFakeTimers();
    writeText.mockRejectedValueOnce(new Error('NotAllowedError'));
    const { result } = renderHook(() => useCopyToClipboard());
    await act(async () => {
      await result.current.copy('first');
    });
    expect(result.current.copied).toBe(false);
    await act(async () => {
      await result.current.copy('second');
    });
    expect(result.current.copied).toBe(true);
    act(() => {
      vi.advanceTimersByTime(COPIED_FEEDBACK_MS);
    });
    expect(result.current.copied).toBe(false);
  });

  it('resetOnAttempt: 試行を始めたら、結果を待つ間は前の成功の copied を消しておく', async () => {
    const { result } = renderHook(useResettingCopy);
    await act(async () => {
      await result.current.copy('first');
    });
    expect(result.current.copied).toBe(true);
    let resolve!: () => void;
    writeText.mockImplementationOnce(() => new Promise<void>((r) => (resolve = r)));
    let pending!: Promise<boolean>;
    await act(async () => {
      pending = result.current.copy('second');
    });
    expect(result.current.copied).toBe(false);
    await act(async () => {
      resolve();
      await pending;
    });
    expect(result.current.copied).toBe(true);
  });

  // 試行が重なったとき (A を始める → B を始める → どちらかが先に終わる): 表示は最新の B の結果だけ。A が成功した
  // ことは A の返り値 true で返す (呼び出し元の分岐は今までどおり)。
  function deferred() {
    let resolve!: () => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }
  for (const order of ['B の失敗 → A の成功', 'A の成功 → B の失敗'] as const) {
    it(`resetOnAttempt: 試行が重なり ${order} の順に終わったら、成功の copied を出さない`, async () => {
      vi.useFakeTimers();
      const a = deferred();
      const b = deferred();
      writeText.mockImplementationOnce(() => a.promise).mockImplementationOnce(() => b.promise);
      const { result } = renderHook(useResettingCopy);
      let pa!: Promise<boolean>;
      let pb!: Promise<boolean>;
      await act(async () => {
        pa = result.current.copy('A');
        pb = result.current.copy('B');
      });
      const settle = async (fn: () => void, p: Promise<boolean>) => {
        let ok: boolean | undefined;
        await act(async () => {
          fn();
          ok = await p;
        });
        return ok;
      };
      let okA: boolean | undefined;
      let okB: boolean | undefined;
      if (order === 'B の失敗 → A の成功') {
        okB = await settle(() => b.reject(new Error('NotAllowedError')), pb);
        okA = await settle(() => a.resolve(), pa);
      } else {
        okA = await settle(() => a.resolve(), pa);
        okB = await settle(() => b.reject(new Error('NotAllowedError')), pb);
      }
      expect(okA).toBe(true);
      expect(okB).toBe(false);
      expect(result.current.copied).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    });
  }

  it('resetOnAttempt: 試行が重なって両方成功したら、最新の試行の成功で copied を立てる', async () => {
    const a = deferred();
    const b = deferred();
    writeText.mockImplementationOnce(() => a.promise).mockImplementationOnce(() => b.promise);
    const { result } = renderHook(useResettingCopy);
    let pa!: Promise<boolean>;
    let pb!: Promise<boolean>;
    await act(async () => {
      pa = result.current.copy('A');
      pb = result.current.copy('B');
    });
    await act(async () => {
      a.resolve();
      await pa;
    });
    // 古い A の成功では立てない (B の結果を待つ)。
    expect(result.current.copied).toBe(false);
    await act(async () => {
      b.resolve();
      await pb;
    });
    expect(result.current.copied).toBe(true);
  });

  it('書き込みの完了前に unmount したら、完了の後に timer を作らず state も更新しない', async () => {
    vi.useFakeTimers();
    let resolve!: () => void;
    writeText.mockImplementationOnce(() => new Promise<void>((r) => (resolve = r)));
    const { result, unmount } = renderHook(() => useCopyToClipboard());
    const before = vi.getTimerCount();
    let pending!: Promise<boolean>;
    await act(async () => {
      pending = result.current.copy('abc');
    });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    unmount();
    resolve();
    // 書き込み自体は成功したので true を返す (呼び出し元の分岐は今までどおり)。
    expect(await pending).toBe(true);
    expect(vi.getTimerCount()).toBe(before);
    expect(errors).not.toHaveBeenCalled();
  });

  it('StrictMode (効果の mount → unmount → mount) の後も、成功で copied を立てる', async () => {
    const effects: string[] = [];
    const { result } = renderHook(
      () => {
        useEffect(() => {
          effects.push('mount');
          return () => {
            effects.push('unmount');
          };
        }, []);
        return useCopyToClipboard();
      },
      { reactStrictMode: true },
    );
    // StrictMode の二重の mount が本当に起きた (このテストが空振りしない)。
    expect(effects).toEqual(['mount', 'unmount', 'mount']);
    await act(async () => {
      await result.current.copy('abc');
    });
    expect(result.current.copied).toBe(true);
  });
});
