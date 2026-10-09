export declare const COVERAGE_THRESHOLDS: Readonly<{
  statements: number;
  branches: number;
  functions: number;
  lines: number;
}>;

export declare function evaluateCoverage(
  summaryText: string | null,
  thresholds?: Readonly<Record<string, number>>,
): {
  ok: boolean;
  readable: boolean;
  results: { metric: string; pct: unknown; min: number; pass: boolean }[];
};
