import { PIMLICO_BALANCE_HEADER } from './lib/pimlico-balance-output.mjs';

// 掲載の再検証 (/api/cron/reverify) の鮮度。毎時の主トリガーは Vercel Cron (vercel.json・毎時 0 分) で、
// GitHub Actions (reverify-cron.yml) は予備。どちらから起動されても、200 で終えた run の時刻が KV の cursor に残り、
// /api/cron/reverify-status で読める。3 時間 = 毎時の run が 2 回続けて失敗 (KV の一時障害で 503 等) するまでは
// 赤にせず、両方が止まったら次の検証 (毎日 + main への push ごと) で気づける幅。
export const REVERIFY_MAX_AGE_MS = 3 * 60 * 60 * 1000;
// 本番と runner の時計のずれで、直前の run を「未来の日時」と誤判定しないための幅。
export const REVERIFY_CLOCK_SKEW_MS = 5 * 60 * 1000;

// 予備のトリガー reverify-cron.yml の run 履歴の基準。毎時 (cron '5 * * * *') の指定だが、GitHub Actions の
// schedule は混雑で遅れ・間引きされ、実測では 2.1〜6.6 時間おき (中央値 4.1 時間・2026-09-14〜09-28 の 80 回)・
// 0.4〜7.4 時間おき (平均 4.4 時間・2026-10-24〜30 の 30 回)。3 時間の基準では間隔の 76% で fail し、止まった・
// secret 不一致といった本当の異常と区別できなかった。実測の最大に余裕を持たせて 8 時間。毎時動いているかは
// 上の REVERIFY_MAX_AGE_MS で見るので、こちらは予備が secret の不一致 (401) 等で止まったことを見つけるため。
export const REVERIFY_GITHUB_RUN_MAX_AGE_MS = 8 * 60 * 60 * 1000;

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
    nowMs - createdAtMs > REVERIFY_GITHUB_RUN_MAX_AGE_MS
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
 * /api/cron/reverify-status の応答から、再検証が最後に 200 で終えた run が REVERIFY_MAX_AGE_MS 以内かを判定する。
 * 記録が無い (null) のは、新しい版の最初の 200 の run の前 (deploy 直後・最長 1 時間) なので warn にとどめる
 * (毎回 503 で記録が入らないままなら、予備の GitHub の run が 200 でなくなり、そちらの検査が赤になる)。
 */
export function assessReverifyFreshness(status, body, nowMs = Date.now()) {
  if (status !== 200) {
    return { ok: false, detail: `HTTP ${status} (/api/cron/reverify-status が読めない)` };
  }
  const lastOkAt = body && typeof body === 'object' ? body.lastOkAt : undefined;
  if (lastOkAt === null) {
    return {
      ok: false,
      severity: 'warn',
      detail: '最後に 200 で終えた run の記録がまだ無い (deploy 直後なら次の毎時 0 分の run で入る)',
    };
  }
  const lastOkMs = typeof lastOkAt === 'string' ? Date.parse(lastOkAt) : Number.NaN;
  const ageMs = nowMs - lastOkMs;
  if (!Number.isFinite(lastOkMs) || ageMs < -REVERIFY_CLOCK_SKEW_MS) {
    return { ok: false, detail: `最後に 200 で終えた run の日時が不正 (lastOkAt=${String(lastOkAt)})` };
  }
  const ageMinutes = Math.max(0, Math.round(ageMs / 60_000));
  if (ageMs > REVERIFY_MAX_AGE_MS) {
    return {
      ok: false,
      detail: `最後に 200 で終えた run が ${ageMinutes} 分前 (${lastOkAt}) — 基準の ${REVERIFY_MAX_AGE_MS / 60_000} 分を超えた (Vercel Cron と GitHub の両方が止まったか、run が 503 を返し続けている)`,
    };
  }
  return { ok: true, detail: `最後に 200 で終えた run は ${ageMinutes} 分前 (${lastOkAt})` };
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

export const NODE_RUNTIME_TIMEOUT_MS = 10_000;

/**
 * CRON_SECRET で守った内部の確認口 (/api/cron/runtime・/api/cron/reverify-status) を読む。
 * 通信の失敗で script ごと落ちる・応答が止まって job の 10 分を使い切ると、warn の check でも全体が赤になり、
 * ほかの check の結果も出なくなるので、ここで止めて null を返す (呼び出し側が固定の文言にし、例外の中身は
 * 公開ログに出さない)。期限は本文の読み取りまで効く。
 */
async function readCronProbe(base, path, secret, fetchImpl, timeoutMs) {
  try {
    const r = await fetchImpl(`${base}${path}`, {
      headers: { authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    let body = null;
    try {
      body = await r.json();
    } catch {
      body = null;
    }
    return { status: r.status, body };
  } catch {
    return null;
  }
}

/** /api/cron/runtime を CRON_SECRET で読み、assessNodeRuntime で判定する。 */
export async function checkNodeRuntime(base, secret, { fetchImpl = fetch, timeoutMs = NODE_RUNTIME_TIMEOUT_MS } = {}) {
  if (!secret) return { ok: false, detail: 'CRON_SECRET 未設定 — 確認できない' };
  const res = await readCronProbe(base, '/api/cron/runtime', secret, fetchImpl, timeoutMs);
  return res ? assessNodeRuntime(res.status, res.body) : { ok: false, detail: '/api/cron/runtime に接続できない' };
}

/** /api/cron/reverify-status を CRON_SECRET で読み、assessReverifyFreshness で判定する。 */
export async function checkReverifyFreshness(
  base,
  secret,
  { fetchImpl = fetch, timeoutMs = NODE_RUNTIME_TIMEOUT_MS, nowMs } = {},
) {
  if (!secret) return { ok: false, detail: 'CRON_SECRET 未設定 — 確認できない' };
  const res = await readCronProbe(base, '/api/cron/reverify-status', secret, fetchImpl, timeoutMs);
  return res
    ? assessReverifyFreshness(res.status, res.body, nowMs ?? Date.now())
    : { ok: false, detail: '/api/cron/reverify-status に接続できない' };
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
