// @vitest-environment node
// 第 10 回レビュー D-5: 保護配布の 2 つの route (購入者の /api/store/delivery/<id>・出品者の
// /api/store/products/<id>/delivery-test) は、失敗を、ブラウザのナビゲーションのときだけ案内のページで返す。
// ここで固定すること:
// - ナビゲーションでない要求 (fetch・curl・SDK・agent) への失敗は、本文も header も今までの JSON のまま。
// - 成功 (302・format=json の 200) は、ナビゲーションの header があっても変わらない。
// - ページに入るのは固定の文と固定の path だけ (商品名・URL・id・error の code・要求の header は入らない)。
// mock は境界 (env・session・rate limit・KV・商品と購入記録の読み取り・RPC) だけで、2 つの route と
// lib/store/deliveryFailurePage は実物。
import { NextResponse } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fixture from '@/tests/fixtures/delivery-ticket.v1.json';
import type { StorePurchaseGrant, StorePurchaseOwnership } from '@/lib/x402/storePaymentSnapshot';
import { createLicenseDefinition } from '@/lib/license/definition';

const h = vi.hoisted(() => ({
  parent: true, enabled: true, license: false, session: vi.fn(), ip: vi.fn(), readLimit: vi.fn(),
  own: vi.fn(), product: vi.fn(), content: vi.fn(), rights: vi.fn(), incr: vi.fn(), eval: vi.fn(),
}));
vi.mock('@/lib/env', async (original) => {
  const actual = await original<typeof import('@/lib/env')>();
  return { ...actual, env: { ...actual.env, get enableCreatorStore() { return h.parent; }, get enableStoreDeliveryTicket() { return h.enabled; }, get enableLicenseNft() { return h.license; } } };
});
vi.mock('@/lib/siweSession', () => ({ requireSession: h.session }));
vi.mock('@/lib/net/ipHash', () => ({ clientIp: () => '192.0.2.1', hashIpBucket: () => 'ip-hash' }));
vi.mock('@/lib/relay/relayGuards', () => ({ checkIpRateLimit: h.ip, checkReadRateLimit: h.readLimit }));
vi.mock('@/lib/kv', () => ({ kvIncr: h.incr, kvEval: h.eval }));
vi.mock('@/lib/x402/hostedStore', () => ({ getHostedProduct: h.product, getHostedContent: h.content, isHostedId: (id: string) => /^h_[0-9a-f]{32}$/.test(id) }));
vi.mock('@/lib/x402/storeEntitlement', async (original) => ({ ...await original<typeof import('@/lib/x402/storeEntitlement')>(), readStoreOwnership: h.own }));
vi.mock('@/lib/license/rights', () => ({ resolveLicenseRights: h.rights }));
import { GET as buyerGet } from '@/app/api/store/delivery/[resourceId]/route';
import { GET as sellerGet } from '@/app/api/store/products/[id]/delivery-test/route';
import {
  DELIVERY_FAILURE_COPY, DELIVERY_FAILURE_PAGE_CSP, deliveryFailurePage, failurePageLocale, isDocumentNavigation,
} from '@/lib/store/deliveryFailurePage';
import { deliveryJwks, verifyDeliveryTicket } from '@/lib/store/deliveryTicket';

const ID = fixture.claims.product; const ADDRESS = fixture.claims.sub as `0x${string}`;
const OTHER = '0x1111111111111111111111111111111111111111';
const SALT = ('0x' + 'b'.repeat(64)) as `0x${string}`;
const HOSTILE = '<script>alert(1)</script>';
const definition = createLicenseDefinition(ID, { transferable: true, supply: 10, termsUrl: 'https://seller.example/terms', termsVersion: '1' }, 80002, '0x3333333333333333333333333333333333333333');
const grant: StorePurchaseGrant = {
  intentSalt: SALT, contentRevision: 3, contentRef: `x402:hosted:${ID}:content:3`,
  metadata: { owner: ADDRESS, payTo: ADDRESS, title: 'Purchased', priceJpyc: '300', contentKind: 'text', label: 'prompt' },
  chainId: 80002, nonce: SALT, purchasedAt: 1600000000000, txHash: SALT,
};
const ownership: StorePurchaseOwnership = { version: 1, policy: 'all-purchased-revisions', payer: ADDRESS, resourceId: ID, firstPurchasedAt: grant.purchasedAt, updatedAt: grant.purchasedAt, grants: [grant], latestGrant: grant };
const product = { ...grant.metadata, id: ID, title: 'Current', contentRevision: 9, saleActive: true, contentAvailable: true, createdAt: 1, deliveryUrl: 'https://files.example/gate?part=1' };

