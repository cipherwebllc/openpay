// SIWE の cookie で認証する書き込み handler すべてに、共通の CSRF 検査 (lib/net/crossOriginWrite) が
// handler の先頭で効いていることを実ルートで確かめる。
//   - cross-site / same-site (サブドメイン) / Origin 不一致 は 403 で、cookie (セッション) を読まない。
//   - JSON の本文を読む route は text/plain を 415 で返し、cookie を読まない。
//   - 正規の同一 origin の書き込みは検査を通り、従来どおりセッションの読み取りへ進む (回帰)。
// 末尾のフェンスは app/api の route を走査し、cookie を読む書き込み handler がこの表から漏れていないこと
// と、handler 本体で rejectCrossOriginWrite を呼んでいることを検査する (route を足したときの付け忘れを CI で止める)。
// SIWE の nonce/verify/logout は tests/app/api/auth-siwe.test.ts、takedown は hostedTakedown-lua.test.ts でも見る。
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';

const h = vi.hoisted(() => ({ sessionReads: 0 }));

vi.mock('@/app/api/auth/siwe/_session', () => ({
  readSession: async () => {
    h.sessionReads += 1;
    return { status: 'missing' };
  },
  requireSession: async () => {
    h.sessionReads += 1;
    return {
      ok: false,
      response: NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 }),
    };
  },
}));

// 検査より前にある flag OFF / 構成不備の早期 return を外し、正規の要求がセッションの読み取りまで届くようにする。
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      enableUsageFee: true,
      feeReceiverConfigured: true,
      enableCsvPass: true,
      enablePro: true,
      enableX402Facilitator: true,
      enableFreeeSync: true,
      enableHandles: true,
      enableOrderCall: true,
      enableOrderRelay: true,
      enableOrderToken: true,
      enablePushNotify: true,
      pushVapidPublicKey: 'BKtestVapidPublicKey',
      enableShopLive: true,
      enableCreatorStore: true,
      enableTipMessage: true,
    },
  };
});
vi.mock('@/lib/kv', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/kv')>()),
  isKvConfigured: () => true,
}));
vi.mock('@/lib/relay/relayProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/relay/relayProvider')>()),
  PROVIDER: 'self-host',
}));
vi.mock('@/lib/relay/relayGuards', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/relay/relayGuards')>()),
  checkIpRateLimit: async () => true,
  checkReadRateLimit: async () => true,
}));
vi.mock('@/lib/net/clientRateLimit', () => ({
  checkClientIpBucketRateLimit: async () => true,
  checkClientIpPrefixRateLimit: async () => true,
}));
vi.mock('@/lib/logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/logger')>()),
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

type Handler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;
type Case = {
  /** app/api からの route ファイル (フェンスと突き合わせる)。 */
  file: string;
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** 本文を JSON として読む handler か (rejectCrossOriginWrite の json と同じ)。 */
  json: boolean;
  load: () => Promise<Record<string, unknown>>;
  params?: Record<string, string>;
  /** 検査を通った正規の要求の行き先。既定は mock のセッション読み取り (401)。 */
  pass?: { status: number; readsSession: boolean };
};

