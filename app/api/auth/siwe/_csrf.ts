import { NextResponse } from 'next/server';

export function rejectSiweCsrf(req: Request, { allowMissingContentType = false }: { allowMissingContentType?: boolean } = {}): NextResponse | null {
  // 外部サイトの遷移がセッション cookie の発行・失効や nonce 保存へ波及するのを防ぐ。
  if (req.headers.get('sec-fetch-site') === 'cross-site') {
    return NextResponse.json({ ok: false, error: 'cross_site_request' }, { status: 403 });
  }
  const contentType = req.headers.get('content-type');
  // nonce/logout の既存 SDK・旧タブの bodyless POST は維持する。フォーム POST は Content-Type を
  // 必ず持つため、旧ブラウザでもログイン状態の変更へ波及させない。verify は常に JSON 必須。
  if (contentType === null && allowMissingContentType) return null;
  if (contentType?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    return NextResponse.json({ ok: false, error: 'unsupported_media_type' }, { status: 415 });
  }
  return null;
}
