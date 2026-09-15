// Node ESM operational API declarations for TypeScript test callers.
export type ByteValue = string | { b: string };
export interface BackupRecord {
  k: ByteValue;
  t?: string;
  capturedAt?: number;
  expiresAt?: number | null;
  s?: ByteValue;
  l?: ByteValue[];
  m?: ByteValue[];
  z?: [ByteValue, string][];
  h?: [ByteValue, ByteValue][];
  uncertain?: true;
  error?: string;
  detail?: string;
}
export interface Limits {
  fullCollectionMax: number; fullCollectionBytes: number; chunk: number; minChunk: number;
  reqBytes: number; stringMax: number; ciphertextBytes: number; gunzipBytes: number; lineBytes: number; lines: number;
}
export interface Manifest {
  v: 2; kind: 'full'; name: string; source: { hostSha256Hex16: string };
  prefixes: string[]; denylist: string[]; limits: Pick<Limits, 'fullCollectionMax' | 'chunk' | 'reqBytes' | 'stringMax'>;
  startedAt: string;
}
export interface Footer {
  end: true; keys: number; errors: number; uncertain: number; status: 'complete' | 'partial';
  finishedAt: string; bodySha256: string;
}
export interface Meta {
  v: 1; name: string; archiveKey: string; ciphertextSha256: string; size: number;
  source: { hostSha256Hex16: string }; capture: { startedAt: string; finishedAt: string };
  run: { id: string; attempt: string | number }; counts: { keys: number; errors: number; uncertain: number };
  status: 'complete' | 'partial';
}
export interface Summary { manifest: Manifest; footer: Footer; prefixes: Record<string, number> }
export interface VerifyOptions { limits?: Limits; stagingRoot?: string }
export const PREFIXES: readonly string[];
export const DENYLIST: readonly string[];
export const LIMITS: Readonly<Limits>;
export class BackupError extends Error { code: string; constructor(code: string) }
export function sha256(bytes: string | Uint8Array): string;
export function representBytes(bytes: Uint8Array): ByteValue;
export function restoreBytes(value: unknown): Buffer;
export function byteText(bytes: Uint8Array): string;
export function isAllowedKey(key: string | Uint8Array): boolean;
export function createRecord(input: { key: string | Uint8Array; type: string; capturedAt: number; pttl: number; value?: Uint8Array | Uint8Array[]; uncertain?: boolean }): BackupRecord;
export function createManifest(input: { name: string; host: string; startedAt: string }): Manifest;
export function createJsonl(manifest: Manifest, records: Iterable<BackupRecord> | AsyncIterable<BackupRecord>, options?: { limits?: Limits; now?: () => Date; onFooter?: (footer: Footer) => void }): AsyncGenerator<Buffer>;
export function parseKey(hex: string): Buffer;
export function writeArchive(options: { manifest: Manifest; records: Iterable<BackupRecord> | AsyncIterable<BackupRecord>; file: string; key: string; limits?: Limits; now?: () => Date }): Promise<Footer>;
export function decryptToStaging(file: string, key: string, options?: VerifyOptions): Promise<string>;
export function cleanupStaging(path: string): Promise<void>;
export function verifyJsonl(source: Iterable<Uint8Array> | AsyncIterable<Uint8Array>, options?: VerifyOptions): Promise<Summary>;
export function verifyArchive(file: string, key: string, options?: VerifyOptions): Promise<Summary>;
export function createMeta<M extends Manifest, F extends Pick<Footer, 'keys' | 'errors' | 'uncertain' | 'status' | 'finishedAt'>>(options: {
  manifest: M;
  footer: F;
  archiveKey: string; digest: { size: number; sha256: string; md5?: string };
  run: { id: string; attempt: string | number; [key: string]: unknown };
}): Meta;
