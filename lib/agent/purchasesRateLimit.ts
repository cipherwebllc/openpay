import 'server-only';

import { clientIp, hashIp } from '@/lib/net/ipHash';
import { checkIpRateLimit } from '@/lib/relay/relayGuards';

const LIMITS = {
  challenge: [20, 200],
  verify: [10, 100],
  unbind: [30],
  purchases: [60, 1000],
  bindings: [60],
} as const;
export type PurchasesRoute = keyof typeof LIMITS;

/** Return the rejected window in seconds; null means allowed. */
export async function agentPurchasesRateLimit(req: Request, route: PurchasesRoute): Promise<number | null> {
  const hashed = hashIp(clientIp(req));
  const limits: readonly number[] = LIMITS[route];
  const scope = `agent-purchases-${route}`;
  // Limiter storage is ancillary and fails open in checkIpRateLimit. Ownership and
  // nonce storage still fail closed. Unbind/bindings have only the specified minute window.
  if (!(await checkIpRateLimit(scope, hashed, limits[0], 60))) return 60;
  if (limits[1] !== undefined && !(await checkIpRateLimit(`${scope}-day`, hashed, limits[1], 86400))) return 86400;
  return null;
}
