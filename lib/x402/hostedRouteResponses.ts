import 'server-only';

import { after, NextResponse } from 'next/server';

export function noStore(response: NextResponse): NextResponse {
  response.headers.set('Cache-Control', 'no-store');
  return response;
}

export function errorResponse(error: string, status: number): NextResponse {
  return NextResponse.json({ ok: false, error }, { status });
}

export function pendingResponse(): NextResponse {
  return NextResponse.json(
    { ok: true, state: 'pending' },
    { status: 202 },
  );
}

// 応答後に付帯処理を予約する (掟 12)。after() はリクエストスコープ外 (テスト等) で
// throw するため、その場合は直接 fire-and-forget に落とす (task は no-throw 前提)。
export function scheduleAfterResponse(task: () => void): void {
  try {
    after(task);
  } catch {
    task();
  }
}
