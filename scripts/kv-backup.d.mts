import type { BackupRecord, Limits, Meta } from './lib/kv-backup-core.mjs';
import type { UpstashClient } from './lib/upstash-rest.mjs';
import type { R2Client } from './lib/r2.mjs';
export interface CaptureOptions { limits?: Limits; now?: () => number }
export interface RunOptions {
  env?: Record<string, string | undefined>; client?: UpstashClient;
  r2?: Pick<R2Client, 'putObject' | 'headObject'>; dryRun?: boolean; out?: string; now?: () => Date; limits?: Limits;
}
export function scanKeys(client: UpstashClient, limits?: Limits): Promise<Uint8Array[]>;
export function probeTypes(client: UpstashClient, keys: Uint8Array[], limits?: Limits): Promise<Map<string, string | Error>>;
export function captureKey(client: UpstashClient, key: Uint8Array, initialType: string | Error, options?: CaptureOptions): Promise<BackupRecord>;
export function captureRecords(client: UpstashClient, options?: CaptureOptions): AsyncGenerator<BackupRecord>;
export function archiveIdentity(env?: Record<string, string | undefined>, now?: Date): { name: string; archiveKey: string; metaKey: string; run: { id: string; attempt: string | number } };
export function runBackup(options?: RunOptions): Promise<{ archiveFile: string; metaFile: string; meta: Meta; exitCode: number }>;
export function parseArgs(args: string[]): { dryRun?: boolean; out?: string; verify?: string };
export function main(args?: string[], options?: RunOptions & { log?: (message: string) => void; error?: (message: string) => void }): Promise<number>;
