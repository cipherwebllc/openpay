// トップ「使い方」の操作の短い動画 (2026-10-13)。
// - 画面に入るまでは動かさない (preload=none・play しない)・入ったら 3 本とも動かす・出たら止める
// - 「動画を止める」で 3 本とも止まり、押し直すと動く (WCAG 2.2.2)
// - 動きを減らす設定では止めた状態で始める・端末が自動再生を断ったらボタンを「再生」に戻す
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LandingDemoVideos, type LandingDemo } from '@/components/LandingDemoVideos';

const demos: LandingDemo[] = [
  { src: '/demo/a.mp4', poster: '/demo/a.webp', label: '① A', description: 'A の操作' },
  { src: '/demo/b.mp4', poster: '/demo/b.webp', label: '② B', description: 'B の操作' },
  { src: '/demo/c.mp4', poster: '/demo/c.webp', label: '③ C', description: 'C の操作' },
];
const props = { demos, caption: '実際の画面で見る', note: '③ はサンプル', pauseLabel: '動画を止める', playLabel: '動画を再生' };

let intersect: (isIntersecting: boolean) => void = () => {};
beforeEach(() => {
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(cb: IntersectionObserverCallback) {
        intersect = (isIntersecting) => cb([{ isIntersecting } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
      }
      observe() {}
      disconnect() {}
    },
  );
});

describe('LandingDemoVideos', () => {
  it('画面に入るまでは動かさず、入ったら 3 本とも動かし、出たら止める', () => {
    const play = vi.mocked(HTMLMediaElement.prototype.play);
    const pause = vi.mocked(HTMLMediaElement.prototype.pause);
    const { container } = render(<LandingDemoVideos {...props} />);
    const videos = container.querySelectorAll('video');
    expect(videos).toHaveLength(3);
    for (const v of videos) {
      expect(v).toHaveAttribute('preload', 'none');
      expect(v.muted).toBe(true);
      expect(v).toHaveAttribute('loop');
      expect(v).toHaveAttribute('playsinline');
      expect(v).not.toHaveAttribute('autoplay');
    }
    expect([...videos].map((v) => v.getAttribute('poster'))).toEqual(demos.map((d) => d.poster));
    expect([...container.querySelectorAll('source')].map((s) => s.getAttribute('src'))).toEqual(demos.map((d) => d.src));
    expect(play).not.toHaveBeenCalled();

    act(() => intersect(true));
    expect(play).toHaveBeenCalledTimes(3);
    pause.mockClear();
    act(() => intersect(false));
    expect(pause).toHaveBeenCalledTimes(3);
  });

  it('「動画を止める」で 3 本とも止まり、押し直すと動く', async () => {
    const user = userEvent.setup();
    const play = vi.mocked(HTMLMediaElement.prototype.play);
    const pause = vi.mocked(HTMLMediaElement.prototype.pause);
    render(<LandingDemoVideos {...props} />);
    act(() => intersect(true));
    play.mockClear();
    pause.mockClear();

    await user.click(screen.getByRole('button', { name: '動画を止める' }));
    expect(pause).toHaveBeenCalledTimes(3);
    await user.click(screen.getByRole('button', { name: '動画を再生' }));
    expect(play).toHaveBeenCalledTimes(3);
    expect(screen.getByRole('button', { name: '動画を止める' })).toBeInTheDocument();
  });

  it('動きを減らす設定では止めた状態 (ポスター) で始める', () => {
    window.matchMedia = vi.fn().mockReturnValue({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() });
    const play = vi.mocked(HTMLMediaElement.prototype.play);
    render(<LandingDemoVideos {...props} />);
    act(() => intersect(true));
    expect(play).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '動画を再生' })).toBeInTheDocument();
  });

  it('端末が自動再生を断ったら、ボタンを「動画を再生」に戻す', async () => {
    vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValue(new DOMException('blocked', 'NotAllowedError'));
    render(<LandingDemoVideos {...props} />);
    await act(async () => intersect(true));
    expect(screen.getByRole('button', { name: '動画を再生' })).toBeInTheDocument();
  });

  it('見出しと説明は可視の文字から (aria-label を付けない・掟 8)・横スクロールは見出しの名前の region', () => {
    const { container } = render(<LandingDemoVideos {...props} />);
    expect(screen.getByRole('region', { name: '実際の画面で見る' })).toHaveAttribute('tabindex', '0');
    // 図の説明は figcaption (見出し + 読み上げ用の説明)。
    expect(container.querySelector('figcaption')).toHaveTextContent('① A: A の操作');
    expect(screen.getByText('③ はサンプル')).toBeInTheDocument();
    expect(container.querySelectorAll('[aria-label]')).toHaveLength(0);
  });
});
