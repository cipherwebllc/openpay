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
