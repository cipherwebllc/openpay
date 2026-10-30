// lib/typeGuards.ts の判定の意味を固定する (全レビュー第 8 回 F-6 / PR-17)。
// 集める前の複製 (lib/agent/activityServer.ts の isRecord・lib/handle/schema.ts / lib/handlePublish.ts /
// components/x402/discoveryDisplay.tsx の isHttpsUrl) と同じ入出力であることが、寄せたことの前提。
// 寄せなかった別の判定 (lib/mobileOrder.ts の正規表現版 isHttpsUrl 等) と分かれる入力もここで固定する。
import { describe, it, expect } from 'vitest';
import { isHttpsUrl, isRecord } from '@/lib/typeGuards';

describe('isRecord', () => {
  it('ふつうの object は true', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
  });

  it('配列は object でも false (配列を record に数えない)', () => {
    expect(isRecord([])).toBe(false);
    expect(isRecord([1, 2])).toBe(false);
    expect(isRecord(new Array(3))).toBe(false);
  });

  it('null・undefined・primitive は false', () => {
    expect(isRecord(null)).toBe(false);
    expect(isRecord(undefined)).toBe(false);
    expect(isRecord('{}')).toBe(false);
    expect(isRecord(0)).toBe(false);
    expect(isRecord(true)).toBe(false);
    expect(isRecord(Symbol('x'))).toBe(false);
    expect(isRecord(10n)).toBe(false);
  });

  it('関数は false (typeof が function)', () => {
    expect(isRecord(() => ({}))).toBe(false);
  });

  it('prototype は見ない: null prototype・Date・Map・typed array も true', () => {
    expect(isRecord(Object.create(null))).toBe(true);
    expect(isRecord(new Date(0))).toBe(true);
    expect(isRecord(new Map())).toBe(true);
    expect(isRecord(new Uint8Array(1))).toBe(true);
  });

  it('JSON.parse の結果: object だけ true', () => {
    expect(isRecord(JSON.parse('{"result":[]}'))).toBe(true);
    expect(isRecord(JSON.parse('[]'))).toBe(false);
    expect(isRecord(JSON.parse('null'))).toBe(false);
    expect(isRecord(JSON.parse('"x"'))).toBe(false);
  });
});

describe('isHttpsUrl', () => {
  it('https の URL は true (scheme の大文字小文字は問わない)', () => {
    expect(isHttpsUrl('https://example.com')).toBe(true);
    expect(isHttpsUrl('https://example.com/path?q=1#h')).toBe(true);
    expect(isHttpsUrl('HTTPS://EXAMPLE.COM')).toBe(true);
  });

  it('http: は false (https だけ)', () => {
    expect(isHttpsUrl('http://example.com')).toBe(false);
    expect(isHttpsUrl('HTTP://example.com')).toBe(false);
  });

  it('javascript:・data:・他の scheme は false', () => {
    expect(isHttpsUrl('javascript:alert(1)')).toBe(false);
    expect(isHttpsUrl('data:text/html,<b>x</b>')).toBe(false);
    expect(isHttpsUrl('wss://example.com')).toBe(false);
    expect(isHttpsUrl('ftp://example.com')).toBe(false);
  });

  it('URL として読めないものは false (空・相対・host なし・host に空白)', () => {
    expect(isHttpsUrl('')).toBe(false);
    expect(isHttpsUrl('example.com')).toBe(false);
    expect(isHttpsUrl('/relative/path')).toBe(false);
    expect(isHttpsUrl('https://')).toBe(false);
    expect(isHttpsUrl('https://exa mple.com')).toBe(false);
    expect(isHttpsUrl('https://%')).toBe(false);
  });

  it('host 末尾のドット・port・userinfo・IPv6 は拒否しない', () => {
    expect(isHttpsUrl('https://example.com.')).toBe(true);
    expect(isHttpsUrl('https://example.com:8443/x')).toBe(true);
    expect(isHttpsUrl('https://user:pass@example.com')).toBe(true);
    expect(isHttpsUrl('https://[::1]/')).toBe(true);
  });

  it('URL parser の寛容さをそのまま使う: 前後の空白・スラッシュ不足・path の空白も true', () => {
    // lib/mobileOrder.ts の isHttpsUrl (/^https:\/\/\S+$/i) はこれらを false にする別の判定。
    expect(isHttpsUrl('  https://example.com  ')).toBe(true);
    expect(isHttpsUrl('\thttps://example.com\n')).toBe(true);
    expect(isHttpsUrl('https:example.com')).toBe(true);
    expect(isHttpsUrl('https:/example.com')).toBe(true);
    expect(isHttpsUrl('https://example.com/a b')).toBe(true);
  });

  it('長さの上限は持たない (上限は呼び出し側が先に見る)', () => {
    expect(isHttpsUrl(`https://example.com/${'a'.repeat(4096)}`)).toBe(true);
  });
});
