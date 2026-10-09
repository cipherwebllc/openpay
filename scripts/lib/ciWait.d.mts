export const PENDING_STATES: Set<string>;
export const PASS_CONCLUSIONS: Set<string>;

export interface WorkflowJob {
  id: string;
  name: string;
  conditional: 'if' | 'strategy' | null;
}

export interface ParsedWorkflow {
  pullRequest: boolean;
  filtered: 'paths' | 'paths-ignore' | 'types' | null;
  jobs: WorkflowJob[];
}

export interface ExcludedCheck {
  workflow: string;
  job?: string;
  reason: string;
}

export interface NormalizedCheck {
  name: string;
  status: string;
  conclusion: string;
}

export interface CheckVerdict {
  pending: NormalizedCheck[];
  missing: string[];
  failed: NormalizedCheck[];
  settled: boolean;
  ok: boolean;
}

export function parseWorkflow(source: string): ParsedWorkflow;
export function expectedPrChecks(workflowsDir: string): { expected: string[]; excluded: ExcludedCheck[] };
export function normalizeRollup(rollup: unknown[] | null | undefined): NormalizedCheck[];
export function evaluateChecks(checks: readonly NormalizedCheck[], expected: readonly string[]): CheckVerdict;
