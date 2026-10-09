import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MAX_CONCURRENCY,
  MAX_PRODUCTION_CONCURRENCY,
  PRODUCTION_HOSTS,
  parseArgs,
} from '../../scripts/load-test.mjs';

// 第 7 回レビュー E20: 使用例をそのまま実行すると本番 (Cloudflare の /api rate limit・Upstash の
// コマンド予算・Coinbase 取得) に並列 50 で負荷をかける。本番 origin は明示フラグが無ければ拒否し、
// 並列数に上限を置く。
describe('load-test production guard', () => {
  it('names the production hosts', () => {
    expect([...PRODUCTION_HOSTS].sort()).toEqual(['open-pay.jp', 'www.open-pay.jp']);
    expect(MAX_PRODUCTION_CONCURRENCY).toBeLessThan(MAX_CONCURRENCY);
  });

  it.each([
    'https://open-pay.jp',
    'https://open-pay.jp/',
    'https://www.open-pay.jp',
    'HTTPS://OPEN-PAY.JP',
    'https://open-pay.jp:443',
    // Codex レビュー (PR #778) 7: FQDN の末尾ドットは同じホストに解決される。
    'https://open-pay.jp.',
    'https://www.open-pay.jp./',
    'HTTPS://OPEN-PAY.JP.:443/ja',
  ])('refuses %s without --allow-prod', (url) => {
    expect(() => parseArgs(['--url', url])).toThrow(/--allow-prod/);
  });

  it('caps production concurrency for the trailing-dot spelling too', () => {
    expect(() => parseArgs(['--url', 'https://open-pay.jp.', '--allow-prod', '-c', String(MAX_PRODUCTION_CONCURRENCY + 1)]))
      .toThrow(new RegExp(`--concurrency .*${MAX_PRODUCTION_CONCURRENCY}`));
  });

  it('accepts the production origin with --allow-prod and a small concurrency', () => {
    const opts = parseArgs(['--url', 'https://open-pay.jp/', '--allow-prod', '-c', String(MAX_PRODUCTION_CONCURRENCY)]);
    expect(opts.url).toBe('https://open-pay.jp');
    expect(opts.allowProd).toBe(true);
    expect(opts.concurrency).toBe(MAX_PRODUCTION_CONCURRENCY);
  });

  it('caps production concurrency even with --allow-prod', () => {
    expect(() => parseArgs(['--url', 'https://open-pay.jp', '--allow-prod', '-c', String(MAX_PRODUCTION_CONCURRENCY + 1)]))
      .toThrow(new RegExp(`--concurrency .*${MAX_PRODUCTION_CONCURRENCY}`));
  });

  it('uses a production-safe default concurrency when --allow-prod is given without -c', () => {
    const opts = parseArgs(['--url', 'https://open-pay.jp', '--allow-prod']);
    expect(opts.concurrency).toBeLessThanOrEqual(MAX_PRODUCTION_CONCURRENCY);
  });

  it.each([
    'http://localhost:3000',
    'http://127.0.0.1:3130',
    'https://openpay-git-feature-example.vercel.app',
    'https://open-pay.jp.evil.example',
    'https://staging.open-pay.jp',
  ])('does not treat %s as production', (url) => {
    const opts = parseArgs(['--url', url, '-c', String(MAX_CONCURRENCY)]);
    expect(opts.allowProd).toBe(false);
    expect(opts.concurrency).toBe(MAX_CONCURRENCY);
  });

  it('caps concurrency for every target', () => {
    expect(() => parseArgs(['--url', 'http://localhost:3000', '-c', String(MAX_CONCURRENCY + 1)]))
      .toThrow(new RegExp(`--concurrency .*${MAX_CONCURRENCY}`));
  });

  it('rejects a target that is not an http(s) URL', () => {
    expect(() => parseArgs(['--url', 'open-pay.jp'])).toThrow(/--url/);
    expect(() => parseArgs(['--url', 'ftp://open-pay.jp'])).toThrow(/--url/);
  });

  it('keeps the existing option parsing', () => {
    const opts = parseArgs(['--url', 'http://localhost:3000/', '-c', '4', '-d', '2', '--max-error-rate', '0.5', '--max-p99-ms', '900', '--pay-to', '0xabc']);
    expect(opts).toMatchObject({ url: 'http://localhost:3000', concurrency: 4, duration: 2, maxErrorRate: 0.5, maxP99Ms: 900, payTo: '0xabc', allowProd: false });
    expect(() => parseArgs(['-c', '0'])).toThrow(/--concurrency/);
    expect(() => parseArgs(['-d', '0'])).toThrow(/--duration/);
  });

  it('exits 2 before any request when run against production without --allow-prod', () => {
    const result = spawnSync(process.execPath, [resolve('scripts/load-test.mjs'), '--url', 'https://open-pay.jp', '-c', '50', '-d', '30'], {
      encoding: 'utf8',
      timeout: 20_000,
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('--allow-prod');
    // probe (最初の fetch) に到達していない = 本番へ 1 リクエストも出していない
    expect(result.stdout).not.toContain('probe');
  });
});
