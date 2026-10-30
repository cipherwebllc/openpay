import { NextResponse } from 'next/server';
import { requireCronAuth } from '@/lib/cronAuth';
import { kvEndpointInfo } from '@/lib/kv';
import { DIRECTORY_ENTRIES } from '@/lib/directory/data';
import { publishedDirectoryEntries } from '@/lib/directory/query';
import {
  probeDirectorySource,
  writeDirectoryVerificationSnapshot,
} from '@/lib/directory/verification';
import type { DirectoryVerificationSnapshot } from '@/lib/directory/types';
import { logger } from '@/lib/logger';
import {
  FIRST_PARTY_RESOURCES,
  firstPartyResourceUrl,
  type FirstPartyResource,
} from '@/lib/x402/firstParty';
import {
  acquireReverifyLock,
  applyExternalReverify,
  applyFirstPartyReverify,
  isViolationVerdict,
  listExternalReverifyIds,
  mapWithConcurrency,
  readExternalReverifyTarget,
  readFirstPartyVerification,
  readReverifyCursor,
  probeForPendingFirstVerification,
  probeForReverifyDetailed,
  releaseReverifyLock,
  REVERIFY_CONCURRENCY,
  REVERIFY_STORAGE_ERROR_QUARANTINE,
  selectReverifyBatch,
  sendReverifyAlert,
  utcDateId,
  utcHourRunId,
  writeReverifyCursor,
  type ReverifyApplyResult,
  type ReverifyTarget,
  type ReverifyVerdict,
} from '@/lib/x402/reverify';
import type { GateAcceptMismatch } from '@/lib/x402/registrationGateMatch';

export const runtime = 'nodejs';
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

type ProbeOutcome = {
  target: ReverifyTarget;
  checked: boolean;
  verdict?: ReverifyVerdict;
  apply?: ReverifyApplyResult;
  storageError?: boolean;
  /** storageError の要約 (KV の reason/status/文言)。cron 応答と warn ログに載せる。 */
  storageDetail?: string;
  /**
   * 観測だけの照合の結果 (印のない外部の掲載の ok の 402・null = 一致)。照合しなかった回 (公開待ち・first-party・ok 以外)
   * には無い。verdict・CAS・集計のほかの数には使わない (集計の observe* だけが数える)。
   */
  observedMismatch?: GateAcceptMismatch | null;
};

// storage 失敗の内訳 (503 応答・x402.reverify.storage_error warn)。操作者だけが読む
// (cron 認証の内側) ので Upstash のエラー文言をそのまま載せる。値 (record 本体) は載せない。
type StorageFailure = {
  target: string;
  stage: 'read' | 'apply' | 'write';
  detail: string | null;
};

function targetLabel(target: ReverifyTarget): string {
  return target.kind === 'external'
    ? `external:${target.id}`
    : `first-party:${target.path}`;
}

type ReverifySummary = {
  runId: string;
  checked: number;
  ok: number;
  violations: number;
  transient: number;
  hidden: number;
  restored: number;
  skippedDuplicate: number;
  urlTaken: number;
  directory: {
    checked: number;
    ok: number;
    failed: number;
    unknown: number;
    ran: boolean;
  };
  // 観測だけの照合 (印のない外部の掲載の ok の 402 を、公開待ちと同じ照合に通した回数と、そのうち合わなかった回数)。
  // alert の条件 (shouldAlert) と alert の文面には入れない = 観測は通知も verdict も変えない。
  observeChecked: number;
  observeMismatch: number;
};

const firstPartyByPath = new Map<string, FirstPartyResource>(
  FIRST_PARTY_RESOURCES.map((resource) => [resource.path, resource]),
);

