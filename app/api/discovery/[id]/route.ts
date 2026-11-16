// Public exact-ID lookup for seller gates; same item shape/visibility as discovery.
import { NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { warnThrottled } from '@/lib/warnThrottle';
import { getPublicResource } from '@/lib/x402/registry';
import { publicDiscoveryItem } from '@/lib/x402/discoveryItem';

export const runtime = 'nodejs';
export const maxDuration = 15;

// 200 だけ edge (Vercel CDN) に 5 分置く。1 回の照会は KV の GET を 1 コマンド使い、
// 出品者の gate のキャッシュは isolate の中だけなので、Cloudflare Workers 等では巡回の 402 のたびに
// 取り直しになる (2026-10-19 に Bazaar 掲載された getbits で 1 日 約 450 回)。
// 代わりに、掲載の変更が gate に届くまでが gate 自身の 5 分と合わせて最大 10 分になる (以前は最大 5 分):
//   - 価格の編集: gate は古い価格の 402 を出し続け、402 を /api/discovery (一覧) と照合する SDK・MCP の
//     買い手はその間 catalog_accept_mismatch で払わない。facilitator は登録の価格を照合しない。
//   - 止めた・隠した掲載: 置いてある 200 が切れるまで gate は売り続けうる (facilitator は公開状態を見ない)。
//   - 受取先の変更: 新しい受取先を pin した gate は古い掲載に合わず止まる側に倒れる (誤送金にはならない)。
// JPYC の gate に取り直しの経路は無いので、期限を過ぎれば戻る (止まり続けない)。
// 400/404/503 は no-store のまま: 公開に戻った掲載・新しい掲載を「無い」と焼き付けない・障害を残さない。
// relay/requirements は edge に置かない (lib/x402/dualRailRelay.ts の handleDualRailRequirements の注記)。
//
// KV で数える IP ごとの制限 (checkIpRateLimit) は置かない: 判定 (INCR + EXPIRE NX の 2 コマンド・制限に当たった後の
// request でも 2) が、守っている掲載の GET 1 コマンドより高い。置かなければ、どれだけ呼ばれても KV は 1 回 1 コマンド。
// 返すのは公開の情報だけ。この route 自身は 429 を返さない。tests/app/api/x402-public-reads-kv.test.ts。
//   - 回数の制限は open-pay.jp の入口の Cloudflare の rule だけ (2026-11-16 に確認した値は docs/DEPLOY_CHECKLIST.md
//     §14.9c・rule を変えたらそこを見直す)。Cloudflare を通らない経路 (*.vercel.app など) には回数の制限が無い。
//   - 掲載の読み取りの失敗の警告は warnThrottled で instance ごとに 60 秒に 1 回まで (lib/warnThrottle.ts)。
const EDGE_CACHE_OK = 'public, s-maxage=300';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const headers = { 'Cache-Control': 'no-store' };
  if (!env.enableX402Facilitator) {
    return NextResponse.json({ error: 'not_found' }, { status: 404, headers });
  }
  const { id } = await params;
  if (!id || id.length > 100) {
    return NextResponse.json({ error: 'invalid_resource_id' }, { status: 400, headers });
  }
  const read = await getPublicResource(id);
  // Storage failure must not become a cached missing listing and disable a healthy seller gate.
  if (!read.ok) {
    warnThrottled('x402.discovery.read_failed', { id });
    return NextResponse.json({ error: 'storage_unavailable' }, { status: 503, headers });
  }
  if (!read.resource) {
    return NextResponse.json({ error: 'not_found' }, { status: 404, headers });
  }
  return NextResponse.json(publicDiscoveryItem(read.resource), {
    headers: { 'Cache-Control': EDGE_CACHE_OK },
  });
}
