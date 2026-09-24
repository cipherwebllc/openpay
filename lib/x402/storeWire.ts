// hosted 購入 (Creator Store) の wire で JPYC/USDC の両 rail が共有する browser-safe な部品。
// rail ごとの metadata/小数 parser は各 rail に残す (JPYC と USDC は受け付ける入力が意図的に違う)。
// ⚠️ ここを変えると両 rail の 402・保存済み intent の読み戻しが同時に変わる (掟 15 のレビュー対象)。
import { getAddress, isAddress, type Address, type Hex } from 'viem';

/** 表示ラベル (商品の見え方だけを変える。配信機構は kind が決める)。 */
export type HostedLabel =
  | 'download'
  | 'pdf'
  | 'zip'
  | 'prompt'
  | 'api'
  | 'external';

export const LABELS: readonly HostedLabel[] = [
  'download',
  'pdf',
  'zip',
  'prompt',
  'api',
  'external',
];

export function isHostedLabel(value: unknown): value is HostedLabel {
  return (
    typeof value === 'string' &&
    (LABELS as readonly string[]).includes(value)
  );
}

// wire 上の resource path・payer の大小文字・query 順をそのまま保つ (rail は呼び出し側が必ず明示)。
export function hostedResourceUrl(
  resourceId: string,
  payer: Address,
  rail: 'jpyc' | 'usdc',
): string {
  return `https://open-pay.jp/api/paid/hosted/${resourceId}?payer=${payer}${rail === 'usdc' ? '&rail=usdc' : ''}`;
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function isSafeTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function parseAddress(value: unknown): Address | null {
  return typeof value === 'string' && isAddress(value)
    ? getAddress(value)
    : null;
}

export function parseHex32(value: unknown): Hex | null {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value)
    ? (value.toLowerCase() as Hex)
    : null;
}
