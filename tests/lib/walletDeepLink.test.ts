import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  metamaskDappLink,
  detectMobilePlatform,
  isMobilePlatform,
} from '@/lib/walletDeepLink';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('metamaskDappLink', () => {
  it('host + pathname + search を順に連結する', () => {
    expect(
      metamaskDappLink({
        host: 'open-pay.jp',
        pathname: '/pay',
        search: '?amount=100',
      }),
    ).toBe('https://metamask.app.link/dapp/open-pay.jp/pay?amount=100');
  });

  it('search が空でも末尾に余計な ? を足さない', () => {
    expect(
      metamaskDappLink({ host: 'open-pay.jp', pathname: '/', search: '' }),
    ).toBe('https://metamask.app.link/dapp/open-pay.jp/');
  });

  it('host にポート / pathname に深い階層を含んでもそのまま連結する', () => {
    expect(
      metamaskDappLink({
        host: 'localhost:3000',
        pathname: '/@alice/tip',
        search: '?token=jpyc',
      }),
    ).toBe('https://metamask.app.link/dapp/localhost:3000/@alice/tip?token=jpyc');
  });
});

describe('detectMobilePlatform', () => {
  // navigator は jsdom default を持つので、UA / maxTouchPoints を stubGlobal で差し替える。
  function stubNavigator(userAgent: string, maxTouchPoints?: number) {
    vi.stubGlobal('navigator', {
      userAgent,
      ...(maxTouchPoints === undefined ? {} : { maxTouchPoints }),
    });
  }

  it('iPhone UA → ios', () => {
    stubNavigator('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)');
    expect(detectMobilePlatform()).toBe('ios');
  });

  it('Android UA → android', () => {
    stubNavigator(
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/129',
    );
    expect(detectMobilePlatform()).toBe('android');
  });

  it('デスクトップ Mac UA (maxTouchPoints=0) → other', () => {
    stubNavigator(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15',
      0,
    );
    expect(detectMobilePlatform()).toBe('other');
  });

  it('iPad の Mac 風 UA + maxTouchPoints=5 → ios', () => {
    stubNavigator(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15',
      5,
    );
    expect(detectMobilePlatform()).toBe('ios');
  });

  it('Mac 風 UA + maxTouchPoints=1 (境界、Mac trackpad 誤検出回避) → other', () => {
    stubNavigator(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15',
      1,
    );
    expect(detectMobilePlatform()).toBe('other');
  });

  it('navigator が undefined (SSR) → other', () => {
    vi.stubGlobal('navigator', undefined);
    expect(detectMobilePlatform()).toBe('other');
  });
});

describe('isMobilePlatform', () => {
  function stubNavigator(userAgent: string, maxTouchPoints?: number) {
    vi.stubGlobal('navigator', {
      userAgent,
      ...(maxTouchPoints === undefined ? {} : { maxTouchPoints }),
    });
  }

  it('iPhone / Android は true', () => {
    stubNavigator('Mozilla/5.0 (iPhone)');
    expect(isMobilePlatform()).toBe(true);
    stubNavigator('Mozilla/5.0 (Linux; Android 14)');
    expect(isMobilePlatform()).toBe(true);
  });

  it('デスクトップ Mac は false', () => {
    stubNavigator(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15',
      0,
    );
    expect(isMobilePlatform()).toBe(false);
  });
});
