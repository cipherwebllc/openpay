import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createRef } from 'react';
import type { RefObject } from 'react';

// qr-scanner は ESM default export なので default 経由で mock instance を渡す。
// 本テストでは「hook の状態遷移」と「scanner ライフサイクル呼出」を見たいので
// scanner 自体は spy 化 (DOM 経由の getUserMedia / canvas は触らない)。
type CtorArgs = {
  video: HTMLVideoElement;
  onDecode: (r: { data: string }) => void;
  options: Record<string, unknown>;
};

const ctorCalls: CtorArgs[] = [];
const startMock = vi.fn<() => Promise<void>>();
const stopMock = vi.fn();
const destroyMock = vi.fn();
const hasCameraMock = vi.fn<() => Promise<boolean>>();

class MockQrScanner {
  static hasCamera = hasCameraMock;
  constructor(
    video: HTMLVideoElement,
    onDecode: (r: { data: string }) => void,
    options: Record<string, unknown>,
  ) {
    ctorCalls.push({ video, onDecode, options });
  }
  start = startMock;
  stop = stopMock;
  destroy = destroyMock;
}

vi.mock('qr-scanner', () => ({ default: MockQrScanner }));

import { useQrScanner } from '@/hooks/useQrScanner';

function makeVideoRef(): RefObject<HTMLVideoElement | null> {
  const ref = createRef<HTMLVideoElement>();
  // jsdom 上で実 video element を作成 (size 等は scanner 側が読まないので最低限で OK)。
  const v = document.createElement('video');
  // RefObject.current は read-only な型だが test 都合で代入する (jsdom 上のみ)。
  (ref as unknown as { current: HTMLVideoElement }).current = v;
  return ref;
}

beforeEach(() => {
  ctorCalls.length = 0;
  startMock.mockReset();
  stopMock.mockReset();
  destroyMock.mockReset();
  hasCameraMock.mockReset();
  hasCameraMock.mockResolvedValue(true);
  startMock.mockResolvedValue(undefined);
});

