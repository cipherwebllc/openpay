import { NextResponse } from 'next/server';
import { checkAgentActivityRateLimit } from '@/lib/agent/activityRateLimit';
import { fetchAgentActivity } from '@/lib/agent/activityServer';
import type { AgentActivityFailure, AgentActivityResponse } from '@/lib/agent/activityTypes';

export const runtime = 'nodejs';

const FAILURE_STATUS: Record<AgentActivityFailure, number> = {
  invalid_address: 400,
  unsupported_chain: 200,
  not_configured: 503,
  rate_limited: 429,
  busy: 429,
  upstream: 502,
};

function respond(result: AgentActivityResponse): NextResponse {
  return NextResponse.json(result, {
    status: result.ok ? 200 : FAILURE_STATUS[result.reason],
    headers: {
      // 一時障害・制限応答が別の閲覧者へキャッシュ経由で波及するのを断つ。
      'Cache-Control': result.ok
        ? 'public, s-maxage=30, stale-while-revalidate=120'
        : 'no-store',
    },
  });
}

export async function GET(req: Request): Promise<NextResponse> {
  // 重複・余分な query で CDN キャッシュを外し、上流 API 枠を枯らす波及を断つ。
  // URLSearchParams は空ペアを数えない (`?address=…&` も `?&address=…` も size 1) ので、パース後の値ではなく
  // **生の query 文字列**を正規形 1 つと完全一致で比べる。長さも検査し、$ が末尾改行の直前に一致するケースを受理しない。
  const { search } = new URL(req.url);
  if (search.length !== 51 || !/^\?address=0x[0-9a-f]{40}$/.test(search)) {
    return respond({ ok: false, reason: 'invalid_address' });
  }
  const address = search.slice('?address='.length);

  if (!(await checkAgentActivityRateLimit(req))) {
    return respond({ ok: false, reason: 'rate_limited' });
  }
  return respond(await fetchAgentActivity(address));
}
