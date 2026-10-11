// lib/net/crossOriginWrite の真理値表。SIWE cookie で認証する書き込み API が handler の先頭で使う共通 CSRF 検査。
// Sec-Fetch-Site があればそれだけで決め (same-origin のみ通す)、無ければ Origin の完全一致、どちらも無ければ通す。
// JSON の本文を読む route は Content-Type: application/json を必須にする。
import { describe, expect, it } from 'vitest';
import { isSameOriginGet, isSameOriginWrite, rejectCrossOriginWrite } from '@/lib/net/crossOriginWrite';

const URL_ = 'https://open-pay.jp/api/handle';

function req(headers: Record<string, string>): Request {
  return new Request(URL_, { method: 'POST', headers });
}

describe('isSameOriginWrite', () => {
  it.each([
    // [説明, headers, 期待]
    ['Sec-Fetch-Site: same-origin', { 'sec-fetch-site': 'same-origin' }, true],
    ['Sec-Fetch-Site: same-site (サブドメイン)', { 'sec-fetch-site': 'same-site' }, false],
    ['Sec-Fetch-Site: cross-site', { 'sec-fetch-site': 'cross-site' }, false],
    ['Sec-Fetch-Site: none', { 'sec-fetch-site': 'none' }, false],
    ['Sec-Fetch-Site: 空文字', { 'sec-fetch-site': '' }, false],
    ['ヘッダ無し (ブラウザ以外の client)', {}, true],
    ['Origin が一致 (Sec-Fetch-Site 無しの旧ブラウザ)', { origin: 'https://open-pay.jp' }, true],
    ['Origin がサブドメイン', { origin: 'https://gateway.open-pay.jp' }, false],
    ['Origin が別 site', { origin: 'https://attacker.example' }, false],
    ['Origin が scheme 違い', { origin: 'http://open-pay.jp' }, false],
    ['Origin が port 違い', { origin: 'https://open-pay.jp:8443' }, false],
    ['Origin: "null"', { origin: 'null' }, false],
    // Sec-Fetch-Site を優先する: no-referrer の same-origin POST は Origin が "null" になるが通す。
    ['same-origin + Origin "null"', { 'sec-fetch-site': 'same-origin', origin: 'null' }, true],
    // Sec-Fetch-Site が拒否なら、Origin が一致していても拒否する。
    ['same-site + Origin 一致', { 'sec-fetch-site': 'same-site', origin: 'https://open-pay.jp' }, false],
    ['cross-site + Origin 一致', { 'sec-fetch-site': 'cross-site', origin: 'https://open-pay.jp' }, false],
  ] as const)('%s → %s', (_label, headers, expected) => {
    expect(isSameOriginWrite(req(headers))).toBe(expected);
  });
});

// cookie で認証する GET (保護配布の ticket 発行) 用。書き込みと同じ順で見るが、Sec-Fetch-Site: none (ブックマーク・
// URL の直打ち) も通す。GET の遷移には Origin が付かないことが多いので、Sec-Fetch-Site も Origin も無ければ通す。
describe('isSameOriginGet', () => {
  it.each([
    ['Sec-Fetch-Site: same-origin (画面のリンク・新しいタブを含む)', { 'sec-fetch-site': 'same-origin' }, true],
    ['Sec-Fetch-Site: none (ブックマーク・URL の直打ち)', { 'sec-fetch-site': 'none' }, true],
    ['Sec-Fetch-Site: same-site (サブドメイン)', { 'sec-fetch-site': 'same-site' }, false],
    ['Sec-Fetch-Site: cross-site', { 'sec-fetch-site': 'cross-site' }, false],
    ['Sec-Fetch-Site: 空文字', { 'sec-fetch-site': '' }, false],
    ['ヘッダ無し (Origin の無い GET の遷移・旧ブラウザ)', {}, true],
    ['Origin が一致 (Sec-Fetch-Site 無し)', { origin: 'https://open-pay.jp' }, true],
    ['Origin がサブドメイン', { origin: 'https://gateway.open-pay.jp' }, false],
    ['Origin が別 site', { origin: 'https://attacker.example' }, false],
    ['Origin: "null"', { origin: 'null' }, false],
    ['same-origin + Origin "null" (no-referrer)', { 'sec-fetch-site': 'same-origin', origin: 'null' }, true],
    ['same-site + Origin 一致', { 'sec-fetch-site': 'same-site', origin: 'https://open-pay.jp' }, false],
    ['cross-site + Origin 一致', { 'sec-fetch-site': 'cross-site', origin: 'https://open-pay.jp' }, false],
  ] as const)('%s → %s', (_label, headers, expected) => {
    expect(isSameOriginGet(new Request(URL_, { headers }))).toBe(expected);
  });
});