describe('useQrScanner', () => {
  it('初期 state は idle', () => {
    const { result } = renderHook(() =>
      useQrScanner(makeVideoRef(), () => {}),
    );
    expect(result.current.state.status).toBe('idle');
  });

  it('start → scanning に遷移、preferredCamera=environment が渡る', async () => {
    const ref = makeVideoRef();
    const { result } = renderHook(() => useQrScanner(ref, () => {}));

    await act(async () => {
      await result.current.start();
    });
    expect(result.current.state.status).toBe('scanning');
    expect(ctorCalls).toHaveLength(1);
    expect(ctorCalls[0].options).toMatchObject({
      preferredCamera: 'environment',
      highlightScanRegion: true,
      returnDetailedScanResult: true,
    });
    expect(startMock).toHaveBeenCalledTimes(1);
    expect(hasCameraMock).toHaveBeenCalledTimes(1);
  });

  it('decode 通知 → onDecode callback が呼ばれ、stopOnDecode=true なら scanner は停止', async () => {
    const onDecode = vi.fn();
    const ref = makeVideoRef();
    const { result } = renderHook(() => useQrScanner(ref, onDecode));

    await act(async () => {
      await result.current.start();
    });
    const cb = ctorCalls[0].onDecode;
    act(() => {
      cb({ data: 'https://open-pay.jp/pay?to=0x...' });
    });
    expect(onDecode).toHaveBeenCalledWith({ data: 'https://open-pay.jp/pay?to=0x...' });
    expect(stopMock).toHaveBeenCalledTimes(1);
    expect(destroyMock).toHaveBeenCalledTimes(1);
    expect(result.current.state.status).toBe('idle');
  });

  it('stopOnDecode=false → decode しても scanner は継続 (idle に戻らない)', async () => {
    const onDecode = vi.fn();
    const ref = makeVideoRef();
    const { result } = renderHook(() =>
      useQrScanner(ref, onDecode, { stopOnDecode: false }),
    );

    await act(async () => {
      await result.current.start();
    });
    act(() => {
      ctorCalls[0].onDecode({ data: 'foo' });
    });
    expect(onDecode).toHaveBeenCalledTimes(1);
    expect(stopMock).not.toHaveBeenCalled();
    expect(result.current.state.status).toBe('scanning');
  });

  it('NotAllowedError → state=permission-denied (scanner は destroy される)', async () => {
    startMock.mockRejectedValueOnce(
      new DOMException('Permission denied', 'NotAllowedError'),
    );
    const ref = makeVideoRef();
    const { result } = renderHook(() => useQrScanner(ref, () => {}));

    await act(async () => {
      await result.current.start();
    });
    expect(result.current.state.status).toBe('permission-denied');
    expect(destroyMock).toHaveBeenCalledTimes(1);
  });

  it('NotFoundError → state=no-camera', async () => {
    startMock.mockRejectedValueOnce(
      new DOMException('No camera', 'NotFoundError'),
    );
    const { result } = renderHook(() => useQrScanner(makeVideoRef(), () => {}));
    await act(async () => {
      await result.current.start();
    });
    expect(result.current.state.status).toBe('no-camera');
  });

  it('preflight hasCamera=false → no-camera で start を呼ばない', async () => {
    hasCameraMock.mockResolvedValueOnce(false);
    const { result } = renderHook(() => useQrScanner(makeVideoRef(), () => {}));
    await act(async () => {
      await result.current.start();
    });
    expect(result.current.state.status).toBe('no-camera');
    expect(startMock).not.toHaveBeenCalled();
  });

  it('未知 DOMException name → state=error', async () => {
    startMock.mockRejectedValueOnce(new DOMException('boom', 'AbortError'));
    const { result } = renderHook(() => useQrScanner(makeVideoRef(), () => {}));
    await act(async () => {
      await result.current.start();
    });
    expect(result.current.state.status).toBe('error');
    if (result.current.state.status === 'error') {
      expect(result.current.state.error.message).toBe('boom');
    }
  });

  it('video ref が null → error state (DOM 未準備)', async () => {
    // current=null の ref を渡すケース (mount 直後に呼ばれた等の異常系)
    const ref: RefObject<HTMLVideoElement | null> = { current: null };
    const { result } = renderHook(() => useQrScanner(ref, () => {}));
    await act(async () => {
      await result.current.start();
    });
    expect(result.current.state.status).toBe('error');
    expect(ctorCalls).toHaveLength(0);
  });

  it('start 2 回呼ぶと 2 回目は no-op (scanner 重複生成しない)', async () => {
    const ref = makeVideoRef();
    const { result } = renderHook(() => useQrScanner(ref, () => {}));
    await act(async () => {
      await result.current.start();
      await result.current.start();
    });
    expect(ctorCalls).toHaveLength(1);
    expect(startMock).toHaveBeenCalledTimes(1);
  });

  it('stop() → scanner.stop / destroy が呼ばれ、idle に戻る', async () => {
    const ref = makeVideoRef();
    const { result } = renderHook(() => useQrScanner(ref, () => {}));
    await act(async () => {
      await result.current.start();
    });
    act(() => {
      result.current.stop();
    });
    expect(stopMock).toHaveBeenCalledTimes(1);
    expect(destroyMock).toHaveBeenCalledTimes(1);
    expect(result.current.state.status).toBe('idle');
  });

  it('unmount 時に scanner.stop / destroy が cleanup される', async () => {
    const ref = makeVideoRef();
    const { result, unmount } = renderHook(() =>
      useQrScanner(ref, () => {}),
    );
    await act(async () => {
      await result.current.start();
    });
    unmount();
    expect(stopMock).toHaveBeenCalledTimes(1);
    expect(destroyMock).toHaveBeenCalledTimes(1);
  });

  it('onDecode の参照が render を跨いで変化しても最新を呼ぶ (ref clojure)', async () => {
    const a = vi.fn();
    const b = vi.fn();
    const ref = makeVideoRef();
    const { result, rerender } = renderHook(
      ({ cb }) => useQrScanner(ref, cb),
      { initialProps: { cb: a } },
    );
    await act(async () => {
      await result.current.start();
    });
    rerender({ cb: b });
    // 最新 callback (b) が呼ばれる必要があるが、scanner の onDecode は固定済。
    // 内部で ref 経由で最新を読む実装かを確認。
    act(() => {
      ctorCalls[0].onDecode({ data: 'x' });
    });
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledWith({ data: 'x' });
  });

  it('preflightCheckCamera=false なら hasCamera を呼ばずに start に直行', async () => {
    const ref = makeVideoRef();
    const { result } = renderHook(() =>
      useQrScanner(ref, () => {}, { preflightCheckCamera: false }),
    );
    await act(async () => {
      await result.current.start();
    });
    expect(hasCameraMock).not.toHaveBeenCalled();
    await waitFor(() => expect(result.current.state.status).toBe('scanning'));
  });
});

