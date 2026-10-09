import type { NextResponse } from 'next/server';
import { isHex } from 'viem';
import { clientIp, hashIpBucket } from '@/lib/net/ipHash';
import { checkIpRateLimit, checkReadRateLimit } from '@/lib/relay/relayGuards';
import { resolveDeps } from '@/lib/storeHandoffDeps';
import { resolveStoreHandoff } from '@/lib/storeHandoffResolve';
import { handoffJson, readHandoffBody } from '@/lib/storeHandoffRoute';

export const runtime = 'nodejs';
export const maxDuration = 20;

// お店の端末で送る 1 件の結論 (支払い済み / 行われていない (証明つき) / 確認中) をチェーンだけで出す。
// 受け渡しのセッションに依存しない (お客様の画面が意図の値を送り、nonce はサーバが計算し直す)。
//
// flag (NEXT_PUBLIC_ENABLE_STORE_GAS_WALLET) を止めた後も答える: 読むだけで資金を動かさない。止めた時点で署名済み・
// 送信中の会計があっても、開いたままのお客様の画面と店の端末が結論 (支払い済み / 行われていない) を受け取れるように
// (lib の isConfiguredChain が開示から外したチェーンの結論も出すのと同じ理由)。新しい受け渡しを作る入口は flag で止まる。
//
// 回数制限は二段。店内 Wi-Fi・携帯の CGNAT では同じ公開 IP から複数のお客様 (5 秒おき = 12 回/分) と店の端末
// (10 秒おき = 6 回/分) が照会するので、IP は 60 回/分 (本文の前)。1 件の支払い (nonce) ごとに 30 回/分 (本文の後)。
// 429 のお客様の画面は「確認中」のまま次の回に照会し直す (結論を変えない)。
export async function POST(req: Request): Promise<NextResponse> {
  if (!(await checkIpRateLimit('store-handoff-resolve', hashIpBucket(clientIp(req)), 60, 60))) {
    return handoffJson({ ok: false, error: 'rate_limited' }, 429);
  }
  const parsed = await readHandoffBody(req);
  if (!parsed.ok) return parsed.res;
  const nonce = parsed.body.nonce;
  // 形の違う nonce は数えない (判定が 400 を返す)。
  if (
    typeof nonce === 'string' &&
    isHex(nonce) &&
    nonce.length === 66 &&
    !(await checkReadRateLimit(`store-handoff-resolve:nonce:${nonce.toLowerCase()}`, 30, 60))
  ) {
    return handoffJson({ ok: false, error: 'rate_limited' }, 429);
  }
  const r = await resolveStoreHandoff(parsed.body, resolveDeps());
  return r.ok ? handoffJson(r) : handoffJson({ ok: false, error: r.error }, r.status);
}
