export type RedisValue = Uint8Array | 'OK' | number | null | RedisValue[];
export type Command = (string | number)[];
// fetch is injectable at a JS transport boundary; test fakes may inspect Node stream bodies.
export type Fetch = (...args: any[]) => Promise<Response>;
export interface UpstashClient {
  host: string;
  command(argv: Command): Promise<RedisValue>;
  pipeline(argvs: Command[]): Promise<(RedisValue | UpstashError)[]>;
  multiExec(argvs: Command[]): Promise<(RedisValue | UpstashError)[]>;
}
export class UpstashError extends Error { code: string; status?: number; constructor(code: string, status?: number) }
export class UpstashTimeoutError extends UpstashError { constructor() }
export class UpstashHttpError extends UpstashError { constructor(status: number) }
export class UpstashLimitError extends UpstashError { constructor() }
export class UpstashCommandError extends UpstashError { constructor(code?: string) }
export function decodeResponse(value: unknown): RedisValue;
export function createUpstashClient(options?: { env?: Record<string, string | undefined>; url?: string; token?: string; fetch?: Fetch; timeoutMs?: number; reqBytes?: number }): UpstashClient;