const CASES: Case[] = [
  { file: 'admin/store/products/[id]/takedown/route.ts', method: 'POST', json: true, params: { id: 'x' },
    load: () => import('@/app/api/admin/store/products/[id]/takedown/route') },
  { file: 'agent/proof/unbind/route.ts', method: 'POST', json: true,
    load: () => import('@/app/api/agent/proof/unbind/route') },
  // verify は本文の形をセッションより先に検査する (不正な本文は 400 malformed)。
  { file: 'agent/proof/verify/route.ts', method: 'POST', json: true, pass: { status: 400, readsSession: false },
    load: () => import('@/app/api/agent/proof/verify/route') },
  { file: 'billing/settle/route.ts', method: 'POST', json: true,
    load: () => import('@/app/api/billing/settle/route') },
  { file: 'csv-pass/relay/route.ts', method: 'POST', json: true,
    load: () => import('@/app/api/csv-pass/relay/route') },
  { file: 'csv-pass/subscribe/route.ts', method: 'POST', json: true,
    load: () => import('@/app/api/csv-pass/subscribe/route') },
  { file: 'facilitator/resources/route.ts', method: 'POST', json: true,
    load: () => import('@/app/api/facilitator/resources/route') },
  { file: 'facilitator/resources/[id]/route.ts', method: 'PATCH', json: true, params: { id: 'x' },
    load: () => import('@/app/api/facilitator/resources/[id]/route') },
  { file: 'facilitator/resources/[id]/route.ts', method: 'DELETE', json: false, params: { id: 'x' },
    load: () => import('@/app/api/facilitator/resources/[id]/route') },
  { file: 'freee/mapping/route.ts', method: 'POST', json: true,
    load: () => import('@/app/api/freee/mapping/route') },
  { file: 'freee/sync/route.ts', method: 'POST', json: true,
    load: () => import('@/app/api/freee/sync/route') },
  { file: 'handle/route.ts', method: 'POST', json: true,
    load: () => import('@/app/api/handle/route') },
  { file: 'handle/[handle]/route.ts', method: 'DELETE', json: false, params: { handle: 'shop' },
    load: () => import('@/app/api/handle/[handle]/route') },
  { file: 'order/calls/route.ts', method: 'POST', json: true,
    load: () => import('@/app/api/order/calls/route') },
  { file: 'order/feed/route.ts', method: 'POST', json: true,
    load: () => import('@/app/api/order/feed/route') },
  { file: 'order/token/route.ts', method: 'POST', json: false,
    load: () => import('@/app/api/order/token/route') },
  { file: 'order/token/route.ts', method: 'DELETE', json: false,
    load: () => import('@/app/api/order/token/route') },
  { file: 'pro/subscribe/route.ts', method: 'POST', json: true,
    load: () => import('@/app/api/pro/subscribe/route') },
  { file: 'push/subscribe/route.ts', method: 'POST', json: true,
    load: () => import('@/app/api/push/subscribe/route') },
  { file: 'push/subscribe/route.ts', method: 'DELETE', json: true,
    load: () => import('@/app/api/push/subscribe/route') },
  { file: 'push/test/route.ts', method: 'POST', json: false,
    load: () => import('@/app/api/push/test/route') },
  { file: 'shop/live/route.ts', method: 'PATCH', json: true,
    load: () => import('@/app/api/shop/live/route') },
  { file: 'store/products/route.ts', method: 'POST', json: true,
    load: () => import('@/app/api/store/products/route') },
  { file: 'store/products/[id]/route.ts', method: 'PATCH', json: true, params: { id: 'x' },
    load: () => import('@/app/api/store/products/[id]/route') },
  { file: 'store/seller/route.ts', method: 'PUT', json: true,
    load: () => import('@/app/api/store/seller/route') },
  { file: 'tip-messages/route.ts', method: 'DELETE', json: false,
    load: () => import('@/app/api/tip-messages/route') },
];

// 別ファイルで同じ検査を確かめている handler (フェンスの対象には含める)。
const COVERED_ELSEWHERE = new Set([
  'auth/siwe/logout/route.ts POST', // tests/app/api/auth-siwe.test.ts
  'auth/siwe/verify/route.ts POST', // tests/app/api/auth-siwe.test.ts
]);

const ORIGIN = 'https://test.local';

function request(c: Case, headers: Record<string, string>): Request {
  const url = `${ORIGIN}/api/${c.file.replace(/\/route\.ts$/, '').replace(/\[(\w+)\]/g, (_m, k: string) => c.params?.[k] ?? k)}`;
  // GET/HEAD 以外は本文を持てる。JSON の handler には JSON の本文、本文を読まない handler には本文を付けない。
  return new Request(url, {
    method: c.method,
    headers,
    ...(c.json ? { body: '{}' } : {}),
  });
}

async function call(c: Case, headers: Record<string, string>): Promise<Response> {
  const mod = await c.load();
  const handler = mod[c.method] as Handler;
  return handler(request(c, headers), { params: Promise.resolve(c.params ?? {}) });
}

const JSON_TYPE = { 'content-type': 'application/json' };

