/** 本番の最後の正常な batch (/api/cron/reverify-status の lastOkAt) の鮮度の基準 (毎時 + 2 回の失敗まで)。 */
export const REVERIFY_MAX_AGE_MS: number;
export const REVERIFY_CLOCK_SKEW_MS: number;
/** 予備のトリガー reverify-cron.yml の run 履歴の鮮度の基準 (GitHub の schedule の実測の遅れに合わせる)。 */
export const REVERIFY_GITHUB_RUN_MAX_AGE_MS: number;

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

/** /api/cron/reverify-status の応答から、再検証の最後の成功が基準の時間内かを判定する (記録なしは warn)。 */
export function assessReverifyFreshness(
  status: number,
  body: unknown,
  nowMs?: number,
): { ok: boolean; detail: string; severity?: 'warn' };

/** /api/cron/reverify-status が 404 (新しい版の配信待ち) のときに読み直すまでの待ち (ms)。 */
export const REVERIFY_STATUS_READY_RETRY_MS: readonly number[];

/** /api/cron/reverify-status を CRON_SECRET で読んで判定する (404 だけ読み直す・通信の失敗・停止は固定の文言で NG)。 */
export function checkReverifyFreshness(
  base: string,
  secret: string | undefined,
  options?: {
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    nowMs?: number;
    retryDelaysMs?: readonly number[];
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<{ ok: boolean; detail: string; severity?: 'warn' }>;

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
