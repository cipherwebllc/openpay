import { PIMLICO_BALANCE_HEADER } from './lib/pimlico-balance-output.mjs';

// reverify-cron.yml は毎時 (cron '5 * * * *') の指定だが、GitHub Actions の schedule は混雑で遅れ・間引きされ、
// 実測では 2.1〜6.6 時間おき (中央値 4.1 時間・2026-09-14〜09-28 の 80 回・すべて success)。3 時間の基準では
// 間隔の 76% で fail し、止まった・secret 不一致といった本当の異常と区別できなかった。実測の最大に余裕を持たせて 8 時間。
// 止まったら半日以内に気づける (日次の Vercel cron がフォールバック)。
export const REVERIFY_MAX_AGE_MS = 8 * 60 * 60 * 1000;

/**
 * `gh run list` の結果 (新しい順) から、完了した最新の run を選ぶ。実行中の run はログがまだ無いので、
 * それを読むと「出力不在」と誤判定する (merge の push と schedule が同時に走ると起きる)。
 */
export function latestCompletedRun(runs) {
  return Array.isArray(runs) ? runs.find((run) => run?.status === 'completed') : undefined;
}

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

/**
 * /api/facilitator/supported の receiptSigner (X402_RECEIPT_SIGNING_KEY から導いた公開アドレス) が入っているか。
 * 鍵が無い・不正だと x402 の受領証明が出ず、署名付きの有料商品 (JPYC 支払い証明・Directory ライセンス版) は
 * 支払いを受けずに 503 を返し続ける (第 7 回レビュー E3) → 売れない状態を外から検出する。
 */
export function assessReceiptSigner(status, body) {
  if (status !== 200) {
    return { ok: false, detail: `HTTP ${status} (/api/facilitator/supported が読めない)` };
  }
  const signer = body && typeof body === 'object' ? body.receiptSigner : undefined;
  if (typeof signer === 'string' && /^0x[0-9a-fA-F]{40}$/.test(signer)) {
    return { ok: true, detail: `receiptSigner ${signer}` };
  }
  return {
    ok: false,
    detail: 'receiptSigner が null — X402_RECEIPT_SIGNING_KEY 未設定/不正。受領証明が出ず、署名付きの有料商品は 503 で売れない',
  };
}

// Node の 2026-10 のセキュリティ修正 (Brotli の展開の範囲外書き込み CVE-2026-111497 ほか) が入った最小の版。
// 本番は出品者の URL を取りに行って本文を読む (lib/x402/moderation.ts) ので、これより古いと突かれる経路が残る。
// 次の Node のセキュリティ修正が出たら、ここを上げる。
export const NODE_RUNTIME_MINIMUM = { 22: [22, 23, 4], 24: [24, 22, 1], 26: [26, 12, 1] };

/**
 * 本番の関数の Node の版 (/api/cron/runtime) が、セキュリティ修正の入った版以上か。
 * 結果は公開リポの Actions のログに出るので、detail には正確な版を書かない (major と以上/未満だけ)。
 */
export function assessNodeRuntime(status, body) {
  if (status !== 200) {
    return { ok: false, detail: `HTTP ${status} (/api/cron/runtime が読めない)` };
  }
  const version = body && typeof body === 'object' ? body.node : undefined;
  const match = typeof version === 'string' ? /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version) : null;
  if (!match) return { ok: false, detail: '版を読み取れない' };
  const [major, minor, patch] = match.slice(1).map(Number);
  const minimum = NODE_RUNTIME_MINIMUM[major];
  if (!minimum) {
    return { ok: false, detail: `major ${major}: 最小の版が決まっていない (NODE_RUNTIME_MINIMUM に足す)` };
  }
  const atLeast = minor !== minimum[1] ? minor > minimum[1] : patch >= minimum[2];
  return atLeast
    ? { ok: true, detail: `major ${major}: セキュリティ修正の入った版以上` }
    : { ok: false, detail: `major ${major}: セキュリティ修正の入った版より古い (Vercel の配布待ち)` };
}

/**
 * 検査の結果を、出力する行と exit code にまとめる。
 * severity 'warn' の失敗は ::warning:: を出すだけで exit 1 にしない。operator が直せない待ち (Vercel の配布待ち等)
 * が何日も赤を続けると、直すべき設定漏れの検知が赤慣れで埋もれるため。
 */
export function summarizeChecks(checks) {
  const lines = ['Production config verification:'];
  let failed = 0;
  let warned = 0;
  for (const c of checks) {
    const warn = !c.ok && c.severity === 'warn';
    lines.push(`  ${c.ok ? '✓' : warn ? '⚠' : '✗'} ${c.name}`, `      ${c.detail}`);
    if (warn) {
      warned += 1;
      lines.push(`::warning title=${c.name}::${c.detail}`);
    } else if (!c.ok) {
      failed += 1;
    }
  }
  lines.push('');
  if (failed > 0) {
    lines.push(`⚠ ${failed}/${checks.length} 件 inactive — 上記詳細を確認`);
    return { lines, exitCode: 1 };
  }
  lines.push(`✅ ${checks.length - warned}/${checks.length} 件 active${warned > 0 ? ` (警告 ${warned} 件)` : ''}`);
  return { lines, exitCode: 0 };
}