beforeAll(() => {
  vi.stubEnv('ENABLE_AGENT_PURCHASES', '1');
});
afterAll(() => {
  vi.unstubAllEnvs();
});
beforeEach(() => {
  h.sessionReads = 0;
});

describe.each(CASES.map((c) => [`${c.method} /api/${c.file.replace(/\/route\.ts$/, '')}`, c] as const))('%s', (_name, c) => {
  it.each([
    ['cross-site', { 'sec-fetch-site': 'cross-site' }],
    ['same-site (サブドメイン)', { 'sec-fetch-site': 'same-site' }],
    ['Sec-Fetch-Site 無しで Origin がサブドメイン', { origin: 'https://gateway.test.local' }],
  ] as const)('%s は 403 でセッションを読まない', async (_label, site) => {
    const res = await call(c, { ...site, ...JSON_TYPE });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ok: false, error: 'cross_site_request' });
    expect(h.sessionReads).toBe(0);
  });

  if (c.json) {
    it('同一 origin でも text/plain の本文は 415 でセッションを読まない', async () => {
      const res = await call(c, { 'sec-fetch-site': 'same-origin', 'content-type': 'text/plain' });
      expect(res.status).toBe(415);
      expect(await res.json()).toEqual({ ok: false, error: 'unsupported_media_type' });
      expect(h.sessionReads).toBe(0);
    });
  }

  it.each([
    ['Sec-Fetch-Site: same-origin', { 'sec-fetch-site': 'same-origin' }],
    ['Origin 一致 (旧ブラウザ)', { origin: ORIGIN }],
    ['ヘッダ無し (SDK・server 間)', {}],
  ] as const)('正規の %s は検査を通り従来の処理へ進む', async (_label, site) => {
    const res = await call(c, { ...site, ...(c.json ? JSON_TYPE : {}) });
    const pass = c.pass ?? { status: 401, readsSession: true };
    expect(res.status).toBe(pass.status);
    expect(h.sessionReads).toBe(pass.readsSession ? 1 : 0);
  });
});

// ---- フェンス: cookie を読む書き込み handler の付け忘れを検出する ----

const API_DIR = join(process.cwd(), 'app/api');
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
// route ファイルがこれらを参照していれば SIWE の cookie を読む (直接・共有 helper 経由)。
const SESSION_READERS = /\b(requireSession|readSession|purchasesSession|requireStoreSeller|resolveOrderFeedMerchant|sessionCookieName)\b|\bcookies\(\)/;

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return routeFiles(path);
    return name === 'route.ts' ? [path] : [];
  });
}

function writeHandlers(path: string): { method: string; callsCheck: boolean }[] {
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
  const out: { method: string; callsCheck: boolean }[] = [];
  for (const stmt of source.statements) {
    if (!ts.isFunctionDeclaration(stmt) || !stmt.name || !WRITE_METHODS.has(stmt.name.text)) continue;
    if (!stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
    let callsCheck = false;
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'rejectCrossOriginWrite') {
        callsCheck = true;
      }
      ts.forEachChild(node, visit);
    };
    if (stmt.body) visit(stmt.body);
    out.push({ method: stmt.name.text, callsCheck });
  }
  return out;
}

describe('フェンス: SIWE cookie を読む書き込み handler', () => {
  const found = routeFiles(API_DIR)
    .filter((path) => SESSION_READERS.test(readFileSync(path, 'utf8')))
    .flatMap((path) =>
      writeHandlers(path).map((w) => ({ key: `${relative(API_DIR, path)} ${w.method}`, callsCheck: w.callsCheck })),
    );

  it('走査で書き込み handler を見つけられている (フェンス自体の空振り防止)', () => {
    expect(found.length).toBeGreaterThanOrEqual(CASES.length);
  });

  it('すべての handler が本体で rejectCrossOriginWrite を呼ぶ', () => {
    expect(found.filter((f) => !f.callsCheck).map((f) => f.key)).toEqual([]);
  });

  it('すべての handler がこのテストの表 (または別ファイルの検証) に載っている', () => {
    const tabled = new Set([...CASES.map((c) => `${c.file} ${c.method}`), ...COVERED_ELSEWHERE]);
    expect(found.map((f) => f.key).filter((key) => !tabled.has(key))).toEqual([]);
  });
});
