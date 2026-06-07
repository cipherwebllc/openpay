import { describe, it, expect, afterEach, vi } from 'vitest';

// AudioContext mock 用ノード。connect は引数を返して
// `osc.connect(gain).connect(destination)` のチェーンを成立させる。
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
  resume?: () => Promise<void>;
};

function makeMockAC(opts: ACOpts) {
  return class {
    currentTime = 0;
    destination = {};
    state = opts.state ?? 'running';
    createOscillator = opts.createOscillator ?? (() => makeNode());
    createGain = opts.createGain ?? (() => makeNode());
    resume = opts.resume ?? (() => Promise.resolve());
  };
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
    vi.resetModules();
  });

  it('AudioContext 非対応環境では throw せず no-op', async () => {
    w.AudioContext = undefined;
    w.webkitAudioContext = undefined;
    const { primeChimeAudio, playSuccessChime } = await import('@/lib/successChime');
    expect(() => primeChimeAudio()).not.toThrow();
    expect(() => playSuccessChime()).not.toThrow();
  });

  it('playSuccessChime は 3 音 (oscillator×3, gain×3) を生成', async () => {
    const createOscillator = vi.fn(() => makeNode());
    const createGain = vi.fn(() => makeNode());
    w.AudioContext = makeMockAC({ state: 'running', createOscillator, createGain });
    const { playSuccessChime } = await import('@/lib/successChime');
    playSuccessChime();
    expect(createOscillator).toHaveBeenCalledTimes(3);
    expect(createGain).toHaveBeenCalledTimes(3);
  });

  it('primeChimeAudio は suspended の時に resume を呼ぶ (iOS 解錠)', async () => {
    const resume = vi.fn(() => Promise.resolve());
    w.AudioContext = makeMockAC({ state: 'suspended', resume });
    const { primeChimeAudio } = await import('@/lib/successChime');
    primeChimeAudio();
    expect(resume).toHaveBeenCalled();
  });

  it('内部で例外が出ても throw しない (createOscillator が投げても握る)', async () => {
    w.AudioContext = makeMockAC({
      state: 'running',
      createOscillator: () => {
        throw new Error('boom');
      },
    });
    const { playSuccessChime } = await import('@/lib/successChime');
    expect(() => playSuccessChime()).not.toThrow();
  });
});
