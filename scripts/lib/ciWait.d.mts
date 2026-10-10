export const MAIN_BRANCH: string;
/** 期待集合の正本 (repo root からの path)。 */
export const EXPECTED_CHECKS_PATH: string;
/** ローカルの正本 (EXPECTED_CHECKS_PATH) から作った期待集合。 */
export const EXPECTED_PR_CHECKS: readonly string[];
export const PENDING_STATES: Set<string>;
export const PASS_CONCLUSIONS: Set<string>;

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

export function parseExpectedChecksJson(text: string): { checks: string[] } | { error: string };
export function normalizeRollup(rollup: unknown[] | null | undefined): NormalizedCheck[];
export function expectedChecksFor(baseRefName: string | null | undefined): string[];
export function evaluateChecks(checks: readonly NormalizedCheck[], expected: readonly string[]): CheckVerdict;
