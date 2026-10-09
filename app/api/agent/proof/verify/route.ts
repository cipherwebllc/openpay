import { bindAgent } from '@/lib/agent/bindings';
import { parseAgentProof, verifyAgentProof } from '@/lib/agent/proof';
import { purchasesBody, purchasesGate, purchasesJson, purchasesSession } from '@/lib/agent/purchasesHttp';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const gated = await purchasesGate(req, 'verify');
  if (gated) return gated;
  const body = await purchasesBody(req);
  if (!body || Object.keys(body).join(',') !== 'proof' || !parseAgentProof(body.proof)) return purchasesJson({ reason: 'malformed' }, 400);
  const session = await purchasesSession();
  if (!session.ok) return session.response;
  const verified = await verifyAgentProof(body.proof);
  if (!verified.ok) return purchasesJson({ reason: verified.reason }, verified.reason === 'storage_error' ? 503 : 401);
  const bound = await bindAgent(verified.address, session.address);
  // 上限到達は認証の失敗ではない (409)。画面は reason で分岐する (第 7 回レビュー C13)。
  if (!bound.ok) return purchasesJson({ reason: bound.reason }, bound.reason === 'storage_error' ? 503 : 409);
  return purchasesJson({ address: bound.address, boundAt: bound.boundAt });
}
