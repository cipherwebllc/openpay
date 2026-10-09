export function publicFeatureFlagKeys(sources: readonly string[]): string[];
export function sourceTextsUnder(root: string, dirs: readonly string[]): string[];
export function budgetBuildEnv(input: {
  parentEnv: Record<string, string | undefined>;
  prodFlagsText: string;
  flagKeys: readonly string[];
}): Record<string, string | undefined>;
