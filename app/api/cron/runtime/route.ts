import { NextResponse } from 'next/server';
import { requireCronAuth } from '@/lib/cronAuth';

// cron ではないが、cron と同じ秘密 (CRON_SECRET) で守る内部の確認口。vercel.json の crons には載せない。
// 本番の関数が動かしている Node の版を、本番設定の確認 (scripts/verify-production-config.mjs) が読む。
// Vercel は Node の patch を自動で配るが、修正版が届いたかは外から見えないため。
// 秘密が未設定・不一致なら 401 (lib/cronAuth は fail-closed): 実行環境の版を誰にでも出すと、
// 修正前の版で動いている間それを外へ知らせることになる。応答は版だけで、headers や env は含めない。
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(request: Request): NextResponse {
  const headers = { 'Cache-Control': 'no-store' };
  if (!requireCronAuth(request)) return NextResponse.json({ error: 'unauthorized' }, { status: 401, headers });
  return NextResponse.json({ node: process.version }, { headers });
}
