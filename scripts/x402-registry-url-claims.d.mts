export const BACKFILL_URL_CLAIM: string;
export type ClaimInventory = {
  mode: string; records: number; duplicates: number; conflicts: number; candidates: number;
  claimed: number; exists: number; changed: number; invalid: string[]; blocked: boolean;
};
export function inventoryUrlClaims(client: { command(args: (string | number)[]): Promise<unknown> }, options?: {
  apply?: boolean; log?: (line: string) => void;
}): Promise<ClaimInventory>;
export function main(args?: string[], options?: {
  env?: Record<string, string | undefined>; fetch?: typeof globalThis.fetch;
  log?: (line: string) => void; error?: (line: string) => void;
}): Promise<number>;
