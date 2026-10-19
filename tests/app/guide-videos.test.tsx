// 使い方動画が 4 つのガイドページに正しく入っていることを実描画で検査する。
// - ja: 決めた動画だけ (/guide/shop はレジ → モバイルオーダー → 受注の 3 本・ほかは 1 本。ボタンの名前に動画のタイトル・
//   YouTube リンクの ID が一致・押す前は iframe なし)
// - en: 動画の節そのものを出さない (動画は日本語のため)
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import GuideQrPage from '@/app/[locale]/guide/qr/page';
import GuideShopPage from '@/app/[locale]/guide/shop/page';
import GuideAiPayPage from '@/app/[locale]/guide/ai-pay/page';
import GuideStorePage from '@/app/[locale]/guide/store/page';
import GuidePayPage from '@/app/[locale]/guide/pay/page';
import { HOWTO_VIDEOS, HOWTO_VIDEO_UI, howtoVideoShortTitle, type HowtoVideoKey } from '@/lib/howtoVideos';

vi.mock('next-intl/server', () => ({ setRequestLocale: vi.fn(), getTranslations: async () => (key: string) => key }));
vi.mock('@/components/AppShell', () => ({ AppShell: ({ children }: { children: React.ReactNode }) => <main>{children}</main> }));

type Page = (props: { params: Promise<{ locale: string }> }) => Promise<React.ReactElement>;
const PAGES: Array<[string, Page, readonly HowtoVideoKey[]]> = [
  ['/guide/qr', GuideQrPage as Page, ['qr']],
  ['/guide/shop', GuideShopPage as Page, ['register', 'mobileOrder', 'orders']],
  ['/guide/ai-pay', GuideAiPayPage as Page, ['agent']],
  ['/guide/store', GuideStorePage as Page, ['creator']],
  ['/guide/pay', GuidePayPage as Page, ['pay']],
];

describe('ガイドページの使い方動画', () => {
  it.each(PAGES)('ja %s は決めた動画だけを決めた順に出す', async (_path, Page, keys) => {
    const { container } = render(await Page({ params: Promise.resolve({ locale: 'ja' }) }));
    const videos = keys.map((key) => HOWTO_VIDEOS[key]);
    expect(screen.getAllByRole('heading', { name: HOWTO_VIDEO_UI.sectionTitle })).toHaveLength(1);
    const buttons = screen.getAllByRole('button', { name: new RegExp(HOWTO_VIDEO_UI.play) });
    expect(buttons).toHaveLength(videos.length);
    const links = screen.getAllByRole('link', { name: HOWTO_VIDEO_UI.openOnYouTube });
    expect(links).toHaveLength(videos.length);
    videos.forEach((video, i) => {
      expect(buttons[i]).toHaveTextContent(`${HOWTO_VIDEO_UI.play} (${video.duration})`);
      expect(buttons[i]).toHaveTextContent(howtoVideoShortTitle(video));
      expect(links[i]).toHaveAttribute('href', `https://www.youtube.com/watch?v=${video.youtubeId}`);
    });
    // 押すまで YouTube の iframe は作らない。
    expect(container.querySelector('iframe[src*="youtube"]')).toBeNull();
  });

  it.each(PAGES)('en %s には動画の節を出さない', async (_path, Page) => {
    const { container } = render(await Page({ params: Promise.resolve({ locale: 'en' }) }));
    expect(screen.queryByRole('heading', { name: HOWTO_VIDEO_UI.sectionTitle })).toBeNull();
    expect(screen.queryByRole('button', { name: new RegExp(HOWTO_VIDEO_UI.play) })).toBeNull();
    expect(screen.queryByRole('link', { name: HOWTO_VIDEO_UI.openOnYouTube })).toBeNull();
    expect(container.querySelector('img[src*="guide%2Fvideos"], img[src*="/guide/videos/"]')).toBeNull();
  });
});
