export interface WorkflowJob {
  id: string;
  name: string;
  /** 'if:' / 'strategy:' / 'uses:' / 'expression in name' / 'multi-line name' / 'empty definition' 等 — check 名が静的に決まらない理由 */
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

export function parseWorkflow(source: string): ParsedWorkflow;
export function analyzeWorkflows(workflowsDir: string): { required: string[]; excluded: WorkflowNote[]; unsupported: WorkflowNote[] };
