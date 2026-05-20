import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { createRef } from 'react';
import type { RefObject } from 'react';

// このファイルだけ qr-scanner の dynamic import を reject させる。同 file 内で
// vi.mock を切り替えるのは複雑なので、import 失敗専用の test を separate file 化。

vi.mock('qr-scanner', () => {
  // 即座に throw する factory — `await import('qr-scanner')` 時に reject。
  throw new Error('Failed to fetch dynamically imported module');
});

import { useQrScanner } from '@/hooks/useQrScanner';

function makeVideoRef(): RefObject<HTMLVideoElement | null> {
  const ref = createRef<HTMLVideoElement>();
  const v = document.createElement('video');
  (ref as unknown as { current: HTMLVideoElement }).current = v;
  return ref;
}

beforeEach(() => {
  // logger mock は他テストと干渉しないよう本 file 専用に
});

describe('useQrScanner: dynamic import の chunk load 失敗 (LARP 防御)', () => {
  it('await import("qr-scanner") が reject → error state (永久 starting にならない)', async () => {
    const ref = makeVideoRef();
    const { result } = renderHook(() => useQrScanner(ref, () => {}));
    await act(async () => {
      await result.current.start();
    });
    expect(result.current.state.status).toBe('error');
    if (result.current.state.status === 'error') {
      // vitest の factory throw は内部メッセージで包む。message が non-empty で
      // import 失敗を示唆していれば classifyMediaError 経由で error 化された証拠。
      expect(result.current.state.error.message.length).toBeGreaterThan(0);
    }
  });
});
