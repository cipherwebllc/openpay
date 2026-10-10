export interface ShellSegment {
  command: string;
  before: string;
  after: string;
}
export interface WorkflowStep {
  raw: string;
  keys: Record<string, string>;
  run: string | null;
  commands: string[];
  segments: ShellSegment[];
}
export interface WorkflowJob {
  job: string;
  steps: WorkflowStep[];
}
export function parseWorkflowJobs(source: string): WorkflowJob[];
export function splitShell(shell: string): ShellSegment[];
export function splitCommands(shell: string): string[];
export function classifyNpmCommand(command: string): { tool: 'npm' | 'npx'; subcommand: string | null; args: string[]; prefix: string | null } | null;
export function installGuardViolations(source: string, name?: string): string[];
