import type { BackupRecord } from './lib/kv-backup-core.mjs';
import type { CheckResult, Finding } from './lib/kv-restore-check.mjs';
import type { Command, Fetch } from './lib/upstash-rest.mjs';
export const RESTORE_LIMITS: Readonly<{ requestBytes: number; members: number; ttlToleranceMs: number }>;
export const INSTALL_LUA: string;
export interface RestoreOptions { file: string; targetUrl: string; targetName: string; prefix?: string; apply?: boolean; check?: boolean }
export type Category = 'applied' | 'exists' | 'lua_error' | 'timeout_verified_match' | 'timeout_unverified' | 'expired_skipped' | 'expired_during_verify' | 'mismatch';
export interface RestoreReport {
  v: 1; archiveDigest: string | null; archiveName: string | null; targetFingerprint: string; targetName: string;
  mode: 'apply' | 'dry-run'; operator: string | null; startedAt: string; finishedAt: string | null;
  status: string; failure: string | null; inFlight: BackupRecord['k'] | null;
  results: Record<Category, BackupRecord['k'][]>;
  checks: { archive: CheckResult | null; selection: CheckResult | null; target: CheckResult | null };
  preflight: { violations: Finding[]; ready: number } | null;
  uncertain: BackupRecord['k'][]; quarantine_candidates: BackupRecord['k'][];
  dbsize: { start: number | null; end: number | null; expected: number | null }; counts: Record<Category, number>;
}
export function parseArgs(args: string[]): RestoreOptions;
export function installCommand(record: BackupRecord, now: number): Command;
export function preflight(records: BackupRecord[], now: number): { violations: Finding[]; expired: BackupRecord['k'][]; ready: BackupRecord[] };
export function compareRecord(expected: BackupRecord, actual: BackupRecord | null, now: number): 'match' | 'mismatch' | 'expired_during_verify';
export function runRestore(options: RestoreOptions & { env?: Record<string, string | undefined>; fetch?: Fetch; now?: () => number; reportDirectory?: string; timeoutMs?: number }): Promise<{ reportPath: string; report: RestoreReport; exitCode: number }>;
export function main(args?: string[], options?: { env?: Record<string, string | undefined>; fetch?: Fetch; now?: () => number; reportDirectory?: string; timeoutMs?: number; log?: (message: string) => void; error?: (message: string) => void }): Promise<number>;
