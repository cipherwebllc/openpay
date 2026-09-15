import type { BackupRecord } from './kv-backup-core.mjs';
export interface Finding { rule: string; key: BackupRecord['k']; detail: string }
export interface CheckResult {
  violations: Finding[];
  unverifiable: Finding[];
  summary: { records: number; violations: number; unverifiable: number; quarantine_candidates: BackupRecord['k'][]; onchainReconciled: false };
}
export function checkRecords(records: BackupRecord[], options?: { incompleteReservationProducts?: string[] }): CheckResult;
