// K4b: 払う側の通常決済の会計の印を準備する hook (hooks/useStdBillMark.ts)。
//   - その端末だけの試しのスイッチが OFF (既定) なら何もしない: URL の bk を読まず、印の chunk も読まない。
//   - ON なら mount の後の effect で印を計算して ref に置き、押した瞬間 (返した関数を呼んだ時) は同期で照合するだけ (K-1):
//     今の URL の bk が ref の bk と同じときだけ印を返す。bk が無い・違う・形が違う・計算中・chunk の失敗は undefined (印なし)。
// 印の chunk (lib/relay/billKeySalt) は、test ごとに読み込みの回数を数え、読み込みを止めておく (計算中) こともできる。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { Hex } from 'viem';

const chunk = vi.hoisted(() => ({
  loads: 0,
  gate: null as Promise<void> | null,
  fail: false,
}));
const bkReads = vi.hoisted(() => ({ count: 0 }));
vi.mock('@/lib/url/billKey', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/url/billKey')>();
  return {
    readBillKeyParam: () => {
      bkReads.count += 1;
      return actual.readBillKeyParam();
    },
  };
});

import { STD_BILL_MARK_TRIAL_KEY } from '@/lib/stdBillMarkTrial';

// 印の chunk の mock は test ごとに作り直す (vi.mock の結果は module の登録簿を消しても残るので、読み込みを数えられない)。
// hook も test ごとに読み直し、新しい登録簿から chunk を読ませる (react 等の node_modules は読み直さない = 同じ React)。
function mockChunk() {
  vi.doMock('@/lib/relay/billKeySalt', async (importOriginal) => {
    chunk.loads += 1;
    if (chunk.gate) await chunk.gate;
    if (chunk.fail) throw new Error('ChunkLoadError: Loading chunk failed');
    return importOriginal<typeof import('@/lib/relay/billKeySalt')>();
  });
}
let useStdBillMark: typeof import('@/hooks/useStdBillMark').useStdBillMark;

const BK = 'Zm9vYmFyYmE';
// tests/lib/billKeySalt.test.ts の golden (cast で計算した billKeyStdMark('Zm9vYmFyYmE'))。
const MARK: Hex = '0x958ae5e2bac7dd1aa8fc9dec6e21f67bd131f20780d3992b9b873d6c4754a317';
const OTHER_BK = 'a-b_c-d_e-8';
const OLD_22_BK = 'Zm9vYmFyYmF6cXV4MTIzNA';

let otherMark: Hex;

function setUrl(bk: string | null) {
  window.history.replaceState(null, '', bk === null ? '/ja/pay?to=x&amount=1' : `/ja/pay?to=x&amount=1&bk=${bk}`);
}
const switchOn = () => window.localStorage.setItem(STD_BILL_MARK_TRIAL_KEY, '1');

// effect の中の dynamic import と then を流す。
async function flush() {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));
  });
}

function render(eligible = true, urlKey: unknown = 'a') {
  return renderHook(({ eligible: e, urlKey: k }) => useStdBillMark(e, k), { initialProps: { eligible, urlKey } });
}

beforeEach(async () => {
  vi.resetModules();
  mockChunk();
  ({ useStdBillMark } = await import('@/hooks/useStdBillMark'));
  chunk.loads = 0;
  chunk.gate = null;
  chunk.fail = false;
  bkReads.count = 0;
  window.localStorage.clear();
  setUrl(BK);
  const actual = await vi.importActual<typeof import('@/lib/relay/billKeySalt')>('@/lib/relay/billKeySalt');
  otherMark = actual.billKeyStdMark(OTHER_BK)!;
});

afterEach(() => {
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});

