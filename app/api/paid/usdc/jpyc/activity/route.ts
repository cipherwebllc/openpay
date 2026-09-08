import { NextResponse, type NextRequest } from 'next/server';
import { readActivityWindow } from '@/lib/jpyc/activity';
import { ACTIVITY_CHAINS, USDC_JPYC_ACTIVITY } from '@/lib/jpyc/liveResources';
import { envelope, gated, invalidQuery } from '@/lib/jpyc/liveRoute';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const params = new URL(request.url).searchParams;
  // 未知・重複・指定済みの不正値で署名を要求する波及を断つ。欠落 chain のみ discovery 402。
  for (const key of params.keys()) {
    if (!['chain', 'window'].includes(key) || params.getAll(key).length !== 1) return invalidQuery();
  }
  const chain = params.get('chain');
  if ((chain !== null && !(ACTIVITY_CHAINS as readonly string[]).includes(chain)) ||
    (params.has('window') && params.get('window') !== '24h')) return invalidQuery();

  return gated(request, USDC_JPYC_ACTIVITY, async () => {
    // 支払い付きの引数欠落は KV に触れず 400。gate は settle しない。
    if (chain === null) return invalidQuery();
    try {
      const result = await readActivityWindow();
      // 不完全・期限切れの集計を課金へ波及させない。
      if (!result.ok) return NextResponse.json({ ok: false, error: result.reason }, { status: 503 });
      return envelope(result.aggregate);
    } catch {
      // content の例外は gate が捕捉しないため、組立失敗も 503 にして claim 解放を通す。
      return NextResponse.json({ ok: false, error: 'data_unavailable' }, { status: 503 });
    }
  });
}
