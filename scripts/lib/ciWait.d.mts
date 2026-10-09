export const MAIN_BRANCH: string;
export const EXPECTED_PR_CHECKS: readonly string[];
export const PENDING_STATES: Set<string>;
export const PASS_CONCLUSIONS: Set<string>;

export interface WorkflowJob {
  id: string;
  name: string;
  /** 'if:' / 'strategy:' / 'uses:' / 'expression in name' / 'block scalar or empty name' — check 名が静的に決まらない理由 */
  conditional: string | null;
  needs: string[];
}

export interface ParsedWorkflow {
  pullRequest: boolean;
  filtered: string | null;
  branches: string[] | null;
  branchesIgnore: string[] | null;
  jobs: WorkflowJob[];
  unsupported: string[];
}

export interface WorkflowNote {
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
export function analyzeWorkflows(workflowsDir: string): { required: string[]; excluded: WorkflowNote[]; unsupported: WorkflowNote[] };
export function normalizeRollup(rollup: unknown[] | null | undefined): NormalizedCheck[];
export function expectedChecksFor(baseRefName: string | null | undefined): string[];
export function evaluateChecks(checks: readonly NormalizedCheck[], expected: readonly string[]): CheckVerdict;
