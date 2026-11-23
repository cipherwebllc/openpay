import { describe, it, expect, afterEach, vi } from 'vitest';

// AudioContext mock 用ノード。connect は引数を返す (今の仕様の形)。古い WebKit の形 (undefined を返す) は個別のテストで
// 差し替える。実装は connect を 1 段ずつ呼ぶので、どちらでも動く。
function makeNode() {
  return {
    gain: {
      setValueAtTime: vi.fn(),
      exponentialRampToValueAtTime: vi.fn(),
    },
    frequency: { value: 0 },
    type: '',
    connect: vi.fn((target: unknown) => target),
    start: vi.fn(),
    stop: vi.fn(),
  };
}

type ACOpts = {
  state?: AudioContextState;
  createOscillator?: () => unknown;
  createGain?: () => unknown;
  createBufferSource?: () => unknown;
  decodeAudioData?: (
    data: ArrayBuffer,
    ok: (buffer: unknown) => void,
    ng: (error: unknown) => void,
  ) => Promise<unknown> | undefined;
  resume?: () => Promise<void>;
};

const VOICE_BUFFER = { duration: 0.5 };

function makeMockAC(opts: ACOpts) {
  return class {
    currentTime = 0;
    destination = {};
    state = opts.state ?? 'running';
    createOscillator = opts.createOscillator ?? (() => makeNode());
    createGain = opts.createGain ?? (() => makeNode());
    createBufferSource = opts.createBufferSource ?? (() => ({ ...makeNode(), buffer: null }));
    decodeAudioData = opts.decodeAudioData ?? (() => Promise.resolve(VOICE_BUFFER));
    resume = opts.resume ?? (() => Promise.resolve());
  };
}

