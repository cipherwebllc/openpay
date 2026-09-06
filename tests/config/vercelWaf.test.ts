// Cloudflare ヘッダーが無い open-pay.jp 宛てのリクエストだけを deny する設定を固定する。
// Vercel cron の *.vercel.app 宛て呼び出しや、既存のルーティングを巻き込まないためのフェンス。

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

type RouteCondition = { type: string; key?: string; value?: string };
type VercelRoute = {
  src?: string;
  has?: RouteCondition[];
  missing?: RouteCondition[];
  mitigate?: { action: string };
};
type VercelConfig = {
  routes?: VercelRoute[];
  crons?: Array<{ path: string; schedule: string }>;
};

const vercelConfig = JSON.parse(
  readFileSync(resolve(process.cwd(), 'vercel.json'), 'utf8'),
) as VercelConfig;
const routes = vercelConfig.routes ?? [];

describe('vercel.json WAF', () => {
  it('routes は deny ルール 1 件だけ (定義削除・意図しない追加を検出)', () => {
    expect(Array.isArray(vercelConfig.routes)).toBe(true);
    expect(routes).toHaveLength(1);
    expect(routes.filter((route) => route.mitigate?.action === 'deny')).toHaveLength(1);
  });

  it('host は open-pay.jp に限定する (Vercel cron の *.vercel.app は対象外)', () => {
    expect(routes[0]?.has).toEqual([{ type: 'host', value: 'open-pay.jp' }]);
  });

  it('cf-connecting-ip ヘッダーが無いリクエストを対象にする', () => {
    expect(routes[0]?.missing).toEqual([{ type: 'header', key: 'cf-connecting-ip' }]);
  });

  it('src は全パスに一致する PCRE', () => {
    expect(routes[0]?.src).toBe('/(.*)');
  });

  it('WAF 以外のルーティング変更や未対応の action を含まない', () => {
    for (const route of routes) {
      expect(route).not.toHaveProperty('dest');
      // destination 等の別名や headers/status/transforms による挙動変更も禁止。
      expect(Object.keys(route).sort()).toEqual(['has', 'missing', 'mitigate', 'src']);
      expect(['deny', 'challenge']).toContain(route.mitigate?.action);
    }
    for (const key of ['rewrites', 'headers', 'redirects']) {
      expect(vercelConfig).not.toHaveProperty(key);
    }
  });

  it('既存の reverify / store-reconcile cron を維持する', () => {
    expect(Array.isArray(vercelConfig.crons)).toBe(true);
    expect(vercelConfig.crons).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '/api/cron/reverify' }),
      expect.objectContaining({ path: '/api/cron/store-reconcile' }),
    ]));
  });
});
