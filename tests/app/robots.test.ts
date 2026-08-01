// /robots.txt の SNS カード互換フェンス (2026-08-01 本番実害):
// X (Twitterbot) は robots.txt を尊重するため、OG 画像 (/api/og/*) が
// /api/ 一括 disallow に飲まれると X だけカードが出ない。
import { describe, expect, it } from 'vitest';
import robots from '@/app/robots';

describe('robots.txt', () => {
  it('OG 画像 (/api/og/) は allow され、/api/ 一括 disallow より優先される形で明示される', () => {
    const config = robots();
    const rule = Array.isArray(config.rules) ? config.rules[0] : config.rules;
    const allow = Array.isArray(rule.allow) ? rule.allow : [rule.allow];
    expect(allow).toContain('/api/og/');
    const disallow = Array.isArray(rule.disallow)
      ? rule.disallow
      : [rule.disallow];
    expect(disallow).toContain('/api/');
  });
});
