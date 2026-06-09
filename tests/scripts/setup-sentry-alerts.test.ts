// scripts/setup-sentry-alerts.mjs の unit test。
// API 通信を実発火しないように、buildRulePayload と RULES の静的シェイプを検証する。
// main() の挙動 (リスト → 冪等 skip → 作成) は fetch を mock した integration として
// このファイル内で完結検証する。

import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import {
  RULES,
  buildRulePayload,
  type AlertRule,
} from '../../scripts/setup-sentry-alerts.mjs';

describe('setup-sentry-alerts: RULES schema', () => {
  it('14 個の rule 定義が存在 (payment / smart-account / x402 / history.load / localStorage.set / cross-chain×2 / a1 billing×7)', () => {
    expect(RULES).toHaveLength(14);
    const tags = RULES.map((r) => r.eventTag);
    expect(tags).toContain('payment.failed');
    expect(tags).toContain('smart-account.init-failed');
    expect(tags).toContain('x402.middleware.error');
    expect(tags).toContain('history.load.invalid-entries-dropped');
    expect(tags).toContain('localStorage.set failed');
    expect(tags).toContain('cross-chain.execute.failed');
    expect(tags).toContain('cross-chain.balance-query.failed');
    // a1 OpenPay 利用料 (現行実装のイベント名)。旧 billing.fee.* は退役済。
    expect(tags).toContain('billing.settle.misconfigured');
    expect(tags).toContain('billing.settle.grant');
    expect(tags).toContain('billing.settle.rpc');
    expect(tags).toContain('billing.settle.unexpected');
    expect(tags).toContain('billing.settle.release');
    expect(tags).toContain('billing.meter.record_failed');
    expect(tags).toContain('billing.revenue.record_failed');
  });

  it('退役した旧 billing.fee.* タグは RULES に残っていない (現行コードが発火しないため)', () => {
    const tags = RULES.map((r) => r.eventTag);
    for (const stale of [
      'billing.fee.grant-failed',
      'billing.fee.unexpected',
      'billing.fee.rpc-error',
      'billing.fee.misconfigured',
      'billing.fee.release-failed',
    ]) {
      expect(tags).not.toContain(stale);
    }
  });

  it('a1 billing money-path rule は低 threshold (正常時ほぼ 0・即調査対象)', () => {
    const byTag = (t: string) => RULES.find((r) => r.eventTag === t);
    expect(byTag('billing.settle.misconfigured')?.threshold).toBe(1);
    expect(byTag('billing.settle.grant')?.threshold).toBe(3);
    expect(byTag('billing.settle.rpc')?.threshold).toBe(3);
    expect(byTag('billing.settle.unexpected')?.threshold).toBe(3);
    expect(byTag('billing.settle.release')?.threshold).toBe(1);
    expect(byTag('billing.meter.record_failed')?.threshold).toBe(5);
    expect(byTag('billing.revenue.record_failed')?.threshold).toBe(3);
    // settle.verify (warn=店主の誤 tx・期待挙動) / settle.promote (warn=一過性) は alert を作らない
    expect(byTag('billing.settle.verify')).toBeUndefined();
    expect(byTag('billing.settle.promote')).toBeUndefined();
  });

  it('history 系 rule は threshold 100/h (LocalStorage は per-user 由来で noise 多め)', () => {
    const historyRule = RULES.find(
      (r) => r.eventTag === 'history.load.invalid-entries-dropped',
    );
    const quotaRule = RULES.find(
      (r) => r.eventTag === 'localStorage.set failed',
    );
    expect(historyRule?.threshold).toBe(100);
    expect(historyRule?.interval).toBe('1h');
    expect(quotaRule?.threshold).toBe(100);
    expect(quotaRule?.interval).toBe('1h');
  });

  it('全 rule に name / description / threshold / interval が定義済', () => {
    for (const r of RULES) {
      expect(r.name).toBeTypeOf('string');
      expect(r.name.length).toBeGreaterThan(0);
      expect(r.description).toBeTypeOf('string');
      expect(r.description.length).toBeGreaterThan(0);
      expect(r.threshold).toBeTypeOf('number');
      expect(r.threshold).toBeGreaterThan(0);
      expect(r.interval).toMatch(/^\d+[mh]$/); // e.g. "1h", "30m"
    }
  });

  it('rule name はユニーク (冪等性 key として機能するため)', () => {
    const names = RULES.map((r) => r.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('setup-sentry-alerts: buildRulePayload', () => {
  const SAMPLE: AlertRule = {
    name: 'test rule',
    description: 'sample rule',
    eventTag: 'payment.failed',
    threshold: 50,
    interval: '1h',
  };

  it('Sentry API 想定 schema を生成する (name / environment / conditions / filters / actions)', () => {
    const payload = buildRulePayload(SAMPLE, 'production');
    expect(payload.name).toBe('test rule');
    expect(payload.environment).toBe('production');
    expect(payload.actionMatch).toBe('all');
    expect(payload.filterMatch).toBe('all');
    expect(payload.frequency).toBe(60);
  });

  it('conditions に EventFrequencyCondition を threshold + interval で組込む', () => {
    const payload = buildRulePayload(SAMPLE, 'production');
    expect(payload.conditions).toHaveLength(1);
    const cond = payload.conditions[0];
    expect(cond.id).toBe(
      'sentry.rules.conditions.event_frequency.EventFrequencyCondition',
    );
    expect(cond.value).toBe(50);
    expect(cond.interval).toBe('1h');
  });

  it('filters に TaggedEventFilter (event=<eventTag>) を組込む', () => {
    const payload = buildRulePayload(SAMPLE, 'production');
    expect(payload.filters).toHaveLength(1);
    const f = payload.filters[0];
    expect(f.id).toBe('sentry.rules.filters.tagged_event.TaggedEventFilter');
    expect(f.key).toBe('event');
    expect(f.match).toBe('eq');
    expect(f.value).toBe('payment.failed');
  });

  it('actions に NotifyEventAction を組込む (project notification 設定に従う)', () => {
    const payload = buildRulePayload(SAMPLE, 'production');
    expect(payload.actions).toHaveLength(1);
    expect(payload.actions[0].id).toBe(
      'sentry.rules.actions.notify_event.NotifyEventAction',
    );
  });

  it('env 引数で environment を上書き可能 (staging / production 切替)', () => {
    expect(buildRulePayload(SAMPLE, 'staging').environment).toBe('staging');
    expect(buildRulePayload(SAMPLE, 'production').environment).toBe(
      'production',
    );
  });
});

describe('setup-sentry-alerts: 冪等性 (fetch mock 経由の挙動検証)', () => {
  let fetchSpy: MockInstance<typeof fetch>;

  beforeEach(() => {
    // 各 test で fresh module を読み直して env が clean な状態から走らせる
    fetchSpy = vi.fn() as unknown as typeof fetchSpy;
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('既存 rule に同 name があれば POST を発行しない (skip)', async () => {
    process.env.SENTRY_AUTH_TOKEN = 'test_token';
    process.env.SENTRY_ORG_SLUG = 'test-org';
    process.env.SENTRY_PROJECT_SLUG = 'test-project';
    process.env.SENTRY_ALERT_ENV = 'production';

    // GET list で既に 3 rule 全て存在する状態を mock
    const existingRules = RULES.map((r, i) => ({ id: `existing-${i}`, name: r.name }));
    fetchSpy.mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'GET' || !init?.method) {
        return new Response(JSON.stringify(existingRules), { status: 200 });
      }
      throw new Error(`想定外 POST: ${url}`);
    });

    const mod = await import('../../scripts/setup-sentry-alerts.mjs');
    await mod.main();

    // 全て skip → GET 1 回のみ、POST はゼロ
    const calls = fetchSpy.mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][1]?.method).toBe('GET');
  });

  it('既存 rule にゼロ件なら 3 rule を POST で作成', async () => {
    process.env.SENTRY_AUTH_TOKEN = 'test_token';
    process.env.SENTRY_ORG_SLUG = 'test-org';
    process.env.SENTRY_PROJECT_SLUG = 'test-project';
    process.env.SENTRY_ALERT_ENV = 'production';

    let createdCount = 0;
    fetchSpy.mockImplementation(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'POST') {
        createdCount++;
        return new Response(
          JSON.stringify({ id: `new-${createdCount}` }),
          { status: 201 },
        );
      }
      return new Response('[]', { status: 200 });
    });

    const mod = await import('../../scripts/setup-sentry-alerts.mjs');
    await mod.main();

    // GET 1 (list existing) + POST × RULES.length (1 per new rule)
    expect(fetchSpy).toHaveBeenCalledTimes(1 + RULES.length);
    expect(createdCount).toBe(RULES.length);
    const posts = fetchSpy.mock.calls.filter(
      ([, init]) => init?.method === 'POST',
    );
    expect(posts).toHaveLength(RULES.length);
    for (const [, init] of posts) {
      expect(init?.body).toBeTypeOf('string');
      const body = JSON.parse(init!.body as string);
      expect(body.actionMatch).toBe('all');
      expect(body.conditions[0].id).toBe(
        'sentry.rules.conditions.event_frequency.EventFrequencyCondition',
      );
    }
  });

  it('Sentry API が non-OK を返したら例外を投げる (silent skip しない)', async () => {
    process.env.SENTRY_AUTH_TOKEN = 'test_token';
    process.env.SENTRY_ORG_SLUG = 'test-org';
    process.env.SENTRY_PROJECT_SLUG = 'test-project';
    fetchSpy.mockImplementation(
      async () =>
        new Response('Unauthorized', { status: 401, statusText: 'Unauthorized' }),
    );

    const mod = await import('../../scripts/setup-sentry-alerts.mjs');
    await expect(mod.main()).rejects.toThrow(/Sentry API.*401/);
  });

  it('既存 1 件 + 不足分のみ POST (冪等性検証)', async () => {
    process.env.SENTRY_AUTH_TOKEN = 'test_token';
    process.env.SENTRY_ORG_SLUG = 'test-org';
    process.env.SENTRY_PROJECT_SLUG = 'test-project';
    const partialExisting = [{ id: 'existing-1', name: RULES[0].name }];
    let postCount = 0;
    fetchSpy.mockImplementation(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'POST') {
        postCount++;
        return new Response(JSON.stringify({ id: `new-${postCount}` }), {
          status: 201,
        });
      }
      return new Response(JSON.stringify(partialExisting), { status: 200 });
    });
    const mod = await import('../../scripts/setup-sentry-alerts.mjs');
    await mod.main();
    expect(postCount).toBe(RULES.length - 1); // 既存 1 件以外
  });

  it('SENTRY_AUTH_TOKEN 未設定で例外 (silent fail せず明示的に error)', async () => {
    delete process.env.SENTRY_AUTH_TOKEN;
    process.env.SENTRY_ORG_SLUG = 'test-org';
    process.env.SENTRY_PROJECT_SLUG = 'test-project';
    const mod = await import('../../scripts/setup-sentry-alerts.mjs');
    await expect(mod.main()).rejects.toThrow(/SENTRY_AUTH_TOKEN/);
  });
});
