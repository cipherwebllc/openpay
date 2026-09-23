// next.config.mjs の frame 保護ヘッダー方針のフェンス。
// - /tip (ja/en) のみ iframe 埋め込み許可 (frame-ancestors *)
// - それ以外の全ページは default-deny (frame-ancestors 'self' + X-Frame-Options SAMEORIGIN)
// - 2 ルールは排他 (tip に X-Frame-Options が付くと CSP を見ない古い実装で埋め込みが壊れる)
import { afterEach, describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { getPathMatch } from 'next/dist/shared/lib/router/utils/path-match';
import * as chains from 'viem/chains';
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
    const deny = rules.find((r) => r.headers.some((h) => h.key === 'X-Frame-Options'));
    expect(deny).toBeDefined();
    expect(deny!.headers).toEqual([
      { key: 'Content-Security-Policy', value: "frame-ancestors 'self'" },
      { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
    ]);
  });

  it('default-deny の source regex は tip 配下だけを除外する (排他性)', async () => {
    const rules = await loadRules();
    const deny = rules.find((r) => r.headers.some((h) => h.key === 'X-Frame-Options'))!;
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

async function baselineHeaders() {
  const rules = await loadRules();
  const baseline = rules.find((rule) => rule.source === '/:path*');
  expect(baseline, 'baseline headers must cover pages, APIs and static assets').toBeDefined();
  return new Map(baseline!.headers.map(({ key, value }) => [key, value]));
}

async function reportOnlyDirectives() {
  const headers = await baselineHeaders();
  const policy = headers.get('Content-Security-Policy-Report-Only');
  expect(policy).toBeDefined();
  return new Map(policy!.split(';').filter((part) => part.trim()).map((part) => {
    const [name, ...sources] = part.trim().split(/\s+/);
    return [name, sources];
  }));
}

async function headersForPath(path: string) {
  const rules = await loadRules();
  return new Map(rules.filter((rule) => getPathMatch(rule.source)(path)).flatMap(
    (rule) => rule.headers.map(({ key, value }) => [key, value] as const),
  ));
}

afterEach(() => vi.unstubAllEnvs());

describe('next.config.mjs headers() — baseline and report-only CSP (C17)', () => {
  it('sets nosniff and the default referrer policy', async () => {
    const headers = await baselineHeaders();
    expect(headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
  });

  it('preserves no-referrer on sensitive delivery routes after all matching header rules', async () => {
    for (const path of ['/api/store/delivery/resource-id', '/api/store/delivery/']) {
      expect((await headersForPath(path)).get('Referrer-Policy')).toBe('no-referrer');
    }
    for (const path of ['/', '/ja/pay', '/en/tip/0xabc', '/api/store/delivery-other', '/_next/static/chunk.js']) {
      const headers = await headersForPath(path);
      expect(headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
      expect(headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(headers.has('Content-Security-Policy-Report-Only')).toBe(true);
      expect(headers.get('Content-Security-Policy')).toBe(
        path === '/en/tip/0xabc' ? 'frame-ancestors *' : "frame-ancestors 'self'",
      );
      expect(headers.get('X-Frame-Options')).toBe(path === '/en/tip/0xabc' ? undefined : 'SAMEORIGIN');
    }
  });

  it('keeps the QR camera on self while denying unused powerful features', async () => {
    const headers = await baselineHeaders();
    expect(headers.get('Permissions-Policy')).toBe(
      'camera=(self), microphone=(), geolocation=(), display-capture=()',
    );
  });

  it('adds only report-only resource restrictions, leaving enforced framing and platform HSTS alone', async () => {
    const headers = await baselineHeaders();
    expect(headers.has('Content-Security-Policy')).toBe(false);
    expect(headers.has('X-Frame-Options')).toBe(false);
    expect(headers.has('Strict-Transport-Security')).toBe(false);
    const csp = await reportOnlyDirectives();
    expect(csp.get('default-src')).toEqual(["'self'"]);
    expect(csp.get('object-src')).toEqual(["'none'"]);
    expect(csp.get('base-uri')).toEqual(["'self'"]);
    expect(csp.get('form-action')).toEqual(["'self'"]);
    expect(csp.has('frame-ancestors')).toBe(false);
    expect(csp.has('report-uri')).toBe(false);
    expect(csp.has('report-to')).toBe(false);
  });

  it('observes inline/eval scripts in production without nonces or dynamic rendering', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const csp = await reportOnlyDirectives();
    expect(csp.get('script-src')).toEqual(["'self'"]);
    expect(csp.get('script-src-attr')).toEqual(["'none'"]);
  });

  it('allows Next dev eval and the Vercel debug script only in development', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const csp = await reportOnlyDirectives();
    expect(csp.get('script-src')).toEqual([
      "'self'", "'unsafe-eval'", 'https://va.vercel-scripts.com',
    ]);
  });

  it('covers every configured viem default RPC plus local chain definitions and Ethereum fallbacks', async () => {
    const csp = await reportOnlyDirectives();
    const source = readFileSync('lib/chains.ts', 'utf8');
    const imported = source.match(/import \{([\s\S]*?)\} from 'viem\/chains'/)![1];
    for (const name of imported.split(',').map((part) => part.trim().split(' as ')[0]).filter(Boolean)) {
      if (['mainnet', 'sepolia', 'arc', 'arcTestnet'].includes(name)) continue;
      const chain = chains[name as keyof typeof chains];
      for (const rpc of chain.rpcUrls.default.http) {
        expect(csp.get('connect-src'), name).toContain(new URL(rpc).origin);
      }
    }
    for (const origin of [
      'https://rpc.mainnet.arc.io', 'https://rpc.testnet.arc.io',
      'https://rpc.hyperliquid-testnet.xyz', 'https://eth.llamarpc.com',
      'https://ethereum-rpc.publicnode.com', 'https://ethereum-sepolia-rpc.publicnode.com',
      'https://rpc.ankr.com',
    ]) expect(csp.get('connect-src')).toContain(origin);
  });

  it('covers wallet connections, Pimlico and both Circle environments without broad connect wildcards', async () => {
    const csp = await reportOnlyDirectives();
    const connect = csp.get('connect-src');
    for (const origin of [
      'wss://relay.walletconnect.org', 'https://rpc.walletconnect.org',
      'https://pulse.walletconnect.org', 'https://api.web3modal.org',
      'https://verify.walletconnect.org', 'https://verify.walletconnect.com',
      'https://echo.walletconnect.com', 'https://www.walletlink.org',
      'wss://www.walletlink.org', 'https://rpc.wallet.coinbase.com',
      'https://cca-lite.coinbase.com', 'https://api.pimlico.io',
      'https://gateway-api.circle.com', 'https://gateway-api-testnet.circle.com',
      'https://iris-api.circle.com', 'https://iris-api-sandbox.circle.com',
    ]) expect(connect).toContain(origin);
    expect(connect).not.toContain('*');
    expect(connect).not.toContain('https:');
  });

  it('allows every rebuilt handle iframe origin and WalletConnect verification frames', async () => {
    const csp = await reportOnlyDirectives();
    const source = readFileSync('lib/handle.ts', 'utf8');
    const origins = [...source.matchAll(/src: `((https:\/\/)[^/]+)/g)].map((match) => match[1]);
    expect(origins).toHaveLength(9);
    for (const origin of [...origins, 'https://verify.walletconnect.org', 'https://verify.walletconnect.com', 'https://secure.walletconnect.org']) {
      expect(csp.get('frame-src')).toContain(origin);
    }
  });

  it('supports third-party HTTPS images, QR blob workers and self-hosted Google Fonts', async () => {
    const csp = await reportOnlyDirectives();
    expect(csp.get('img-src')).toEqual(["'self'", 'https:', 'data:', 'blob:']);
    expect(csp.get('worker-src')).toEqual(["'self'", 'blob:']);
    expect(csp.get('font-src')).toEqual(["'self'"]);
    expect(csp.get('style-src')).toEqual(["'self'", "'unsafe-inline'"]);
  });

  it('adds only origins from public RPC/DSN settings, never credentials, paths or query tokens', async () => {
    vi.stubEnv('NEXT_PUBLIC_BASE_RPC_URL', 'https://user:secret@rpc.example.test/v2/key?token=private#fragment');
    vi.stubEnv('NEXT_PUBLIC_SENTRY_DSN', 'https://public-key@o123.ingest.us.sentry.io/456');
    vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://server-only.example.test');
    const connect = (await reportOnlyDirectives()).get('connect-src')!;
    expect(connect).toContain('https://rpc.example.test');
    expect(connect).toContain('https://o123.ingest.us.sentry.io');
    expect(connect.join(' ')).not.toMatch(/secret|private|public-key|server-only|fragment|\/v2\/|\/456/);
  });

  it('accepts underscores in configured host origins without exposing URL credentials or tokens', async () => {
    vi.stubEnv('NEXT_PUBLIC_BASE_RPC_URL', 'https://user:secret@rpc_primary.example.test:8545/v2/key?token=private');
    vi.stubEnv('NEXT_PUBLIC_SENTRY_DSN', 'https://public-key@o_123.ingest.sentry.io/456');
    const connect = (await reportOnlyDirectives()).get('connect-src')!;
    expect(connect).toContain('https://rpc_primary.example.test:8545');
    expect(connect).toContain('https://o_123.ingest.sentry.io');
    expect(connect.join(' ')).not.toMatch(/user:|secret|private|public-key|\/v2\/|\/456/);
  });

  it('isolates invalid optional origins from response headers and page delivery', async () => {
    vi.stubEnv('NEXT_PUBLIC_BASE_RPC_URL', 'not a URL');
    vi.stubEnv('NEXT_PUBLIC_POLYGON_RPC_URL', 'https://rpc.example;script-src');
    vi.stubEnv('NEXT_PUBLIC_SENTRY_DSN', 'data:text/plain,hello');
    const csp = await reportOnlyDirectives();
    expect(csp.get('connect-src')!.join(' ')).not.toMatch(/not a URL|script-src|data:/);
  });
});
