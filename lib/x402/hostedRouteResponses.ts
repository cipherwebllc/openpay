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

// 応答後に付帯処理を予約する (掟 12)。after() は task が返す Promise の完了まで実行環境を保つので、task は付帯処理の
// Promise を返すこと (void で捨てると応答後の凍結で push・購入数・メトリクスが途中で切れる・第 7 回レビュー B11)。
// after() はリクエストスコープ外 (テスト等) で throw するため、その場合は直接実行に落とす (task は no-throw 前提)。
export function scheduleAfterResponse(task: () => Promise<unknown>): void {
  try {
    after(task);
  } catch {
    void task();
  }
}
