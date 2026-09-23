import { issueAgentProofChallenge } from '@/lib/agent/proof';
import { agentPurchasesEnabled } from '@/lib/agent/purchasesEnv';
import { purchasesGate, purchasesJson, queryAgentAddress } from '@/lib/agent/purchasesHttp';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  // Keep this gate aligned with purchasesGate so disabled routes return 404
  // before validation; the shared guard still gates its other callers.
  if (!agentPurchasesEnabled()) return purchasesJson({ reason: 'not_found' }, 404);
  // Malformed addresses must not drain the shared KV budget through the limiter.
  const address = queryAgentAddress(req);
  if (!address) return purchasesJson({ reason: 'malformed' }, 400);
  const gated = await purchasesGate(req, 'challenge');
  if (gated) return gated;
  const result = await issueAgentProofChallenge(address);
  if (!result.ok) return purchasesJson({ reason: result.reason }, result.reason === 'storage_error' ? 503 : 400);
  return purchasesJson({ nonce: result.nonce, issuedAt: result.issuedAt, expiresAt: result.expiresAt });
}
