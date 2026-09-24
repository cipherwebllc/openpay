// verify/settle (同一プロセス内で route handler を直接呼ぶ) へ、レート制限の IP 判定に要る転送ヘッダを
// 引き継ぐ。Cloudflare 配下では接続元 (x-vercel-forwarded-for) と真の利用者 IP (cf-connecting-ip) の
// 両方が揃って初めて clientIp() が利用者 IP を採用する (lib/net/ipHash.ts)。
const FORWARDED_IP_HEADERS = [
  'x-forwarded-for',
  'x-real-ip',
  'x-vercel-forwarded-for',
  'cf-connecting-ip',
] as const;

export function cloneForwardHeaders(req: Request): Headers {
  const h = new Headers({ 'content-type': 'application/json' });
  for (const name of FORWARDED_IP_HEADERS) {
    const value = req.headers.get(name);
    if (value) h.set(name, value);
  }
  return h;
}
