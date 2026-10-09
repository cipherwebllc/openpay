// TypeScript 型宣言: scripts/setup-sentry-alerts.mjs の export 用 (test 等から import するため)。

export type TagMatch = 'eq' | 'ew' | 'sw' | 'co';

export type AlertRule = {
  name: string;
  /** 以前の name。planRules が旧名の rule を引き当てて rename (PUT) する。 */
  legacyNames?: string[];
  description: string;
  /** 複数なら TaggedEventFilter を並べて filterMatch=any (OR)。 */
  eventTags: string[];
  /** TaggedEventFilter の比較 (既定 eq)。 */
  match?: TagMatch;
  /** EventFrequencyCondition の「N 回より多い」の N (0 = 1 件目で通知)。 */
  threshold: number;
  interval: string;
};

export type SentryRulePayload = {
  name: string;
  environment: string;
  actionMatch: 'all' | 'any';
  filterMatch: 'all' | 'any';
  frequency: number;
  conditions: Array<{ id: string; comparisonType: 'count'; value: number; interval: string }>;
  filters: Array<{ id: string; key: string; match: string; value: string }>;
  actions: Array<{ id: string }>;
};

/** Sentry API (GET /rules/) が返す rule。表示用 field (name 等) が増えるので比較は planRules が絞る。 */
export type ExistingRule = {
  id: string;
  name: string;
  environment?: string | null;
  actionMatch?: string;
  filterMatch?: string;
  frequency?: number;
  conditions?: Array<{ id: string; value?: number | string; interval?: string; [k: string]: unknown }>;
  filters?: Array<{ id: string; key?: string; match?: string; value?: string; [k: string]: unknown }>;
  actions?: Array<{ id: string; [k: string]: unknown }>;
};

export type RulePlan = {
  create: Array<{ name: string; payload: SentryRulePayload }>;
  update: Array<{
    id: string;
    name: string;
    previousName?: string;
    changes: string[];
    /** 既存 rule から引き継いだ actions の class 名 (PUT で通知先を消さない)。 */
    keptActions: string[];
    payload: SentryRulePayload & { actions: Array<{ id: string; [k: string]: unknown }> };
  }>;
  unchanged: Array<{ id: string; name: string }>;
  retire: Array<{ id: string; name: string }>;
};

export const RULES: readonly AlertRule[];
export const RETIRED_RULE_NAMES: readonly string[];
export function buildRulePayload(rule: AlertRule, env?: string): SentryRulePayload;
export function planRules(existing: ExistingRule[], rules?: readonly AlertRule[], env?: string): RulePlan;
export function formatPlan(plan: RulePlan, env?: string): string[];
export function main(argv?: string[]): Promise<RulePlan>;