// 今のブラウザがリンク・新しいタブ・URL の直打ちに付ける header (Chrome の実物の形)。
const NAVIGATION = {
  'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-User': '?1',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
};
type Audience = 'buyer' | 'seller';
function call(audience: Audience, query = '', headers?: HeadersInit, id = ID): Promise<Response> {
  return audience === 'buyer'
    ? buyerGet(new Request(`https://open-pay.jp/api/store/delivery/${id}${query}`, { headers }), { params: Promise.resolve({ resourceId: id }) })
    : sellerGet(new Request(`https://open-pay.jp/api/store/products/${id}/delivery-test${query}`, { headers }), { params: Promise.resolve({ id }) });
}
const authFailure = (code: string, status: number) => () =>
  h.session.mockImplementation(async () => ({ ok: false, response: NextResponse.json({ ok: false, error: code }, { status }) }));
function licensePurchase() {
  h.license = true;
  h.product.mockResolvedValue({ ...product, productKind: 'license', license: definition, contentRevision: 1 });
  const licenseGrant = { ...grant, contentRevision: 1, contentRef: definition.contentRef, metadata: { ...grant.metadata, productKind: 'license', license: definition } };
  h.own.mockResolvedValue({ ok: true, ownership: { ...ownership, grants: [licenseGrant], latestGrant: licenseGrant } });
}

