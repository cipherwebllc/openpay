// origin 直下の /openapi.json。x402 のインデクサ (x402scan / @agentcash/discovery) は
// `${origin}/openapi.json` **だけ**を discovery ドキュメントとして読むため、/api 配下の
// 同一文書とは別にここでも配信する (旧 /.well-known/x402 は legacy 扱いで既に読まれない)。
// middleware の matcher はドットを含む path を除外するため locale リダイレクトは掛からない。

import type { NextResponse } from 'next/server';
import { serveOpenApiDocument } from '@/lib/openapi/route';

export const runtime = 'nodejs';

export async function GET(): Promise<NextResponse> {
  return serveOpenApiDocument();
}
