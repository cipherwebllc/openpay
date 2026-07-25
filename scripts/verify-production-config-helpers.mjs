export const REVERIFY_MAX_AGE_MS = 3 * 60 * 60 * 1000;

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
