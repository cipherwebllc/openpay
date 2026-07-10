import 'server-only';

import { checkReadRateLimit } from '@/lib/relay/relayGuards';

export const RESOURCE_BODY_MAX_BYTES = 8 * 1024;
export const RESOURCE_RATE_LIMIT_MAX = 10;
export const RESOURCE_RATE_LIMIT_WINDOW_SEC = 60;

export async function checkResourceWalletRateLimit(
  wallet: string,
): Promise<boolean> {
  try {
    return await checkReadRateLimit(
      `x402res:${wallet.toLowerCase()}`,
      RESOURCE_RATE_LIMIT_MAX,
      RESOURCE_RATE_LIMIT_WINDOW_SEC,
    );
  } catch {
    // rate-limit storage の障害を resource 管理本体へ波及させない (既存 guard と同じ fail-open)。
    return true;
  }
}
