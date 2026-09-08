import type { ActivityBucket, ActivityItem } from '@/lib/jpyc/activity';

export const ACTIVITY_NOW = Date.parse('2026-09-08T03:00:00.000Z');
export const ACTIVITY_CONTRACT = '0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29';
export const SENDER = '0x00000000000000000000000000000000000000aa';
export const RECEIVER = '0x00000000000000000000000000000000000000bb';

export function bucket(index = 100, items: ActivityItem[] = [], end = ACTIVITY_NOW): ActivityBucket {
  return {
    schema: 1, chain: 'polygon', chainId: 137, contract: ACTIVITY_CONTRACT, index,
    fromBlock: String(index * 1_800), toBlock: String(index * 1_800 + 1_799),
    fromTimestamp: new Date(end - 3_599_000).toISOString(), toTimestamp: new Date(end).toISOString(),
    eventCount: items.length, items, overflow: false,
  };
}

export function activityWindow(end = ACTIVITY_NOW): ActivityBucket[] {
  return Array.from({ length: 25 }, (_, i) => bucket(76 + i, [[SENDER, RECEIVER, '1']], end - (24 - i) * 3_600_000));
}
