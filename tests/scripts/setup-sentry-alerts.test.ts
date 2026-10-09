// scripts/setup-sentry-alerts.mjs の unit test。
// API 通信を実発火しないように、RULES の静的シェイプ・buildRulePayload・planRules (差分計画) と
// formatPlan (dry-run の出力) を検証する。main() の挙動 (GET → 計画 → POST/PUT、dry-run は GET のみ)
// は fetch を mock した integration としてこのファイル内で完結検証する。

import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { makeRespond } from '@/lib/relay/relayRoute';
import { logger } from '@/lib/logger';
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

// lib/logger を spy 化 (Sentry / console へは出さない)。実配線 (makeRespond) を通した tag の確認に使う。
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const byTag = (t: string) => RULES.find((r) => r.eventTags.includes(t));

const SLACK_ACTION = {
  id: 'sentry.rules.actions.notify_event_service.SlackNotifyServiceAction',
  workspace: 12345,
  channel: '#openpay-alerts',
  tags: 'event',
};

// app/lib/components/hooks の TypeScript AST から logger.warn / logger.error の第 1 引数 (文字列リテラル) を集める。
// コメントは AST に乗らないので根拠にならない。テンプレートリテラル (`${prefix}.suffix`) は集めない
// (実配線を通した wiredTags で確かめる)。
function collectLoggerLiteralTags(): { tags: Set<string>; respondPrefixes: Set<string> } {
  const tags = new Set<string>();
  // makeRespond('<prefix>') の実引数 (route の配線)。コメントではなく呼び出し式から取る。
  const respondPrefixes = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const arg = node.arguments[0];
      const isStr = arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg));
      if (
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === 'logger' &&
        (node.expression.name.text === 'warn' || node.expression.name.text === 'error') &&
        isStr
      ) {
        tags.add(arg.text);
      }
      if (ts.isIdentifier(node.expression) && node.expression.text === 'makeRespond' && isStr) {
        respondPrefixes.add(arg.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  for (const root of ['app', 'lib', 'components', 'hooks']) {
    const files = readdirSync(root, { recursive: true }).filter(
      (f): f is string => typeof f === 'string' && /\.(?:ts|tsx|mjs|js)$/.test(f),
    );
    for (const f of files) {
      const path = join(root, f);
      const sf = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
      visit(sf);
    }
  }
  return { tags, respondPrefixes };
}

// 動的な tag は実配線で確かめる: route が呼ぶ makeRespond(<AST から取った実引数の prefix>) に各 RelayResult を
// 通し、spy 化した logger が受け取った tag を集める (prefix の綴りは route の実引数・suffix の組み立ては
// relayRoute の実コードで検証。コメントや別の文字列は根拠にならない)。
function wiredTags(respondPrefixes: Set<string>): Set<string> {
  const warn = vi.mocked(logger.warn);
  warn.mockClear();
  for (const prefix of respondPrefixes) {
    const respond = makeRespond(prefix);
    respond({ kind: 'reverted', txHash: '0xabc' }, 137);
    respond({ kind: 'pending', txHash: '0xabc' }, 137);
    respond({ kind: 'relay_error', detail: 'relayer_unfunded' }, 137);
    respond({ kind: 'success', txHash: '0xabc' }, 137);
  }
  const tags = new Set(warn.mock.calls.map(([tag]) => tag));
  warn.mockClear();
  return tags;
}

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
      'relay.jpyc.misconfig',
      'relay.jpyc.forwarder_invalid',
      'x402.facilitator.relay_error',
      'x402.facilitator.reverted',
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

  it('pending (結論待ち) は確定失敗の rule から分け、1h に 3 回より多いときだけ通知する', () => {
    // relay.jpyc.pending / x402.facilitator.pending は障害専用ではない: 重複 claim (relayBroadcast の
    // idempotency duplicate) や既使用 authorization (jpycRelay の used guard) という正常な防御経路でも出る。
    // 閾値 0 だと客の正当な再送 (double-click / retry) のたびに通知が繰り返される (Codex P2)。
    const pending = byTag('relay.jpyc.pending');
    expect(pending?.eventTags).toEqual(['relay.jpyc.pending', 'x402.facilitator.pending']);
    expect(pending?.threshold).toBe(3);
    expect(byTag('relay.jpyc.relay_error')?.eventTags).not.toContain('relay.jpyc.pending');
    expect(byTag('x402.facilitator.relay_error')?.eventTags).not.toContain('x402.facilitator.pending');
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
    // 'x402.middleware.error' がどこからも emit されていなかった。
    // 検査の根拠は AST 上の logger.warn / logger.error 呼び出しの第 1 引数だけ (コメントや無関係な文字列は
    // 根拠にしない)。`${prefix}.suffix` 形の動的な tag (makeRespond) は実配線を通した logger spy で確かめる
    // (下の WIRED_TAGS)。
    const { tags: literal, respondPrefixes } = collectLoggerLiteralTags();
    // sanity: 走査が機能している保証。
    expect(literal.size).toBeGreaterThan(50);
    // コメント中の 'relay.jpyc.reverted' (relayRoute.ts の説明文) は根拠にならない。
    expect(literal.has('relay.jpyc.reverted')).toBe(false);
    // route の実引数: /api/relay/jpyc = 'relay.jpyc'・/api/csv-pass/relay = 'csvpass.relay'。
    expect(respondPrefixes).toEqual(new Set(['relay.jpyc', 'csvpass.relay']));
    const wired = wiredTags(respondPrefixes);
    expect(wired).toEqual(
      new Set([
        'relay.jpyc.reverted',
        'relay.jpyc.pending',
        'relay.jpyc.relay_error',
        'csvpass.relay.reverted',
        'csvpass.relay.pending',
        'csvpass.relay.relay_error',
      ]),
    );
    const emitted = (tag: string, match: TagMatch): boolean => {
      if (match === 'ew') return [...literal].some((l) => l.endsWith(tag));
      // sw / co の rule は今は無い。足すときはここに判定を追加する (黙って通さない)。
      expect(match, `match=${match} の emit 判定は未実装`).toBe('eq');
      return literal.has(tag) || wired.has(tag);
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

  describe('update は既存の通知先 (actions) を保持する (PUT は rule 全体を上書きするため・Codex P1)', () => {
    const rule = RULES.find((r) => r.eventTags[0] === 'history.load.unreadable-entries-preserved')!;
    const withActions = (actions: ExistingRule['actions']): ExistingRule => ({
      id: '7',
      ...buildRulePayload(rule, 'mainnet'),
      conditions: [{ id: 'sentry.rules.conditions.event_frequency.EventFrequencyCondition', value: 100, interval: '1h' }],
      actions,
    });

    it('Slack 等の既存 actions を PUT payload にそのまま載せ、計画にも出す', () => {
      const plan = planRules([withActions([SLACK_ACTION, { id: 'sentry.rules.actions.notify_event.NotifyEventAction' }])], RULES, 'mainnet');
      expect(plan.update).toHaveLength(1);
      const u = plan.update[0];
      expect(u.changes).toEqual(['threshold 100 → 10']);
      expect(u.payload.actions).toEqual([
        SLACK_ACTION,
        { id: 'sentry.rules.actions.notify_event.NotifyEventAction' },
      ]);
      expect(u.keptActions).toEqual(['SlackNotifyServiceAction', 'NotifyEventAction']);
      expect(formatPlan(plan, 'mainnet')).toContain(
        '  ~ update  OpenPay: history.load.unreadable-entries-preserved spike (id=7): threshold 100 → 10 ' +
          '[actions 保持: SlackNotifyServiceAction, NotifyEventAction]',
      );
    });

    it('既存 rule に actions が無い (空) ときだけ既定の NotifyEventAction を付け、計画に明示する', () => {
      const plan = planRules([withActions([])], RULES, 'mainnet');
      expect(plan.update[0].payload.actions).toEqual([
        { id: 'sentry.rules.actions.notify_event.NotifyEventAction' },
      ]);
      expect(plan.update[0].changes).toEqual(['threshold 100 → 10', 'actions (none) → NotifyEventAction']);
    });

    it('create の actions は既定の NotifyEventAction', () => {
      const plan = planRules([], RULES, 'mainnet');
      for (const c of plan.create) {
        expect(c.payload.actions).toEqual([{ id: 'sentry.rules.actions.notify_event.NotifyEventAction' }]);
      }
    });
  });

  describe('比較は conditions / filters 全体と論理条件 (actionMatch / filterMatch) を見る (Codex P2)', () => {
    const rule = RULES.find((r) => r.eventTags[0] === 'billing.settle.grant-failed')!;
    const base = (): ExistingRule => ({ id: '9', ...buildRulePayload(rule, 'mainnet') });

    it('同じ内容なら unchanged (表示用の name / label は無視)', () => {
      const existing = base();
      existing.conditions = existing.conditions!.map((c) => ({ ...c, name: 'The issue is seen more than 0 times in 1h' }));
      existing.filters = existing.filters!.map((f) => ({ ...f, name: "The event's tags match event eq billing.settle.grant-failed", label: 'x' }));
      existing.conditions[0].value = '0';
      const plan = planRules([existing], RULES, 'mainnet');
      expect(plan.unchanged).toHaveLength(1);
    });

    it('追加の condition があれば update (発火条件が変わっている)', () => {
      const existing = base();
      existing.conditions = [
        ...existing.conditions!,
        { id: 'sentry.rules.conditions.first_seen_event.FirstSeenEventCondition' },
      ];
      const plan = planRules([existing], RULES, 'mainnet');
      expect(plan.update[0]?.changes).toEqual([
        'conditions EventFrequencyCondition + FirstSeenEventCondition → EventFrequencyCondition',
      ]);
    });

    it('別キーの filter (level 等) が混ざっていれば update', () => {
      const existing = base();
      existing.filters = [
        ...existing.filters!,
        { id: 'sentry.rules.filters.level.LevelFilter', match: 'gte', level: '40' },
      ];
      const plan = planRules([existing], RULES, 'mainnet');
      expect(plan.update[0]?.changes).toEqual([
        'filters billing.settle.grant-failed + LevelFilter → billing.settle.grant-failed',
      ]);
    });

    it('同じ tag でも match (eq / ew) が違えば update', () => {
      const existing = base();
      existing.filters![0].match = 'co';
      const plan = planRules([existing], RULES, 'mainnet');
      expect(plan.update[0]?.changes).toEqual([
        'filters contains billing.settle.grant-failed → billing.settle.grant-failed',
      ]);
    });

    it('actionMatch が違えば update', () => {
      const existing = base();
      existing.actionMatch = 'any';
      const plan = planRules([existing], RULES, 'mainnet');
      expect(plan.update[0]?.changes).toEqual(['actionMatch any → all']);
    });

    it('filter が 1 つのとき all と any は同等とみなすが、none (通知対象の反転) は update', () => {
      const same = base();
      same.filterMatch = 'all';
      expect(planRules([same], RULES, 'mainnet').unchanged).toHaveLength(1);
      const inverted = base();
      inverted.filterMatch = 'none';
      expect(planRules([inverted], RULES, 'mainnet').update[0]?.changes).toEqual(['filterMatch none → any']);
    });

    it('filter が複数の rule は all / any の違いも update (OR と AND で意味が変わる)', () => {
      const multi = RULES.find((r) => r.eventTags.length > 1)!;
      const existing: ExistingRule = { id: '10', ...buildRulePayload(multi, 'mainnet'), filterMatch: 'all' };
      expect(planRules([existing], RULES, 'mainnet').update[0]?.changes).toEqual(['filterMatch all → any']);
    });
  });

  it('formatPlan は dry-run の出力 (何をどう変えるか) を 1 行 1 rule で出す', () => {
    const lines = formatPlan(planRules(LEGACY_SENTRY_RULES, RULES, 'mainnet'), 'mainnet');
    expect(lines[0]).toBe(
      `[setup-sentry-alerts] plan (environment=mainnet): create ${RULES.length - 13} / update 13 / unchanged 0 / retire 1`,
    );
    expect(lines).toContain(
      '  ~ update  OpenPay: 支払いフォームの失敗 (payment / tip / checkout) (id=100): ' +
        'rename from "OpenPay: payment.failed rate exceeded (alpha threshold)"; threshold 50 → 3; ' +
        'filters payment.failed → payment.failed + tip.failed + checkout.failed; filterMatch all → any ' +
        '[actions 保持: NotifyEventAction]',
    );
    expect(lines).toContain(
      '  ~ update  OpenPay: smart-account.init-failed (全フォーム・接尾一致) (id=101): ' +
        'rename from "OpenPay: smart-account.init-failed rate exceeded"; threshold 10 → 2; ' +
        'filters smart-account.init-failed → ends-with smart-account.init-failed [actions 保持: NotifyEventAction]',
    );
    expect(lines).toContain(
      '  ~ update  OpenPay: billing.meter.record-failed (usage volume undercount) (id=112): threshold 5 → 2 ' +
        '[actions 保持: NotifyEventAction]',
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

  it('PUT の body は既存の Slack 通知先を保持し、POST の body は既定の NotifyEventAction だけ', async () => {
    const existing = LEGACY_SENTRY_RULES.map((r) => ({ ...r, actions: [SLACK_ACTION] }));
    fetchSpy.mockImplementation(async (_url, init) => {
      if (init?.method === 'POST') return new Response(JSON.stringify({ id: 'new' }), { status: 201 });
      if (init?.method === 'PUT') return new Response(JSON.stringify({ id: 'upd' }), { status: 200 });
      return new Response(JSON.stringify(existing), { status: 200 });
    });
    const mod = await import('../../scripts/setup-sentry-alerts.mjs');
    await mod.main([]);
    const bodies = (method: string) =>
      fetchSpy.mock.calls.filter(([, init]) => init?.method === method).map(([, init]) => JSON.parse(init!.body as string));
    expect(bodies('PUT')).toHaveLength(13);
    for (const body of bodies('PUT')) expect(body.actions).toEqual([SLACK_ACTION]);
    for (const body of bodies('POST')) {
      expect(body.actions).toEqual([{ id: 'sentry.rules.actions.notify_event.NotifyEventAction' }]);
    }
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
