export interface LoadTestOptions {
  url: string;
  concurrency: number;
  duration: number;
  maxErrorRate: number;
  maxP99Ms: number;
  payTo: string;
  allowProd: boolean;
}

export const PRODUCTION_HOSTS: ReadonlySet<string>;
export const MAX_CONCURRENCY: number;
export const MAX_PRODUCTION_CONCURRENCY: number;
export function parseArgs(argv: readonly string[]): LoadTestOptions;
