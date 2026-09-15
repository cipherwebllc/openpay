export const EMPTY_SHA256: string;
export function awsEncode(value: string): string;
export function canonicalQuery(query?: string[][]): string;
export interface SigningOptions {
  method: string; path?: string; query?: string[][]; headers: Record<string, string>;
  payloadHash: string; accessKeyId: string; secretAccessKey: string; region?: string; service?: string;
}
export function signHeaders(options: SigningOptions): { canonicalRequest: string; stringToSign: string; signature: string; authorization: string; canonicalUri: string; queryString: string };
export function signRequest(options: Omit<SigningOptions, 'headers' | 'region' | 'service'> & { host: string; path: string; now?: Date }): { url: string; headers: Record<string, string> };