async function processTarget(
  target: ReverifyTarget,
  checkedAt: string,
  runId: string,
): Promise<ProbeOutcome> {
  if (target.kind === 'external') {
    const read = await readExternalReverifyTarget(target.id);
    if (!read.ok) {
      return { target, checked: false, storageError: true, storageDetail: read.detail };
    }
    if (!read.resource) return { target, checked: false };
    if (read.resource.verification?.lastRunId === runId) {
      return {
        target,
        checked: false,
        apply: { applied: false, reason: 'duplicate' },
      };
    }
    const probedUrl = read.resource.url;
    // 最初の再検証を待つ新規掲載 (pendingFirstVerification) は、登録と同じ照合 (受取先・チェーン・JPYC・forwarder) を
    // 通った 402 だけで公開に進める (E-3)。照合に使った受取先を CAS に渡し、probe の間にそれが編集されていたら結果を
    // 捨てる。公開中・モデレーションの hidden の掲載は照合しない (verdict は従来どおり)。
    const matchedPayTo = read.resource.pendingFirstVerification === true ? read.resource.payTo : undefined;
    // 印のない掲載 (公開中・モデレーションの hidden) は、同じ照合を「観測だけ」する (2026-10-30 user 裁定 (b) の観測の段)。
    // 結果は warn と集計に残すだけで、verdict・CAS の引数 (matchedPayTo は渡さない)・復帰は変えない。1 週間の観測で
    // 不一致が 0 なら、次の PR で照合を強制する (docs/DEPLOY_CHECKLIST.md §14.5)。
    const probe = matchedPayTo !== undefined
      ? await probeForPendingFirstVerification(probedUrl, matchedPayTo)
      : await probeForReverifyDetailed(probedUrl, {}, read.resource.payTo);
    const { verdict, authClass } = probe;
    if ('mismatch' in probe && probe.mismatch) {
      logger.warn('x402.reverify.pending_gate_mismatch', {
        runId,
        target: targetLabel(target),
        mismatch: probe.mismatch,
      });
    }
    const observedMismatch = 'observedMismatch' in probe ? probe.observedMismatch : undefined;
    const apply = await applyExternalReverify(
      target.id,
      probedUrl,
      verdict,
      checkedAt,
      runId,
      authClass,
      matchedPayTo,
    );
    const storageError = apply.applied
      ? apply.restoreBlocked === 'storage'
      : apply.reason === 'storage';
    if (apply.applied && apply.restoreBlocked === 'url_taken') {
      logger.warn('x402.reverify.url_taken', { runId, target: targetLabel(target) });
    }
    if (observedMismatch) {
      // CAS の後に出すのは、モデレーションの hidden が合わない 402 のまま実際に復帰したか (restored) を一緒に残すため
      // (照合を強制する前に塞ぐ穴そのもの)。warn は「その時の 402 が掲載と合わなかった」記録で、CAS が結果を捨てた回
      // (url_changed・duplicate 等) にも出る。host は observedMismatch がある = SSRF-safe fetch がこの URL を
      // new URL で読めて 402 を受け取った回なので、ここで読み直しても throw しない。
      logger.warn('x402.reverify.observe_gate_mismatch', {
        runId,
        target: targetLabel(target),
        host: new URL(probedUrl).host,
        mismatch: observedMismatch,
        visibility: read.resource.hidden === true ? 'hidden' : 'visible',
        restored: apply.applied && apply.hiddenBefore && !apply.hiddenAfter,
      });
    }
    return {
      target,
      checked: true,
      verdict,
      apply,
      storageError,
      ...(storageError ? { storageDetail: apply.applied ? 'url claim unavailable' : apply.detail } : {}),
      ...(observedMismatch !== undefined ? { observedMismatch } : {}),
    };
  }

  const resource = firstPartyByPath.get(target.path);
  if (!resource) return { target, checked: false };
  const read = await readFirstPartyVerification(target.path);
  if (!read.ok) {
    return { target, checked: false, storageError: true, storageDetail: read.detail };
  }
  if (read.state?.verification?.lastRunId === runId) {
    return {
      target,
      checked: false,
      apply: { applied: false, reason: 'duplicate' },
    };
  }
  const probedUrl = firstPartyResourceUrl(resource);
  const { verdict, authClass } = await probeForReverifyDetailed(probedUrl);
  const apply = await applyFirstPartyReverify(
    target.path,
    probedUrl,
    verdict,
    checkedAt,
    runId,
    authClass,
  );
  const storageError = !apply.applied && apply.reason === 'storage';
  return {
    target,
    checked: true,
    verdict,
    apply,
    storageError,
    ...(storageError && !apply.applied ? { storageDetail: apply.detail } : {}),
  };
}

