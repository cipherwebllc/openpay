import type { Fetch } from './upstash-rest.mjs';
export interface Digest { size: number; sha256: string; md5: string }
export interface ObjectHead { size: number; md5: string }
export class R2Error extends Error { code: string; status?: number; constructor(code: string, status?: number) }
export interface R2Client {
  putObject(file: string, key: string): Promise<Digest>;
  headObject(key: string, expected?: ObjectHead): Promise<ObjectHead>;
  getObjectToFile(key: string, file: string, options?: { maxBytes?: number; expected?: Pick<Digest, 'size' | 'sha256'> }): Promise<Digest>;
  listObjects(prefix: string): Promise<{ key: string; size: number }[]>;
}
export function validateObjectKey(key: string): string;
export function fileDigest(file: string, maxBytes?: number): Promise<Digest>;
export function createR2Client(options?: { env?: Record<string, string | undefined>; fetch?: Fetch; timeoutMs?: number; now?: () => Date }): R2Client;
