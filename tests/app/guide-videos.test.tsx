// 使い方動画が 4 つのガイドページに正しく入っていることを実描画で検査する。
// - ja: 決めた 1 本だけ (サムネイルの alt = 動画のタイトル・YouTube リンクの ID が一致・押す前は iframe なし)
// - en: 動画の節そのものを出さない (動画は日本語のため)
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import GuideQrPage from '@/app/[locale]/guide/qr/page';
import GuideShopPage from '@/app/[locale]/guide/shop/page';
import GuideAiPayPage from '@/app/[locale]/guide/ai-pay/page';
import GuideStorePage from '@/app/[locale]/guide/store/page';
import { HOWTO_VIDEOS, HOWTO_VIDEO_UI, type HowtoVideoKey } from '@/lib/howtoVideos';

vi.mock('next-intl/server', () => ({ setRequestLocale: vi.fn(), getTranslations: async () => (key: string) => key }));
vi.mock('@/components/AppShell', () => ({ AppShell: ({ children }: { children: React.ReactNode }) => <main>{children}</main> }));

type Page = (props: { params: Promise<{ locale: string }> }) => Promise<React.ReactElement>;
const PAGES: Array<[string, Page, HowtoVideoKey]> = [
  ['/guide/qr', GuideQrPage as Page, 'qr'],
  ['/guide/shop', GuideShopPage as Page, 'mobileOrder'],
  ['/guide/ai-pay', GuideAiPayPage as Page, 'agent'],
  ['/guide/store', GuideStorePage as Page, 'creator'],
];

describe('ガイドページの使い方動画', () => {
  it.each(PAGES)('ja %s は決めた 1 本だけを出す', async (_path, Page, key) => {
    const { container } = render(await Page({ params: Promise.resolve({ locale: 'ja' }) }));
    const video = HOWTO_VIDEOS[key];
    expect(screen.getAllByRole('heading', { name: HOWTO_VIDEO_UI.sectionTitle })).toHaveLength(1);
    const buttons = screen.getAllByRole('button', { name: new RegExp(HOWTO_VIDEO_UI.play) });
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toHaveTextContent(`${HOWTO_VIDEO_UI.play}（${video.duration}）`);
    expect(screen.getByAltText(video.title)).toBeInTheDocument();
    const links = screen.getAllByRole('link', { name: HOWTO_VIDEO_UI.openOnYouTube });
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute('href', `https://www.youtube.com/watch?v=${video.youtubeId}`);
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