function summarize(
  runId: string,
  outcomes: readonly ProbeOutcome[],
  directory: ReverifySummary['directory'],
): ReverifySummary {
  const summary: ReverifySummary = {
    runId,
    checked: 0,
    ok: 0,
    violations: 0,
    transient: 0,
    hidden: 0,
    restored: 0,
    skippedDuplicate: 0,
    urlTaken: 0,
    directory,
    observeChecked: 0,
    observeMismatch: 0,
  };
  for (const outcome of outcomes) {
    if (!outcome.checked) {
      if (!outcome.apply?.applied && outcome.apply?.reason === 'duplicate') {
        summary.skippedDuplicate += 1;
      }
      continue;
    }
    summary.checked += 1;
    if (outcome.observedMismatch !== undefined) {
      summary.observeChecked += 1;
      if (outcome.observedMismatch !== null) summary.observeMismatch += 1;
    }
    if (outcome.verdict === 'ok_402_openpay') summary.ok += 1;
    else if (outcome.verdict && isViolationVerdict(outcome.verdict)) {
      summary.violations += 1;
    } else summary.transient += 1;

    if (outcome.apply?.applied) {
      if (outcome.apply.restoreBlocked === 'url_taken') summary.urlTaken += 1;
      if (!outcome.apply.hiddenBefore && outcome.apply.hiddenAfter) {
        summary.hidden += 1;
      }
      if (outcome.apply.hiddenBefore && !outcome.apply.hiddenAfter) {
        summary.restored += 1;
      }
    }
  }
  return summary;
}

function alertMessage(
  summary: ReverifySummary,
  outcomes: readonly ProbeOutcome[],
): string {
  const firstPartyViolations = outcomes.filter(
    (outcome) =>
      outcome.target.kind === 'first-party' &&
      outcome.apply?.applied &&
      outcome.verdict &&
      isViolationVerdict(outcome.verdict),
  ).length;
  return [
    `[OpenPay reverify ${summary.runId}] checked=${summary.checked} ok=${summary.ok}`,
    `violations=${summary.violations} transient=${summary.transient}`,
    `hidden=${summary.hidden} restored=${summary.restored}`,
    `FIRST_PARTY_VIOLATIONS=${firstPartyViolations}`,
    `directory_failed=${summary.directory.failed} directory_unknown=${summary.directory.unknown}`,
  ].join(' ');
}

async function runDirectoryVerification(
  checkedAt: string,
): Promise<{ summary: ReverifySummary['directory']; saved: boolean }> {
  const entries = publishedDirectoryEntries(DIRECTORY_ENTRIES);
  const results = await mapWithConcurrency(
    entries,
    REVERIFY_CONCURRENCY,
    async (entry) => ({ entry, ok: await probeDirectorySource(entry.sourceUrl) }),
  );
  const snapshot: DirectoryVerificationSnapshot = Object.fromEntries(
    results.map(({ entry, ok }) => [
      entry.slug,
      { checkedAt, ok, sourceUrl: entry.sourceUrl },
    ]),
  );
  const saved = await writeDirectoryVerificationSnapshot(snapshot);
  const ok = results.filter((result) => result.ok === true).length;
  // failed=確定消滅 (404/410) のみ。判定不能 (null) を failed に混ぜると alert が常時鳴る +
  // sourceOk:false の誤情報配信になる (2026-07-14 実害)。
  const failed = results.filter((result) => result.ok === false).length;
  return {
    summary: {
      checked: results.length,
      ok,
      failed,
      unknown: results.length - ok - failed,
      ran: true,
    },
    saved,
  };
}

