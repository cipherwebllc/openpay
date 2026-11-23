// 完了画面が裏で出たとき (ウォレットのアプリで承認している間に決済が確定した等)、iPhone は音を出さないので、
// 表に戻ったときに 1 回だけ鳴らす (2026-11-24 user)。戻るまでが CHIME_ON_RETURN_MAX_MS を超えたら鳴らさない。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from '@testing-library/react';

vi.mock('wagmi', () => ({
  useSignMessage: () => ({ signMessageAsync: vi.fn(), isPending: false }),
  useAccount: () => ({ address: undefined }),
  usePublicClient: () => undefined,
}));
const chime = vi.hoisted(() => ({ play: vi.fn() }));
vi.mock('@/lib/successChime', () => ({ playSuccessChime: () => chime.play() }));
const pref = vi.hoisted(() => ({ enabled: true }));
vi.mock('@/lib/soundPref', () => ({
  isSuccessSoundEnabled: () => pref.enabled,
  setSuccessSoundEnabled: vi.fn(),
}));

import { renderWithIntl as render } from '../_helpers/i18n';
import { SuccessOverlay, CHIME_ON_RETURN_MAX_MS } from '@/components/SuccessOverlay';

const TX_HASH = `0x${'a'.repeat(64)}`;
let visibility: DocumentVisibilityState = 'visible';
let clock = 1000;

function setVisibility(next: DocumentVisibilityState) {
  visibility = next;
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

function renderOverlay() {
  return render(<SuccessOverlay amountDisplay="3 JPYC" txHash={TX_HASH} onDismiss={() => undefined} />);
}

describe('SuccessOverlay の完了音 (裏で出たときは戻ってから鳴らす)', () => {
  beforeEach(() => {
    chime.play.mockReset();
    pref.enabled = true;
    visibility = 'visible';
    clock = 1000;
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
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
    clock += 20_000;
    setVisibility('visible');
    expect(chime.play).toHaveBeenCalledTimes(1);
    setVisibility('hidden');
    setVisibility('visible');
    expect(chime.play).toHaveBeenCalledTimes(1);
  });

  it('戻るまでが CHIME_ON_RETURN_MAX_MS を超えたら鳴らさない (時間がたってから急に鳴らさない)', () => {
    visibility = 'hidden';
    renderOverlay();
    clock += CHIME_ON_RETURN_MAX_MS + 1;
    setVisibility('visible');
    expect(chime.play).not.toHaveBeenCalled();
    setVisibility('hidden');
    setVisibility('visible');
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