describe('useQrScanner: lifecycle / 並行性 edge', () => {
  it('stop → start で scanner が再生成される (再利用フロー)', async () => {
    const ref = makeVideoRef();
    const { result } = renderHook(() => useQrScanner(ref, () => {}));
    await act(async () => {
      await result.current.start();
    });
    expect(ctorCalls.length).toBe(1);
    act(() => {
      result.current.stop();
    });
    expect(stopMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      await result.current.start();
    });
    expect(ctorCalls.length).toBe(2);
    expect(result.current.state.status).toBe('scanning');
  });

  it('stop() を 2 回連続呼んでも idempotent (2 度目は scanner 不在で no-op)', async () => {
    const ref = makeVideoRef();
    const { result } = renderHook(() => useQrScanner(ref, () => {}));
    await act(async () => {
      await result.current.start();
    });
    act(() => {
      result.current.stop();
      result.current.stop();
    });
    expect(stopMock).toHaveBeenCalledTimes(1);
    expect(destroyMock).toHaveBeenCalledTimes(1);
    expect(result.current.state.status).toBe('idle');
  });

  it('start 中 (await scanner.start() resolve 前) に並行 start 呼出 → 2 つ目は no-op', async () => {
    // scanner.start は実 getUserMedia なので resolve が遅延する。その間に
    // ユーザがダブルクリック等で start を再発火しても scanner instance が
    // 2 つ作られない (camera stream の二重取得を構造的に防ぐ) ことを担保。
    let resolveStart: (() => void) | undefined;
    startMock.mockImplementationOnce(
      () =>
        new Promise<void>((res) => {
          resolveStart = res;
        }),
    );
    const ref = makeVideoRef();
    const { result } = renderHook(() => useQrScanner(ref, () => {}));
    // 1 つ目: scanner instance が ref に積まれた直後 (status: starting) で並行発火
    let firstResolved = false;
    const firstPromise = result.current.start().then(() => {
      firstResolved = true;
    });
    // 2 つ目: instance が積まれているので no-op で即 resolve
    await act(async () => {
      await result.current.start();
    });
    expect(ctorCalls.length).toBe(1);
    expect(firstResolved).toBe(false);
    // 1 つ目を解決して cleanup
    await act(async () => {
      resolveStart!();
      await firstPromise;
    });
    expect(result.current.state.status).toBe('scanning');
  });

  it('非 DOMException かつ 非 Error の rejection (string) → error state でメッセージ化', async () => {
    startMock.mockRejectedValueOnce('plain-string-error');
    const ref = makeVideoRef();
    const { result } = renderHook(() => useQrScanner(ref, () => {}));
    await act(async () => {
      await result.current.start();
    });
    expect(result.current.state.status).toBe('error');
    if (result.current.state.status === 'error') {
      expect(result.current.state.error.message).toBe('plain-string-error');
    }
  });

  it('DOMException で message 空 → error.name を message にフォールバック', async () => {
    // WebKit の一部 build は NotReadableError 等で message が空のことがある。
    // classifyMediaError は message が空なら name を採用するはず。
    const ex = new DOMException('', 'NotReadableError');
    startMock.mockRejectedValueOnce(ex);
    const { result } = renderHook(() => useQrScanner(makeVideoRef(), () => {}));
    await act(async () => {
      await result.current.start();
    });
    expect(result.current.state.status).toBe('error');
    if (result.current.state.status === 'error') {
      expect(result.current.state.error.message).toBe('NotReadableError');
    }
  });

  it('decode 後 stopOnDecode=true で scanner 不在 → 2 度目の decode 呼出は何も起きない (instance 既 destroy)', async () => {
    // qr-scanner は内部で次フレーム scan を回しているが、destroy 後の onDecode 流入は
    // 起きない設計。理論上は 1 度しか呼ばれないが、もし testing 上重複させた時に
    // crash しないことを check (defensive guard 確認、実装変更時の回帰検知)。
    const onDecode = vi.fn();
    const ref = makeVideoRef();
    const { result } = renderHook(() => useQrScanner(ref, onDecode));
    await act(async () => {
      await result.current.start();
    });
    const cb = ctorCalls[0].onDecode;
    act(() => {
      cb({ data: 'first' });
    });
    expect(onDecode).toHaveBeenCalledTimes(1);
    expect(result.current.state.status).toBe('idle');
    // 2 回目: scannerRef は null になっているので stop は呼ばれない、onDecodeRef は
    // そのまま呼ばれる (理論上ここで data が漏れても上位 ScanShell が再 push しても
    // 同 href なら冪等)。callbacks 自体は invoke される。
    act(() => {
      cb({ data: 'second' });
    });
    expect(onDecode).toHaveBeenCalledTimes(2);
  });

  it('SecurityError (permission の別 variant) → permission-denied', async () => {
    startMock.mockRejectedValueOnce(
      new DOMException('blocked by feature policy', 'SecurityError'),
    );
    const { result } = renderHook(() => useQrScanner(makeVideoRef(), () => {}));
    await act(async () => {
      await result.current.start();
    });
    expect(result.current.state.status).toBe('permission-denied');
  });

  it('OverconstrainedError (要件と camera 不一致) → no-camera', async () => {
    startMock.mockRejectedValueOnce(
      new DOMException('constraints', 'OverconstrainedError'),
    );
    const { result } = renderHook(() => useQrScanner(makeVideoRef(), () => {}));
    await act(async () => {
      await result.current.start();
    });
    expect(result.current.state.status).toBe('no-camera');
  });

  it('TypeError (DOMException ではない Error サブクラス) → error', async () => {
    startMock.mockRejectedValueOnce(new TypeError('something wrong'));
    const { result } = renderHook(() => useQrScanner(makeVideoRef(), () => {}));
    await act(async () => {
      await result.current.start();
    });
    expect(result.current.state.status).toBe('error');
    if (result.current.state.status === 'error') {
      expect(result.current.state.error.message).toBe('something wrong');
      expect(result.current.state.error).toBeInstanceOf(TypeError);
    }
  });

  it('unmount 中に scanner が active でも cleanup が 1 回だけ走る (multi-unmount なし)', async () => {
    const ref = makeVideoRef();
    const { result, unmount } = renderHook(() => useQrScanner(ref, () => {}));
    await act(async () => {
      await result.current.start();
    });
    unmount();
    // unmount 後 cleanup は 1 度のみ
    expect(stopMock).toHaveBeenCalledTimes(1);
    expect(destroyMock).toHaveBeenCalledTimes(1);
  });
});