type Kind = keyof typeof DELIVERY_FAILURE_COPY.ja.buyer.pages;
type Failure = {
  name: string; audience: Audience; status: number; code: string; kind: Kind;
  arrange?: () => void; query?: string; headers?: Record<string, string>; retryAfter?: true;
};
// 2 つの route が返す失敗の全部 (route の return error(...) と requireStoreSeller の 3 つの失敗を上から順に)。
const FAILURES: Failure[] = [
  { name: 'flag OFF', audience: 'buyer', status: 404, code: 'not_found', kind: 'notFound', arrange: () => { h.enabled = false; } },
  { name: 'IP の枠', audience: 'buyer', status: 429, code: 'rate_limited', kind: 'busy', retryAfter: true, arrange: () => { h.ip.mockResolvedValue(false); } },
  { name: 'session なし', audience: 'buyer', status: 401, code: 'unauthenticated', kind: 'signIn', arrange: authFailure('unauthenticated', 401) },
  { name: 'session の storage 障害', audience: 'buyer', status: 503, code: 'session_storage_unavailable', kind: 'unavailable', arrange: authFailure('session_storage_unavailable', 503) },
  { name: 'ウォレットの枠', audience: 'buyer', status: 429, code: 'rate_limited', kind: 'busy', retryAfter: true, arrange: () => { h.readLimit.mockResolvedValue(false); } },
  { name: '別 site からの遷移', audience: 'buyer', status: 403, code: 'cross_site', kind: 'crossSite', headers: { 'Sec-Fetch-Site': 'cross-site' } },
  { name: 'selector が不正', audience: 'buyer', status: 400, code: 'invalid_selector', kind: 'badLink', query: '?revision=bad' },
  { name: 'チケットの枠 (1 分 20 枚)', audience: 'buyer', status: 429, code: 'rate_limited', kind: 'busy', arrange: () => { h.incr.mockResolvedValue({ ok: true, value: 21 }); } },
  { name: 'RPC の枠が取れない', audience: 'buyer', status: 503, code: 'delivery_unavailable', kind: 'unavailable', arrange: () => { h.license = true; h.eval.mockResolvedValue({ ok: false }); } },
  { name: '購入も保有もない', audience: 'buyer', status: 404, code: 'not_found', kind: 'notFound', arrange: () => { h.own.mockResolvedValue({ ok: true, ownership: null }); } },
  { name: '購入記録の storage 障害', audience: 'buyer', status: 503, code: 'storage_unavailable', kind: 'unavailable', arrange: () => { h.own.mockResolvedValue({ ok: false }); } },
  { name: 'ライセンスの権利が不明', audience: 'buyer', status: 503, code: 'license_rights_unknown', kind: 'unavailable', arrange: () => { licensePurchase(); h.rights.mockResolvedValue({ entitled: null, basis: null, nft: { status: 'unknown' } }); } },
  { name: '提供終了', audience: 'buyer', status: 409, code: 'provided_ended', kind: 'ended', arrange: () => { h.product.mockResolvedValue({ ...product, contentAvailable: false }); } },
  { name: '配布先が未設定', audience: 'buyer', status: 409, code: 'delivery_not_configured', kind: 'notConfigured', arrange: () => { h.product.mockResolvedValue({ ...product, deliveryUrl: undefined }); } },
  { name: '署名鍵が未設定', audience: 'buyer', status: 503, code: 'delivery_unavailable', kind: 'unavailable', arrange: () => { vi.stubEnv('STORE_DELIVERY_SIGNING_KEYS', ''); } },
  { name: 'flag OFF', audience: 'seller', status: 404, code: 'not_found', kind: 'notFound', arrange: () => { h.parent = false; } },
  { name: 'IP の枠', audience: 'seller', status: 429, code: 'rate_limited', kind: 'busy', retryAfter: true, arrange: () => { h.ip.mockResolvedValue(false); } },
  { name: 'session なし', audience: 'seller', status: 401, code: 'unauthenticated', kind: 'signIn', arrange: authFailure('unauthenticated', 401) },
  { name: 'session の storage 障害', audience: 'seller', status: 503, code: 'session_storage_unavailable', kind: 'unavailable', arrange: authFailure('session_storage_unavailable', 503) },
  { name: 'ウォレットの枠', audience: 'seller', status: 429, code: 'rate_limited', kind: 'busy', retryAfter: true, arrange: () => { h.readLimit.mockResolvedValue(false); } },
  { name: '別 site からの遷移', audience: 'seller', status: 403, code: 'cross_site', kind: 'crossSite', headers: { 'Sec-Fetch-Site': 'same-site' } },
  { name: 'チケットの枠 (1 分 20 枚)', audience: 'seller', status: 429, code: 'rate_limited', kind: 'busy', arrange: () => { h.incr.mockResolvedValue({ ok: true, value: 21 }); } },
  { name: '商品の storage 障害', audience: 'seller', status: 503, code: 'storage_unavailable', kind: 'unavailable', arrange: () => { h.product.mockResolvedValue('storage'); } },
  { name: '他人の商品', audience: 'seller', status: 404, code: 'not_found', kind: 'notFound', arrange: () => { h.session.mockResolvedValue({ ok: true, address: OTHER }); } },
  { name: '提供終了', audience: 'seller', status: 409, code: 'provided_ended', kind: 'ended', arrange: () => { h.product.mockResolvedValue({ ...product, contentAvailable: false }); } },
  { name: '配布先が未設定', audience: 'seller', status: 409, code: 'delivery_not_configured', kind: 'notConfigured', arrange: () => { h.product.mockResolvedValue({ ...product, deliveryUrl: 'http://files.example/gate' }); } },
  { name: '署名鍵が未設定', audience: 'seller', status: 503, code: 'delivery_unavailable', kind: 'unavailable', arrange: () => { vi.stubEnv('STORE_DELIVERY_SIGNING_KEYS', ''); } },
];
const BACK = { buyer: '/ja/store/library', seller: '/ja/create?tab=profile' } as const;
// 今までの失敗の header (storePrivateJson + PRIVATE_HEADERS・requireStoreSeller の 429 だけ Retry-After)。
const jsonHeaders = (failure: Failure) => [
  ['cache-control', 'private, no-store'], ['content-type', 'application/json'], ['referrer-policy', 'no-referrer'],
  ...(failure.retryAfter ? [['retry-after', '60']] : []), ['vary', 'Cookie'],
];
const entries = (response: Response) => [...response.headers.entries()].sort(([a], [b]) => a.localeCompare(b));
const escaped = (text: string) => text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

