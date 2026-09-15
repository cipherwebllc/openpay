import type { Meta } from './lib/kv-backup-core.mjs';
import type { R2Client } from './lib/r2.mjs';
export interface WatchOptions { r2?: Pick<R2Client, 'listObjects' | 'getObjectToFile' | 'headObject'>; env?: Record<string, string | undefined>; now?: Date }
export function validateMeta(meta: unknown, key: string): Meta;
export function watchBackups(options?: WatchOptions): Promise<{ completeFinishedAt: string; ageMs: number; metaCount: number }>;
export function main(args?: string[], options?: WatchOptions & { log?: (message: string) => void; error?: (message: string) => void }): Promise<number>;
