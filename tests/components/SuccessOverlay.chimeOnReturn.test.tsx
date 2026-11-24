// 完了画面が裏で出たとき (ウォレットのアプリで承認している間に決済が確定した等)、iPhone は音を出さないので、
// 表に戻ったときに 1 回だけ鳴らす (2026-11-24 user)。戻るまでが CHIME_ON_RETURN_MAX_MS を超えたら鳴らさない。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, screen } from '@testing-library/react';

vi.mock('wagmi', () => ({
  useSignMessage: () => ({ signMessageAsync: vi.fn(), isPending: false }),
  useAccount: () => ({ address: undefined }),
  usePublicClient: () => undefined,
}));
const chime = vi.hoisted(() => ({ play: vi.fn() }));
// 完了音の ON/OFF は localStorage を読む本物の hook (useSuccessSoundPref) が soundPref を経由して読む。
vi.mock('@/lib/successChime', () => ({ playSuccessChime: () => chime.play() }));
// 音のボタンの確認の音は audio 要素で鳴らす (鳴らなかったときの鳴らし直しは tests/components/SuccessOverlay.chimeOnTap.test.tsx)。
const voice = vi.hoisted(() => ({ play: vi.fn(() => ({ result: Promise.resolve(true), stop: () => undefined })) }));
vi.mock('@/lib/successVoice', () => ({ playVoiceElement: () => voice.play() }));
const pref = vi.hoisted(() => ({ enabled: true }));
vi.mock('@/lib/soundPref', () => ({
  isSuccessSoundEnabled: () => pref.enabled,
  setSuccessSoundEnabled: (v: boolean) => {
    pref.enabled = v;
  },
}));

import { renderWithIntl as render } from '../_helpers/i18n';
import { SuccessOverlay, CHIME_ON_RETURN_MAX_MS } from '@/components/SuccessOverlay';

const TX_HASH = `0x${'a'.repeat(64)}`;
let visibility: DocumentVisibilityState = 'visible';
let wall = 1_000_000;

function setVisibility(next: DocumentVisibilityState) {
  visibility = next;
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

function renderOverlay(opts?: { reactStrictMode?: boolean }) {
  return render(<SuccessOverlay amountDisplay="3 JPYC" txHash={TX_HASH} onDismiss={() => undefined} />, opts);
}

describe('SuccessOverlay の完了音 (裏で出たときは戻ってから鳴らす)', () => {
  beforeEach(() => {
    chime.play.mockReset();
    voice.play.mockClear();
    pref.enabled = true;
    visibility = 'visible';
    wall = 1_000_000;
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
    vi.spyOn(Date, 'now').mockImplementation(() => wall);
    // performance.now は端末のスリープ中に進まない (WebKit) ので、テストでは止めておく。
    vi.spyOn(performance, 'now').mockImplementation(() => 5_000);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('表で出たら、出たときに 1 回だけ鳴らす (戻る操作で 2 回目は鳴らない)', () => {
    renderOverlay();
    expect(chime.play).toHaveBeenCalledTimes(1);
    setVisibility('hidden');
    setVisibility('visible');
    expect(chime.play).toHaveBeenCalledTimes(1);
  });

  it('裏で出たら、そのときは鳴らさず、表に戻ったときに 1 回だけ鳴らす', () => {
    visibility = 'hidden';
    renderOverlay();
    expect(chime.play).not.toHaveBeenCalled();
    wall += 20_000;
    setVisibility('visible');
    expect(chime.play).toHaveBeenCalledTimes(1);
    setVisibility('hidden');
    setVisibility('visible');
    expect(chime.play).toHaveBeenCalledTimes(1);
  });

  it('戻るまでが CHIME_ON_RETURN_MAX_MS を超えたら鳴らさない (時間がたってから急に鳴らさない)', () => {
    visibility = 'hidden';
    renderOverlay();
    wall += CHIME_ON_RETURN_MAX_MS + 1; // スリープを挟んで実時刻だけ進んだ (performance.now は止まったまま)
    setVisibility('visible');
    expect(chime.play).not.toHaveBeenCalled();
    setVisibility('hidden');
    setVisibility('visible');
    expect(chime.play).not.toHaveBeenCalled();
  });

  it('React StrictMode (mount → unmount → mount) でも、裏で出たら戻ったときに 1 回だけ鳴らす', () => {
    visibility = 'hidden';
    renderOverlay({ reactStrictMode: true });
    expect(chime.play).not.toHaveBeenCalled();
    setVisibility('visible');
    expect(chime.play).toHaveBeenCalledTimes(1);
  });

  it('戻るのを待っている間に完了音を OFF にしたら、戻っても鳴らさない', () => {
    visibility = 'hidden';
    renderOverlay();
    pref.enabled = false; // 別のタブの完了画面で OFF にした
    setVisibility('visible');
    expect(chime.play).not.toHaveBeenCalled();
  });

  it('完了音 OFF で表に出たら鳴らさず、ON に切り替えた瞬間に確認の音を 1 回だけ鳴らす (押した操作の中で audio 要素で)', () => {
    pref.enabled = false;
    renderOverlay();
    expect(chime.play).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /完了音/ }));
    expect(voice.play).toHaveBeenCalledTimes(1);
    expect(chime.play).not.toHaveBeenCalled();
  });

  it('戻る前に完了画面を閉じたら、戻っても鳴らさない (聞き手を外す)', () => {
    visibility = 'hidden';
    const { unmount } = renderOverlay();
    unmount();
    setVisibility('visible');
    expect(chime.play).not.toHaveBeenCalled();
  });

  it('完了音を OFF にしていたら、裏で出ても表で出ても鳴らさない', () => {
    pref.enabled = false;
    visibility = 'hidden';
    renderOverlay();
    setVisibility('visible');
    expect(chime.play).not.toHaveBeenCalled();
  });
});
