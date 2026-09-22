import { issueAgentProofChallenge } from '@/lib/agent/proof';
import { purchasesGate, purchasesJson, queryAgentAddress } from '@/lib/agent/purchasesHttp';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const gated = await purchasesGate(req, 'challenge');
  if (gated) return gated;
  const address = queryAgentAddress(req);
  if (!address) return purchasesJson({ reason: 'malformed' }, 400);
  const result = await issueAgentProofChallenge(address);
  if (!result.ok) return purchasesJson({ reason: result.reason }, result.reason === 'storage_error' ? 503 : 400);
  return purchasesJson({ nonce: result.nonce, issuedAt: result.issuedAt, expiresAt: result.expiresAt });
}
