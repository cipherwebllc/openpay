import type { NextResponse } from 'next/server';
import { serveOpenApiDocument } from '@/lib/openapi/route';

export async function GET(): Promise<NextResponse> {
  return serveOpenApiDocument();
}