export async function GET(req: Request): Promise<NextResponse> {
  // cron 認証は lib/cronAuth に集約 (CRON_SECRET は server 専用・比較は timing-safe)。
  if (!requireCronAuth(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const now = new Date();
  const runId = utcHourRunId(now);
  const lock = await acquireReverifyLock(runId);
  if (lock === 'storage') {
    return NextResponse.json({ error: 'storage_unavailable' }, { status: 503 });
  }
  if (lock === 'locked') {
    return NextResponse.json({ runId, skipped: 'locked' });
  }

  try {
    const [cursor, externalIds] = await Promise.all([
      readReverifyCursor(),
      listExternalReverifyIds(),
    ]);
    if (cursor === null || externalIds === null) {
      return NextResponse.json({ error: 'storage_unavailable' }, { status: 503 });
    }

    const selected = selectReverifyBatch(
      externalIds,
      FIRST_PARTY_RESOURCES.map((resource) => resource.path),
      cursor,
    );
    const checkedAt = now.toISOString();
    const outcomes = await mapWithConcurrency(
      selected.targets,
      REVERIFY_CONCURRENCY,
      (target) => processTarget(target, checkedAt, runId),
    );

    const today = utcDateId(now);
    const directoryResult =
      cursor.directoryDate === today
        ? {
            summary: { checked: 0, ok: 0, failed: 0, unknown: 0, ran: false },
            saved: true,
          }
        : await runDirectoryVerification(checkedAt);
    const storageError =
      outcomes.some((outcome) => outcome.storageError) || !directoryResult.saved;
    const directoryPart =
      directoryResult.saved && directoryResult.summary.ran
        ? { directoryDate: today }
        : cursor.directoryDate
          ? { directoryDate: cursor.directoryDate }
          : {};
    // storage エラー中は cursor を進めない (取りこぼした record を次回もう一度見るため) が、
    // 同じ offset で永続的に失敗する record が 1 件あると cursor が永久に凍結し、その先の
    // record が二度と再検証されなくなる (B12)。3 回連続で同じ offset が失敗したら warn を出して
    // その batch を quarantine し、cursor を進めて巡回を再開する。
    const storageErrorStreak = storageError
      ? (cursor.storageErrorStreak ?? 0) + 1
      : 0;
    const quarantined =
      storageError && storageErrorStreak >= REVERIFY_STORAGE_ERROR_QUARANTINE;
    if (quarantined) {
      logger.warn('x402.reverify.cursor_quarantined', {
        runId,
        offset: cursor.offset,
        nextOffset: selected.nextOffset,
        streak: storageErrorStreak,
      });
    }
    // lastOkAt = storage エラーの無かった batch の開始時刻 (鮮度の心拍)。storage エラーの run は進めず直前の値を
    // 引き継ぐ。「200 を返した run」とは一致しない: cursor の SET が反映されたのに応答 (ack) だけ失敗した run は
    // 503 を返しても進み、cursor の保存より後の処理 (alert・lock の解放) の失敗も反映しない。鮮度の検査が見たいのは
    // 「batch が storage エラーなしで動いたか」なので、これで足りる。
    const lastOkPart = !storageError
      ? { lastOkAt: checkedAt }
      : cursor.lastOkAt
        ? { lastOkAt: cursor.lastOkAt }
        : {};
    const nextCursor =
      storageError && !quarantined
        ? { offset: cursor.offset, ...directoryPart, storageErrorStreak, ...lastOkPart }
        : { offset: selected.nextOffset, ...directoryPart, ...lastOkPart };
    const cursorSaved = await writeReverifyCursor(nextCursor);
    const summary = summarize(runId, outcomes, directoryResult.summary);
    // 接続先の診断 (ホスト名と採用 env 名のみ)。env を切り替えたつもりで旧プロキシに残っていた
    // 障害 (2026-09-06) で、応答から接続先が読めず特定に時間を要した。cron 認証の内側のみ。
    const kv = kvEndpointInfo();
    logger.info('x402.reverify.completed', {
      ...summary,
      storageError: storageError || !cursorSaved,
    });

    // どの対象の・どの段階の KV 操作が失敗したかを応答と warn に残す。summary だけでは
    // 「checked 9 / ok 9 なのに 503」の理由が読めず、原因特定に 3 日を要した (2026-09-06)。
    const storageFailures: StorageFailure[] = outcomes
      .filter((outcome) => outcome.storageError)
      .map((outcome) => ({
        target: targetLabel(outcome.target),
        stage: outcome.checked ? 'apply' : 'read',
        detail: outcome.storageDetail ?? null,
      }));
    if (!directoryResult.saved) {
      storageFailures.push({ target: 'directory-snapshot', stage: 'write', detail: null });
    }
    if (!cursorSaved) {
      storageFailures.push({ target: 'cursor', stage: 'write', detail: null });
    }
    if (storageFailures.length > 0) {
      logger.warn('x402.reverify.storage_error', {
        runId,
        failures: storageFailures.slice(0, 20),
      });
    }

    const shouldAlert =
      summary.violations > 0 ||
      summary.transient > 0 ||
      summary.hidden > 0 ||
      summary.restored > 0 ||
      summary.directory.failed > 0;
    const webhookUrl = process.env.ALERT_WEBHOOK_URL;
    if (shouldAlert && webhookUrl) {
      const sent = await sendReverifyAlert(
        webhookUrl,
        alertMessage(summary, outcomes),
      );
      if (!sent) logger.warn('x402.reverify.alert_failed', { runId });
    }

    if (storageError || !cursorSaved) {
      return NextResponse.json(
        {
          ...summary,
          error: 'storage_unavailable',
          storageFailures: storageFailures.slice(0, 20),
          kv,
        },
        { status: 503 },
      );
    }
    return NextResponse.json({ ...summary, kv });
  } finally {
    await releaseReverifyLock(runId);
  }
}
