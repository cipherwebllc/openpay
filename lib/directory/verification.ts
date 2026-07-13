import 'server-only';

import { kvGet, kvSet } from '@/lib/kv';
import type {
  DirectoryEntry,
  DirectoryVerificationRecord,
  DirectoryVerificationSnapshot,
} from '@/lib/directory/types';
import {
  fetchSsrfSafe,
  type SsrfSafeFetchOptions,
} from '@/lib/x402/moderation';

export const DIRECTORY_VERIFICATION_KEY = 'directory:verification';

function parseSnapshot(raw: string): DirectoryVerificationSnapshot | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  for (const value of Object.values(parsed)) {
    if (typeof value !== 'object' || value === null) return null;
    const record = value as Partial<DirectoryVerificationRecord>;
    if (
      typeof record.checkedAt !== 'string' ||
      (typeof record.ok !== 'boolean' && record.ok !== null) ||
      typeof record.sourceUrl !== 'string'
    ) {
      return null;
    }
  }
  return parsed as DirectoryVerificationSnapshot;
}

// missing key は「まだ一度も日次検証していない」ので空 snapshot。KV 障害/破損は null と分け、
// paid route が settlement 前に 503 を返せるようにする。
export async function readDirectoryVerificationSnapshot(): Promise<
  DirectoryVerificationSnapshot | null
> {
  const got = await kvGet(DIRECTORY_VERIFICATION_KEY);
  if (!got.ok) return null;
  if (got.value === null) return {};
  return parseSnapshot(got.value);
}

export async function writeDirectoryVerificationSnapshot(
  snapshot: DirectoryVerificationSnapshot,
): Promise<boolean> {
  const saved = await kvSet(DIRECTORY_VERIFICATION_KEY, JSON.stringify(snapshot));
  return saved.ok && saved.value === 'OK';
}

export function directoryVerificationForEntry(
  entry: DirectoryEntry,
  snapshot: DirectoryVerificationSnapshot,
): DirectoryVerificationRecord | null {
  const record = snapshot[entry.slug];
  // sourceUrl がコード変更された後は、旧 URL の死活結果を新 URL の結果として表示しない。
  return record?.sourceUrl === entry.sourceUrl ? record : null;
}

// 三値死活判定。true=到達 (2xx/3xx)・false=**確定消滅のみ** (404/410)・null=判定不能。
// 401/403/429/5xx/network/timeout は「ソースが死んだ」証拠にならない (Cloudflare 等の bot 保護は
// probe UA に 403 を返すが人間には生きている) — false に潰すと本番 API が誤情報を配信する
// (2026-07-14 実害: 全 19 件 sourceOk:false)。
export async function probeDirectorySource(
  url: string,
  opts: SsrfSafeFetchOptions = {},
): Promise<boolean | null> {
  const response = await fetchSsrfSafe(url, {
    ...opts,
    timeoutMs: opts.timeoutMs ?? 2_000,
    userAgent: opts.userAgent ?? 'OpenPay-directory-reverify/1.0',
  });
  if (response === null) return null;
  if (response.status >= 200 && response.status < 400) return true;
  if (response.status === 404 || response.status === 410) return false;
  return null;
}
