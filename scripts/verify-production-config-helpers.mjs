import { PIMLICO_BALANCE_HEADER } from './lib/pimlico-balance-output.mjs';

// reverify-cron.yml は毎時 (cron '5 * * * *') の指定だが、GitHub Actions の schedule は混雑で遅れ・間引きされ、
// 実測では 2.1〜6.6 時間おき (中央値 4.1 時間・2026-09-14〜09-28 の 80 回・すべて success)。3 時間の基準では
// 間隔の 76% で fail し、止まった・secret 不一致といった本当の異常と区別できなかった。実測の最大に余裕を持たせて 8 時間。
// 止まったら半日以内に気づける (日次の Vercel cron がフォールバック)。
export const REVERIFY_MAX_AGE_MS = 8 * 60 * 60 * 1000;

/**
 * Pimlico 残高 cron の最新 run のログから、実際に残高を読んだか (見出しの出力があるか) を判定する。
 * ログには shell の SOURCE 行も含まれるので、skip は GitHub がレンダした `##[warning]Secrets 未設定` で見る。
 */
export function assessPimlicoRun(log) {
  if (log.includes(PIMLICO_BALANCE_HEADER)) {
    return { ok: true, detail: '実 balance check 実行済 (script output 検出)' };
  }
  if (/##\[warning\]Secrets 未設定/.test(log)) {
    return { ok: false, detail: 'graceful skip — PIMLICO_PAYMASTER_POLYGON / BASE / ALERT_WEBHOOK_URL 未設定。balance 監視ゼロ' };
  }
  return { ok: false, detail: 'run は実行されたが balance output 不在 (build 失敗 / script error / 出力の見出しの変更の可能性)' };
}

export function assessReverifyRun(run, log, nowMs = Date.now()) {
  if (!run) {
    return { ok: false, detail: '直近の completed run なし' };
  }
  if (run.conclusion !== 'success') {
    return {
      ok: false,
      detail: `run #${run.databaseId} conclusion=${run.conclusion ?? 'unknown'}`,
    };
  }
  const createdAtMs = Date.parse(run.createdAt);
  if (
    !Number.isFinite(createdAtMs) ||
    nowMs - createdAtMs < 0 ||
    nowMs - createdAtMs > REVERIFY_MAX_AGE_MS
  ) {
    return {
      ok: false,
      detail: `run #${run.databaseId} が stale/日時不正 (createdAt=${run.createdAt ?? 'missing'})`,
    };
  }
  if (!/\bHTTP 200\b/.test(log)) {
    return {
      ok: false,
      detail: `run #${run.databaseId} に HTTP 200 の実行出力なし`,
    };
  }
  return {
    ok: true,
    detail: `run #${run.databaseId} HTTP 200 (${run.createdAt})`,
  };
}