describe('useStdBillMark: 試しのスイッチが OFF (既定) なら何もしない', () => {
  it('URL に形の正しい bk があっても、bk を読まず・印の chunk を読まず・印を返さない', async () => {
    const view = render();
    await flush();
    expect(view.result.current()).toBeUndefined();
    expect(bkReads.count).toBe(0);
    expect(chunk.loads).toBe(0);
  });

  it('スイッチが "1" 以外の値でも OFF', async () => {
    window.localStorage.setItem(STD_BILL_MARK_TRIAL_KEY, 'on');
    const view = render();
    await flush();
    expect(view.result.current()).toBeUndefined();
    expect(chunk.loads).toBe(0);
  });

  it('スイッチの読み込みが throw しても止まらない (OFF と読む・chunk を読まない)', async () => {
    switchOn();
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError: storage is disabled');
    });
    const view = render();
    await flush();
    expect(() => view.result.current()).not.toThrow();
    expect(view.result.current()).toBeUndefined();
    expect(chunk.loads).toBe(0);
  });

  it('対象でない会計 (eligible = false) は、スイッチが ON でも何もしない', async () => {
    switchOn();
    const view = render(false);
    await flush();
    expect(view.result.current()).toBeUndefined();
    expect(bkReads.count).toBe(0);
    expect(chunk.loads).toBe(0);
  });
});

describe('useStdBillMark: スイッチが ON の端末', () => {
  beforeEach(() => switchOn());

  it('mount の後に印を計算して置き、押した時に同じ bk なら印 (billKeyStdMark の golden) を返す', async () => {
    const view = render();
    await flush();
    expect(chunk.loads).toBe(1);
    expect(view.result.current()).toBe(MARK);
    // 何度呼んでも同じ (押すたびに計算しない・chunk を読み直さない)。
    expect(view.result.current()).toBe(MARK);
    expect(chunk.loads).toBe(1);
  });

  it('計算中 (chunk の読み込み待ち) に押すと印なし。読み終えた後に押すと印つき', async () => {
    let release!: () => void;
    chunk.gate = new Promise<void>((r) => {
      release = r;
    });
    const view = render();
    await flush();
    expect(chunk.loads).toBe(1);
    expect(view.result.current()).toBeUndefined();
    release();
    await flush();
    expect(view.result.current()).toBe(MARK);
  });

  it('chunk を読めないときは印なし (throw しない・支払いは止まらない)', async () => {
    chunk.fail = true;
    const view = render();
    await flush();
    expect(chunk.loads).toBe(1);
    expect(view.result.current()).toBeUndefined();
  });

  it('URL に bk が無ければ chunk を読まず印なし・形の違う bk (前の 22 字) は印なし', async () => {
    setUrl(null);
    const none = render();
    await flush();
    expect(none.result.current()).toBeUndefined();
    expect(chunk.loads).toBe(0);
    none.unmount();

    setUrl(OLD_22_BK);
    const bad = render();
    await flush();
    expect(bad.result.current()).toBeUndefined();
  });

  it('押した時の URL の bk が、準備した bk と違う・無いと印なし (K-1 の同期の照合)', async () => {
    const view = render();
    await flush();
    expect(view.result.current()).toBe(MARK);
    setUrl(OTHER_BK);
    expect(view.result.current()).toBeUndefined();
    setUrl(null);
    expect(view.result.current()).toBeUndefined();
    setUrl(BK);
    expect(view.result.current()).toBe(MARK);
  });

  it('準備の後にスイッチを OFF にすると、押した時に印なし', async () => {
    const view = render();
    await flush();
    expect(view.result.current()).toBe(MARK);
    window.localStorage.removeItem(STD_BILL_MARK_TRIAL_KEY);
    expect(view.result.current()).toBeUndefined();
  });

  it('URL が変わったら (urlKey)、前の印を捨てて作り直す。遅れて返った前の計算は、新しい印を上書きしない', async () => {
    let release!: () => void;
    chunk.gate = new Promise<void>((r) => {
      release = r;
    });
    const view = render(true, 'a');
    await flush();
    // 前の URL (BK) の計算が終わる前に、同じ画面で URL が OTHER_BK に変わる。
    setUrl(OTHER_BK);
    view.rerender({ eligible: true, urlKey: 'b' });
    expect(view.result.current()).toBeUndefined();
    release();
    await flush();
    expect(view.result.current()).toBe(otherMark);
    expect(otherMark).not.toBe(MARK);
    setUrl(BK);
    expect(view.result.current()).toBeUndefined();
  });

  it('対象でなくなったら (eligible が false)、準備した印を使わない', async () => {
    const view = render(true);
    await flush();
    expect(view.result.current()).toBe(MARK);
    view.rerender({ eligible: false, urlKey: 'a' });
    expect(view.result.current()).toBeUndefined();
  });
});