describe('rejectCrossOriginWrite', () => {
  async function expectRejected(res: Response | null, status: number, error: string) {
    expect(res).not.toBeNull();
    expect(res!.status).toBe(status);
    expect(res!.headers.get('cache-control')).toBe('private, no-store');
    expect(await res!.json()).toEqual({ ok: false, error });
  }

  it.each(['same-site', 'cross-site', 'none'])('Sec-Fetch-Site: %s は JSON でも 403', async (site) => {
    const res = rejectCrossOriginWrite(
      req({ 'sec-fetch-site': site, 'content-type': 'application/json' }),
      { json: true },
    );
    await expectRejected(res, 403, 'cross_site_request');
  });

  it.each(['https://attacker.example', 'https://sub.open-pay.jp', 'null'])(
    'Sec-Fetch-Site 無しで Origin %s は 403',
    async (origin) => {
      const res = rejectCrossOriginWrite(req({ origin, 'content-type': 'application/json' }), { json: true });
      await expectRejected(res, 403, 'cross_site_request');
    },
  );

  it('origin の判定は Content-Type の判定より先 (別 origin の text/plain は 403)', async () => {
    const res = rejectCrossOriginWrite(
      req({ 'sec-fetch-site': 'same-site', 'content-type': 'text/plain' }),
      { json: true },
    );
    await expectRejected(res, 403, 'cross_site_request');
  });

  describe('json: true', () => {
    it.each([
      'application/json',
      'application/json; charset=utf-8',
      'Application/JSON; charset=UTF-8',
      ' application/json ',
    ])('same-origin の %s は通す', (type) => {
      expect(
        rejectCrossOriginWrite(req({ 'sec-fetch-site': 'same-origin', 'content-type': type }), { json: true }),
      ).toBeNull();
    });

    it('Origin が一致する旧ブラウザの JSON は通す', () => {
      expect(
        rejectCrossOriginWrite(
          req({ origin: 'https://open-pay.jp', 'content-type': 'application/json' }),
          { json: true },
        ),
      ).toBeNull();
    });

    it('ヘッダ無しの JSON (SDK・server 間) は通す', () => {
      expect(rejectCrossOriginWrite(req({ 'content-type': 'application/json' }), { json: true })).toBeNull();
    });

    it.each([
      'text/plain',
      'text/plain; application/json',
      'application/x-www-form-urlencoded',
      'multipart/form-data; boundary=x',
      'application/jsonp',
      'application/json-patch+json',
      '',
    ])('same-origin でも %j は 415', async (type) => {
      const res = rejectCrossOriginWrite(
        req({ 'sec-fetch-site': 'same-origin', 'content-type': type }),
        { json: true },
      );
      await expectRejected(res, 415, 'unsupported_media_type');
    });

    it('Content-Type 無しは既定で 415', async () => {
      const res = rejectCrossOriginWrite(req({ 'sec-fetch-site': 'same-origin' }), { json: true });
      await expectRejected(res, 415, 'unsupported_media_type');
    });

    it('allowMissingContentType なら Content-Type 無しの bodyless POST だけを通す', async () => {
      expect(
        rejectCrossOriginWrite(req({ 'sec-fetch-site': 'same-origin' }), { json: true, allowMissingContentType: true }),
      ).toBeNull();
      expect(rejectCrossOriginWrite(req({}), { json: true, allowMissingContentType: true })).toBeNull();
      // フォームは Content-Type を必ず持つので、allowMissingContentType でも 415。
      await expectRejected(
        rejectCrossOriginWrite(
          req({ 'sec-fetch-site': 'same-origin', 'content-type': 'text/plain' }),
          { json: true, allowMissingContentType: true },
        ),
        415,
        'unsupported_media_type',
      );
      // origin の拒否は allowMissingContentType でも変わらない。
      await expectRejected(
        rejectCrossOriginWrite(req({ 'sec-fetch-site': 'same-site' }), { json: true, allowMissingContentType: true }),
        403,
        'cross_site_request',
      );
    });
  });

  describe('json: false (本文を読まない route)', () => {
    it.each([
      [{ 'sec-fetch-site': 'same-origin' }],
      [{ 'sec-fetch-site': 'same-origin', 'content-type': 'text/plain' }],
      [{ origin: 'https://open-pay.jp' }],
      [{}],
    ])('同一 origin / ヘッダ無しは Content-Type を見ずに通す: %j', (headers) => {
      expect(rejectCrossOriginWrite(req(headers), { json: false })).toBeNull();
    });

    it.each([
      [{ 'sec-fetch-site': 'same-site' }],
      [{ 'sec-fetch-site': 'cross-site' }],
      [{ 'sec-fetch-site': 'none' }],
      [{ origin: 'https://attacker.example' }],
      [{ origin: 'null' }],
    ])('別 origin は 403: %j', async (headers) => {
      await expectRejected(rejectCrossOriginWrite(req(headers), { json: false }), 403, 'cross_site_request');
    });
  });
});
