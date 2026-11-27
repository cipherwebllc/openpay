// どの API にも当たらない /api と /api/* に、HTML の 404 ページではなく JSON の 404 を返す (2026-11-27)。
// AI エージェントは HTML のエラーページを読めない (Is Agentic の必須項目「JSON error responses」が 0 点)。
// 今ある route はこの catch-all より優先されるので、既存の API の応答は変わらない
// (method の無い既存 route は従来どおり 405)。本文は RFC 9457 の problem+json に、
// 既存の API と同じ `error` の欄を足した形 (新しい説明文は足さない)。
// OPTIONS も 404 にする (Next の自動 OPTIONS は 204 + Allow で、無い API を在るように見せる)。
// HEAD は GET から Next が作る。

const BODY = JSON.stringify({
  type: 'about:blank',
  title: 'Not Found',
  status: 404,
  error: 'not_found',
  docs: 'https://open-pay.jp/openapi.json',
});

function notFound(): Response {
  return new Response(BODY, {
    status: 404,
    headers: { 'Content-Type': 'application/problem+json; charset=utf-8' },
  });
}

export const GET = notFound;
export const POST = notFound;
export const PUT = notFound;
export const PATCH = notFound;
export const DELETE = notFound;
export const OPTIONS = notFound;
