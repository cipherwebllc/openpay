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

/** Pimlico 残高 cron の最新 run のログから、実際に残高を読んだかを判定する。 */
export function assessPimlicoRun(log: string): { ok: boolean; detail: string };

/** /api/facilitator/supported の receiptSigner が入っているか (署名付きの有料商品が売れる状態か)。 */
export function assessReceiptSigner(status: number, body: unknown): { ok: boolean; detail: string };
