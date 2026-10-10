// scripts/setup-sentry-alerts.mjs の unit test。
// API 通信を実発火しないように、RULES の静的シェイプ・buildWorkflowPayload・planRules (差分計画)・
// resolveIssueStreamDetector・formatPlan (dry-run の出力) を検証する。main() の挙動 (GET → 計画 → POST/PUT、
// dry-run は GET のみ) は、Sentry の Workflow Engine API (workflows / detectors) を模した fetch の fake で
// このファイル内で完結検証する。fixture の ID・宛先はすべてダミー (本番の実データからは形だけを写す)。

import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import ts from 'typescript';
import { makeRespond } from '@/lib/relay/relayRoute';
import { logger } from '@/lib/logger';
import {
  RULES,
  RETIRED_RULE_NAMES,
  buildWorkflowPayload,
  planRules,
  formatPlan,
  resolveIssueStreamDetector,
  verifyFallbackDetector,
  describeErrorBody,
  nextCursor,
  type AlertRule,
  type ExistingDetector,
  type ExistingWorkflow,
  type PlanOptions,
  type TagMatch,
  type WorkflowAction,
  type WorkflowConditionGroup,
  type WorkflowPayload,
} from '../../scripts/setup-sentry-alerts.mjs';

// lib/logger を spy 化 (Sentry / console へは出さない)。実配線 (makeRespond) を通した tag の確認に使う。
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const byTag = (t: string) => RULES.find((r) => r.eventTags.includes(t));

// import の module specifier をリポジトリ相対のモジュール path に解決する ('@/lib/logger' / './logger' /
// '../logger' → 'lib/logger')。拡張子は付けない。
function resolveModule(specifier: string, fromPath: string): string | null {
  if (specifier.startsWith('@/')) return specifier.slice(2);
  if (specifier.startsWith('.')) {
    return posix.normalize(posix.join(posix.dirname(fromPath), specifier)).replace(/\.(?:ts|tsx|mjs|js)$/, '');
  }
  return null; // 外部パッケージ
}

type Emits = { tags: Set<string>; respondPrefixes: Set<string> };

// 与えたファイルだけから成る TypeScript Program (module 解決も lib も読まない)。識別子の symbol 解決
// (binder) はファイル内で完結するので、import の binding・トップレベルの const・shadowing の判別に使える。
function makeProgram(files: Map<string, string>): ts.Program {
  const host: ts.CompilerHost = {
    getSourceFile: (f) => {
      const s = files.get(f);
      return s === undefined ? undefined : ts.createSourceFile(f, s, ts.ScriptTarget.Latest, true);
    },
    fileExists: (f) => files.has(f),
    readFile: (f) => files.get(f),
    writeFile: () => {},
    getDefaultLibFileName: () => 'lib.d.ts',
    getCurrentDirectory: () => '',
    getCanonicalFileName: (f) => f,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
    getDirectories: () => [],
  };
  return ts.createProgram(
    [...files.keys()],
    { noResolve: true, noLib: true, allowJs: true, jsx: ts.JsxEmit.Preserve, target: ts.ScriptTarget.Latest, module: ts.ModuleKind.ESNext },
    host,
  );
}

// 識別子が指す宣言 (checker の symbol 解決)。shadowing (引数・var・case 間で共有される switch のスコープ・
// 名前付き class 式の名前・catch・分割代入…) は binder が解決するので、手書きのスコープ追跡を持たない。
// 宣言が 1 つだけのときに返す。同じスコープに import と var が並ぶ (TS では重複宣言のエラー) ような
// 二重の宣言は「lib/logger の binding」と言い切れないので数えない。
function declarationOf(checker: ts.TypeChecker, id: ts.Identifier): ts.Declaration | undefined {
  const decls = checker.getSymbolAtLocation(id)?.declarations ?? [];
  return decls.length === 1 ? decls[0] : undefined;
}

// 宣言が `<module>` からの named import (別名を含む) で、import 元の名前が `name` か。
function isImportOf(decl: ts.Declaration | undefined, fromPath: string, module: string, name: string): boolean {
  if (!decl || !ts.isImportSpecifier(decl)) return false;
  const importDecl = decl.parent.parent.parent;
  if (!ts.isImportDeclaration(importDecl) || !ts.isStringLiteral(importDecl.moduleSpecifier)) return false;
  return resolveModule(importDecl.moduleSpecifier.text, fromPath) === module && (decl.propertyName ?? decl.name).text === name;
}

// 宣言がトップレベルの `const X = '文字列'` なら、その文字列。
function topLevelConstString(decl: ts.Declaration | undefined): string | null {
  if (!decl || !ts.isVariableDeclaration(decl) || !decl.initializer || !ts.isStringLiteral(decl.initializer)) return null;
  const list = decl.parent;
  if (!ts.isVariableDeclarationList(list) || !(list.flags & ts.NodeFlags.Const)) return null;
  const stmt = list.parent;
  return ts.isVariableStatement(stmt) && ts.isSourceFile(stmt.parent) ? decl.initializer.text : null;
}

