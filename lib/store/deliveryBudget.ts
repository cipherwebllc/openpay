import 'server-only';

import { randomUUID } from 'node:crypto';
import { kvEval } from '@/lib/kv';
import { LICENSE_VERIFY_BUDGET } from '@/lib/license/verifyBudget';

const KEY = 'store:delivery:rpc';
const RELEASE = 'return redis.call("ZREM",KEYS[1],ARGV[1]); ';

export async function acquireDeliveryBudget(): Promise<string | null> {
  const token = randomUUID();
  const result = await kvEval<number>(LICENSE_VERIFY_BUDGET, [KEY], [String(Date.now()), token]);
  // admission ストレージの障害を無制限 RPC へ波及させない。権利 denial ではなく 503。
  return result.ok && result.value === 1 ? token : null;
}

export async function releaseDeliveryBudget(token: string): Promise<void> {
  await kvEval(RELEASE, [KEY], [token]);
}
