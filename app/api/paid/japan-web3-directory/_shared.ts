import { NextResponse } from 'next/server';
import { env } from '@/lib/env';

export function guardPaidDirectoryApi(): NextResponse | null {
  if (!env.enableWeb3Directory || !env.enableX402Facilitator) {
    return NextResponse.json(
      { ok: false, error: 'not_found' },
      { status: 404 },
    );
  }
  return null;
}

export function paidDirectoryError(
  error: string,
  status: number,
): NextResponse {
  return NextResponse.json({ ok: false, error }, { status });
}