// 1 ファイルから、`@/lib/logger` (相対 path も) から import した binding (別名を含む) の .warn / .error
// 呼び出しの第 1 引数と、`@/lib/relay/relayRoute` から import した makeRespond の実引数を集める。
// - コメントは AST に乗らないので根拠にならない。
// - 識別子は checker の symbol で解決する: import の binding を指すときだけ数え、同名のローカル変数・
//   引数・別モジュールの logger (偽物の emit) は数えない。
// - テンプレートリテラルは、トップレベルの `const X = '…'` だけを参照する静的なものは解決し、
//   引数や外から来る値を含む動的なもの (`${logPrefix}.reverted`) は集めない (実配線を通した wiredTags で確かめる)。
// - 数えるのは named import (別名可) の `logger.warn/error(...)` だけ。namespace import (`import * as l` →
//   `l.logger.warn`) や re-export 経由は数えない = 実際には送っていても「発火元なし」でこのテストが落ちる
//   (偽 red で安全側)。落ちたら emit 側を named import に書き換える。
function extractFromSourceFile(sf: ts.SourceFile, checker: ts.TypeChecker, into: Emits): void {
  const path = sf.fileName;
  const staticText = (arg: ts.Expression | undefined): string | null => {
    if (!arg) return null;
    if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) return arg.text;
    if (ts.isTemplateExpression(arg)) {
      let out = arg.head.text;
      for (const span of arg.templateSpans) {
        if (!ts.isIdentifier(span.expression)) return null;
        const v = topLevelConstString(declarationOf(checker, span.expression));
        if (v === null) return null;
        out += v + span.literal.text;
      }
      return out;
    }
    return null;
  };
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const text = staticText(node.arguments[0]);
      const callee = node.expression;
      if (
        text !== null &&
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        (callee.name.text === 'warn' || callee.name.text === 'error') &&
        isImportOf(declarationOf(checker, callee.expression), path, 'lib/logger', 'logger')
      ) {
        into.tags.add(text);
      }
      if (
        text !== null &&
        ts.isIdentifier(callee) &&
        isImportOf(declarationOf(checker, callee), path, 'lib/relay/relayRoute', 'makeRespond')
      ) {
        into.respondPrefixes.add(text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

function extractEmits(path: string, source: string): Emits {
  const program = makeProgram(new Map([[path, source]]));
  const into: Emits = { tags: new Set(), respondPrefixes: new Set() };
  extractFromSourceFile(program.getSourceFile(path)!, program.getTypeChecker(), into);
  return into;
}

// app/lib/components/hooks の全ファイルを 1 つの Program にして集める (checker は 1 つ・binder はファイルごと)。
function collectLoggerLiteralTags(): Emits {
  const files = new Map<string, string>();
  for (const root of ['app', 'lib', 'components', 'hooks']) {
    const names = readdirSync(root, { recursive: true }).filter(
      (f): f is string => typeof f === 'string' && /\.(?:ts|tsx|mjs|js)$/.test(f),
    );
    for (const f of names) {
      const path = join(root, f);
      files.set(path, readFileSync(path, 'utf8'));
    }
  }
  const program = makeProgram(files);
  const checker = program.getTypeChecker();
  const into: Emits = { tags: new Set(), respondPrefixes: new Set() };
  for (const path of files.keys()) extractFromSourceFile(program.getSourceFile(path)!, checker, into);
  return into;
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

// ---- Sentry (Workflow Engine) の fixture・fake ----------------------------------------------------

const ORG = 'test-org';
const PROJECT = 'test-project';
const PROJECT_ID = '4500000000000001';
const DETECTOR = '7000001';
const ALL_PROJECTS_DETECTOR = '7000002';
const ORG_URL = `https://sentry.io/api/0/organizations/${ORG}`;

// 本番の detectors 一覧と同じ形 (Error Monitor・Issue Stream・Uptime・全 project 用の Issue Stream)。
const DETECTORS: ExistingDetector[] = [
  { id: '7000000', projectId: PROJECT_ID, name: 'Error Monitor', type: 'error' },
  { id: DETECTOR, projectId: PROJECT_ID, name: 'Issue Stream', type: 'issue_stream' },
  { id: '7000003', projectId: PROJECT_ID, name: 'Uptime Monitoring', type: 'uptime_domain_failure' },
  { id: ALL_PROJECTS_DETECTOR, projectId: null, name: 'Issue Stream: All Projects', type: 'issue_stream' },
];

// 新 UI の既定の trigger (本番の relay failure (mainnet) 等の形)。issue の状態変化のときだけ評価される。
const UI_DEFAULT_TRIGGERS = ['first_seen_event', 'issue_resolved_trigger', 'reappeared_event', 'regression_event'];

// 通知先 (宛先の ID は架空)。
const USER_EMAIL: WorkflowAction = {
  type: 'email',
  integrationId: null,
  data: {},
  config: { targetType: 'user', targetDisplay: null, targetIdentifier: '1000001' },
  status: 'active',
};
const SLACK: WorkflowAction = {
  type: 'slack',
  integrationId: '55',
  data: { tags: 'event' },
  config: { targetType: 'specific', targetDisplay: '#openpay-alerts', targetIdentifier: 'C000001' },
  status: 'active',
};
// 旧 NotifyEventAction 相当 (script が新規作成に使う既定の通知先)。
const DEFAULT_EMAIL: WorkflowAction = {
  type: 'email',
  integrationId: null,
  data: { fallthroughType: 'ActiveMembers' },
  config: { targetType: 'issue_owners', targetDisplay: null, targetIdentifier: '' },
  status: 'active',
};
// Sentry が保存して GET で返す既定の通知先 (targetIdentifier '' は null で返る)。
const DEFAULT_EMAIL_STORED: WorkflowAction = {
  ...DEFAULT_EMAIL,
  config: { ...DEFAULT_EMAIL.config, targetIdentifier: null },
};

let serverId = 90000;
const sid = () => String(serverId++);

// Sentry が保存した data condition group (GET の形): group・条件・action に id と organizationId が付く。
function storedGroup(g: WorkflowConditionGroup): WorkflowConditionGroup {
  return {
    id: sid(),
    organizationId: '1',
    logicType: g.logicType,
    conditions: g.conditions.map((c) => ({
      id: sid(),
      type: c.type,
      comparison: c.comparison,
      conditionResult: c.conditionResult,
    })),
    actions: (g.actions ?? []).map((a) => ({
      id: sid(),
      ...a,
      config: {
        ...a.config,
        targetIdentifier: a.config?.targetIdentifier === '' ? null : (a.config?.targetIdentifier ?? null),
      },
    })),
  };
}

// Sentry が POST / PUT の body を保存して GET で返す形を模す。PUT は渡した top-level キーだけを更新し (enabled は
// 省くと validator の既定 true)、triggers / actionFilters は渡した内容が正 (id 無し = 置き換え)。
function sentryStored(body: Partial<WorkflowPayload>, id: string, prev?: ExistingWorkflow): ExistingWorkflow {
  const base: ExistingWorkflow = prev ?? {
    id,
    name: '',
    organizationId: '1',
    createdBy: '1',
    dateCreated: '2026-10-10T00:00:00Z',
    dateUpdated: '2026-10-10T00:00:00Z',
    triggers: null,
    actionFilters: [],
    environment: null,
    config: {},
    detectorIds: [],
    enabled: true,
    lastTriggered: null,
    owner: null,
  };
  return {
    ...base,
    id,
    dateUpdated: '2026-10-11T00:00:00Z',
    ...(body.name !== undefined ? { name: body.name } : {}),
    enabled: body.enabled ?? true,
    ...('environment' in body ? { environment: body.environment ?? null } : {}),
    ...(body.config !== undefined ? { config: { ...body.config } } : {}),
    ...(body.detectorIds !== undefined ? { detectorIds: body.detectorIds.map(String) } : {}),
    ...(body.triggers !== undefined ? { triggers: storedGroup(body.triggers) } : {}),
    ...(body.actionFilters !== undefined ? { actionFilters: body.actionFilters.map(storedGroup) } : {}),
    ...('owner' in body ? { owner: body.owner ?? null } : {}),
  };
}

// RULES の 1 件を script が作った形のまま Sentry に保存した workflow。
const stored = (rule: AlertRule, id: string, extra: Partial<ExistingWorkflow> = {}): ExistingWorkflow => ({
  ...sentryStored(buildWorkflowPayload(rule, 'mainnet', DETECTOR), id),
  ...extra,
});

// 新 UI で作った workflow の形 (本番の relay failure (mainnet) 等と同じ: 既定の 4 trigger・tag と件数の組・frequency 0)。
function uiShaped(
  id: string,
  name: string,
  tag: string,
  value: number,
  interval: string,
  action: WorkflowAction = USER_EMAIL,
): ExistingWorkflow {
  return sentryStored(
    {
      name,
      enabled: true,
      environment: 'mainnet',
      config: { frequency: 0 },
      detectorIds: [DETECTOR],
      triggers: {
        logicType: 'any-short',
        conditions: UI_DEFAULT_TRIGGERS.map((type) => ({ type, comparison: true, conditionResult: true })),
      },
      actionFilters: [
        {
          logicType: 'all',
          conditions: [
            { type: 'tagged_event', comparison: { key: 'event', match: 'eq', value: tag }, conditionResult: true },
            { type: 'event_frequency_count', comparison: { value, interval }, conditionResult: true },
          ],
          actions: [action],
        },
      ],
    },
    id,
  );
}

// 本番の workflow 6 件と同じ名前・形 (ID・宛先はダミー): 新 UI で作った 4 件 + Sentry 既定の 2 件。
// relay failure (mainnet) と relayer balance low (mainnet) は RULES の legacyNames に載っている (上書き更新して
// 重複させない)。残り 4 件は管理外。
const PROD_NAMES = [
  'Send a notification for high priority issues',
  'relay failure (mainnet)',
  'relayer balance low (mainnet)',
  'relay misconfig (mainnet)',
  'OpenPay billing failures',
  'Send a notification when pull requests are ready',
];
function prodLikeWorkflows(): ExistingWorkflow[] {
  const billing = uiShaped('3000005', PROD_NAMES[4], 'billing.', 0, '1h', DEFAULT_EMAIL);
  billing.actionFilters = [
    {
      ...billing.actionFilters![0],
      conditions: [
        { id: sid(), type: 'tagged_event', comparison: { key: 'event', match: 'sw', value: 'billing.' }, conditionResult: true },
      ],
    },
  ];
  const defaults = (id: string, name: string, triggers: WorkflowConditionGroup['conditions'], detector: string) =>
    sentryStored(
      {
        name,
        enabled: true,
        environment: 'mainnet',
        config: { frequency: 0 },
        detectorIds: [detector],
        triggers: { logicType: 'any-short', conditions: triggers },
        actionFilters: [{ logicType: 'any-short', conditions: [], actions: [DEFAULT_EMAIL] }],
      },
      id,
    );
  return [
    defaults(
      '3000001',
      PROD_NAMES[0],
      ['new_high_priority_issue', 'existing_high_priority_issue'].map((type) => ({
        type,
        comparison: true,
        conditionResult: true,
      })),
      DETECTOR,
    ),
    uiShaped('3000002', PROD_NAMES[1], 'relay.jpyc.relay_error', 3, '5m'),
    uiShaped('3000003', PROD_NAMES[2], 'relay.relayer.balance_low', 1, '1h'),
    uiShaped('3000004', PROD_NAMES[3], 'relay.jpyc.misconfig', 1, '1h'),
    billing,
    defaults(
      '3000006',
      PROD_NAMES[5],
      [{ type: 'seer_activity_trigger', comparison: ['pr_ready_for_review'], conditionResult: true }],
      ALL_PROJECTS_DETECTOR,
    ),
  ];
}
// 管理外のまま残る 4 件 (Sentry 既定 2 件・relay misconfig・billing の前方一致)。
const PROD_UNMANAGED_NAMES = [PROD_NAMES[0], PROD_NAMES[3], PROD_NAMES[4], PROD_NAMES[5]];
const prodUnmanagedWorkflows = (): ExistingWorkflow[] =>
  prodLikeWorkflows().filter((w) => PROD_UNMANAGED_NAMES.includes(w.name));

// 第 7 回レビュー E6 以前の 14 rule (name・閾値・tag は旧 RULES のまま) が workflow として登録されている状態。
const LEGACY: Array<[string, string, number]> = [
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
];
const legacyWorkflows = (): ExistingWorkflow[] =>
  LEGACY.map(([suffix, tag, value], i) =>
    stored({ name: `OpenPay: ${suffix}`, description: '', eventTags: [tag], threshold: value, interval: '1h' }, String(100 + i)),
  );

// Workflow Engine API の fake。GET はページング (Link ヘッダの cursor) し、POST / PUT は sentryStored で保存する。
// detectors は project で絞った一覧の応答、detectorDetails は GET /detectors/{id}/ が引く先 (既定は DETECTORS 全部)。
type FakeOptions = {
  workflows: ExistingWorkflow[];
  detectors?: ExistingDetector[];
  detectorDetails?: ExistingDetector[];
  pageSize?: number;
};
function fakeSentry({ workflows, detectors = DETECTORS, detectorDetails = DETECTORS, pageSize = 100 }: FakeOptions) {
  const store = new Map(workflows.map((w) => [w.id, w]));
  let nextId = 500;
  const page = (items: unknown[], url: URL) => {
    const cursor = url.searchParams.get('cursor');
    const offset = cursor === null ? 0 : Number(cursor.split(':')[1]);
    const more = offset + pageSize < items.length;
    const self = `${url.origin}${url.pathname}`;
    const link =
      `<${self}?cursor=0:0:1>; rel="previous"; results="false"; cursor="0:0:1", ` +
      `<${self}?cursor=0:${offset + pageSize}:0>; rel="next"; results="${more}"; cursor="0:${offset + pageSize}:0"`;
    return new Response(JSON.stringify(items.slice(offset, offset + pageSize)), { status: 200, headers: { link } });
  };
  const handler = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    if (url.pathname === `/api/0/organizations/${ORG}/workflows/`) {
      if (method === 'GET') return page([...store.values()], url);
      if (method === 'POST') {
        const id = String(nextId++);
        store.set(id, sentryStored(JSON.parse(String(init!.body)), id));
        return new Response(JSON.stringify(store.get(id)), { status: 201 });
      }
    }
    if (url.pathname === `/api/0/organizations/${ORG}/detectors/` && method === 'GET') return page(detectors, url);
    const d = url.pathname.match(new RegExp(`^/api/0/organizations/${ORG}/detectors/(\\d+)/$`));
    const detail = d ? detectorDetails.find((x) => x.id === d[1]) : undefined;
    if (detail && method === 'GET') return new Response(JSON.stringify(detail), { status: 200 });
    const m = url.pathname.match(new RegExp(`^/api/0/organizations/${ORG}/workflows/(\\d+)/$`));
    if (m && method === 'PUT' && store.has(m[1])) {
      store.set(m[1], sentryStored(JSON.parse(String(init!.body)), m[1], store.get(m[1])));
      return new Response(JSON.stringify(store.get(m[1])), { status: 200 });
    }
    return new Response('not found', { status: 404, statusText: 'Not Found' });
  };
  return { store, handler };
}

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
    // 1 つの旧名は 1 つの rule にだけ属する (2 つの rule が同じ既存 workflow を取り合わない)。
    const legacy = RULES.flatMap((r) => r.legacyNames ?? []);
    expect(new Set(legacy).size).toBe(legacy.length);
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
      // 確定前の候補の溢れは異常時だけ。保存済み hash の確定の storage は RPC の一時障害でも出るが、同じく RPC 不明でも
      // 出る照合系 (purchase_reconcile_indeterminate / license.reconcile_indeterminate) と同じ 0 に揃える。
      'creator_store.usdc_purchase_deferred_overflow',
      'creator_store.usdc_purchase_finalize_storage_failed',
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
    const payload = buildWorkflowPayload(sa!, 'mainnet', DETECTOR);
    expect(payload.actionFilters.map((g) => g.conditions[0])).toEqual([
      {
        type: 'tagged_event',
        comparison: { key: 'event', match: 'ew', value: 'smart-account.init-failed' },
        conditionResult: true,
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

describe('setup-sentry-alerts: emit 抽出器 (extractEmits) は lib/logger の binding だけを数える', () => {
  const tagsOf = (path: string, src: string) => [...extractEmits(path, src).tags];

  it("'@/lib/logger' / './logger' / '../logger' からの import を同じ binding として解決する", () => {
    expect(tagsOf('app/api/x/route.ts', "import { logger } from '@/lib/logger';\nlogger.warn('a.b');")).toEqual(['a.b']);
    expect(tagsOf('lib/x.ts', "import { logger } from './logger';\nlogger.error('c.d');")).toEqual(['c.d']);
    expect(tagsOf('lib/sub/x.ts', "import { logger } from '../logger';\nlogger.warn('e.f');")).toEqual(['e.f']);
  });

  it('別名 import (logger as log) の呼び出しも数える', () => {
    expect(tagsOf('lib/x.ts', "import { logger as log } from '@/lib/logger';\nlog.warn('alias.tag');")).toEqual(['alias.tag']);
  });

  it('lib/logger から来ていない同名のローカル logger や別モジュールの logger は数えない (偽物の emit)', () => {
    expect(tagsOf('lib/x.ts', "const logger = { warn: (_m: string) => {} };\nlogger.warn('fake.local');")).toEqual([]);
    expect(tagsOf('lib/x.ts', "import { logger } from 'pino';\nlogger.warn('fake.external');")).toEqual([]);
    expect(tagsOf('lib/x.ts', "import { logger } from '@/lib/other';\nlogger.warn('fake.other');")).toEqual([]);
    // コメントは AST に乗らない。
    expect(tagsOf('lib/x.ts', "import { logger } from '@/lib/logger';\n// logger.warn('in.comment');\n")).toEqual([]);
  });

  it('同じファイルの const 文字列だけを参照する静的なテンプレートは解決し、動的なものは数えない', () => {
    expect(
      tagsOf('lib/x.ts', "import { logger } from '@/lib/logger';\nconst P = 'relay.x';\nlogger.warn(`${P}.reverted`);"),
    ).toEqual(['relay.x.reverted']);
    expect(
      tagsOf('lib/x.ts', "import { logger } from '@/lib/logger';\nfunction f(p: string) { logger.warn(`${p}.reverted`); }"),
    ).toEqual([]);
    expect(tagsOf('lib/x.ts', "import { logger } from '@/lib/logger';\nlogger.warn(`plain.template`);")).toEqual(['plain.template']);
  });

  it('import した logger を隠す同名の引数・ローカル変数の .warn() は数えない (shadowing)', () => {
    const head = "import { logger } from '@/lib/logger';\n";
    expect(tagsOf('lib/x.ts', head + "function f(logger: { warn(m: string): void }) { logger.warn('shadow.param'); }")).toEqual([]);
    expect(tagsOf('lib/x.ts', head + "const g = (logger: { warn(m: string): void }) => logger.warn('shadow.arrow');")).toEqual([]);
    expect(tagsOf('lib/x.ts', head + "function f() { const logger = { warn(_m: string) {} }; logger.warn('shadow.local'); }")).toEqual([]);
    expect(tagsOf('lib/x.ts', head + "function f() { try { throw 0; } catch (logger) { (logger as any).warn('shadow.catch'); } }")).toEqual([]);
    expect(tagsOf('lib/x.ts', head + "function f({ logger }: { logger: { warn(m: string): void } }) { logger.warn('shadow.destructure'); }")).toEqual([]);
    // var は関数スコープ: ブロックの外側でも同じ関数内なら隠す。
    expect(tagsOf('lib/x.ts', head + "function f() { { var logger = { warn(_m: string) {} }; } logger.warn('shadow.var'); }")).toEqual([]);
    expect(tagsOf('lib/x.ts', head + "{ var logger = { warn(_m: string) {} }; }\nlogger.warn('shadow.var.toplevel');")).toEqual([]);
    // switch の case 節はスコープを共有する: 別の case の宣言も隠す。
    expect(
      tagsOf('lib/x.ts', head + "function f(k: number) { switch (k) { case 1: { break; } case 2: const logger = { warn(_m: string) {} }; break; case 3: logger.warn('shadow.case'); } }"),
    ).toEqual([]);
    // 名前付き class 式の名前は class 本体の中で有効。
    expect(
      tagsOf('lib/x.ts', head + "const C = class logger { static warn(_m: string) {} static run() { logger.warn('shadow.classexpr'); } };"),
    ).toEqual([]);
    expect(tagsOf('lib/x.ts', head + "class logger { static warn(_m: string) {} static run() { logger.warn('shadow.classdecl'); } }")).toEqual([]);
    // 隠されていない入れ子の関数からの呼び出しは数える。
    expect(tagsOf('lib/x.ts', head + "function f() { function g() { logger.warn('nested.ok'); } g(); }")).toEqual(['nested.ok']);
    // 別のスコープで同名を宣言しても、その外側の呼び出しには影響しない。
    expect(tagsOf('lib/x.ts', head + "function f(logger: unknown) { void logger; }\nlogger.warn('outside.ok');")).toEqual(['outside.ok']);
  });

  it('トップレベルの const を隠す引数・ブロック内の const で組んだテンプレートは誤解決しない', () => {
    const head = "import { logger } from '@/lib/logger';\nconst P = 'real';\n";
    expect(tagsOf('lib/x.ts', head + 'function f(P: string) { logger.warn(`${P}.failed`); }')).toEqual([]);
    expect(tagsOf('lib/x.ts', head + "function f() { const P = 'other'; logger.warn(`${P}.failed`); }")).toEqual([]);
    expect(tagsOf('lib/x.ts', head + "{ let P = 'block'; logger.warn(`${P}.failed`); }")).toEqual([]);
    // トップレベル const を参照する入れ子の関数は解決する。
    expect(tagsOf('lib/x.ts', head + 'function f() { logger.warn(`${P}.failed`); }')).toEqual(['real.failed']);
    // トップレベルでも const 以外 (let) は再代入されうるので解決しない。
    expect(tagsOf('lib/x.ts', "import { logger } from '@/lib/logger';\nlet Q = 'q';\nlogger.warn(`${Q}.failed`);")).toEqual([]);
  });

  it("makeRespond の prefix は '@/lib/relay/relayRoute' からの binding の呼び出しだけ", () => {
    const ok = extractEmits('app/api/x/route.ts', "import { makeRespond } from '@/lib/relay/relayRoute';\nconst r = makeRespond('relay.x');");
    expect([...ok.respondPrefixes]).toEqual(['relay.x']);
    const fake = extractEmits('app/api/x/route.ts', "const makeRespond = (p: string) => p;\nmakeRespond('relay.fake');");
    expect([...fake.respondPrefixes]).toEqual([]);
  });
});

describe('setup-sentry-alerts: buildWorkflowPayload', () => {
  const SAMPLE: AlertRule = {
    name: 'test rule',
    description: 'sample rule',
    eventTags: ['payment.failed'],
    threshold: 3,
    interval: '1h',
  };

  it('Workflow Engine の形 (every_event の trigger・tag と件数の組・既定の通知先・detector・frequency 60) を作る', () => {
    expect(buildWorkflowPayload(SAMPLE, 'mainnet', DETECTOR)).toEqual({
      name: 'test rule',
      enabled: true,
      environment: 'mainnet',
      config: { frequency: 60 },
      detectorIds: [DETECTOR],
      triggers: {
        logicType: 'any-short',
        conditions: [{ type: 'every_event', comparison: true, conditionResult: true }],
      },
      actionFilters: [
        {
          logicType: 'all',
          conditions: [
            { type: 'tagged_event', comparison: { key: 'event', match: 'eq', value: 'payment.failed' }, conditionResult: true },
            { type: 'event_frequency_count', comparison: { value: 3, interval: '1h' }, conditionResult: true },
          ],
          actions: [DEFAULT_EMAIL],
        },
      ],
    });
  });

  it('triggers は毎 event 評価の every_event だけ (新 UI 既定の 4 trigger = issue の状態変化だけ、にはしない)', () => {
    for (const r of RULES) {
      const types = buildWorkflowPayload(r, 'mainnet', DETECTOR).triggers.conditions.map((c) => c.type);
      expect(types, r.name).toEqual(['every_event']);
      for (const t of UI_DEFAULT_TRIGGERS) expect(types).not.toContain(t);
    }
  });

  it('複数 tag は tag ごとの組 [tagged_event, event_frequency_count] を並べる (組同士は OR)・通知先は組ごとに別オブジェクト', () => {
    const payload = buildWorkflowPayload({ ...SAMPLE, eventTags: ['a.b', 'c.d'] }, 'mainnet', DETECTOR);
    expect(
      payload.actionFilters.map((g) => [g.logicType, ...g.conditions.map((c) => (c.comparison as { value: unknown }).value)]),
    ).toEqual([
      ['all', 'a.b', 3],
      ['all', 'c.d', 3],
    ]);
    expect(payload.actionFilters[0].actions[0]).not.toBe(payload.actionFilters[1].actions[0]);
  });

  it('environment の既定は mainnet (通知は本番だけ・手元は local-<network>・#709)。detector 未指定なら detectorIds は空', () => {
    expect(buildWorkflowPayload(SAMPLE).environment).toBe('mainnet');
    expect(buildWorkflowPayload(SAMPLE, 'testnet').environment).toBe('testnet');
    expect(buildWorkflowPayload(SAMPLE).detectorIds).toEqual([]);
    for (const r of RULES) expect(buildWorkflowPayload(r).environment).toBe('mainnet');
  });
});

describe('setup-sentry-alerts: resolveIssueStreamDetector / nextCursor', () => {
  it('project の issue_stream を選ぶ (Error Monitor・Uptime・全 project 用 (projectId=null) の detector は使わない)', () => {
    expect(resolveIssueStreamDetector(DETECTORS, [], PROJECT)).toEqual({ id: DETECTOR, source: 'detectors' });
    expect(resolveIssueStreamDetector(DETECTORS, [], PROJECT_ID)).toEqual({ id: DETECTOR, source: 'detectors' });
  });

  it('数値の project ID と projectId が一致しない issue_stream は使わない', () => {
    expect(() => resolveIssueStreamDetector(DETECTORS, [], '4500000000000999')).toThrow(/特定できません/);
  });

  it('project の issue_stream が複数なら止める', () => {
    const two = [...DETECTORS, { id: '7000009', projectId: '4500000000000002', type: 'issue_stream' }];
    expect(() => resolveIssueStreamDetector(two, [], PROJECT)).toThrow(/複数あります \(7000001, 7000009\)/);
  });

  it('一覧に無ければ管理対象 workflow の detectorIds から拾う (管理外の workflow の detector は使わない)', () => {
    const managed = stored(RULES[0], '1');
    expect(resolveIssueStreamDetector([], [managed, ...prodUnmanagedWorkflows()], PROJECT)).toEqual({
      id: DETECTOR,
      source: 'workflows',
    });
    // legacyNames で引き当たる本番の手作り alert (relay failure 等) も管理対象として数える。
    expect(resolveIssueStreamDetector([], prodLikeWorkflows(), PROJECT)).toEqual({ id: DETECTOR, source: 'workflows' });
    expect(() => resolveIssueStreamDetector([], prodUnmanagedWorkflows(), PROJECT)).toThrow(/detectorIds は \(none\)/);
    const other = stored(RULES[1], '2', { detectorIds: ['7000005'] });
    expect(() => resolveIssueStreamDetector([], [managed, other], PROJECT)).toThrow(/detectorIds は 7000001,7000005/);
  });

  describe('verifyFallbackDetector: fallback の候補は詳細で型と project を確かめる', () => {
    // project で絞った一覧に Issue Stream が出ない状況 (Error Monitor・Uptime だけ・どちらも projectId を持つ)。
    const listed = DETECTORS.filter((d) => d.type !== 'issue_stream');
    const byId = (id: string) => DETECTORS.find((d) => d.id === id)!;

    it('issue_stream で対象 project のものなら通す (slug は一覧の projectId・数値は ID そのもので照合)', () => {
      expect(() => verifyFallbackDetector(byId(DETECTOR), PROJECT, listed)).not.toThrow();
      expect(() => verifyFallbackDetector(byId(DETECTOR), PROJECT_ID, [])).not.toThrow();
    });

    it('Issue Stream でない detector (error 型など) は止める', () => {
      expect(() => verifyFallbackDetector(byId('7000000'), PROJECT, listed)).toThrow(/type error で、Issue Stream ではありません/);
    });

    it('別 project・全 project 用の Issue Stream は止める', () => {
      const elsewhere = { id: '7000009', projectId: '4500000000000002', type: 'issue_stream' };
      expect(() => verifyFallbackDetector(elsewhere, PROJECT, listed)).toThrow(/project 4500000000000002 の Issue Stream で/);
      expect(() => verifyFallbackDetector(elsewhere, PROJECT_ID, [])).toThrow(/対象 project 4500000000000001/);
      expect(() => verifyFallbackDetector(byId(ALL_PROJECTS_DETECTOR), PROJECT, listed)).toThrow(/\(全 project\)/);
    });

    it('slug で project の ID が一覧から 1 つに決まらなければ (空・複数 project) 判断できないので止める', () => {
      expect(() => verifyFallbackDetector(byId(DETECTOR), PROJECT, [])).toThrow(/確かめられない/);
      const mixed = [...listed, { id: '7000010', projectId: '4500000000000002', type: 'error' }];
      expect(() => verifyFallbackDetector(byId(DETECTOR), PROJECT, mixed)).toThrow(/確かめられない/);
    });
  });

  describe('describeErrorBody: 異常応答の本文は JSON のキーの path だけ (値に宛先が入りうる)', () => {
    it('入れ子のキーを path で出し、値は出さない', () => {
      const body = JSON.stringify({
        actionFilters: [{ actions: [{ config: ['user 1000001 is not a member of this organization'] }] }],
        detail: 'invalid',
      });
      const out = describeErrorBody(body);
      expect(out).toBe('本文のキー: actionFilters[0].actions[0].config, detail');
      expect(out).not.toContain('1000001');
    });

    it('JSON でない本文は字数だけ・キーの無い本文はその旨・多すぎるキーは件数で省く', () => {
      expect(describeErrorBody('<html>Bad Gateway</html>')).toBe('JSON でない本文・24 字');
      expect(describeErrorBody('["only a message"]')).toBe('キーの無い本文');
      const many = JSON.stringify(Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`k${i}`, 'v'])));
      expect(describeErrorBody(many)).toMatch(/k19 ほか 5 件$/);
    });
  });

  it('Link ヘッダの rel="next" の cursor を取り、results="false"・ヘッダ無しは null', () => {
    const link = (more: boolean) =>
      '<https://sentry.io/api/0/organizations/o/workflows/?&cursor=0:0:1>; rel="previous"; results="false"; cursor="0:0:1", ' +
      `<https://sentry.io/api/0/organizations/o/workflows/?&cursor=0:100:0>; rel="next"; results="${more}"; cursor="0:100:0"`;
    expect(nextCursor(link(true))).toBe('0:100:0');
    expect(nextCursor(link(false))).toBeNull();
    expect(nextCursor(null)).toBeNull();
    expect(nextCursor('')).toBeNull();
  });
});

describe('setup-sentry-alerts: planRules / formatPlan (dry-run の出力を固定)', () => {
  const plan = (existing: ExistingWorkflow[], opts: PlanOptions = {}) =>
    planRules(existing, RULES, 'mainnet', { detectorId: DETECTOR, ...opts });
  const ruleOf = (tag: string) => RULES.find((r) => r.eventTags[0] === tag)!;
  const GRANT = 'billing.settle.grant-failed';
  const HISTORY = 'history.load.unreadable-entries-preserved';
  const GRANT_GROUP = 'all[billing.settle.grant-failed + event_frequency_count > 0 / 1h]';

  it('空の Sentry に対しては全 rule が create・retire / 管理外なし', () => {
    const p = plan([]);
    expect(p.create.map((r) => r.name)).toEqual(RULES.map((r) => r.name));
    expect(p.update).toEqual([]);
    expect(p.unchanged).toEqual([]);
    expect(p.retire).toEqual([]);
    expect(p.unmanaged).toEqual([]);
    for (const c of p.create) expect(c.payload.detectorIds).toEqual([DETECTOR]);
  });

  it('Sentry の保存形 (id・organizationId・日付・targetIdentifier null) を経た GET に対しては全 rule が unchanged (往復で冪等)', () => {
    const p = plan(RULES.map((r, i) => stored(r, String(i))));
    expect(p.update.map((u) => `${u.name}: ${u.changes.join('; ')}`)).toEqual([]);
    expect(p.unchanged).toHaveLength(RULES.length);
  });

  it('条件・comparison のキーの並び順や数値の文字列化が違っても同じ workflow', () => {
    const w = stored(ruleOf(GRANT), '4');
    const g = w.actionFilters![0];
    w.actionFilters = [
      {
        ...g,
        conditions: [...g.conditions].reverse().map((c) => ({
          conditionResult: c.conditionResult,
          comparison: Object.fromEntries(
            Object.entries(c.comparison as object).map(([k, v]) => [k, typeof v === 'number' ? String(v) : v]).reverse(),
          ),
          type: c.type,
          id: c.id,
        })),
      },
    ];
    expect(plan([w]).unchanged).toHaveLength(1);
  });

  it('本番と同じ 6 件: 手作りの 2 件は legacyNames で引き当てて上書き更新 (重複させない)、残り 4 件は管理外で触らない', () => {
    const p = plan(prodLikeWorkflows());
    expect(p.update.map((u) => [u.id, u.previousName, u.name])).toEqual([
      ['3000003', 'relayer balance low (mainnet)', 'OpenPay: relayer の残高不足 (relay.relayer.balance_low)'],
      ['3000002', 'relay failure (mainnet)', 'OpenPay: JPYC ガスレス中継の失敗 (relay.jpyc.*)'],
    ]);
    expect(p.create).toHaveLength(RULES.length - 2);
    expect(p.create.map((c) => c.name)).not.toContain('OpenPay: JPYC ガスレス中継の失敗 (relay.jpyc.*)');
    expect(p.unchanged).toEqual([]);
    expect(p.retire).toEqual([]);
    expect(p.unmanaged.map((u) => u.name)).toEqual(PROD_UNMANAGED_NAMES);
    const lines = formatPlan(p, 'mainnet');
    expect(lines[0]).toBe(
      `[setup-sentry-alerts] plan (environment=mainnet): create ${RULES.length - 2} / update 2 / unchanged 0 / retire 0 / 管理外 (触らない) 4`,
    );
    expect(lines).toContain('  · 管理外  relay misconfig (mainnet) (id=3000004): RULES に無い名前 → 触らない');
    expect(lines).toContain('  · 管理外  OpenPay billing failures (id=3000005): RULES に無い名前 → 触らない');
    expect(lines).toContain('  · 管理外  Send a notification for high priority issues (id=3000001): RULES に無い名前 → 触らない');
    expect(lines).toHaveLength(1 + RULES.length + 4);
  });

  it('legacyNames で引き当てた手作りの alert: 名前を RULES に改め、trigger・条件・閾値を RULES どおりに直し、通知先 (user 宛てメール) は保持する', () => {
    const p = plan(prodLikeWorkflows());
    const triggers =
      'triggers any-short[first_seen_event + issue_resolved_trigger + reappeared_event + regression_event] → any-short[every_event]';
    const relay = p.update.find((u) => u.id === '3000002')!;
    expect(relay.changes).toEqual([
      'rename from "relay failure (mainnet)"',
      'frequency 0 → 60',
      triggers,
      'threshold 3 → 0',
      'interval 5m → 1h',
      'filters relay.jpyc.relay_error → relay.jpyc.relay_error + relay.jpyc.reverted + relay.jpyc.misconfig + relay.jpyc.forwarder_invalid',
    ]);
    expect(relay.keptActions).toEqual(['email (user)']);
    expect(relay.payload.name).toBe('OpenPay: JPYC ガスレス中継の失敗 (relay.jpyc.*)');
    expect(relay.payload.triggers.conditions.map((c) => c.type)).toEqual(['every_event']);
    expect(relay.payload.actionFilters).toHaveLength(4);
    for (const g of relay.payload.actionFilters) expect(g.actions).toEqual([USER_EMAIL]);
    expect(relay.payload).not.toHaveProperty('owner');
    const balance = p.update.find((u) => u.id === '3000003')!;
    expect(balance.changes).toEqual([
      'rename from "relayer balance low (mainnet)"',
      'frequency 0 → 60',
      triggers,
      'threshold 1 → 0',
    ]);
    expect(formatPlan(p, 'mainnet')).toContain(
      '  ~ update  OpenPay: relayer の残高不足 (relay.relayer.balance_low) (id=3000003): ' +
        `rename from "relayer balance low (mainnet)"; frequency 0 → 60; ${triggers}; threshold 1 → 0 [actions 保持: email (user)]`,
    );
    // owner (担当) があれば保持する (PUT に owner キーを載せない = Sentry は owner を変えない)。
    const owned = prodLikeWorkflows().map((w) => (w.id === '3000003' ? { ...w, owner: 'user:1000001' } : w));
    const ownedUpdate = plan(owned).update.find((u) => u.id === '3000003')!;
    expect(ownedUpdate.keptOwner).toBe('user:1000001');
    expect(ownedUpdate.payload).not.toHaveProperty('owner');
  });

  it('手作りの relay failure と relay misconfig は同じ rule に当たるので、legacyNames に両方は載せない (載せると止まる)', () => {
    const jpyc = RULES.find((r) => r.name === 'OpenPay: JPYC ガスレス中継の失敗 (relay.jpyc.*)')!;
    expect(jpyc.legacyNames).toEqual(['relay failure (mainnet)']);
    const both = [{ ...jpyc, legacyNames: ['relay failure (mainnet)', 'relay misconfig (mainnet)'] }];
    expect(() => planRules(prodLikeWorkflows(), both, 'mainnet', { detectorId: DETECTOR })).toThrow(/複数/);
  });

  it('E6 以前の 14 rule が登録済みの計画: 旧 name は rename + 閾値更新、tag の追加は filters の行、発火元の無いものは retire', () => {
    const p = plan(legacyWorkflows());
    const updated = Object.fromEntries(p.update.map((u) => [u.name, u]));
    expect(updated['OpenPay: 支払いフォームの失敗 (payment / tip / checkout)']).toMatchObject({
      id: '100',
      previousName: 'OpenPay: payment.failed rate exceeded (alpha threshold)',
      changes: [
        'rename from "OpenPay: payment.failed rate exceeded (alpha threshold)"',
        'threshold 50 → 3',
        'filters payment.failed → payment.failed + tip.failed + checkout.failed',
      ],
    });
    // tag ごとの組 3 つに、既存の通知先を載せる。
    expect(updated['OpenPay: 支払いフォームの失敗 (payment / tip / checkout)'].payload.actionFilters.map((g) => g.actions)).toEqual([
      [DEFAULT_EMAIL_STORED],
      [DEFAULT_EMAIL_STORED],
      [DEFAULT_EMAIL_STORED],
    ]);
    expect(updated['OpenPay: smart-account.init-failed (全フォーム・接尾一致)']).toMatchObject({
      id: '101',
      changes: [
        'rename from "OpenPay: smart-account.init-failed rate exceeded"',
        'threshold 10 → 2',
        'filters smart-account.init-failed → ends-with smart-account.init-failed',
      ],
    });
    expect(updated['OpenPay: history.load.unreadable-entries-preserved spike']?.changes).toEqual(['threshold 100 → 10']);
    expect(updated['OpenPay: billing.settle.grant-failed (paid but not credited)']?.changes).toEqual(['threshold 3 → 0']);
    expect(p.update).toHaveLength(13);
    expect(p.unchanged).toEqual([]);
    expect(p.retire).toEqual([{ id: '102', name: 'OpenPay: x402.middleware.error rate exceeded' }]);
    expect(p.create).toHaveLength(RULES.length - 13);
    expect(p.unmanaged).toEqual([]);
  });

  it('formatPlan は dry-run の出力 (何をどう変えるか) を 1 行 1 workflow で出す', () => {
    const lines = formatPlan(plan(legacyWorkflows()), 'mainnet');
    expect(lines[0]).toBe(
      `[setup-sentry-alerts] plan (environment=mainnet): create ${RULES.length - 13} / update 13 / unchanged 0 / retire 1`,
    );
    expect(lines).toContain(
      '  ~ update  OpenPay: 支払いフォームの失敗 (payment / tip / checkout) (id=100): ' +
        'rename from "OpenPay: payment.failed rate exceeded (alpha threshold)"; threshold 50 → 3; ' +
        'filters payment.failed → payment.failed + tip.failed + checkout.failed [actions 保持: email (issue_owners)]',
    );
    expect(lines).toContain(
      '  ~ update  OpenPay: billing.meter.record-failed (usage volume undercount) (id=112): threshold 5 → 2 ' +
        '[actions 保持: email (issue_owners)]',
    );
    expect(lines).toContain(
      '  + create  OpenPay: relayer の残高不足 (relay.relayer.balance_low) [relay.relayer.balance_low > 0 / 1h]',
    );
    expect(lines).toContain(
      '  + create  OpenPay: JPYC ガスレス中継の失敗 (relay.jpyc.*) ' +
        '[relay.jpyc.relay_error | relay.jpyc.reverted | relay.jpyc.misconfig | relay.jpyc.forwarder_invalid > 0 / 1h]',
    );
    expect(lines).toContain(
      '  - retire  OpenPay: x402.middleware.error rate exceeded (id=102): ' +
        '発火元が無い → Sentry Dashboard (Alerts) で削除 (本 script は削除しない)',
    );
    expect(lines).toHaveLength(1 + RULES.length + 1);
  });

  it('新 UI の形 (既定の 4 trigger・frequency 0) の管理対象は triggers を every_event に直す update (メールの宛先は保持)', () => {
    const rule = ruleOf('relay.relayer.balance_low');
    const p = plan([uiShaped('3100001', rule.name, 'relay.relayer.balance_low', 1, '1h')]);
    expect(p.update).toHaveLength(1);
    const triggers =
      'triggers any-short[first_seen_event + issue_resolved_trigger + reappeared_event + regression_event] → any-short[every_event]';
    expect(p.update[0].changes).toEqual(['frequency 0 → 60', triggers, 'threshold 1 → 0']);
    expect(p.update[0].payload.actionFilters[0].actions).toEqual([USER_EMAIL]);
    expect(formatPlan(p, 'mainnet')).toContain(
      `  ~ update  ${rule.name} (id=3100001): frequency 0 → 60; ${triggers}; threshold 1 → 0 [actions 保持: email (user)]`,
    );
  });

  it('event_frequency_percent (前期間比) は count とは別物なので update (比較種別・比較間隔を行ごとに)', () => {
    const w = stored(ruleOf(GRANT), '3');
    w.actionFilters![0].conditions[1] = {
      id: 'x',
      type: 'event_frequency_percent',
      comparison: { value: 0, interval: '1h', comparison_interval: '1d' },
      conditionResult: true,
    };
    expect(plan([w]).update[0]?.changes).toEqual(['comparisonType percent → count', 'comparisonInterval 1d → (none)']);
  });

  it('閾値と比較種別が同時に変わるときも、比較種別・比較間隔の変更を計画に出す (threshold だけで隠さない)', () => {
    const w = stored(ruleOf(HISTORY), '6');
    w.actionFilters![0].conditions[1] = {
      id: 'x',
      type: 'event_frequency_percent',
      comparison: { value: 100, interval: '1h', comparison_interval: '1d' },
      conditionResult: true,
    };
    expect(plan([w]).update[0]?.changes).toEqual([
      'threshold 100 → 10',
      'comparisonType percent → count',
      'comparisonInterval 1d → (none)',
    ]);
    // 件数だけ違うなら閾値の行だけ。
    expect(plan([stored({ ...ruleOf(HISTORY), threshold: 100 }, '6')]).update[0]?.changes).toEqual(['threshold 100 → 10']);
  });

  it("tag の match が欠損/null/'' の既存 workflow は eq と同じ扱いにせず update (Sentry では match は必須)", () => {
    for (const match of [undefined, null, '']) {
      const w = stored(ruleOf(GRANT), '4');
      const tag = w.actionFilters![0].conditions[0];
      tag.comparison = { ...(tag.comparison as object), match };
      expect(plan([w]).update[0]?.changes, String(match)).toEqual([
        'filters (match なし) billing.settle.grant-failed → billing.settle.grant-failed',
      ]);
    }
  });

  it('同じ tag でも match (eq / co) が違えば update', () => {
    const w = stored(ruleOf(GRANT), '4');
    const tag = w.actionFilters![0].conditions[0];
    tag.comparison = { ...(tag.comparison as object), match: 'co' };
    expect(plan([w]).update[0]?.changes).toEqual([
      'filters contains billing.settle.grant-failed → billing.settle.grant-failed',
    ]);
  });

  it('environment / detector / frequency が違えば update (production → mainnet の取り違えも直す)', () => {
    const prod = plan(RULES.map((r, i) => sentryStored(buildWorkflowPayload(r, 'production', DETECTOR), String(i))));
    expect(prod.update).toHaveLength(RULES.length);
    expect(prod.update[0].changes).toEqual(['environment production → mainnet']);
    expect(plan([stored(ruleOf(GRANT), '5', { detectorIds: ['6999999'] })]).update[0]?.changes).toEqual([
      'detector 6999999 → 7000001',
    ]);
    expect(plan([stored(ruleOf(GRANT), '5', { detectorIds: [] })]).update[0]?.changes).toEqual(['detector (none) → 7000001']);
    expect(plan([stored(ruleOf(GRANT), '5', { config: { frequency: 30 } })]).update[0]?.changes).toEqual([
      'frequency 30 → 60',
    ]);
    expect(plan([stored(ruleOf(GRANT), '5', { config: null })]).update[0]?.changes).toEqual(['frequency (none) → 60']);
  });

  describe('action filter の組の形が違えば全体を出す (通知の条件が変わる)', () => {
    it('別の条件 (level) が混ざった組', () => {
      const w = stored(ruleOf(GRANT), '9');
      w.actionFilters![0].conditions.push({
        id: 'l',
        type: 'level',
        comparison: { level: 40, match: 'gte' },
        conditionResult: true,
      });
      expect(plan([w]).update[0]?.changes).toEqual([
        `actionFilters all[billing.settle.grant-failed + event_frequency_count > 0 / 1h + level] → ${GRANT_GROUP}`,
      ]);
    });

    it('tag をまとめた any-short の組 (tag 同士も件数とも OR になる)', () => {
      const rule = ruleOf('cross-chain.burn.unresolved');
      const w = stored(rule, '9');
      const [a, b] = w.actionFilters!;
      w.actionFilters = [{ ...a, logicType: 'any-short', conditions: [a.conditions[0], b.conditions[0], a.conditions[1]] }];
      expect(plan([w]).update[0]?.changes).toEqual([
        'actionFilters any-short[cross-chain.burn.unresolved + circle.broadcast.response-lost + event_frequency_count > 0 / 1h] → ' +
          'all[cross-chain.burn.unresolved + event_frequency_count > 0 / 1h] | ' +
          'all[circle.broadcast.response-lost + event_frequency_count > 0 / 1h]',
      ]);
    });

    it('論理 (all / any-short) の違い', () => {
      const w = stored(ruleOf(GRANT), '9');
      w.actionFilters = [{ ...w.actionFilters![0], logicType: 'any-short' }];
      expect(plan([w]).update[0]?.changes).toEqual([
        `actionFilters any-short[billing.settle.grant-failed + event_frequency_count > 0 / 1h] → ${GRANT_GROUP}`,
      ]);
    });
  });

  describe('update は既存の通知先 (actions) と owner を保持する (PUT は渡した actionFilters を正とするため)', () => {
    const rule = ruleOf(HISTORY);
    const withActions = (actions: WorkflowAction[]): ExistingWorkflow => {
      const w = stored({ ...rule, threshold: 100 }, '7');
      w.actionFilters = w.actionFilters!.map((g) => ({ ...g, actions: actions.map((a) => ({ id: sid(), ...a })) }));
      return w;
    };

    it('Slack・メール (user) の既存 actions を id を外して PUT payload に載せ、計画には種類だけ出す (宛先の ID は出さない)', () => {
      const p = plan([withActions([SLACK, USER_EMAIL])]);
      expect(p.update).toHaveLength(1);
      const u = p.update[0];
      expect(u.changes).toEqual(['threshold 100 → 10']);
      expect(u.payload.actionFilters[0].actions).toEqual([SLACK, USER_EMAIL]);
      expect(u.keptActions).toEqual(['slack (specific)', 'email (user)']);
      const line = `  ~ update  ${rule.name} (id=7): threshold 100 → 10 [actions 保持: slack (specific), email (user)]`;
      expect(formatPlan(p, 'mainnet')).toContain(line);
      expect(formatPlan(p, 'mainnet').join('\n')).not.toContain('1000001');
    });

    it('既存 workflow に actions が無い (空) ときだけ既定の通知先を付け、計画に明示する', () => {
      const p = plan([withActions([])]);
      expect(p.update[0].payload.actionFilters[0].actions).toEqual([DEFAULT_EMAIL]);
      expect(p.update[0].changes).toEqual(['threshold 100 → 10', 'actions (none) → email (issue_owners)']);
      expect(p.update[0].keptActions).toEqual([]);
    });

    it('組ごとに通知先が違えば、和集合を全組に載せる update にして計画に出す', () => {
      const multi = ruleOf('payment.failed');
      const w = stored(multi, '12');
      w.actionFilters![1] = { ...w.actionFilters![1], actions: [{ id: sid(), ...SLACK }] };
      const p = plan([w]);
      expect(p.update[0]?.changes).toEqual(['actions を全 action filter で共通に (email (issue_owners), slack (specific))']);
      for (const g of p.update[0].payload.actionFilters) expect(g.actions).toEqual([DEFAULT_EMAIL_STORED, SLACK]);
    });

    it('既存 workflow の owner (担当) は PUT payload に載せずに保持し (同じ値の再送で team の権限検証を起こさない)、計画には種別だけ出す', () => {
      const p = plan([{ ...withActions([SLACK]), owner: 'team:42' }]);
      expect(p.update[0].payload).not.toHaveProperty('owner');
      expect(p.update[0].keptOwner).toBe('team:42');
      expect(formatPlan(p, 'mainnet')).toContain(
        `  ~ update  ${rule.name} (id=7): threshold 100 → 10 [actions 保持: slack (specific); owner 保持: team]`,
      );
      // owner が無い (null) 既存 workflow も owner を載せない (PUT で触らない)。
      const none = plan([{ ...withActions([SLACK]), owner: null }]);
      expect(none.update[0].payload).not.toHaveProperty('owner');
      expect(none.update[0].keptOwner).toBeUndefined();
    });

    it('create の actions は既定の通知先 (Suggested Assignees → ActiveMembers)・owner なし', () => {
      for (const c of plan([]).create) {
        for (const g of c.payload.actionFilters) expect(g.actions).toEqual([DEFAULT_EMAIL]);
        expect(c.payload).not.toHaveProperty('owner');
      }
    });
  });

  describe('無効化 (enabled=false) 中の workflow は既定で更新しない (Dashboard で止めたもの)', () => {
    const rule = ruleOf(HISTORY);
    const disabled = () => stored({ ...rule, threshold: 100 }, '8', { enabled: false });

    it('差分があっても update に入れず skippedDisabled に出す (計画に「無効化中のため更新しない」)', () => {
      const p = plan([disabled()]);
      expect(p.update).toEqual([]);
      expect(p.unchanged).toEqual([]);
      expect(p.skippedDisabled).toEqual([{ id: '8', name: rule.name, changes: ['threshold 100 → 10'] }]);
      const lines = formatPlan(p, 'mainnet');
      expect(lines[0]).toBe(
        `[setup-sentry-alerts] plan (environment=mainnet): create ${RULES.length - 1} / update 0 / unchanged 0 / retire 0 / disabled (更新しない) 1`,
      );
      expect(lines).toContain(
        `  ! skip    ${rule.name} (id=8): 無効化中のため更新しない ` +
          '(差分あり: threshold 100 → 10・再有効化して更新するには --include-disabled)',
      );
      expect(lines).toHaveLength(1 + RULES.length);
    });

    it('差分が無い無効化中の workflow は keep のまま (再有効化もしない)', () => {
      const p = plan([stored(rule, '8', { enabled: false })]);
      expect(p.unchanged).toEqual([{ id: '8', name: rule.name, disabled: true }]);
      expect(p.skippedDisabled).toEqual([]);
      expect(formatPlan(p, 'mainnet')).toContain(`  = keep    ${rule.name} (id=8) ※無効化中のまま`);
    });

    it('includeDisabled を明示したときだけ update に入り、enabled: true を送って再有効化することを計画に出す', () => {
      const p = plan([disabled()], { includeDisabled: true });
      expect(p.skippedDisabled).toEqual([]);
      expect(p.update[0]).toMatchObject({ id: '8', reenable: true, changes: ['threshold 100 → 10', 'enabled false → true'] });
      expect(p.update[0].payload.enabled).toBe(true);
      expect(formatPlan(p, 'mainnet')).toContain(
        `  ~ update  ${rule.name} (id=8): threshold 100 → 10; enabled false → true ` +
          '[actions 保持: email (issue_owners)] ※無効化中 → 再有効化して更新する (--include-disabled)',
      );
    });
  });

  it('同じ name (または legacyNames の旧名) の workflow が複数あれば止める (どれを更新するか決められない)', () => {
    const rule = ruleOf(GRANT);
    expect(() => plan([stored(rule, '1'), stored(rule, '2')])).toThrow(
      new RegExp(`複数.*\\n  - ${rule.name.replace(/[()]/g, '\\$&')}: .*\\(id=1\\), .*\\(id=2\\)`),
    );
    const renamed = RULES.find((r) => (r.legacyNames ?? []).length > 0)!;
    const legacy = stored({ ...renamed, name: renamed.legacyNames![0] }, '11');
    expect(() => plan([stored(renamed, '10'), legacy])).toThrow(/\(id=10\), .*\(id=11\)/);
  });

  it('発火元の無い名前は (同名が複数でも) retire に出すだけ', () => {
    const retired = (id: string) =>
      stored({ name: RETIRED_RULE_NAMES[0], description: '', eventTags: ['x402.middleware.error'], threshold: 10, interval: '1h' }, id);
    const p = plan([retired('20'), retired('21')]);
    expect(p.retire).toEqual([
      { id: '20', name: RETIRED_RULE_NAMES[0] },
      { id: '21', name: RETIRED_RULE_NAMES[0] },
    ]);
    expect(p.unmanaged).toEqual([]);
  });
});

describe('setup-sentry-alerts: main (Workflow Engine API の fake 経由の挙動検証)', () => {
  let fetchSpy: MockInstance<typeof fetch>;
  const calls = () => fetchSpy.mock.calls.map(([url, init]) => `${init?.method ?? 'GET'} ${String(url)}`);
  const writes = () => calls().filter((c) => !c.startsWith('GET '));
  const bodies = (method: string) =>
    fetchSpy.mock.calls
      .filter(([, init]) => init?.method === method)
      .map(([url, init]) => ({ url: String(url), body: JSON.parse(String(init!.body)) as WorkflowPayload }));
  const useFake = (opts: FakeOptions) => {
    const fake = fakeSentry(opts);
    fetchSpy.mockImplementation(fake.handler);
    return fake;
  };
  const load = () => import('../../scripts/setup-sentry-alerts.mjs');
  const GET_WORKFLOWS = `GET ${ORG_URL}/workflows/?per_page=100`;
  const GET_DETECTORS = `GET ${ORG_URL}/detectors/?projectSlug=${PROJECT}&per_page=100`;

  beforeEach(() => {
    fetchSpy = vi.fn() as unknown as typeof fetchSpy;
    vi.stubGlobal('fetch', fetchSpy);
    // main() は計画を console.log に出す。テスト出力を汚さないよう既定では捨てる (出力を見る test は自前で spy する)。
    vi.spyOn(console, 'log').mockImplementation(() => {});
    process.env.SENTRY_AUTH_TOKEN = 'test_token';
    process.env.SENTRY_ORG_SLUG = ORG;
    process.env.SENTRY_PROJECT_SLUG = PROJECT;
    delete process.env.SENTRY_ALERT_ENV;
    delete process.env.SENTRY_API_BASE;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.resetModules();
    delete process.env.SENTRY_API_BASE;
  });

  it('現行 RULES が全て登録済みなら GET (workflows・detectors) だけで書き込みを出さない', async () => {
    useFake({ workflows: RULES.map((r, i) => stored(r, String(i + 1))) });
    const plan = await (await load()).main([]);
    expect(calls()).toEqual([GET_WORKFLOWS, GET_DETECTORS]);
    expect(plan.unchanged).toHaveLength(RULES.length);
    const auth = (fetchSpy.mock.calls[0][1]!.headers as Record<string, string>).Authorization;
    expect(auth).toBe('Bearer test_token');
  });

  it('SENTRY_PROJECT_SLUG が数値の project ID なら detectors を project=<id> で引く', async () => {
    process.env.SENTRY_PROJECT_SLUG = PROJECT_ID;
    useFake({ workflows: [] });
    const plan = await (await load()).main(['--dry-run']);
    expect(calls()).toEqual([GET_WORKFLOWS, `GET ${ORG_URL}/detectors/?project=${PROJECT_ID}&per_page=100`]);
    expect(plan.create[0].payload.detectorIds).toEqual([DETECTOR]);
  });

  it('空の Sentry には全 rule を POST で作成する (Issue Stream に接続・every_event・mainnet・既定の通知先・owner なし)', async () => {
    const fake = useFake({ workflows: [] });
    await (await load()).main([]);
    const posts = bodies('POST');
    expect(posts).toHaveLength(RULES.length);
    for (const { url, body } of posts) {
      expect(url).toBe(`${ORG_URL}/workflows/`);
      expect(body).toMatchObject({
        enabled: true,
        environment: 'mainnet',
        config: { frequency: 60 },
        detectorIds: [DETECTOR],
        triggers: { logicType: 'any-short', conditions: [{ type: 'every_event', comparison: true, conditionResult: true }] },
      });
      expect(body).not.toHaveProperty('owner');
      for (const g of body.actionFilters) expect(g.actions).toEqual([DEFAULT_EMAIL]);
    }
    expect(fake.store.size).toBe(RULES.length);
  });

  it('往復: 旧 14 rule + 本番と同じ 6 件 → 1 回目は POST / PUT、2 回目は GET だけで書き込みゼロ (冪等)', async () => {
    const fake = useFake({ workflows: [...legacyWorkflows(), ...prodLikeWorkflows()] });
    const mod = await load();
    const first = await mod.main([]);
    // 旧 14 rule のうち 13 件 + 本番の手作り 2 件 (legacyNames) を PUT で更新。
    expect(first.update).toHaveLength(15);
    expect(first.create).toHaveLength(RULES.length - 15);
    expect(first.retire.map((r) => r.id)).toEqual(['102']);
    expect(first.unmanaged.map((u) => u.name)).toEqual(PROD_UNMANAGED_NAMES);
    expect(writes()).toHaveLength(RULES.length);
    expect(writes()).toContain(`PUT ${ORG_URL}/workflows/3000002/`);
    expect(writes()).toContain(`PUT ${ORG_URL}/workflows/3000003/`);
    // 管理外 (3000001・3000004〜6) と retire (102) には書き込まない。DELETE もしない。
    for (const w of writes()) expect(w).not.toMatch(/\/workflows\/(102|300000[1456])\/$|^DELETE/);
    // 上書きした手作りの alert は RULES の名前になり、user 宛てメールのまま。
    expect(fake.store.get('3000002')!.name).toBe('OpenPay: JPYC ガスレス中継の失敗 (relay.jpyc.*)');
    for (const g of fake.store.get('3000002')!.actionFilters!) {
      expect(g.actions!.map(({ id: _id, ...a }) => a)).toEqual([USER_EMAIL]);
    }
    fetchSpy.mockClear();
    const second = await mod.main([]);
    expect(calls()).toEqual([GET_WORKFLOWS, GET_DETECTORS]);
    expect(second.update.map((u) => `${u.name}: ${u.changes.join('; ')}`)).toEqual([]);
    expect(second.create).toEqual([]);
    expect(second.unchanged).toHaveLength(RULES.length);
  });

  it('PUT の body: 既存の通知先 (メール・Slack) を全組に載せ、owner は送らずに保持し、id を含まず、enabled を明示する', async () => {
    const existing = legacyWorkflows().map((w) => ({
      ...w,
      owner: 'team:42',
      actionFilters: w.actionFilters!.map((g) => ({
        ...g,
        actions: [
          { id: sid(), ...USER_EMAIL },
          { id: sid(), ...SLACK },
        ],
      })),
    }));
    const fake = useFake({ workflows: existing });
    const mod = await load();
    await mod.main([]);
    const puts = bodies('PUT');
    expect(puts).toHaveLength(13);
    for (const { url, body } of puts) {
      expect(body.enabled).toBe(true);
      // owner キーを送らない = Sentry は owner を変えない (同じ team を送り直すと権限の再検証で 400 になりうる)。
      expect(body).not.toHaveProperty('owner');
      expect(fake.store.get(url.match(/\/workflows\/(\d+)\/$/)![1])!.owner).toBe('team:42');
      for (const g of body.actionFilters) expect(g.actions).toEqual([USER_EMAIL, SLACK]);
      // 送った内容が正 (id の無い要素は作り直し・送らなかった要素は削除) なので id は送らない。
      expect(JSON.stringify(body)).not.toContain('"id"');
    }
    const payment = puts.find((p) => p.body.name === 'OpenPay: 支払いフォームの失敗 (payment / tip / checkout)')!;
    expect(payment.url).toBe(`${ORG_URL}/workflows/100/`);
    expect(payment.body.actionFilters).toHaveLength(3);
    for (const { body } of bodies('POST')) {
      for (const g of body.actionFilters) expect(g.actions).toEqual([DEFAULT_EMAIL]);
      expect(body).not.toHaveProperty('owner');
    }
    // 2 回目は owner を含めて差分なし (owner を送らなくても往復で冪等)。
    fetchSpy.mockClear();
    const second = await mod.main([]);
    expect(writes()).toEqual([]);
    expect(second.unchanged).toHaveLength(RULES.length);
  });

  it('無効化中の workflow には PUT を送らず、--include-disabled のときだけ enabled: true で送る', async () => {
    const rule = RULES.find((r) => r.eventTags[0] === 'history.load.unreadable-entries-preserved')!;
    const existing = RULES.map((r, i) =>
      r === rule ? stored({ ...rule, threshold: 100 }, '8', { enabled: false }) : stored(r, String(1000 + i)),
    );
    useFake({ workflows: existing });
    const mod = await load();
    const plan = await mod.main([]);
    expect(writes()).toEqual([]);
    expect(plan.skippedDisabled.map((s) => s.id)).toEqual(['8']);
    fetchSpy.mockClear();
    const plan2 = await mod.main(['--include-disabled']);
    expect(writes()).toEqual([`PUT ${ORG_URL}/workflows/8/`]);
    expect(bodies('PUT')[0].body.enabled).toBe(true);
    expect(plan2.update.map((u) => u.id)).toEqual(['8']);
  });

  it('ページング: Link ヘッダの cursor を最後まで辿り、2 ページ目以降の管理対象も引き当てる', async () => {
    useFake({ workflows: [...prodUnmanagedWorkflows(), ...RULES.map((r, i) => stored(r, String(2000 + i)))], pageSize: 10 });
    const plan = await (await load()).main(['--dry-run']);
    const pages = Math.ceil((4 + RULES.length) / 10);
    expect(calls()).toEqual([
      GET_WORKFLOWS,
      ...Array.from({ length: pages - 1 }, (_, i) => `${GET_WORKFLOWS}&cursor=0%3A${(i + 1) * 10}%3A0`),
      GET_DETECTORS,
    ]);
    expect(plan.unchanged).toHaveLength(RULES.length);
    expect(plan.create).toEqual([]);
    expect(plan.unmanaged).toHaveLength(4);
  });

  it('同じ cursor を返し続ける Link ヘッダは止める (GET を無限に叩かない)', async () => {
    fetchSpy.mockImplementation(
      async () =>
        new Response('[]', {
          status: 200,
          headers: { link: '<https://sentry.io/x?cursor=0:100:0>; rel="next"; results="true"; cursor="0:100:0"' },
        }),
    );
    await expect((await load()).main(['--dry-run'])).rejects.toThrow(/同じ cursor \(0:100:0\)/);
    expect(calls()).toHaveLength(2);
  });

  it('同名の workflow が 2 つあればエラーで止め、書き込みをしない', async () => {
    useFake({ workflows: [stored(RULES[0], '1'), stored(RULES[0], '2')] });
    await expect((await load()).main([])).rejects.toThrow(/複数/);
    expect(writes()).toEqual([]);
  });

  describe('Issue Stream detector が一覧に無いときの fallback (管理対象 workflow の接続先を詳細で確かめる)', () => {
    // project で絞った一覧に Issue Stream が出ない (Error Monitor・Uptime だけ)。
    const listed = DETECTORS.filter((d) => d.type !== 'issue_stream');

    it('接続先が対象 project の issue_stream なら、詳細を GET して確かめてから使う', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      useFake({ workflows: [stored(RULES[0], '1')], detectors: listed });
      const plan = await (await load()).main(['--dry-run']);
      expect(calls()).toEqual([GET_WORKFLOWS, GET_DETECTORS, `GET ${ORG_URL}/detectors/${DETECTOR}/`]);
      expect(plan.unchanged).toHaveLength(1);
      expect(plan.create[0].payload.detectorIds).toEqual([DETECTOR]);
      const out = log.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(out).toContain('管理対象 workflow の detectorIds から・詳細で issue_stream と project を確認済み');
      log.mockRestore();
    });

    it('接続先が error 型の detector なら止め、書き込みをしない', async () => {
      useFake({ workflows: [stored(RULES[0], '1', { detectorIds: ['7000000'] })], detectors: listed });
      await expect((await load()).main([])).rejects.toThrow(/Issue Stream ではありません/);
      expect(writes()).toEqual([]);
    });

    it('接続先が別 project の issue_stream なら止め、書き込みをしない', async () => {
      const elsewhere = { id: '7000009', projectId: '4500000000000002', type: 'issue_stream' };
      useFake({
        workflows: [stored(RULES[0], '1', { detectorIds: ['7000009'] })],
        detectors: listed,
        detectorDetails: [...DETECTORS, elsewhere],
      });
      await expect((await load()).main([])).rejects.toThrow(/のものではありません/);
      expect(writes()).toEqual([]);
    });

    it('slug で project の ID を一覧から確かめられなければ止める (数値の project ID なら通る)', async () => {
      useFake({ workflows: [stored(RULES[0], '1')], detectors: [] });
      const mod = await load();
      await expect(mod.main([])).rejects.toThrow(/確かめられない/);
      expect(writes()).toEqual([]);
      fetchSpy.mockClear();
      process.env.SENTRY_PROJECT_SLUG = PROJECT_ID;
      const plan = await mod.main(['--dry-run']);
      expect(plan.unchanged).toHaveLength(1);
    });

    it('管理対象 workflow にも接続先が無ければ止める', async () => {
      useFake({ workflows: prodUnmanagedWorkflows(), detectors: listed });
      await expect((await load()).main([])).rejects.toThrow(/Issue Stream detector を特定できません/);
      expect(writes()).toEqual([]);
    });
  });

  it('--dry-run は GET だけで計画を出し、書き込みを一切しない', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    useFake({ workflows: [...legacyWorkflows(), ...prodLikeWorkflows()] });
    await (await load()).main(['--dry-run']);
    expect(calls()).toEqual([GET_WORKFLOWS, GET_DETECTORS]);
    const out = log.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(out).toContain(`create ${RULES.length - 15} / update 15 / unchanged 0 / retire 1 / 管理外 (触らない) 4`);
    expect(out).toContain(`Issue Stream detector: id=${DETECTOR} (detectors 一覧から)`);
    expect(out).toContain('dry-run');
    expect(out).not.toContain('test_token');
    log.mockRestore();
  });

  it('適用の出力にも token を出さない', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    useFake({ workflows: legacyWorkflows() });
    await (await load()).main([]);
    const out = log.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(out).toContain('=== summary ===');
    expect(out).not.toContain('test_token');
    log.mockRestore();
  });

  it('--dry-run --offline は Sentry に接続せず (token 不要)、空の Sentry に対する計画を出す', async () => {
    delete process.env.SENTRY_AUTH_TOKEN;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await (await load()).main(['--dry-run', '--offline']);
    expect(fetchSpy).not.toHaveBeenCalled();
    const out = log.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(out).toContain(`create ${RULES.length} / update 0 / unchanged 0 / retire 0`);
    log.mockRestore();
  });

  it('--offline は --dry-run なしでは拒否する (適用を省いた気になる事故を防ぐ)', async () => {
    await expect((await load()).main(['--offline'])).rejects.toThrow(/--offline/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  describe('Sentry API が non-OK を返したら例外 (既定は status・メソッド・path と本文のキー名だけ)', () => {
    // PUT の検証エラーの形 (値に送った宛先が入りうる)。
    const rejected = JSON.stringify({
      actionFilters: [{ actions: [{ config: ['user 1000001 is not a member of this organization'] }] }],
    });
    const failPut = () => {
      const fake = fakeSentry({ workflows: legacyWorkflows() });
      fetchSpy.mockImplementation(async (input, init) =>
        init?.method === 'PUT'
          ? new Response(rejected, { status: 400, statusText: 'Bad Request' })
          : fake.handler(input, init),
      );
    };
    afterEach(() => {
      delete process.env.SENTRY_ALERTS_DEBUG;
    });

    it('既定では本文の値 (宛先) を出さず、キーの path と SENTRY_ALERTS_DEBUG の案内だけ', async () => {
      failPut();
      const err = (await (await load()).main([]).catch((e: unknown) => e)) as Error;
      expect(err.message).toBe(
        'Sentry API PUT /api/0/organizations/test-org/workflows/100/ → 400 Bad Request ' +
          '(本文のキー: actionFilters[0].actions[0].config・本文の全文は SENTRY_ALERTS_DEBUG=1 で表示)',
      );
      expect(err.message).not.toContain('1000001');
      expect(err.message).not.toContain('test_token');
    });

    it('SENTRY_ALERTS_DEBUG=1 のときだけ本文の全文を出す', async () => {
      process.env.SENTRY_ALERTS_DEBUG = '1';
      failPut();
      const err = (await (await load()).main([]).catch((e: unknown) => e)) as Error;
      expect(err.message).toBe(
        `Sentry API PUT /api/0/organizations/test-org/workflows/100/ → 400 Bad Request (本文: ${rejected})`,
      );
      expect(err.message).not.toContain('test_token');
    });

    it('JSON でない本文 (HTML のエラーページ等) は字数だけ', async () => {
      fetchSpy.mockImplementation(async () => new Response(`<html>${'x'.repeat(1000)}</html>`, { status: 502, statusText: 'Bad Gateway' }));
      const err = (await (await load()).main([]).catch((e: unknown) => e)) as Error;
      expect(err.message).toBe(
        'Sentry API GET /api/0/organizations/test-org/workflows/?per_page=100 → 502 Bad Gateway ' +
          '(JSON でない本文・1013 字・本文の全文は SENTRY_ALERTS_DEBUG=1 で表示)',
      );
    });
  });

  it('SENTRY_API_BASE で接続先を変えられる (self-host 等)', async () => {
    process.env.SENTRY_API_BASE = 'https://sentry.example.com';
    useFake({ workflows: [] });
    await (await load()).main(['--dry-run']);
    expect(calls()[0]).toBe(`GET https://sentry.example.com/api/0/organizations/${ORG}/workflows/?per_page=100`);
  });

  it('SENTRY_AUTH_TOKEN 未設定で例外 (silent fail せず明示的に error)', async () => {
    delete process.env.SENTRY_AUTH_TOKEN;
    await expect((await load()).main([])).rejects.toThrow(/SENTRY_AUTH_TOKEN/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
