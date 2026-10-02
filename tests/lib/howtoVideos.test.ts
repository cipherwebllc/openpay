// 使い方動画の SOT (lib/howtoVideos.ts) のフェンス。
// - YouTube の動画 ID と長さの形・サムネイルの実在
// - 動画は日本語なので ja だけに出す
// - 4 本がそれぞれ決めたガイドページに 1 回ずつ埋め込まれている (付け忘れ・付け間違いの検出)
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  HOWTO_VIDEOS,
  HOWTO_VIDEO_EMBED_ORIGIN,
  howtoVideoEmbedUrl,
  howtoVideoFor,
  howtoVideoWatchUrl,
  type HowtoVideoKey,
} from '@/lib/howtoVideos';

const PAGE_OF: Record<HowtoVideoKey, string> = {
  qr: 'app/[locale]/guide/qr/page.tsx',
  mobileOrder: 'app/[locale]/guide/shop/page.tsx',
  agent: 'app/[locale]/guide/ai-pay/page.tsx',
  creator: 'app/[locale]/guide/store/page.tsx',
};

describe('HOWTO_VIDEOS', () => {
  it('動画 ID・長さ・タイトルの形と、サムネイルの実在', () => {
    const ids = new Set<string>();
    for (const v of Object.values(HOWTO_VIDEOS)) {
      expect(v.youtubeId).toMatch(/^[A-Za-z0-9_-]{11}$/);
      expect(v.duration).toMatch(/^\d+:[0-5]\d$/);
      expect(v.title.startsWith('OpenPay の使い方｜')).toBe(true);
      expect(v.thumbnail).toMatch(/^\/guide\/videos\/[a-z-]+\.webp$/);
      expect(existsSync(join('public', v.thumbnail))).toBe(true);
      ids.add(v.youtubeId);
    }
    expect(ids.size).toBe(Object.keys(HOWTO_VIDEOS).length);
  });

  it('埋め込みは youtube-nocookie・自動再生、外部リンクは youtube.com', () => {
    const v = HOWTO_VIDEOS.qr;
    expect(howtoVideoEmbedUrl(v)).toBe(`${HOWTO_VIDEO_EMBED_ORIGIN}/embed/${v.youtubeId}?autoplay=1&rel=0`);
    expect(HOWTO_VIDEO_EMBED_ORIGIN).toBe('https://www.youtube-nocookie.com');
    expect(howtoVideoWatchUrl(v)).toBe(`https://www.youtube.com/watch?v=${v.youtubeId}`);
  });

  it('ja だけに出す (en と未知の locale は null)', () => {
    expect(howtoVideoFor('ja', 'agent')).toBe(HOWTO_VIDEOS.agent);
    expect(howtoVideoFor('en', 'agent')).toBeNull();
    expect(howtoVideoFor('fr', 'agent')).toBeNull();
  });

  it('4 本がそれぞれのガイドページに 1 回ずつ埋め込まれている', () => {
    for (const [key, page] of Object.entries(PAGE_OF)) {
      const src = readFileSync(page, 'utf8');
      const calls = [...src.matchAll(/howtoVideoFor\(locale, '([A-Za-z]+)'\)/g)].map((m) => m[1]);
      expect(calls, page).toEqual([key]);
      expect(src).toContain('<GuideVideo video={video} />');
    }
  });
});