beforeEach(() => {
  vi.resetAllMocks(); h.parent = true; h.enabled = true; h.license = false;
  vi.stubEnv('STORE_DELIVERY_SIGNING_KEYS', fixture.seed);
  vi.spyOn(Date, 'now').mockReturnValue(fixture.claims.iat * 1000);
  h.ip.mockResolvedValue(true); h.readLimit.mockResolvedValue(true);
  h.session.mockResolvedValue({ ok: true, address: ADDRESS });
  h.incr.mockResolvedValue({ ok: true, value: 1 }); h.eval.mockResolvedValue({ ok: true, value: 1 });
  h.own.mockResolvedValue({ ok: true, ownership }); h.product.mockResolvedValue(product);
  h.content.mockResolvedValue({ kind: 'text', value: 'Purchased content' });
  h.rights.mockResolvedValue({ entitled: true, basis: 'holder', nft: { status: 'minted' } });
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe.each(FAILURES)('$audience: $name ($status $code)', (failure) => {
  const { audience, status, code, kind } = failure;
  it('ナビゲーションでない要求には、今までの JSON を本文も header も同じまま返す', async () => {
    failure.arrange?.();
    const response = await call(audience, failure.query, failure.headers);
    expect(response.status).toBe(status);
    expect(await response.text()).toBe(JSON.stringify({ ok: false, error: code }));
    expect(entries(response)).toEqual(jsonHeaders(failure));
  });
  it('ブラウザのナビゲーションには、同じ status の案内のページを返す', async () => {
    failure.arrange?.();
    const response = await call(audience, failure.query, { ...NAVIGATION, ...failure.headers });
    expect(response.status).toBe(status);
    // 元の header (no-store・Vary・Referrer-Policy・Retry-After) を引き継ぎ、種類と安全の header だけが変わる。
    expect(entries(response)).toEqual([
      ...jsonHeaders(failure).filter(([name]) => name !== 'content-type'),
      ['content-security-policy', DELIVERY_FAILURE_PAGE_CSP], ['content-type', 'text/html; charset=utf-8'], ['x-content-type-options', 'nosniff'],
    ].sort(([a], [b]) => a.localeCompare(b)));
    const html = await response.text();
    expect(html.startsWith('<!doctype html>\n<html lang="ja">')).toBe(true);
    const copy = DELIVERY_FAILURE_COPY.ja[audience].pages[kind]!;
    expect(html).toContain(`<h1>${escaped(copy.heading)}</h1>`);
    expect(html).toContain(`<p>${escaped(copy.body)}</p>`);
    expect(html).toContain(`<a href="${escaped(BACK[audience])}">${escaped(DELIVERY_FAILURE_COPY.ja[audience].back)}</a>`);
    // JSON の本文・error の code・商品の値は入らない。
    expect(html).not.toContain('"ok"'); expect(html).not.toContain(code);
    expect(html).not.toContain(ID); expect(html).not.toContain('files.example');
  });
});

describe('成功は、ナビゲーションの header があっても変わらない', () => {
  it.each(['buyer', 'seller'] as const)('%s: 302・header・チケットの中身が同じ', async (audience) => {
    const plain = await call(audience); const navigated = await call(audience, '', NAVIGATION);
    const basis = audience === 'buyer' ? 'purchase' : 'seller';
    for (const response of [plain, navigated]) {
      expect(response.status).toBe(302); expect(await response.text()).toBe('');
      expect(entries(response).map(([name]) => name)).toEqual(['cache-control', 'location', 'referrer-policy', 'vary']);
      const location = new URL(response.headers.get('Location')!);
      expect(`${location.origin}${location.pathname}`).toBe('https://files.example/gate');
      const claims = verifyDeliveryTicket(location.searchParams.get('ticket')!, { audience: 'https://files.example', product: ID, keys: deliveryJwks().keys, now: fixture.claims.iat });
      expect(claims).toMatchObject({ sub: ADDRESS, product: ID, basis, aud: 'https://files.example', iat: fixture.claims.iat, exp: fixture.claims.iat + 60 });
    }
  });
  it('buyer: format=json の成功は、ナビゲーションでも 200 の JSON', async () => {
    const response = await call('buyer', '?format=json', NAVIGATION);
    expect(response.status).toBe(200); expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toMatchObject({ ok: true, product: ID, audience: 'https://files.example' });
  });
});

describe('ナビゲーションの判定', () => {
  const limited = () => h.incr.mockResolvedValue({ ok: true, value: 21 });
  const html = 'text/html,application/xhtml+xml,*/*;q=0.8';
  it.each([
    ['header なし (curl・SDK・agent)', {}],
    ['page の fetch (cors・empty)', { 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty', Accept: '*/*' }],
    ['Accept: text/html だけ (Fetch Metadata の無い古いブラウザ・curl -H)', { Accept: html }],
    ['navigate + document だが Accept に text/html が無い', { 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document', Accept: 'application/json, */*' }],
    ['navigate だが Accept が無い', { 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' }],
    ['navigate だが dest が iframe', { 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'iframe', Accept: html }],
    ['navigate だが dest が無い', { 'Sec-Fetch-Mode': 'navigate', Accept: html }],
    ['dest は document だが mode が cors', { 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'document', Accept: html }],
    ['dest は document だが mode が無い', { 'Sec-Fetch-Dest': 'document', Accept: html }],
  ] as const)('%s → JSON のまま', async (_label, headers) => {
    for (const audience of ['buyer', 'seller'] as const) {
      limited();
      const response = await call(audience, '', headers);
      expect(response.status).toBe(429); expect(response.headers.get('content-type')).toBe('application/json');
      expect(await response.text()).toBe('{"ok":false,"error":"rate_limited"}');
    }
  });
  it.each([
    ['リンク・新しいタブ (same-origin)', NAVIGATION],
    ['URL の直打ち・ブックマーク (none)', { ...NAVIGATION, 'Sec-Fetch-Site': 'none' }],
    ['Accept の大文字と q つき', { 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document', Accept: 'application/xml;q=0.9, Text/HTML;q=0.8' }],
  ] as const)('%s → ページ', async (_label, headers) => {
    limited();
    const response = await call('buyer', '', headers);
    expect(response.status).toBe(429); expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
  });
  it('format を付けた要求は JSON を選んでいるので、ナビゲーションでも失敗は JSON のまま', async () => {
    limited();
    const counted = await call('buyer', '?format=json', NAVIGATION);
    expect(counted.status).toBe(429); expect(await counted.text()).toBe('{"ok":false,"error":"rate_limited"}');
    const invalid = await call('buyer', '?format=xml', NAVIGATION);
    expect(invalid.status).toBe(400); expect(await invalid.text()).toBe('{"ok":false,"error":"invalid_format"}');
    expect(isDocumentNavigation(new Request('https://open-pay.jp/x?format=', { headers: NAVIGATION }))).toBe(false);
    expect(isDocumentNavigation(new Request('https://open-pay.jp/x?revision=3', { headers: NAVIGATION }))).toBe(true);
  });
});

describe('ページに、利用者・出品者・要求の文字列を入れない', () => {
  const hostileHeaders = {
    ...NAVIGATION, Referer: `https://open-pay.jp/ja/store/library?x=${HOSTILE}`, 'X-Forwarded-Host': 'evil.example',
    'Accept-Language': `${HOSTILE},ja`, Cookie: `NEXT_LOCALE=${HOSTILE}; other=//evil.example`,
  };
  async function page(response: Response, status: number): Promise<string> {
    expect(response.status).toBe(status); expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    const html = await response.text();
    // 固定の <style> 1 つと固定のリンク 1 つだけ。script・外部の読み込み・form は無い。
    expect(html).not.toMatch(/<script|<img|<link|<iframe|<form|<base|javascript:|evil\.example|alert\(1\)/i);
    expect(html.match(/<a /g)).toHaveLength(1); expect(html.match(/<style>/g)).toHaveLength(1);
    expect(html).toContain(`<meta http-equiv="Content-Security-Policy" content="${escaped(DELIVERY_FAILURE_PAGE_CSP)}">`);
    expect(html).toContain('<meta name="referrer" content="no-referrer">');
    return html;
  }
  it.each(['buyer', 'seller'] as const)('%s: 商品名と配布先 URL に script を入れた商品 (409)', async (audience) => {
    h.product.mockResolvedValue({ ...product, title: HOSTILE, label: HOSTILE, deliveryUrl: `https://files.example/#${HOSTILE}` });
    const html = await page(await call(audience, '', hostileHeaders), 409);
    expect(html).toContain(`<h1>${escaped(DELIVERY_FAILURE_COPY.ja[audience].pages.notConfigured!.heading)}</h1>`);
  });
  it.each(['buyer', 'seller'] as const)('%s: path の id に script (404)', async (audience) => {
    h.own.mockResolvedValue({ ok: true, ownership: null }); h.product.mockResolvedValue(null);
    await page(await call(audience, '', hostileHeaders, encodeURIComponent(`"><script>alert(1)</script>`)), 404);
  });
  it('buyer: query に script (400)', async () => {
    await page(await call('buyer', `?revision=${encodeURIComponent(HOSTILE)}&intentSalt=${encodeURIComponent('"><img src=x>')}`, hostileHeaders), 400);
  });
  it.each(['buyer', 'seller'] as const)('%s: 認証の応答の error に script が入っていても、code は写さない (401)', async (audience) => {
    authFailure(HOSTILE, 401)();
    const html = await page(await call(audience, '', hostileHeaders), 401);
    expect(html).toContain(`<h1>${escaped(DELIVERY_FAILURE_COPY.ja[audience].pages.signIn!.heading)}</h1>`);
  });
  it('戻るリンクは自分の origin の固定の path (locale × 購入者 / 出品者 の 4 通りだけ)', async () => {
    const hrefs = new Set<string>();
    for (const audience of ['buyer', 'seller'] as const) {
      for (const language of ['ja', 'en', HOSTILE, '//evil.example', '']) {
        h.incr.mockResolvedValue({ ok: true, value: 21 });
        const html = await page(await call(audience, '', { ...hostileHeaders, 'Accept-Language': language, Cookie: `NEXT_LOCALE=${language}` }), 429);
        hrefs.add(/<a href="([^"]*)">/.exec(html)![1]);
      }
    }
    expect([...hrefs].sort()).toEqual(['/en/create?tab=profile', '/en/store/library', '/ja/create?tab=profile', '/ja/store/library']);
  });
});

describe('ページの言語', () => {
  const request = (headers: Record<string, string>) => new Request('https://open-pay.jp/api/store/delivery/x', { headers });
  it.each([
    ['何も無ければ既定の ja', {}, 'ja'],
    ['Accept-Language が en', { 'Accept-Language': 'en-US,en;q=0.9' }, 'en'],
    ['Accept-Language が ja', { 'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8' }, 'ja'],
    ['q の大きい方 (並び順ではない)', { 'Accept-Language': 'fr,en;q=0.8,ja;q=0.9' }, 'ja'],
    ['q=0 (受け付けない) の言語は選ばず、既定へ', { 'Accept-Language': 'en;q=0, fr' }, 'ja'],
    ['対応しない言語だけなら既定', { 'Accept-Language': 'fr-FR,de;q=0.9' }, 'ja'],
    ['NEXT_LOCALE cookie (利用者が切り替えた言語) が先', { 'Accept-Language': 'ja', Cookie: 'a=1; NEXT_LOCALE=en; b=2' }, 'en'],
    ['一覧に無い cookie は使わず Accept-Language へ', { 'Accept-Language': 'en', Cookie: 'NEXT_LOCALE=fr' }, 'en'],
  ] as const)('%s', (_label, headers, locale) => {
    expect(failurePageLocale(request(headers))).toBe(locale);
  });
  it.each(['buyer', 'seller'] as const)('%s: en のページは en の文と /en の戻る先', async (audience) => {
    h.session.mockResolvedValue({ ok: false, response: NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 }) });
    const html = await (await call(audience, '', { ...NAVIGATION, 'Accept-Language': 'en-US,en;q=0.9' })).text();
    const copy = DELIVERY_FAILURE_COPY.en[audience];
    expect(html.startsWith('<!doctype html>\n<html lang="en">')).toBe(true);
    expect(html).toContain(`<title>${escaped(copy.pages.signIn!.heading)} · OpenPay</title>`);
    expect(html).toContain(`<p>${escaped(copy.pages.signIn!.body)}</p>`);
    expect(html).toContain(`<a href="${audience === 'buyer' ? '/en/store/library' : '/en/create?tab=profile'}">${escaped(copy.back)}</a>`);
  });
});

describe('差し替えない応答は、受け取った応答そのもの', () => {
  const navigation = () => new Request('https://open-pay.jp/api/store/delivery/x', { headers: NAVIGATION });
  it('成功 (302・200) はナビゲーションでも同じ object を返す', async () => {
    const redirect = new NextResponse(null, { status: 302, headers: { Location: 'https://files.example/gate?ticket=t' } });
    expect(await deliveryFailurePage(navigation(), redirect, 'buyer')).toBe(redirect);
    const ok = NextResponse.json({ ok: true, ticket: 't' });
    expect(await deliveryFailurePage(navigation(), ok, 'buyer')).toBe(ok);
  });
  it('ナビゲーションでない要求の失敗は同じ object を返す', async () => {
    const failure = NextResponse.json({ ok: false, error: 'rate_limited' }, { status: 429 });
    expect(await deliveryFailurePage(new Request('https://open-pay.jp/api/store/delivery/x'), failure, 'buyer')).toBe(failure);
  });
  it.each([
    [409, 'some_other_conflict', 'buyer'], [409, undefined, 'seller'], [500, 'internal', 'buyer'], [405, 'method_not_allowed', 'seller'],
    // 出品者の route は 400 を返さないので、出品者の 400 の文は無い。
    [400, 'invalid_selector', 'seller'],
  ] as const)('表に無い失敗 (%s %s・%s) は同じ object を返し、本文も読める', async (status, error, audience) => {
    const failure = NextResponse.json({ ok: false, error }, { status });
    const result = await deliveryFailurePage(navigation(), failure, audience);
    expect(result).toBe(failure); expect(await result.json()).toEqual({ ok: false, error });
  });
});

describe('公開文言の表', () => {
  it('ja / en は、購入者・出品者ごとに同じ種類のページを持つ', () => {
    for (const audience of ['buyer', 'seller'] as const) {
      expect(Object.keys(DELIVERY_FAILURE_COPY.en[audience].pages).sort()).toEqual(Object.keys(DELIVERY_FAILURE_COPY.ja[audience].pages).sort());
    }
    expect(Object.keys(DELIVERY_FAILURE_COPY.ja.buyer.pages).sort()).toEqual(['badLink', 'busy', 'crossSite', 'ended', 'notConfigured', 'notFound', 'signIn', 'unavailable']);
    expect(Object.keys(DELIVERY_FAILURE_COPY.ja.seller.pages).sort()).toEqual(['busy', 'crossSite', 'ended', 'notConfigured', 'notFound', 'signIn', 'unavailable']);
  });
  it('文は空でなく、約束 (必ず・自動)・連絡先 (メールアドレス・URL) を書かない', () => {
    for (const locale of ['ja', 'en'] as const) {
      for (const audience of ['buyer', 'seller'] as const) {
        const copy = DELIVERY_FAILURE_COPY[locale][audience];
        for (const text of [copy.back, ...Object.values(copy.pages).flatMap((page) => [page.heading, page.body])]) {
          expect(text.trim()).toBe(text); expect(text.length).toBeGreaterThan(0);
          expect(text).not.toMatch(/必ず|自動|@|https?:|always|automatic|guarantee/i);
        }
      }
    }
  });
});
