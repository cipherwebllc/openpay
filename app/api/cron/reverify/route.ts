import { NextResponse } from 'next/server';
import { requireCronAuth } from '@/lib/cronAuth';
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

export const runtime = 'nodejs';
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

type ProbeOutcome = {
  target: ReverifyTarget;
  checked: boolean;
  verdict?: ReverifyVerdict;
  apply?: ReverifyApplyResult;
  storageError?: boolean;
};

type ReverifySummary = {
  runId: string;
  checked: number;
  ok: number;
  violations: number;
  transient: number;
  hidden: number;
  restored: number;
  skippedDuplicate: number;
  directory: {
    checked: number;
    ok: number;
    failed: number;
    unknown: number;
    ran: boolean;
  };
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
    if (!read.ok) return { target, checked: false, storageError: true };
    if (!read.resource) return { target, checked: false };
    if (read.resource.verification?.lastRunId === runId) {
      return {
        target,
        checked: false,
        apply: { applied: false, reason: 'duplicate' },
      };
    }
    const probedUrl = read.resource.url;
    const { verdict, authClass } = await probeForReverifyDetailed(probedUrl);
    const apply = await applyExternalReverify(
      target.id,
      probedUrl,
      verdict,
      checkedAt,
      runId,
      authClass,
    );
    return {
      target,
      checked: true,
      verdict,
      apply,
      storageError: !apply.applied && apply.reason === 'storage',
    };
  }

  const resource = firstPartyByPath.get(target.path);
  if (!resource) return { target, checked: false };
  const read = await readFirstPartyVerification(target.path);
  if (!read.ok) return { target, checked: false, storageError: true };
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
  return {
    target,
    checked: true,
    verdict,
    apply,
    storageError: !apply.applied && apply.reason === 'storage',
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
    directory,
  };
  for (const outcome of outcomes) {
    if (!outcome.checked) {
      if (!outcome.apply?.applied && outcome.apply?.reason === 'duplicate') {
        summary.skippedDuplicate += 1;
      }
      continue;
    }
    summary.checked += 1;
    if (outcome.verdict === 'ok_402_openpay') summary.ok += 1;
    else if (outcome.verdict && isViolationVerdict(outcome.verdict)) {
      summary.violations += 1;
    } else summary.transient += 1;

    if (outcome.apply?.applied) {
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
    const nextCursor =
      storageError && !quarantined
        ? { offset: cursor.offset, ...directoryPart, storageErrorStreak }
        : { offset: selected.nextOffset, ...directoryPart };
    const cursorSaved = await writeReverifyCursor(nextCursor);
    const summary = summarize(runId, outcomes, directoryResult.summary);
    logger.info('x402.reverify.completed', {
      ...summary,
      storageError: storageError || !cursorSaved,
    });

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
        { ...summary, error: 'storage_unavailable' },
        { status: 503 },
      );
    }
    return NextResponse.json(summary);
  } finally {
    await releaseReverifyLock(runId);
  }
}
