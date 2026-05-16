// TypeScript 型宣言: scripts/setup-sentry-alerts.mjs の export 用 (test 等から import するため)。

export type AlertRule = {
  name: string;
  description: string;
  eventTag: string;
  threshold: number;
  interval: string;
};

export type SentryRulePayload = {
  name: string;
  environment: string;
  actionMatch: 'all' | 'any';
  filterMatch: 'all' | 'any';
  frequency: number;
  conditions: Array<{ id: string; value: number; interval: string }>;
  filters: Array<{ id: string; key: string; match: string; value: string }>;
  actions: Array<{ id: string }>;
};

export const RULES: readonly AlertRule[];
export function buildRulePayload(rule: AlertRule, env?: string): SentryRulePayload;
export function main(): Promise<void>;