// 声のファイルの fetch を差し替える。ok: 200 と中身 / fail: 404 / reject: 通信の失敗 / hang: 返らない。
function stubFetch(mode: 'ok' | 'fail' | 'reject' | 'hang') {
  const fetchMock = vi.fn((url: string) => {
    void url;
    if (mode === 'reject') return Promise.reject(new Error('offline'));
    if (mode === 'hang') return new Promise(() => undefined);
    return Promise.resolve({
      ok: mode === 'ok',
      status: mode === 'ok' ? 200 : 404,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

// 読み込み (fetch → arrayBuffer → decode) の Promise の連鎖を流し切る。
async function flush() {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

const w = window as unknown as {
  AudioContext?: unknown;
  webkitAudioContext?: unknown;
};

describe('lib/successChime', () => {
  const origAC = w.AudioContext;
  const origWebkit = w.webkitAudioContext;

  afterEach(() => {
    w.AudioContext = origAC;
    w.webkitAudioContext = origWebkit;
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.resetModules();
  });

  it('AudioContext 非対応環境では throw せず no-op', async () => {
    w.AudioContext = undefined;
    w.webkitAudioContext = undefined;
    const { primeChimeAudio, playSuccessChime } = await import('@/lib/successChime');
    expect(() => primeChimeAudio()).not.toThrow();
    expect(() => playSuccessChime()).not.toThrow();
  });

  it('声を読めないとき (404) は、合成チャイム 3 音 (oscillator×3, gain×3) を鳴らす', async () => {
    stubFetch('fail');
    const createOscillator = vi.fn(() => makeNode());
    const createGain = vi.fn(() => makeNode());
    const createBufferSource = vi.fn(() => ({ ...makeNode(), buffer: null }));
    w.AudioContext = makeMockAC({ state: 'running', createOscillator, createGain, createBufferSource });
    const { playSuccessChime } = await import('@/lib/successChime');
    playSuccessChime();
    await flush();
    expect(createOscillator).toHaveBeenCalledTimes(3);
    expect(createGain).toHaveBeenCalledTimes(3);
    expect(createBufferSource).not.toHaveBeenCalled();
  });

  it('通信の失敗でも合成チャイムを鳴らし、throw しない', async () => {
    stubFetch('reject');
    const createOscillator = vi.fn(() => makeNode());
    w.AudioContext = makeMockAC({ state: 'running', createOscillator });
    const { playSuccessChime } = await import('@/lib/successChime');
    expect(() => playSuccessChime()).not.toThrow();
    await flush();
    expect(createOscillator).toHaveBeenCalledTimes(3);
  });

  it('支払いボタンで読み込んだ声を、完了のときに 1 回だけ鳴らす (合成チャイムは鳴らさない)', async () => {
    const fetchMock = stubFetch('ok');
    const sources: Array<ReturnType<typeof makeNode> & { buffer: unknown }> = [];
    const gains: Array<ReturnType<typeof makeNode> & { gain: { value?: number } }> = [];
    const createOscillator = vi.fn(() => makeNode());
    w.AudioContext = makeMockAC({
      state: 'running',
      createOscillator,
      createGain: () => {
        const node = makeNode();
        gains.push(node);
        return node;
      },
      createBufferSource: () => {
        const node = { ...makeNode(), buffer: null as unknown };
        sources.push(node);
        return node;
      },
    });
    const { primeChimeAudio, playSuccessChime } = await import('@/lib/successChime');
    primeChimeAudio();
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('/sounds/openpay-complete-v1.mp3');
    playSuccessChime();
    expect(sources).toHaveLength(1);
    expect(sources[0].buffer).toBe(VOICE_BUFFER);
    expect(sources[0].start).toHaveBeenCalledTimes(1);
    expect(sources[0].connect).toHaveBeenCalledWith(gains[0]);
    expect(gains[0].connect).toHaveBeenCalledTimes(1);
    expect(gains[0].gain.value).toBe(0.5);
    expect(createOscillator).not.toHaveBeenCalled();
    // 2 回目の支払いは読み直さない (読み込んだ声を使い回す)。
    primeChimeAudio();
    playSuccessChime();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sources).toHaveLength(2);
  });

  it('完了のときに読み込み中なら、読み終わってから声を鳴らす (待つのは VOICE_WAIT_MS まで)', async () => {
    stubFetch('ok');
    const createBufferSource = vi.fn(() => ({ ...makeNode(), buffer: null }));
    const createOscillator = vi.fn(() => makeNode());
    w.AudioContext = makeMockAC({ state: 'running', createBufferSource, createOscillator });
    const { playSuccessChime } = await import('@/lib/successChime');
    playSuccessChime();
    expect(createBufferSource).not.toHaveBeenCalled();
    await flush();
    expect(createBufferSource).toHaveBeenCalledTimes(1);
    expect(createOscillator).not.toHaveBeenCalled();
  });

  it('読み込みが VOICE_WAIT_MS を過ぎても終わらなければ合成チャイムを鳴らし、後から声は鳴らさない', async () => {
    vi.useFakeTimers();
    let finish: (value: unknown) => void = () => undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      ),
    );
    const createBufferSource = vi.fn(() => ({ ...makeNode(), buffer: null }));
    const createOscillator = vi.fn(() => makeNode());
    w.AudioContext = makeMockAC({ state: 'running', createBufferSource, createOscillator });
    const { playSuccessChime, VOICE_WAIT_MS } = await import('@/lib/successChime');
    playSuccessChime();
    vi.advanceTimersByTime(VOICE_WAIT_MS - 1);
    expect(createOscillator).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(createOscillator).toHaveBeenCalledTimes(3);
    finish({ ok: true, status: 200, arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) });
    await flush();
    expect(createBufferSource).not.toHaveBeenCalled();
  });

  it('decodeAudioData が callback だけの古い形 (Promise を返さない) でも声を鳴らす', async () => {
    stubFetch('ok');
    const createBufferSource = vi.fn(() => ({ ...makeNode(), buffer: null }));
    w.AudioContext = makeMockAC({
      state: 'running',
      createBufferSource,
      decodeAudioData: (_data, ok) => {
        ok(VOICE_BUFFER);
        return undefined;
      },
    });
    const { playSuccessChime } = await import('@/lib/successChime');
    playSuccessChime();
    await flush();
    expect(createBufferSource).toHaveBeenCalledTimes(1);
  });

  it('声を鳴らせない (createBufferSource が投げる) ときは合成チャイムに切り替え、throw しない', async () => {
    stubFetch('ok');
    const createOscillator = vi.fn(() => makeNode());
    w.AudioContext = makeMockAC({
      state: 'running',
      createOscillator,
      createBufferSource: () => {
        throw new Error('boom');
      },
    });
    const { playSuccessChime } = await import('@/lib/successChime');
    expect(() => playSuccessChime()).not.toThrow();
    await flush();
    expect(createOscillator).toHaveBeenCalledTimes(3);
  });

  it('unlockChimeAudio は解錠だけで、声のファイルを読まない (厨房・注文状況の画面用)', async () => {
    const fetchMock = stubFetch('ok');
    const resume = vi.fn(() => Promise.resolve());
    w.AudioContext = makeMockAC({ state: 'suspended', resume });
    const { unlockChimeAudio } = await import('@/lib/successChime');
    unlockChimeAudio();
    await flush();
    expect(resume).toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('古い WebKit (connect が接続先を返さない) でも、声と合成チャイムを鳴らせる', async () => {
    const oldNode = () => ({ ...makeNode(), connect: vi.fn(() => undefined), buffer: null as unknown });
    // 声: 読めたら start が 1 回。
    stubFetch('ok');
    const voiceSources: Array<ReturnType<typeof oldNode>> = [];
    w.AudioContext = makeMockAC({
      state: 'running',
      createGain: oldNode,
      createBufferSource: () => {
        const node = oldNode();
        voiceSources.push(node);
        return node;
      },
    });
    let mod = await import('@/lib/successChime');
    mod.playSuccessChime();
    await flush();
    expect(voiceSources).toHaveLength(1);
    expect(voiceSources[0].start).toHaveBeenCalledTimes(1);
    // 合成チャイム: 声を読めないとき、3 音とも start する。
    vi.resetModules();
    stubFetch('fail');
    const oscillators: Array<ReturnType<typeof oldNode>> = [];
    w.AudioContext = makeMockAC({
      state: 'running',
      createGain: oldNode,
      createOscillator: () => {
        const node = oldNode();
        oscillators.push(node);
        return node;
      },
    });
    mod = await import('@/lib/successChime');
    mod.playSuccessChime();
    await flush();
    expect(oscillators).toHaveLength(3);
    for (const osc of oscillators) expect(osc.start).toHaveBeenCalledTimes(1);
  });

  it('decode に失敗したら合成チャイムを鳴らし、次の支払いで読み直して声を鳴らす', async () => {
    const fetchMock = stubFetch('ok');
    let decodes = 0;
    const createBufferSource = vi.fn(() => ({ ...makeNode(), buffer: null }));
    const createOscillator = vi.fn(() => makeNode());
    w.AudioContext = makeMockAC({
      state: 'running',
      createBufferSource,
      createOscillator,
      decodeAudioData: () => {
        decodes += 1;
        return decodes === 1 ? Promise.reject(new Error('bad mp3')) : Promise.resolve(VOICE_BUFFER);
      },
    });
    const { primeChimeAudio, playSuccessChime } = await import('@/lib/successChime');
    primeChimeAudio();
    playSuccessChime();
    await flush();
    expect(createOscillator).toHaveBeenCalledTimes(3);
    expect(createBufferSource).not.toHaveBeenCalled();
    primeChimeAudio();
    await flush();
    playSuccessChime();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(createBufferSource).toHaveBeenCalledTimes(1);
    expect(createOscillator).toHaveBeenCalledTimes(3);
  });

  it('読み込み中に支払いボタンと完了が重なっても、fetch は 1 本で声は 1 回', async () => {
    let finish: (value: unknown) => void = () => undefined;
    const fetchMock = vi.fn(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const createBufferSource = vi.fn(() => ({ ...makeNode(), buffer: null }));
    const createOscillator = vi.fn(() => makeNode());
    w.AudioContext = makeMockAC({ state: 'running', createBufferSource, createOscillator });
    const { primeChimeAudio, playSuccessChime } = await import('@/lib/successChime');
    primeChimeAudio();
    primeChimeAudio();
    playSuccessChime();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    finish({ ok: true, status: 200, arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) });
    await flush();
    expect(createBufferSource).toHaveBeenCalledTimes(1);
    expect(createOscillator).not.toHaveBeenCalled();
  });

  it('読み終わりが timer より先に走っても、VOICE_WAIT_MS を過ぎていたら声ではなく合成チャイム (1 回だけ)', async () => {
    let finish: (value: unknown) => void = () => undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      ),
    );
    let clock = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    const createBufferSource = vi.fn(() => ({ ...makeNode(), buffer: null }));
    const createOscillator = vi.fn(() => makeNode());
    w.AudioContext = makeMockAC({ state: 'running', createBufferSource, createOscillator });
    const { playSuccessChime, VOICE_WAIT_MS } = await import('@/lib/successChime');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    playSuccessChime();
    clock += VOICE_WAIT_MS + 40; // event loop が塞がって timer がまだ走っていない状態
    finish({ ok: true, status: 200, arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) });
    await flush();
    expect(createBufferSource).not.toHaveBeenCalled();
    expect(createOscillator).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(VOICE_WAIT_MS);
    expect(createOscillator).toHaveBeenCalledTimes(3);
    vi.restoreAllMocks();
  });

  it('読み込みが VOICE_LOAD_TIMEOUT_MS を過ぎて固まったら打ち切り、次の支払いで読み直す', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const fetchMock = vi.fn(() => new Promise(() => undefined));
    vi.stubGlobal('fetch', fetchMock);
    w.AudioContext = makeMockAC({ state: 'running' });
    const { primeChimeAudio, VOICE_LOAD_TIMEOUT_MS } = await import('@/lib/successChime');
    primeChimeAudio();
    primeChimeAudio();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(VOICE_LOAD_TIMEOUT_MS);
    await flush();
    primeChimeAudio();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('声のファイルは public/sounds にあり、中身は v1 のまま (変えるならファイル名の版を上げる)', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { createHash } = await import('node:crypto');
    const bytes = readFileSync(join(process.cwd(), 'public/sounds/openpay-complete-v1.mp3'));
    expect(bytes.length).toBe(4460);
    // 中身を変えたらこの hash を直すのではなく、openpay-complete-v2.mp3 を作って VOICE_URL を変える
    // (public/ は max-age=0 の再検証なので壊れはしないが、版で分けると古い端末のキャッシュと混ざらない)。
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(
      'ca8b9ae890278bd33158f512b1a6e5ffd3c215cf48e1915033d218e22e97dd59',
    );
  });

  it('primeChimeAudio は suspended の時に resume を呼ぶ (iOS 解錠)', async () => {
    stubFetch('fail');
    const resume = vi.fn(() => Promise.resolve());
    w.AudioContext = makeMockAC({ state: 'suspended', resume });
    const { primeChimeAudio } = await import('@/lib/successChime');
    primeChimeAudio();
    expect(resume).toHaveBeenCalled();
  });

  it('内部で例外が出ても throw しない (createOscillator が投げても握る)', async () => {
    stubFetch('fail');
    w.AudioContext = makeMockAC({
      state: 'running',
      createOscillator: () => {
        throw new Error('boom');
      },
    });
    const { playSuccessChime } = await import('@/lib/successChime');
    expect(() => playSuccessChime()).not.toThrow();
    await flush();
  });

  it('playNewOrderChime は 4 音 (ピンポン×2) を生成 = 完了音と区別・声のファイルは読まない', async () => {
    const fetchMock = stubFetch('ok');
    const createOscillator = vi.fn(() => makeNode());
    const createGain = vi.fn(() => makeNode());
    w.AudioContext = makeMockAC({ state: 'running', createOscillator, createGain });
    const { playNewOrderChime } = await import('@/lib/successChime');
    playNewOrderChime();
    expect(createOscillator).toHaveBeenCalledTimes(4);
    expect(createGain).toHaveBeenCalledTimes(4);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('playNewOrderChime も AudioContext 非対応では throw せず no-op', async () => {
    w.AudioContext = undefined;
    w.webkitAudioContext = undefined;
    const { playNewOrderChime } = await import('@/lib/successChime');
    expect(() => playNewOrderChime()).not.toThrow();
  });
});
