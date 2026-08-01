// /og/* 公開 URL の配線フェンス (2026-08-02 本番実害):
// SNS カード検証系には robots.txt の Disallow: /api/ を前置一致だけで評価する crude な
// parser があり、OG 画像を /api/og/ の URL で公開すると longest-match の Allow や
// Twitterbot 専用グループ (#316/#321) を無視して「restricted」と誤判定され続けた。
// 公開 URL は /og/* に固定し、middleware の server rewrite で /api/og/* へ転送する
// (next.config.mjs の rewrites() は存在するだけで client router に解決コードが入り
// 全ルートの First Load JS が +3kB 太って bundle 予算を割るため使わない)。
// 次の 2 点が揃って初めて成立する:
//   ① middleware が /og/* を /api/og/* へ rewrite する (query 保持)
//   ② matcher が /og/ を除外しない (除外すると rewrite が動かず画像 404)
// 片方欠けは「メタタグは /og/ を指すが画像 404」という静かな全滅になるため、
// 両方をフェンスする。
import { NextRequest } from 'next/server';
import { describe, expect, it, vi } from 'vitest';

// next-intl の middleware 実体は vitest の node ESM 解決で 'next/server' を引けず
// import 自体が落ちる。/og/ 経路は intl に到達しない (先に rewrite で return) ため、
// ここでは素通し stub に差し替えて配線だけを検証する。
vi.mock('next-intl/middleware', () => ({
  default: () => () => null,
}));

const { default: middleware, config: middlewareConfig } = await import(
  '../../middleware'
);

describe('/og/* 公開 URL の配線', () => {
  it('middleware rewrite: /og/* → /api/og/* (query 保持)', () => {
    const res = middleware(
      new NextRequest(
        'https://open-pay.jp/og/handle?h=masia&locale=ja&product=h_abc',
      ),
    );
    const rewrite = res?.headers.get('x-middleware-rewrite');
    expect(rewrite).toBe(
      'https://open-pay.jp/api/og/handle?h=masia&locale=ja&product=h_abc',
    );
  });

  it('middleware rewrite: /og/tip も対象', () => {
    const res = middleware(
      new NextRequest('https://open-pay.jp/og/tip?locale=ja'),
    );
    expect(res?.headers.get('x-middleware-rewrite')).toBe(
      'https://open-pay.jp/api/og/tip?locale=ja',
    );
  });

  it('matcher は /og/ を除外しない (middleware が動かないと rewrite されず 404)', () => {
    // headers フェンス (next-config-headers.test.ts) と同様に、matcher の
    // '/(<regex>)' から内側 regex を取り出して全長マッチで検証する。
    const source = middlewareConfig.matcher[0];
    const m = source.match(/^\/\((.*)\)$/);
    expect(m).not.toBeNull();
    const re = new RegExp(`^(?:${m![1]})$`);

    // OG 画像 URL は middleware の対象 (rewrite が動く)
    for (const path of ['og/tip', 'og/handle']) {
      expect(re.test(path), `expected matcher to match "${path}"`).toBe(true);
    }
    // 通常ページも従来どおり対象 (locale 判定が生きている)
    for (const path of ['ja', 'ja/create']) {
      expect(re.test(path), `expected matcher to match "${path}"`).toBe(true);
    }
    // /api は従来どおり対象外
    expect(re.test('api/og/tip')).toBe(false);
  });
});
