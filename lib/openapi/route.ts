// /openapi.json と /api/openapi.json が共有する配信ハンドラ。
// 文書自体は lib/openapi/document.ts が単一情報源。

import { NextResponse } from 'next/server';
import { buildOpenApiDocument } from '@/lib/openapi/document';

export function serveOpenApiDocument(): NextResponse {
  const document = buildOpenApiDocument();
  if (!document) {
    return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 });
  }
  return NextResponse.json(document, {
    headers: {
      'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=120',
    },
  });
}
