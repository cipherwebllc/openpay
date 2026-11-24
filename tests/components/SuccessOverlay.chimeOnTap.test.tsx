// 鳴らした完了音が鳴らなかった (iPhone がほかのアプリから戻った後の Web Audio を、running のまま時計を止めて無音にする) ときは、
// 最初に触れたときに audio 要素で鳴らし直す (2026-11-24 user 裁定「最初に触れたとき」・iOS 27.2 の実測は SuccessOverlay の
// watchChimeSilence)。時計が進んだ (鳴った) 端末では何もしない。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useState } from 'react';
import { act, fireEvent, screen } from '@testing-library/react';

vi.mock('wagmi', () => ({
  useSignMessage: () => ({ signMessageAsync: vi.fn(), isPending: false }),
  useAccount: () => ({ address: undefined }),
  usePublicClient: () => undefined,
}));
type FakeCtx = { state: string; currentTime: number; close: ReturnType<typeof vi.fn> };
const chime = vi.hoisted(() => ({ play: vi.fn(), ctx: null as FakeCtx | null }));
vi.mock('@/lib/successChime', () => ({
  playSuccessChime: () => {
    chime.play();
    return chime.ctx;
  },
}));
// 声の結果を順に決める: true = 鳴らし始めた・false = 断られた・'pending' = 鳴らし始めを待っている (resolvePending で決める)。
const voice = vi.hoisted(() => ({
  play: vi.fn(),
  stop: vi.fn(),
  outcomes: [] as Array<boolean | 'pending'>,
  resolvePending: (() => undefined) as (ok: boolean) => void,
}));
vi.mock('@/lib/successVoice', () => ({
  playVoiceElement: () => {
    voice.play();
    const next = voice.outcomes.shift() ?? true;
    const result =
      next === 'pending'
        ? new Promise<boolean>((resolve) => {
            voice.resolvePending = resolve;
          })
        : Promise.resolve(next);
    return { result, stop: voice.stop };
  },
}));
const pref = vi.hoisted(() => ({ enabled: true }));
vi.mock('@/lib/soundPref', () => ({
  isSuccessSoundEnabled: () => pref.enabled,
  setSuccessSoundEnabled: (v: boolean) => {
    pref.enabled = v;
  },
}));

import { renderWithIntl as render } from '../_helpers/i18n';
import { SuccessOverlay, CHIME_ON_RETURN_MAX_MS, CHIME_SILENCE_CHECK_MS } from '@/components/SuccessOverlay';

const TX_HASH = `0x${'a'.repeat(64)}`;
let visibility: DocumentVisibilityState = 'visible';
let wall = 1_000_000;

function renderOverlay(opts?: { reactStrictMode?: boolean }) {
  return render(<SuccessOverlay amountDisplay="3 JPYC" txHash={TX_HASH} onDismiss={() => undefined} />, opts);
}

function frozenCtx(state = 'running', currentTime = 10): FakeCtx {
  const ctx: FakeCtx = {
    state,
    currentTime,
    close: vi.fn(() => {
      ctx.state = 'closed';
      return Promise.resolve();
    }),
  };
  return ctx;
}

