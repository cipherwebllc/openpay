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

/** `gh run list` の結果 (新しい順) から、完了した最新の run を選ぶ (実行中の run はログがまだ無い)。 */
export function latestCompletedRun<T extends { status?: string | null }>(runs: unknown): T | undefined;

/** Pimlico 残高 cron の最新 run のログから、実際に残高を読んだかを判定する。 */
export function assessPimlicoRun(log: string): { ok: boolean; detail: string };

/** /api/facilitator/supported の receiptSigner が入っているか (署名付きの有料商品が売れる状態か)。 */
export function assessReceiptSigner(status: number, body: unknown): { ok: boolean; detail: string };

/** Node の 2026-10 のセキュリティ修正が入った最小の版 (major → [major, minor, patch])。 */
export const NODE_RUNTIME_MINIMUM: Partial<Record<number, [number, number, number]>>;

/** 本番の関数の Node の版がセキュリティ修正の入った版以上か (detail に正確な版は書かない)。 */
export function assessNodeRuntime(status: number, body: unknown): { ok: boolean; detail: string };

export const NODE_RUNTIME_TIMEOUT_MS: number;

/** /api/cron/runtime を CRON_SECRET で読んで判定する (通信の失敗・停止は固定の文言で NG・例外の中身は出さない)。 */
export function checkNodeRuntime(
  base: string,
  secret: string | undefined,
  options?: { fetchImpl?: typeof fetch; timeoutMs?: number },
): Promise<{ ok: boolean; detail: string }>;

export type ProductionCheck = { name: string; ok: boolean; detail: string; severity?: 'error' | 'warn' };

/** 検査の結果を出力の行と exit code にまとめる (warn の失敗は ::warning:: だけで exit 1 にしない)。 */
export function summarizeChecks(checks: ProductionCheck[]): { lines: string[]; exitCode: 0 | 1 };
