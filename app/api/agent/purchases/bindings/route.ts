import { listAgentBindings } from '@/lib/agent/bindings';
import { purchasesGate, purchasesJson, purchasesSession } from '@/lib/agent/purchasesHttp';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const gated = await purchasesGate(req, 'bindings');
  if (gated) return gated;
  const session = await purchasesSession();
  if (!session.ok) return session.response;
  const result = await listAgentBindings(session.address);
  if (!result.ok) return purchasesJson({ reason: result.reason }, 503);
  return purchasesJson({ addresses: result.addresses });
}