/** 時刻と timer を進める。 */
function advance(ms: number) {
  wall += ms;
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

/** 声の Promise の続きを流し切る。 */
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function body() {
  return screen.getByText('3 JPYC');
}

/** 画面に 1 回触れる (iPhone は touchend の後に click が来る)。 */
async function tap(target: Element = body()) {
  fireEvent.touchEnd(target);
  fireEvent.click(target);
  await flush();
}

describe('SuccessOverlay の完了音 (鳴らなかったら最初に触れたときに鳴らす)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    chime.play.mockReset();
    chime.ctx = frozenCtx();
    voice.play.mockReset();
    voice.stop.mockReset();
    voice.outcomes = [];
    pref.enabled = true;
    visibility = 'visible';
    wall = 1_000_000;
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
    vi.spyOn(Date, 'now').mockImplementation(() => wall);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('Web Audio の時計が進んだ (鳴った) ら、触れても鳴らし直さず、触れるのも待たない (2 回は鳴らない)', async () => {
    const listen = vi.spyOn(document, 'addEventListener');
    renderOverlay();
    expect(chime.play).toHaveBeenCalledTimes(1);
    chime.ctx!.currentTime += 1;
    advance(CHIME_SILENCE_CHECK_MS);
    expect(listen.mock.calls.filter(([type]) => type === 'touchend')).toEqual([]);
    expect(chime.ctx!.close).not.toHaveBeenCalled();
    await tap();
    expect(voice.play).not.toHaveBeenCalled();
  });

  it('鳴って時計が進んだ後に割り込みで suspended になっていても、鳴った分は鳴ったとみなす', async () => {
    renderOverlay();
    chime.ctx!.currentTime += 0.75;
    chime.ctx!.state = 'suspended';
    advance(CHIME_SILENCE_CHECK_MS);
    await tap();
    expect(voice.play).not.toHaveBeenCalled();
  });

  it('時計が止まったまま (ほかのアプリから戻った後の iPhone) なら、最初に触れたときに声を 1 回だけ鳴らす', async () => {
    renderOverlay();
    advance(CHIME_SILENCE_CHECK_MS);
    await tap(); // touchend と click の 2 つが来ても 1 回
    expect(voice.play).toHaveBeenCalledTimes(1);
    wall += 5_000;
    await tap();
    expect(voice.play).toHaveBeenCalledTimes(1);
  });

  it('鳴らなかったと分かったら、予約した音を context ごと閉じて取り消す (後で動き出しても 2 回にならない)', () => {
    renderOverlay();
    advance(CHIME_SILENCE_CHECK_MS);
    expect(chime.ctx!.close).toHaveBeenCalledTimes(1);
  });

  it('context を閉じられない (close が投げる) ときも、触れたときに鳴らす', async () => {
    chime.ctx!.close = vi.fn(() => {
      throw new Error('old browser');
    });
    renderOverlay();
    advance(CHIME_SILENCE_CHECK_MS);
    await tap();
    expect(voice.play).toHaveBeenCalledTimes(1);
  });

  it('suspended のまま (鳴らせなかった) でも、触れたときに鳴らす', async () => {
    chime.ctx = frozenCtx('suspended', 0);
    renderOverlay();
    advance(CHIME_SILENCE_CHECK_MS);
    await tap();
    expect(voice.play).toHaveBeenCalledTimes(1);
  });

  it('touchend だけ (iPhone で押せない所に触れた) でも鳴らす', async () => {
    renderOverlay();
    advance(CHIME_SILENCE_CHECK_MS);
    fireEvent.touchEnd(body());
    await flush();
    expect(voice.play).toHaveBeenCalledTimes(1);
  });

  it('click だけ (PC のマウス・キーボードでボタンを押した) でも鳴らす', async () => {
    renderOverlay();
    advance(CHIME_SILENCE_CHECK_MS);
    fireEvent.click(body());
    await flush();
    expect(voice.play).toHaveBeenCalledTimes(1);
  });

  it('触れた要素が伝わりを止めても鳴らす (document の capture で受ける)', async () => {
    renderOverlay();
    advance(CHIME_SILENCE_CHECK_MS);
    const target = body();
    target.addEventListener('touchend', (event) => event.stopPropagation());
    fireEvent.touchEnd(target);
    await flush();
    expect(voice.play).toHaveBeenCalledTimes(1);
  });

  it('iPhone が操作と数えずに断ったら (scroll の後など)、次に触れたときにもう一度鳴らす (すぐ後の「閉じる」も落とさない)', async () => {
    voice.outcomes = [false];
    renderOverlay();
    advance(CHIME_SILENCE_CHECK_MS);
    fireEvent.touchEnd(body()); // scroll の後に指を離した (断られる)
    await flush();
    expect(voice.play).toHaveBeenCalledTimes(1);
    wall += 300;
    await tap(); // すぐ後に触れた
    expect(voice.play).toHaveBeenCalledTimes(2);
    wall += 1_500;
    await tap();
    expect(voice.play).toHaveBeenCalledTimes(2);
  });

  it('声の読み込み中 (鳴らし始めを待っている間) に触れても、次を鳴らさない (2 回にならない)', async () => {
    voice.outcomes = ['pending'];
    renderOverlay();
    advance(CHIME_SILENCE_CHECK_MS);
    await tap();
    wall += 1_500;
    await tap();
    expect(voice.play).toHaveBeenCalledTimes(1);
    voice.resolvePending(false); // 結局断られたら、次に触れたときにまた試す
    await flush();
    wall += 1_500;
    await tap();
    expect(voice.play).toHaveBeenCalledTimes(2);
  });

  it('鳴ったかを確かめる前に触れても鳴らさない (確かめた後に触れたら鳴らす)', async () => {
    renderOverlay();
    await tap();
    expect(voice.play).not.toHaveBeenCalled();
    advance(CHIME_SILENCE_CHECK_MS);
    await tap();
    expect(voice.play).toHaveBeenCalledTimes(1);
  });

  it('音のボタンは数えない: 消すために押しても声は鳴らず、その後に触れても鳴らし直さない', async () => {
    renderOverlay();
    advance(CHIME_SILENCE_CHECK_MS);
    await tap(screen.getByRole('button', { name: /完了音/ }));
    expect(pref.enabled).toBe(false);
    expect(voice.play).not.toHaveBeenCalled();
    wall += 2_000;
    await tap();
    expect(voice.play).not.toHaveBeenCalled();
  });

  it('鳴ったかを確かめる前に音のボタンで消したら、まだ鳴っていない予約を取り消す (後で動き出しても鳴らさない)', async () => {
    renderOverlay();
    advance(800);
    await tap(screen.getByRole('button', { name: /完了音/ }));
    expect(pref.enabled).toBe(false);
    expect(chime.ctx!.close).toHaveBeenCalledTimes(1);
    advance(CHIME_SILENCE_CHECK_MS);
    expect(chime.ctx!.close).toHaveBeenCalledTimes(1);
  });

  it('鳴った後に音のボタンで消しても、context は閉じない (鳴った音は取り消すものがない)', async () => {
    renderOverlay();
    chime.ctx!.currentTime += 0.5;
    advance(800);
    await tap(screen.getByRole('button', { name: /完了音/ }));
    expect(chime.ctx!.close).not.toHaveBeenCalled();
  });

  it('触れて鳴らし始めを待っている声は、音のボタンで消したら止める', async () => {
    voice.outcomes = ['pending'];
    renderOverlay();
    advance(CHIME_SILENCE_CHECK_MS);
    await tap();
    expect(voice.play).toHaveBeenCalledTimes(1);
    await tap(screen.getByRole('button', { name: /完了音/ }));
    expect(pref.enabled).toBe(false);
    expect(voice.stop).toHaveBeenCalledTimes(1);
  });

  it('鳴らし直しを待っている間に音のボタンで消して出し直したら、そのとき 1 回鳴らし、後で触れても鳴らし直さない', async () => {
    renderOverlay();
    advance(CHIME_SILENCE_CHECK_MS);
    const toggle = screen.getByRole('button', { name: /完了音/ });
    await tap(toggle); // 消す
    wall += 2_000;
    await tap(toggle); // 出す (確認の音)
    expect(pref.enabled).toBe(true);
    expect(voice.play).toHaveBeenCalledTimes(1);
    wall += 2_000;
    await tap();
    expect(voice.play).toHaveBeenCalledTimes(1);
  });

  it('音のボタンで出したら、押した操作の中で audio 要素で 1 回鳴らし、後で鳴らし直さない', async () => {
    pref.enabled = false;
    renderOverlay();
    expect(chime.play).not.toHaveBeenCalled();
    await tap(screen.getByRole('button', { name: /完了音/ }));
    expect(voice.play).toHaveBeenCalledTimes(1);
    expect(chime.play).not.toHaveBeenCalled();
    advance(CHIME_SILENCE_CHECK_MS + 2_000);
    await tap();
    expect(voice.play).toHaveBeenCalledTimes(1);
  });

  it('音のボタンで出したときに audio 要素で鳴らせなかったら、Web Audio で鳴らす', async () => {
    pref.enabled = false;
    voice.outcomes = [false];
    renderOverlay();
    await tap(screen.getByRole('button', { name: /完了音/ }));
    expect(voice.play).toHaveBeenCalledTimes(1);
    expect(chime.play).toHaveBeenCalledTimes(1);
  });

  it('音のボタンで出した確認の音の読み込み中に消したら、声を止め、後から Web Audio でも鳴らさない', async () => {
    pref.enabled = false;
    voice.outcomes = ['pending'];
    renderOverlay();
    const toggle = screen.getByRole('button', { name: /完了音/ });
    await tap(toggle); // 出す
    await tap(toggle); // すぐ消す
    expect(voice.stop).toHaveBeenCalledTimes(1);
    voice.resolvePending(false); // 止めたので play は断られる
    await flush();
    expect(chime.play).not.toHaveBeenCalled();
  });

  it('音のボタンで出した確認の音の読み込み中に閉じたら、後から Web Audio で鳴らさない', async () => {
    pref.enabled = false;
    voice.outcomes = ['pending'];
    const { unmount } = renderOverlay();
    await tap(screen.getByRole('button', { name: /完了音/ }));
    unmount();
    voice.resolvePending(false);
    await flush();
    expect(chime.play).not.toHaveBeenCalled();
  });

  it('鳴らそうとしてから CHIME_ON_RETURN_MAX_MS を過ぎて触れたら鳴らさない (時間がたってから急に鳴らさない)', async () => {
    renderOverlay();
    advance(CHIME_SILENCE_CHECK_MS);
    wall += CHIME_ON_RETURN_MAX_MS; // スリープで timer が止まり、時刻だけ進んだ
    await tap();
    expect(voice.play).not.toHaveBeenCalled();
  });

  it('触れないまま CHIME_ON_RETURN_MAX_MS がたったら、document の聞き手を外す', async () => {
    const unlisten = vi.spyOn(document, 'removeEventListener');
    renderOverlay();
    advance(CHIME_SILENCE_CHECK_MS);
    expect(unlisten.mock.calls.filter(([type]) => type === 'touchend')).toEqual([]);
    advance(CHIME_ON_RETURN_MAX_MS - CHIME_SILENCE_CHECK_MS);
    expect(unlisten.mock.calls.filter(([type]) => type === 'touchend')).toHaveLength(1);
    expect(unlisten.mock.calls.filter(([type]) => type === 'click')).toHaveLength(1);
  });

  it('触れる前に完了音を OFF にしていたら (別のタブの完了画面など)、触れても鳴らさない', async () => {
    renderOverlay();
    advance(CHIME_SILENCE_CHECK_MS);
    pref.enabled = false;
    await tap();
    expect(voice.play).not.toHaveBeenCalled();
  });

  it('完了画面を閉じた後に触れても鳴らさない (聞き手を外す)', async () => {
    const { unmount } = renderOverlay();
    advance(CHIME_SILENCE_CHECK_MS);
    unmount();
    await tap(document.body);
    expect(voice.play).not.toHaveBeenCalled();
  });

  it('「閉じる」に触れて鳴らした声は、完了画面が閉じても止めない (触れたときに鳴らすと決めた声)', async () => {
    voice.outcomes = ['pending'];
    function Dismissable() {
      const [open, setOpen] = useState(true);
      return open ? <SuccessOverlay amountDisplay="3 JPYC" txHash={TX_HASH} onDismiss={() => setOpen(false)} /> : null;
    }
    render(<Dismissable />);
    advance(CHIME_SILENCE_CHECK_MS);
    await tap(screen.getByRole('button', { name: '閉じる' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(voice.play).toHaveBeenCalledTimes(1);
    expect(voice.stop).not.toHaveBeenCalled();
  });

  it('スリープで確かめるのが 60 秒を過ぎても、鳴らなかった予約は取り消す (後から急に鳴らない・触れても鳴らさない)', async () => {
    renderOverlay();
    wall += CHIME_ON_RETURN_MAX_MS + 1;
    act(() => {
      vi.advanceTimersByTime(CHIME_SILENCE_CHECK_MS);
    });
    expect(chime.ctx!.close).toHaveBeenCalledTimes(1);
    await tap();
    expect(voice.play).not.toHaveBeenCalled();
  });

  it('確かめる前に閉じたら、確かめもしない (閉じた後に聞き手を付けない・context も閉じない)', async () => {
    const { unmount } = renderOverlay();
    unmount();
    advance(CHIME_SILENCE_CHECK_MS);
    await tap(document.body);
    expect(voice.play).not.toHaveBeenCalled();
    expect(chime.ctx!.close).not.toHaveBeenCalled();
  });

  it('Web Audio が無い (playSuccessChime が null) ときは、触れても鳴らさない (今までどおり)', async () => {
    chime.ctx = null;
    renderOverlay();
    advance(CHIME_SILENCE_CHECK_MS);
    await tap();
    expect(voice.play).not.toHaveBeenCalled();
  });

  it('裏で出て、戻ったときに鳴らなかったら、最初に触れたときに鳴らす', async () => {
    visibility = 'hidden';
    renderOverlay();
    expect(chime.play).not.toHaveBeenCalled();
    wall += 20_000;
    visibility = 'visible';
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(chime.play).toHaveBeenCalledTimes(1);
    advance(CHIME_SILENCE_CHECK_MS);
    await tap();
    expect(voice.play).toHaveBeenCalledTimes(1);
  });

  it('裏で出て戻り、鳴ったかを確かめる前に閉じたら、閉じた後に触れても鳴らさない (確かめと聞き手を残さない)', async () => {
    visibility = 'hidden';
    const { unmount } = renderOverlay();
    wall += 20_000;
    visibility = 'visible';
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(chime.play).toHaveBeenCalledTimes(1);
    unmount();
    advance(CHIME_SILENCE_CHECK_MS);
    await tap(document.body);
    expect(voice.play).not.toHaveBeenCalled();
    expect(chime.ctx!.close).not.toHaveBeenCalled();
  });

  it('React StrictMode (mount → unmount → mount) でも、最初に触れたときに 1 回だけ鳴らす', async () => {
    renderOverlay({ reactStrictMode: true });
    expect(chime.play).toHaveBeenCalledTimes(1);
    advance(CHIME_SILENCE_CHECK_MS);
    await tap();
    expect(voice.play).toHaveBeenCalledTimes(1);
    wall += 2_000;
    await tap();
    expect(voice.play).toHaveBeenCalledTimes(1);
  });
});
