// scripts/setup-sentry-alerts.mjs の unit test。
// API 通信を実発火しないように、RULES の静的シェイプ・buildRulePayload・planRules (差分計画) と
// formatPlan (dry-run の出力) を検証する。main() の挙動 (GET → 計画 → POST/PUT、dry-run は GET のみ)
// は fetch を mock した integration としてこのファイル内で完結検証する。

import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  RULES,
  RETIRED_RULE_NAMES,
  buildRulePayload,
  planRules,
  formatPlan,
  type AlertRule,
  type ExistingRule,
  type TagMatch,
} from '../../scripts/setup-sentry-alerts.mjs';

const byTag = (t: string) => RULES.find((r) => r.eventTags.includes(t));

// 第 7 回レビュー E6 以前の 14 rule が Sentry に登録されている状態 (name・閾値・tag は旧 RULES のまま)。
// planRules の fixture と dry-run 出力の固定に使う。
const LEGACY_SENTRY_RULES: ExistingRule[] = [
  ['payment.failed rate exceeded (alpha threshold)', 'payment.failed', 50],
  ['smart-account.init-failed rate exceeded', 'smart-account.init-failed', 10],
  ['x402.middleware.error rate exceeded', 'x402.middleware.error', 10],
  ['history.load.unreadable-entries-preserved spike', 'history.load.unreadable-entries-preserved', 100],
  ['localStorage.set failed spike (quota / private-mode)', 'localStorage.set failed', 100],
  ['cross-chain.execute.failed rate exceeded', 'cross-chain.execute.failed', 20],
  ['cross-chain.balance-query.failed spike', 'cross-chain.balance-query.failed', 100],
  ['billing.settle.misconfigured (FEE_RECEIVER unset)', 'billing.settle.misconfigured', 1],
  ['billing.settle.grant-failed (paid but not credited)', 'billing.settle.grant-failed', 3],
  ['billing.settle.rpc-error (chain RPC outage on verify)', 'billing.settle.rpc-error', 3],
  ['billing.settle.unexpected (money-path throw)', 'billing.settle.unexpected', 3],
  ['billing.settle.release-failed (idempotency lock burned)', 'billing.settle.release-failed', 1],
  ['billing.meter.record-failed (usage volume undercount)', 'billing.meter.record_failed', 5],
  ['billing.revenue.record-failed (revenue ledger gap)', 'billing.revenue.record_failed', 3],
].map(([suffix, tag, value], i) => ({
  id: String(100 + i),
  name: `OpenPay: ${suffix}`,
  environment: 'mainnet',
  actionMatch: 'all',
  filterMatch: 'all',
  frequency: 60,
  conditions: [
    {
      id: 'sentry.rules.conditions.event_frequency.EventFrequencyCondition',
      name: `The issue is seen more than ${value} times in 1h`,
      value,
      interval: '1h',
    },
  ],
  filters: [
    {
      id: 'sentry.rules.filters.tagged_event.TaggedEventFilter',
      key: 'event',
      match: 'eq',
      value: String(tag),
    },
  ],
  actions: [{ id: 'sentry.rules.actions.notify_event.NotifyEventAction' }],
}));

