// next.config.mjs の frame 保護ヘッダー方針のフェンス。
// - /tip (ja/en) のみ iframe 埋め込み許可 (frame-ancestors *)
// - それ以外の全ページは default-deny (frame-ancestors 'self' + X-Frame-Options SAMEORIGIN)
// - 2 ルールは排他 (tip に X-Frame-Options が付くと CSP を見ない古い実装で埋め込みが壊れる)
import { describe, it, expect } from 'vitest';
import config from '../../next.config.mjs';

type HeaderRule = {
  source: string;
  headers: Array<{ key: string; value: string }>;
};

async function loadRules(): Promise<HeaderRule[]> {
  const headersFn = (config as { headers?: () => Promise<HeaderRule[]> }).headers;
  expect(typeof headersFn).toBe('function');
  return headersFn!();
}

describe('next.config.mjs headers() — frame 保護', () => {
  it('tip ルール: /:locale(ja|en)/tip/:path* に frame-ancestors * のみ (X-Frame-Options なし)', async () => {
    const rules = await loadRules();
    const tip = rules.find((r) => r.source.includes('tip/:path*'));
    expect(tip).toBeDefined();
    expect(tip!.headers).toEqual([
      { key: 'Content-Security-Policy', value: 'frame-ancestors *' },
    ]);
  });

  it('default-deny ルール: tip 以外に frame-ancestors self + X-Frame-Options SAMEORIGIN', async () => {
    const rules = await loadRules();
    const deny = rules.find((r) => r.source !== '/:locale(ja|en)/tip/:path*');
    expect(deny).toBeDefined();
    expect(deny!.headers).toEqual([
      { key: 'Content-Security-Policy', value: "frame-ancestors 'self'" },
      { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
    ]);
  });

  it('default-deny の source regex は tip 配下だけを除外する (排他性)', async () => {
    const rules = await loadRules();
    const deny = rules.find((r) => r.source !== '/:locale(ja|en)/tip/:path*')!;
    // source 形式 '/(<regex>)' から内側 regex を取り出し、path-to-regexp と同様に
    // 先頭 '/' 以降のパス全体へ全長マッチさせる。
    const m = deny.source.match(/^\/\((.*)\)$/);
    expect(m).not.toBeNull();
    const re = new RegExp(`^(?:${m![1]})$`);

    // 署名ページ・主要ページは default-deny の対象
    for (const path of [
      'ja/pay',
      'en/pay',
      'ja/checkout',
      'ja/create',
      'ja/history',
      'ja/scan',
      'ja',
      '',
      'api/og/tip', // OG 画像 API は tip ページではない (除外しない)
      'ja/tipjar', // prefix が偶然 tip でも boundary (/|$) で除外されない
    ]) {
      expect(re.test(path), `expected deny rule to match "${path}"`).toBe(true);
    }

    // tip ページ (埋め込み許可) は対象外
    for (const path of ['ja/tip/0xabc', 'en/tip/0xabc', 'ja/tip', 'en/tip']) {
      expect(re.test(path), `expected deny rule NOT to match "${path}"`).toBe(false);
    }
  });
});
