// 使い方動画の SOT (lib/howtoVideos.ts) のフェンス。
// - YouTube の動画 ID と長さの形・サムネイルの実在
// - 動画は日本語なので ja だけに出す
// (ページへの埋め込みは tests/app/guide-videos.test.tsx が実描画で検査する)
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  HOWTO_VIDEOS,
  HOWTO_VIDEO_EMBED_ORIGIN,
  howtoVideoEmbedUrl,
  howtoVideoFor,
  howtoVideoWatchUrl,
} from '@/lib/howtoVideos';

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
});
