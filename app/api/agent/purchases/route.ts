import { isOwner } from '@/lib/agent/bindings';
import { readPayerPurchases } from '@/lib/agent/purchases';
import { purchasesGate, purchasesJson, purchasesSession, queryAgentAddress } from '@/lib/agent/purchasesHttp';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const gated = await purchasesGate(req, 'purchases');
  if (gated) return gated;
  const session = await purchasesSession();
  if (!session.ok) return session.response;
  const address = queryAgentAddress(req);
  if (!address) return purchasesJson({ reason: 'malformed' }, 400);
  const ownership = await isOwner(address, session.address);
  if (!ownership.ok) return purchasesJson({ reason: ownership.reason }, 503);
  if (!ownership.isOwner) return purchasesJson({ reason: 'not_bound' }, 401);
  const purchases = await readPayerPurchases(address);
  if (!purchases.ok) return purchasesJson({ reason: purchases.reason }, 503);
  return purchasesJson({ ...purchases, boundAt: ownership.boundAt });
}
