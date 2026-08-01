// /robots.txt の SNS カード互換フェンス (2026-08-01 本番実害):
// X (Twitterbot) は robots.txt を尊重するため、OG 画像 (/api/og/*) が
// /api/ 一括 disallow に飲まれると X だけカードが出ない。
import { describe, expect, it } from 'vitest';
import robots from '@/app/robots';

describe('robots.txt', () => {
  it('OG 画像 (/api/og/) は allow され、/api/ 一括 disallow より優先される形で明示される', () => {
    const config = robots();
    const rules = Array.isArray(config.rules) ? config.rules : [config.rules];
    const rule = rules.find((r) => r.userAgent === '*');
    if (!rule) throw new Error('missing * rule group');
    const allow = Array.isArray(rule.allow) ? rule.allow : [rule.allow];
    expect(allow).toContain('/api/og/');
    const disallow = Array.isArray(rule.disallow)
      ? rule.disallow
      : [rule.disallow];
    expect(disallow).toContain('/api/');
  });

  it('Twitterbot 専用グループは Disallow を一切持たない (crude parser 対策)', () => {
    const config = robots();
    const rules = Array.isArray(config.rules) ? config.rules : [config.rules];
    const rule = rules.find((r) => r.userAgent === 'Twitterbot');
    if (!rule) throw new Error('missing Twitterbot rule group');
    const allow = Array.isArray(rule.allow) ? rule.allow : [rule.allow];
    expect(allow).toContain('/');
    expect(rule.disallow).toBeUndefined();
  });
});
