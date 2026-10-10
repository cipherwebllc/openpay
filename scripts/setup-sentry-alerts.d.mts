// TypeScript 型宣言: scripts/setup-sentry-alerts.mjs の export 用 (test 等から import するため)。

export type TagMatch = 'eq' | 'ew' | 'sw' | 'co';

export type AlertRule = {
  name: string;
  /** 以前の name。planRules が旧名の workflow を引き当てて rename (PUT) する。 */
  legacyNames?: string[];
  description: string;
  /** 複数なら tag ごとに action filter (tagged_event + event_frequency_count) を並べる (OR)。 */
  eventTags: string[];
  /** tagged_event の比較 (既定 eq)。 */
  match?: TagMatch;
  /** event_frequency_count の「N 回より多い」の N (0 = 1 件目で通知)。 */
  threshold: number;
  interval: string;
};

/** Workflow Engine の data condition (triggers / actionFilters の中身)。GET では id が付く。 */
export type WorkflowCondition = {
  id?: string;
  type: string;
  comparison?: unknown;
  conditionResult?: unknown;
  [k: string]: unknown;
};

/** 通知先 (action)。GET では id が付く。config.targetIdentifier は user / team の ID。 */
export type WorkflowAction = {
  id?: string;
  type: string;
  integrationId?: string | number | null;
  data?: Record<string, unknown>;
  config?: { targetType?: string; targetDisplay?: string | null; targetIdentifier?: string | null; [k: string]: unknown };
  status?: string;
  [k: string]: unknown;
};

export type WorkflowConditionGroup = {
  id?: string;
  organizationId?: string;
  logicType: string;
  conditions: WorkflowCondition[];
  actions?: WorkflowAction[];
};

/** POST / PUT の body。 */
export type WorkflowPayload = {
  name: string;
  enabled: boolean;
  environment: string;
  config: { frequency: number };
  detectorIds: string[];
  triggers: WorkflowConditionGroup;
  actionFilters: Array<WorkflowConditionGroup & { actions: WorkflowAction[] }>;
  owner?: string;
};

/** Sentry API (GET /organizations/{org}/workflows/) が返す workflow。比較は planRules が必要な項目に絞る。 */
export type ExistingWorkflow = {
  id: string;
  name: string;
  organizationId?: string;
  createdBy?: string | null;
  dateCreated?: string;
  dateUpdated?: string;
  lastTriggered?: string | null;
  environment?: string | null;
  owner?: string | null;
  /** false は Dashboard で無効化中。既定で更新対象外。 */
  enabled?: boolean;
  config?: { frequency?: number | string | null; [k: string]: unknown } | null;
  detectorIds?: string[];
  triggers?: WorkflowConditionGroup | null;
  actionFilters?: WorkflowConditionGroup[];
};

/** Sentry API (GET /organizations/{org}/detectors/) が返す detector。projectId=null は「全 project」用。 */
export type ExistingDetector = {
  id: string;
  type: string;
  name?: string;
  projectId?: string | null;
  [k: string]: unknown;
};

export type WorkflowPlan = {
  create: Array<{ name: string; payload: WorkflowPayload }>;
  update: Array<{
    id: string;
    name: string;
    previousName?: string;
    changes: string[];
    /** 既存 workflow から引き継いだ通知先の要約 ("email (user)" 等・宛先の ID は含まない)。 */
    keptActions: string[];
    /** 既存 workflow から引き継いだ owner (担当・"team:<id>" / "user:<id>")。無ければ undefined。 */
    keptOwner?: string;
    /** 無効化中の workflow を --include-disabled で更新する (再有効化する)。 */
    reenable?: boolean;
    payload: WorkflowPayload;
  }>;
  unchanged: Array<{ id: string; name: string; disabled?: boolean }>;
  retire: Array<{ id: string; name: string }>;
  /** 無効化 (enabled=false) 中で差分がある workflow。既定では更新しない。 */
  skippedDisabled: Array<{ id: string; name: string; changes: string[] }>;
  /** RULES (と RETIRED) に無い名前の workflow。触らない。 */
  unmanaged: Array<{ id: string; name: string }>;
};

export type PlanOptions = {
  /** project の Issue Stream detector の id。desired の detectorIds になる。 */
  detectorId?: string | null;
  /** 無効化中の workflow も update に入れる (再有効化する)。 */
  includeDisabled?: boolean;
};

export const RULES: readonly AlertRule[];
export const RETIRED_RULE_NAMES: readonly string[];
export function buildWorkflowPayload(rule: AlertRule, env?: string, detectorId?: string | null): WorkflowPayload;
export function planRules(
  existing: ExistingWorkflow[],
  rules?: readonly AlertRule[],
  env?: string,
  opts?: PlanOptions,
): WorkflowPlan;
export function formatPlan(plan: WorkflowPlan, env?: string): string[];
export function resolveIssueStreamDetector(
  detectors: ExistingDetector[],
  workflows: ExistingWorkflow[],
  project: string,
  rules?: readonly AlertRule[],
): { id: string; source: 'detectors' | 'workflows' };
export function nextCursor(link: string | null | undefined): string | null;
export function main(argv?: string[]): Promise<WorkflowPlan>;
