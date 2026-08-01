// /og/* 公開 URL の配線フェンス (2026-08-02 本番実害):
// SNS カード検証系には robots.txt の Disallow: /api/ を前置一致だけで評価する crude な
// parser があり、OG 画像を /api/og/ の URL で公開すると longest-match の Allow や
// Twitterbot 専用グループ (#316/#321) を無視して「restricted」と誤判定され続けた。
// 公開 URL は /og/* に固定し、次の 2 点が揃って初めて成立する:
//   ① next.config.mjs の rewrite が /og/:path* を /api/og/:path* へ内部転送する
//   ② middleware の locale リダイレクトが /og/ を除外する (漏れると /ja/og/… → 404)
// 片方だけ残ると「メタタグは /og/ を指すが画像が 404」という静かな全滅になるため、
// 両方をフェンスする。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import config from '../../next.config.mjs';

type Rewrite = { source: string; destination: string };

describe('/og/* 公開 URL の配線', () => {
  it('rewrite: /og/:path* → /api/og/:path*', async () => {
    const rewritesFn = (
      config as { rewrites?: () => Promise<Rewrite[]> }
    ).rewrites;
    expect(typeof rewritesFn).toBe('function');
    const rewrites = await rewritesFn!();
    expect(rewrites).toContainEqual({
      source: '/og/:path*',
      destination: '/api/og/:path*',
    });
  });

  it('middleware matcher は /og/ を除外する (locale リダイレクトで 404 化しない)', () => {
    // middleware.ts の import は next-intl の実行を伴うため、matcher 文字列を
    // ソースから直接取り出して headers フェンスと同様に全長マッチで検証する。
    const src = readFileSync(
      join(process.cwd(), 'middleware.ts'),
      'utf8',
    );
    const m = src.match(/matcher:\s*\['\/\((.*)\)'\]/);
    expect(m).not.toBeNull();
    const re = new RegExp(`^(?:${m![1].replaceAll('\\\\', '\\')})$`);

    // OG 画像 URL は middleware 対象外
    for (const path of ['og/tip', 'og/handle']) {
      expect(re.test(path), `expected matcher NOT to match "${path}"`).toBe(
        false,
      );
    }
    // 通常ページは従来どおり対象 (locale 判定が生きている)
    for (const path of ['ja', 'ja/create', 'ogp-like-page']) {
      expect(re.test(path), `expected matcher to match "${path}"`).toBe(true);
    }
  });
});
