// RFC 9727 の API カタログ (2026-11-27)。中身は lib/agentDiscovery.ts の apiCatalog()。

import { apiCatalog } from '@/lib/agentDiscovery';

export const dynamic = 'force-static';

export function GET(): Response {
  return new Response(JSON.stringify(apiCatalog()), {
    headers: { 'Content-Type': 'application/linkset+json' },
  });
}
