// components/guide/GuideVideo.tsx を実描画で検証する。
// 押すまでは自前のサムネイルだけ (YouTube の iframe を作らない)・押すと youtube-nocookie の iframe に替わる。
import { describe, it, expect } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { GuideVideo } from '@/components/guide/GuideVideo';
import { HOWTO_VIDEOS, HOWTO_VIDEO_UI } from '@/lib/howtoVideos';

const video = HOWTO_VIDEOS.creator;

describe('GuideVideo', () => {
  it('最初はサムネイルと再生ボタンだけで、iframe は無い', () => {
    const { container } = render(<GuideVideo video={video} />);
    expect(container.querySelector('iframe')).toBeNull();
    const button = screen.getByRole('button', { name: new RegExp(`${HOWTO_VIDEO_UI.play}（${video.duration}）`) });
    // a11y 名は可視テキスト (再生ボタンの文字) と サムネイルの alt (動画のタイトル) から決まる (aria-label は使わない)。
    expect(button).not.toHaveAttribute('aria-label');
    expect(button).toHaveTextContent(`${HOWTO_VIDEO_UI.play}（${video.duration}）`);
    expect(screen.getByAltText(video.title)).toBeInTheDocument();
    const link = screen.getByRole('link', { name: HOWTO_VIDEO_UI.openOnYouTube });
    expect(link).toHaveAttribute('href', `https://www.youtube.com/watch?v=${video.youtubeId}`);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.getByText(video.title, { selector: 'span' })).toBeInTheDocument();
  });

  it('押すと youtube-nocookie の iframe (自動再生・origin だけの Referer・sandbox) に替わる', () => {
    const { container } = render(<GuideVideo video={video} />);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.queryByRole('button')).toBeNull();
    const iframe = container.querySelector('iframe');
    expect(iframe).not.toBeNull();
    expect(iframe).toHaveAttribute('src', `https://www.youtube-nocookie.com/embed/${video.youtubeId}?autoplay=1&rel=0`);
    expect(iframe).toHaveAttribute('title', video.title);
    expect(iframe).toHaveAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
    expect(iframe).toHaveAttribute('sandbox', 'allow-scripts allow-same-origin allow-popups allow-presentation');
    expect(iframe!.getAttribute('allow')).toContain('autoplay');
    expect(iframe).toHaveAttribute('allowfullscreen');
  });

  // D6: 押したボタンが消えると focus が body に落ち、キーボードでは動画まで辿り直しになる。
  it('キーボードで再生すると、focus は置き換わった iframe (動画) へ移る', async () => {
    const user = userEvent.setup();
    const { container } = render(<GuideVideo video={video} />);
    await user.tab();
    expect(screen.getByRole('button')).toHaveFocus();
    await user.keyboard('{Enter}');
    const iframe = container.querySelector('iframe');
    expect(iframe).not.toBeNull();
    expect(iframe).toHaveFocus();
  });
});
