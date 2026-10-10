export interface WorkflowStep {
  keys: Record<string, string>;
  run: string | null;
}
export interface WorkflowJob {
  job: string;
  steps: WorkflowStep[];
}
export function parseWorkflowJobs(source: string): WorkflowJob[];
export const ALLOWED_RUN_LINES: readonly string[];
export function runLines(run: string): string[];
export function installGuardViolations(source: string, name?: string): string[];
