import { env } from '@/lib/env';

/** Shops search と無料 menuUrl が同時に到達可能になる server-side AND guard。 */
export function shopsApiEnabled(): boolean {
  return (
    env.enableShopsApi &&
    env.enableX402Facilitator &&
    env.enableOrderRelay &&
    env.enableAgentOrder
  );
}