describe('setup-sentry-alerts: RULES schema', () => {
  it('全 rule に name / description / eventTags / threshold / interval が定義済・name はユニーク', () => {
    for (const r of RULES) {
      expect(r.name).toMatch(/^OpenPay: /);
      expect(r.description.length).toBeGreaterThan(0);
      expect(r.eventTags.length).toBeGreaterThan(0);
      expect(Number.isInteger(r.threshold)).toBe(true);
      expect(r.threshold).toBeGreaterThanOrEqual(0);
      expect(r.interval).toMatch(/^\d+[mh]$/);
    }
    const names = RULES.map((r) => r.name);
    expect(new Set(names).size).toBe(names.length);
    // 1 つの tag は 1 つの rule にだけ属する (同じ event で 2 通の通知を出さない)。
    const tags = RULES.flatMap((r) => r.eventTags);
    expect(new Set(tags).size).toBe(tags.length);
  });

  it('旧 name (legacyNames) は現行 name と重ならず、RETIRED にも無い', () => {
    const current = new Set(RULES.map((r) => r.name));
    for (const r of RULES) {
      for (const legacy of r.legacyNames ?? []) {
        expect(current.has(legacy)).toBe(false);
        expect(RETIRED_RULE_NAMES).not.toContain(legacy);
      }
    }
  });

  it('閾値は実トラフィック (外部の実購入が月数件) で発火しうる値: 全 rule が 10 以下・money-path は 0 (1 件目で通知)', () => {
    for (const r of RULES) expect(r.threshold, r.name).toBeLessThanOrEqual(10);
    // 「支払ったのに反映されない」「資金が中間状態」「relayer / minter が止まる」は 1 件目で通知。
    for (const tag of [
      'relay.relayer.balance_low',
      'relay.jpyc.relay_error',
      'relay.jpyc.reverted',
      'relay.jpyc.pending',
      'relay.jpyc.misconfig',
      'relay.jpyc.forwarder_invalid',
      'x402.facilitator.relay_error',
      'x402.facilitator.reverted',
      'x402.facilitator.pending',
      'x402.facilitator.gas_ceiling_required',
      'x402.facilitator.kv_required',
      'x402.facilitator.settlement_record_failed',
      'x402.vanilla.settle_unavailable',
      'x402.dualrail.misconfigured',
      'x402.payment_redelivery.promotion_failed',
      'x402.settle_ledger.record_failed',
      'cross-chain.burn.unresolved',
      'circle.broadcast.response-lost',
      'creator_store.purchase_reconcile_indeterminate',
      'creator_store.purchase_pending_quarantined',
      'creator_store.usdc_purchase_pending_quarantined',
      'creator_store.usdc_purchase_reschedule_failed',
      'license.reconcile_indeterminate',
      'order.notify.unexpected',
      'order.agent.registration_failed',
      'order.agent.finalize_conflict',
      'order.agent.settlement_save_failed',
      'billing.settle.misconfigured',
      'billing.settle.grant-failed',
      'billing.settle.unexpected',
      'billing.settle.release-failed',
      'billing.revenue.record_failed',
    ]) {
      expect(byTag(tag)?.threshold, tag).toBe(0);
    }
    // 再試行が効く・一過性が混ざる側は 2〜3 件目で通知 (1 人の客の失敗や 1 回の RPC 揺らぎでは鳴らない)。
    expect(byTag('license.worker_job_failed')?.threshold).toBe(2);
    expect(byTag('x402.vanilla.verify_unavailable')?.threshold).toBe(2);
    expect(byTag('x402.dualrail.facilitator_unavailable')?.threshold).toBe(2);
    expect(byTag('billing.settle.rpc-error')?.threshold).toBe(2);
    expect(byTag('billing.meter.record_failed')?.threshold).toBe(2);
    expect(byTag('order.notify.verify_failed')?.threshold).toBe(3);
    expect(byTag('payment.failed')?.threshold).toBe(3);
    expect(byTag('cross-chain.execute.failed')?.threshold).toBe(1);
    expect(byTag('smart-account.init-failed')?.threshold).toBe(2);
  });

  it('支払いフォームの失敗は payment / tip / checkout を 1 rule にまとめ、smart-account.init-failed は接尾一致で 3 フォームを拾う', () => {
    const forms = byTag('payment.failed');
    expect(forms?.eventTags).toEqual(['payment.failed', 'tip.failed', 'checkout.failed']);
    const sa = byTag('smart-account.init-failed');
    expect(sa?.match).toBe('ew');
    // 接尾一致なので tip.smart-account.init-failed / checkout.smart-account.init-failed も対象。
    const payload = buildRulePayload(sa!);
    expect(payload.filters).toEqual([
      {
        id: 'sentry.rules.filters.tagged_event.TaggedEventFilter',
        key: 'event',
        match: 'ew',
        value: 'smart-account.init-failed',
      },
    ]);
  });

  it('発火元の無い x402.middleware.error は RULES から外し、RETIRED として Dashboard 削除の対象にする', () => {
    expect(byTag('x402.middleware.error')).toBeUndefined();
    expect(RETIRED_RULE_NAMES).toContain('OpenPay: x402.middleware.error rate exceeded');
  });

  it('退役した旧 billing.fee.* タグは RULES に残っていない (現行コードが発火しないため)', () => {
    for (const stale of [
      'billing.fee.grant-failed',
      'billing.fee.unexpected',
      'billing.fee.rpc-error',
      'billing.fee.misconfigured',
      'billing.fee.release-failed',
    ]) {
      expect(byTag(stale)).toBeUndefined();
    }
    // settle.verify-failed (店主の誤 tx・期待挙動) / settle.promote-failed (一過性) は alert を作らない
    expect(byTag('billing.settle.verify-failed')).toBeUndefined();
    expect(byTag('billing.settle.promote-failed')).toBeUndefined();
  });

  it('全 eventTag は app/lib/components/hooks のソースで実際に emit されている (tag タイポでアラート不発を防ぐ)', () => {
    // 過去バグ (Codex review で検出): 'billing.settle.grant' を指定したが実 emit は
    // 'billing.settle.grant-failed' で、アラートが永久に発火しなかった。第 7 回レビュー E6 では
    // 'x402.middleware.error' がどこからも emit されていなかった。RULES の全 tag が実 logger.warn/error
    // 文字列 (または makeRespond / logPrefix による `${prefix}.suffix` 形) に存在することを恒久 fence する。
    const literal = new Set<string>();
    const dynamicSuffix = new Set<string>();
    const sources: string[] = [];
    const literalRe = /logger\.(?:warn|error)\(\s*['"]([A-Za-z0-9._: -]+)['"]/g;
    const dynamicRe = /logger\.(?:warn|error)\(\s*`\$\{[A-Za-z0-9_.]+\}\.([A-Za-z0-9_-]+)`/g;
    for (const root of ['app', 'lib', 'components', 'hooks']) {
      const files = readdirSync(root, { recursive: true }).filter(
        (f): f is string => typeof f === 'string' && /\.(?:ts|tsx|mjs|js)$/.test(f),
      );
      for (const f of files) {
        const src = readFileSync(join(root, f), 'utf8');
        sources.push(src);
        for (const m of src.matchAll(literalRe)) literal.add(m[1]);
        for (const m of src.matchAll(dynamicRe)) dynamicSuffix.add(m[1]);
      }
    }
    // sanity: 走査が機能している保証。
    expect(literal.size).toBeGreaterThan(50);
    expect(dynamicSuffix.has('reverted')).toBe(true);
    const emitted = (tag: string, match: TagMatch): boolean => {
      if (match === 'ew') return [...literal].some((l) => l.endsWith(tag));
      // sw / co の rule は今は無い。足すときはここに判定を追加する (黙って通さない)。
      expect(match, `match=${match} の emit 判定は未実装`).toBe('eq');
      if (literal.has(tag)) return true;
      const dot = tag.lastIndexOf('.');
      if (dot < 0) return false;
      const prefix = tag.slice(0, dot);
      const suffix = tag.slice(dot + 1);
      return dynamicSuffix.has(suffix) && sources.some((s) => s.includes(`'${prefix}'`));
    };
    for (const rule of RULES) {
      for (const tag of rule.eventTags) {
        expect(
          emitted(tag, rule.match ?? 'eq'),
          `${tag} は app/lib/components/hooks のどこからも logger.warn/error で emit されていない (tag タイポ?)`,
        ).toBe(true);
      }
    }
  });
});

describe('setup-sentry-alerts: buildRulePayload', () => {
  const SAMPLE: AlertRule = {
    name: 'test rule',
    description: 'sample rule',
    eventTags: ['payment.failed'],
    threshold: 3,
    interval: '1h',
  };

  it('Sentry API 想定 schema を生成する (name / environment / conditions / filters / actions)', () => {
    const payload = buildRulePayload(SAMPLE, 'mainnet');
    expect(payload.name).toBe('test rule');
    expect(payload.environment).toBe('mainnet');
    expect(payload.actionMatch).toBe('all');
    expect(payload.filterMatch).toBe('any');
    expect(payload.frequency).toBe(60);
    expect(payload.conditions).toEqual([
      {
        id: 'sentry.rules.conditions.event_frequency.EventFrequencyCondition',
        value: 3,
        interval: '1h',
      },
    ]);
    expect(payload.filters).toEqual([
      {
        id: 'sentry.rules.filters.tagged_event.TaggedEventFilter',
        key: 'event',
        match: 'eq',
        value: 'payment.failed',
      },
    ]);
    expect(payload.actions).toEqual([
      { id: 'sentry.rules.actions.notify_event.NotifyEventAction' },
    ]);
  });

  it('複数 tag は TaggedEventFilter を tag ごとに並べ filterMatch=any (OR) にする', () => {
    const payload = buildRulePayload({ ...SAMPLE, eventTags: ['a.b', 'c.d'] }, 'mainnet');
    expect(payload.filterMatch).toBe('any');
    expect(payload.filters.map((f) => f.value)).toEqual(['a.b', 'c.d']);
  });

  it('environment の既定は mainnet (通知は本番だけ・手元は local-<network>・#709)。production は存在しない', () => {
    expect(buildRulePayload(SAMPLE).environment).toBe('mainnet');
    expect(buildRulePayload(SAMPLE, 'testnet').environment).toBe('testnet');
    for (const r of RULES) expect(buildRulePayload(r).environment).toBe('mainnet');
  });
});

describe('setup-sentry-alerts: planRules / formatPlan (dry-run の出力を固定)', () => {
  it('空の Sentry に対しては全 rule が create・retire なし', () => {
    const plan = planRules([], RULES, 'mainnet');
    expect(plan.create.map((r) => r.name)).toEqual(RULES.map((r) => r.name));
    expect(plan.update).toEqual([]);
    expect(plan.unchanged).toEqual([]);
    expect(plan.retire).toEqual([]);
  });

  it('現行 RULES をそのまま登録済みの Sentry に対しては全 rule が unchanged (冪等)', () => {
    const existing: ExistingRule[] = RULES.map((r, i) => ({
      id: String(i),
      ...buildRulePayload(r, 'mainnet'),
    }));
    const plan = planRules(existing, RULES, 'mainnet');
    expect(plan.create).toEqual([]);
    expect(plan.update).toEqual([]);
    expect(plan.unchanged).toHaveLength(RULES.length);
  });

  it('E6 以前の 14 rule が登録済みの Sentry に対する計画: 旧 name は rename + 閾値更新、新 rule は create、発火元の無い rule は retire', () => {
    const plan = planRules(LEGACY_SENTRY_RULES, RULES, 'mainnet');
    const updated = Object.fromEntries(plan.update.map((u) => [u.name, u]));
    // 旧 name から rename される 2 件 (id は旧 rule を引き継ぐ)。
    expect(updated['OpenPay: 支払いフォームの失敗 (payment / tip / checkout)']).toMatchObject({
      id: '100',
      previousName: 'OpenPay: payment.failed rate exceeded (alpha threshold)',
    });
    expect(updated['OpenPay: smart-account.init-failed (全フォーム・接尾一致)']).toMatchObject({
      id: '101',
      previousName: 'OpenPay: smart-account.init-failed rate exceeded',
    });
    // 同名で閾値だけ変わる 11 件。
    expect(updated['OpenPay: history.load.unreadable-entries-preserved spike']?.changes).toEqual([
      'threshold 100 → 10',
    ]);
    expect(updated['OpenPay: billing.settle.grant-failed (paid but not credited)']?.changes).toEqual([
      'threshold 3 → 0',
    ]);
    expect(plan.update).toHaveLength(13);
    expect(plan.unchanged).toEqual([]);
    expect(plan.retire).toEqual([
      { id: '102', name: 'OpenPay: x402.middleware.error rate exceeded' },
    ]);
    expect(plan.create).toHaveLength(RULES.length - 13);
  });

  it('同名 rule の environment が違えば update (production → mainnet の取り違えを直す)', () => {
    const existing: ExistingRule[] = RULES.map((r, i) => ({
      id: String(i),
      ...buildRulePayload(r, 'production'),
    }));
    const plan = planRules(existing, RULES, 'mainnet');
    expect(plan.update).toHaveLength(RULES.length);
    expect(plan.update[0].changes).toEqual(['environment production → mainnet']);
  });

  it('formatPlan は dry-run の出力 (何をどう変えるか) を 1 行 1 rule で出す', () => {
    const lines = formatPlan(planRules(LEGACY_SENTRY_RULES, RULES, 'mainnet'), 'mainnet');
    expect(lines[0]).toBe(
      `[setup-sentry-alerts] plan (environment=mainnet): create ${RULES.length - 13} / update 13 / unchanged 0 / retire 1`,
    );
    expect(lines).toContain(
      '  ~ update  OpenPay: 支払いフォームの失敗 (payment / tip / checkout) (id=100): ' +
        'rename from "OpenPay: payment.failed rate exceeded (alpha threshold)"; threshold 50 → 3; ' +
        'filters payment.failed → payment.failed | tip.failed | checkout.failed; filterMatch all → any',
    );
    expect(lines).toContain(
      '  ~ update  OpenPay: smart-account.init-failed (全フォーム・接尾一致) (id=101): ' +
        'rename from "OpenPay: smart-account.init-failed rate exceeded"; threshold 10 → 2; ' +
        'filters smart-account.init-failed → ends-with smart-account.init-failed',
    );
    expect(lines).toContain(
      '  ~ update  OpenPay: billing.meter.record-failed (usage volume undercount) (id=112): threshold 5 → 2',
    );
    expect(lines).toContain(
      '  + create  OpenPay: relayer の残高不足 (relay.relayer.balance_low) [relay.relayer.balance_low > 0 / 1h]',
    );
    expect(lines).toContain(
      '  - retire  OpenPay: x402.middleware.error rate exceeded (id=102): 発火元が無い → Sentry Dashboard で削除 (本 script は削除しない)',
    );
    // 1 行 1 rule + 見出し。
    expect(lines).toHaveLength(1 + RULES.length + 1);
  });
});

describe('setup-sentry-alerts: main (fetch mock 経由の挙動検証)', () => {
  let fetchSpy: MockInstance<typeof fetch>;
  const calls = () => fetchSpy.mock.calls.map(([url, init]) => [init?.method ?? 'GET', String(url)]);

  beforeEach(() => {
    fetchSpy = vi.fn() as unknown as typeof fetchSpy;
    vi.stubGlobal('fetch', fetchSpy);
    // main() は計画を console.log に出す。テスト出力を汚さないよう既定では捨てる (dry-run の test は自前で spy する)。
    vi.spyOn(console, 'log').mockImplementation(() => {});
    process.env.SENTRY_AUTH_TOKEN = 'test_token';
    process.env.SENTRY_ORG_SLUG = 'test-org';
    process.env.SENTRY_PROJECT_SLUG = 'test-project';
    delete process.env.SENTRY_ALERT_ENV;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('現行 RULES が全て登録済みなら GET 1 回だけで書き込み (POST/PUT) を出さない', async () => {
    const existing = RULES.map((r, i) => ({ id: `existing-${i}`, ...buildRulePayload(r, 'mainnet') }));
    fetchSpy.mockImplementation(async (url, init) => {
      if (!init?.method || init.method === 'GET') {
        return new Response(JSON.stringify(existing), { status: 200 });
      }
      throw new Error(`想定外 ${init.method}: ${url}`);
    });
    const mod = await import('../../scripts/setup-sentry-alerts.mjs');
    await mod.main([]);
    expect(calls()).toEqual([['GET', 'https://sentry.io/api/0/projects/test-org/test-project/rules/']]);
  });

  it('空の Sentry には全 rule を POST で作成する (environment=mainnet)', async () => {
    fetchSpy.mockImplementation(async (_url, init) => {
      if (init?.method === 'POST') return new Response(JSON.stringify({ id: 'new' }), { status: 201 });
      return new Response('[]', { status: 200 });
    });
    const mod = await import('../../scripts/setup-sentry-alerts.mjs');
    await mod.main([]);
    const posts = fetchSpy.mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(posts).toHaveLength(RULES.length);
    for (const [, init] of posts) {
      const body = JSON.parse(init!.body as string);
      expect(body.environment).toBe('mainnet');
      expect(body.conditions[0].id).toBe('sentry.rules.conditions.event_frequency.EventFrequencyCondition');
    }
  });

  it('旧 14 rule が登録済みなら rename/閾値変更は PUT・新 rule は POST・retire は DELETE しない', async () => {
    fetchSpy.mockImplementation(async (_url, init) => {
      if (init?.method === 'POST') return new Response(JSON.stringify({ id: 'new' }), { status: 201 });
      if (init?.method === 'PUT') return new Response(JSON.stringify({ id: 'upd' }), { status: 200 });
      return new Response(JSON.stringify(LEGACY_SENTRY_RULES), { status: 200 });
    });
    const mod = await import('../../scripts/setup-sentry-alerts.mjs');
    await mod.main([]);
    const methods = calls().map(([m]) => m);
    expect(methods.filter((m) => m === 'PUT')).toHaveLength(13);
    expect(methods.filter((m) => m === 'POST')).toHaveLength(RULES.length - 13);
    expect(methods).not.toContain('DELETE');
    const put = calls().find(([m, url]) => m === 'PUT' && url.endsWith('/rules/100/'));
    expect(put).toBeDefined();
    const putInit = fetchSpy.mock.calls.find(([url]) => String(url).endsWith('/rules/100/'))![1];
    expect(JSON.parse(putInit!.body as string).name).toBe('OpenPay: 支払いフォームの失敗 (payment / tip / checkout)');
  });

  it('--dry-run は GET だけで計画を出し、書き込みを一切しない', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    fetchSpy.mockImplementation(async (url, init) => {
      if (!init?.method || init.method === 'GET') {
        return new Response(JSON.stringify(LEGACY_SENTRY_RULES), { status: 200 });
      }
      throw new Error(`想定外 ${init.method}: ${url}`);
    });
    const mod = await import('../../scripts/setup-sentry-alerts.mjs');
    await mod.main(['--dry-run']);
    expect(calls()).toEqual([['GET', 'https://sentry.io/api/0/projects/test-org/test-project/rules/']]);
    const out = log.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(out).toContain('update 13 / unchanged 0 / retire 1');
    expect(out).toContain('dry-run');
    log.mockRestore();
  });

  it('--dry-run --offline は Sentry に接続せず (token 不要)、空の Sentry に対する計画を出す', async () => {
    delete process.env.SENTRY_AUTH_TOKEN;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const mod = await import('../../scripts/setup-sentry-alerts.mjs');
    await mod.main(['--dry-run', '--offline']);
    expect(fetchSpy).not.toHaveBeenCalled();
    const out = log.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(out).toContain(`create ${RULES.length} / update 0 / unchanged 0 / retire 0`);
    log.mockRestore();
  });

  it('--offline は --dry-run なしでは拒否する (適用を省いた気になる事故を防ぐ)', async () => {
    const mod = await import('../../scripts/setup-sentry-alerts.mjs');
    await expect(mod.main(['--offline'])).rejects.toThrow(/--offline/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('Sentry API が non-OK を返したら例外を投げる (silent skip しない)', async () => {
    fetchSpy.mockImplementation(
      async () => new Response('Unauthorized', { status: 401, statusText: 'Unauthorized' }),
    );
    const mod = await import('../../scripts/setup-sentry-alerts.mjs');
    await expect(mod.main([])).rejects.toThrow(/Sentry API.*401/);
  });

  it('SENTRY_AUTH_TOKEN 未設定で例外 (silent fail せず明示的に error)', async () => {
    delete process.env.SENTRY_AUTH_TOKEN;
    const mod = await import('../../scripts/setup-sentry-alerts.mjs');
    await expect(mod.main([])).rejects.toThrow(/SENTRY_AUTH_TOKEN/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
