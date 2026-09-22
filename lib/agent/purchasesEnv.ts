import 'server-only';

import { parseBoolFlag } from '@/lib/env';

export function agentPurchasesEnabled(): boolean {
  return parseBoolFlag('ENABLE_AGENT_PURCHASES', process.env.ENABLE_AGENT_PURCHASES);
}
