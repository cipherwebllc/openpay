import type { ActivityBucket, ActivityItem } from '@/lib/jpyc/activity';

export const ACTIVITY_NOW = Date.parse('2026-09-08T03:00:00.000Z');
export const ACTIVITY_CONTRACT = '0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29';
export const SENDER = '0x00000000000000000000000000000000000000aa';
export const RECEIVER = '0x00000000000000000000000000000000000000bb';

export function bucket(index = 100, items: ActivityItem[] = [], end = ACTIVITY_NOW, blockTimeSeconds = 2): ActivityBucket {
  return {
    schema: 1, chain: 'polygon', chainId: 137, contract: ACTIVITY_CONTRACT, index,
    fromBlock: String(index * 1_800), toBlock: String(index * 1_800 + 1_799),
    fromTimestamp: new Date(end - 1_799 * blockTimeSeconds * 1_000).toISOString(), toTimestamp: new Date(end).toISOString(),
    eventCount: items.length, items, overflow: false,
  };
}

export function activityWindow(end = ACTIVITY_NOW, blockTimeSeconds = 2, newest = 100): ActivityBucket[] {
  // 両端のブロック間は 1,799 間隔。隣のバケットまでも 1 ブロック分進む。
  return Array.from({ length: 60 }, (_, i) => bucket(newest - 59 + i, [[SENDER, RECEIVER, '1']],
    end - (59 - i) * 1_800 * blockTimeSeconds * 1_000, blockTimeSeconds));
}
