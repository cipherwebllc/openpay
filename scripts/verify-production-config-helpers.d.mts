export const REVERIFY_MAX_AGE_MS: number;

export type ReverifyRun = {
  databaseId: number;
  conclusion?: string | null;
  createdAt?: string | null;
};

export type ReverifyRunAssessment = {
  ok: boolean;
  detail: string;
};

export function assessReverifyRun(
  run: ReverifyRun | undefined,
  log: string,
  nowMs?: number,
): ReverifyRunAssessment;
