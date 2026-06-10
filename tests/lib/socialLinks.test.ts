import { describe, it, expect } from 'vitest';
import {
  detectSocialPlatform,
  socialLabelFor,
  socialIconPath,
} from '@/lib/socialLinks';

describe('detectSocialPlatform', () => {
  it('主要 SNS をドメインから判定する', () => {
    expect(detectSocialPlatform('https://x.com/alice')).toBe('x');
    expect(detectSocialPlatform('https://twitter.com/alice')).toBe('x');
    expect(detectSocialPlatform('https://www.instagram.com/alice')).toBe('instagram');
    expect(detectSocialPlatform('https://youtube.com/@alice')).toBe('youtube');
    expect(detectSocialPlatform('https://youtu.be/abc')).toBe('youtube');
    expect(detectSocialPlatform('https://www.tiktok.com/@alice')).toBe('tiktok');
    expect(detectSocialPlatform('https://line.me/R/ti/p/@alice')).toBe('line');
    expect(detectSocialPlatform('https://lin.ee/abc')).toBe('line');
    expect(detectSocialPlatform('https://www.facebook.com/alice')).toBe('facebook');
    expect(detectSocialPlatform('https://github.com/alice')).toBe('github');
    expect(detectSocialPlatform('https://discord.gg/abc')).toBe('discord');
    expect(detectSocialPlatform('https://www.twitch.tv/alice')).toBe('twitch');
    expect(detectSocialPlatform('https://note.com/alice')).toBe('note');
    expect(detectSocialPlatform('https://www.pixiv.net/users/123')).toBe('pixiv');
    expect(detectSocialPlatform('https://www.threads.net/@alice')).toBe('threads');
    expect(detectSocialPlatform('https://threads.com/@alice')).toBe('threads');
    expect(detectSocialPlatform('https://bsky.app/profile/alice.bsky.social')).toBe(
      'bluesky',
    );
    expect(detectSocialPlatform('https://www.linkedin.com/in/alice')).toBe('linkedin');
    expect(detectSocialPlatform('https://lnkd.in/abc')).toBe('linkedin');
    expect(detectSocialPlatform('https://t.me/alice')).toBe('telegram');
    expect(detectSocialPlatform('https://wa.me/810000000000')).toBe('whatsapp');
    expect(detectSocialPlatform('https://www.whatsapp.com/channel/x')).toBe('whatsapp');
    // ニュースレター/ブログ/クリエイター系 (サブドメイン形式の URL も拾う)
    expect(detectSocialPlatform('https://alice.substack.com')).toBe('substack');
    expect(detectSocialPlatform('https://medium.com/@alice')).toBe('medium');
    expect(detectSocialPlatform('https://zenn.dev/alice')).toBe('zenn');
    expect(detectSocialPlatform('https://qiita.com/alice')).toBe('qiita');
    expect(detectSocialPlatform('https://open.spotify.com/artist/abc')).toBe('spotify');
    expect(detectSocialPlatform('https://soundcloud.com/alice')).toBe('soundcloud');
    expect(detectSocialPlatform('https://www.patreon.com/alice')).toBe('patreon');
  });

  it('subdomain は許容・大文字 host は正規化', () => {
    expect(detectSocialPlatform('https://m.youtube.com/@alice')).toBe('youtube');
    expect(detectSocialPlatform('https://X.com/alice')).toBe('x');
  });

  it('似て非なるドメインに釣られない (suffix 偽装)', () => {
    expect(detectSocialPlatform('https://evil-x.com/alice')).toBe('other');
    expect(detectSocialPlatform('https://x.com.evil.example/alice')).toBe('other');
    expect(detectSocialPlatform('https://notgithub.com/alice')).toBe('other');
  });

  it('未知ドメイン / 不正 URL は other', () => {
    expect(detectSocialPlatform('https://example.com/alice')).toBe('other');
    expect(detectSocialPlatform('not a url')).toBe('other');
    expect(detectSocialPlatform('')).toBe('other');
  });
});

describe('socialLabelFor', () => {
  it('既知 SNS はブランド名を返す', () => {
    expect(socialLabelFor('https://x.com/alice')).toBe('X');
    expect(socialLabelFor('https://line.me/abc')).toBe('LINE');
    expect(socialLabelFor('https://github.com/alice')).toBe('GitHub');
  });

  it('未知ドメインは hostname、不正 URL は入力をそのまま返す', () => {
    expect(socialLabelFor('https://example.com/alice')).toBe('example.com');
    expect(socialLabelFor('not a url')).toBe('not a url');
  });
});

describe('socialIconPath', () => {
  it('既知 platform は path data・other は null', () => {
    expect(socialIconPath('x')).toMatch(/^M/);
    expect(socialIconPath('line')).toMatch(/^M/);
    expect(socialIconPath('other')).toBeNull();
  });
});
