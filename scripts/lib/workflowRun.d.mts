export interface WorkflowStep {
  /** step の mapping そのもの (YAML の値・run / env を含む) */
  keys: Record<string, unknown>;
  envKeys: string[];
  run: string | null;
}
export interface WorkflowJob {
  job: string;
  steps: WorkflowStep[];
  envKeys: string[];
  hasDefaults: boolean;
}
export function parseWorkflow(source: string): { envKeys: string[]; hasDefaults: boolean; jobs: WorkflowJob[] };
export function parseWorkflowJobs(source: string): WorkflowJob[];
export const PIPEFAIL_BUILD_RUN: readonly string[];
export const ALLOWED_RUN_LINES: readonly string[];
export function runLines(run: string): string[];
export function installGuardViolations(source: string, name?: string): string[];
