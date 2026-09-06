import 'server-only';

import { createHmac } from 'node:crypto';
import { isIP } from 'node:net';

import { logger } from '@/lib/logger';
import { isCloudflareIp } from '@/lib/net/cloudflareIps';
import { parseIp } from '@/lib/net/ipParse';

const MIN_SECRET_BYTES = 32;

// IP_HASH_SECRET 欠落/過短は hashIp=null → checkIpRateLimit が skip する (許可挙動は不変・
// fail-open)。ただし「IP レート制限が全 endpoint で無効」という構成ミスが無音で続くのを防ぐため、
// プロセスごとに 1 回だけ warn を出す (relay hot path のログスパム防止・lib/alphaBypass と同型)。
let warnedIpHashDisabled = false;
// 接続元の信頼判定が外れて edge IP ごとの無効な制限へ退化する状態を可視化する。
// flood が警告ログ量へ波及するのを断つためプロセスごとに 1 回だけ (生 IP は記録しない)。
let warnedCfIpUntrusted = false;

function normalizeIp(ip: string): string | null {
  const trimmed = ip.trim();
  const parsed = parseIp(trimmed);
  if (parsed === null) return null;
  if (parsed.width === 32) {
    // IPv4-mapped IPv6 も dotted IPv4 に揃え、表記替えによる limiter bucket 分裂を断つ。
    return [24n, 16n, 8n, 0n].map((shift) => (parsed.value >> shift) & 0xffn).join('.');
  }

  try {
    // WHATWG URL は IPv6 literal を圧縮済み小文字表記へ canonicalize する。
    const hostname = new URL(`http://[${trimmed}]`).hostname;
    return hostname.slice(1, -1);
  } catch {
    // URL が扱えない IPv6 literal (zone ID 等) を header 経由の例外へ波及させない。
    return null;
  }
}

// Vercel が見た接続元 (Cloudflare 配下ならエッジ IP)。
function connectingIp(req: Request): string | null {
  const vercelForwardedFor = req.headers.get('x-vercel-forwarded-for');
  if (vercelForwardedFor !== null) return normalizeIp(vercelForwardedFor.split(',', 1)[0]);

  const forwardedFor = req.headers.get('x-forwarded-for');
  if (forwardedFor === null) return null;
  return normalizeIp(forwardedFor.split(',', 1)[0]);
}

export function clientIp(req: Request): string | null {
  const connecting = connectingIp(req);
  // open-pay.jp は Cloudflare 配下 (2026-09-06 発覚): 接続元はエッジ IP で毎回変わり、IP 固定窓の
  // レート制限が効かなかった。真の利用者 IP は `cf-connecting-ip` にあるが、無条件に信じると Vercel
  // 直叩きで偽装できるので、**Vercel 由来の接続元が Cloudflare の公開レンジのときだけ** 採用する
  // (lib/net/cloudflareIps.ts)。それ以外 (直叩き・レンジ更新漏れ) は従来どおり接続元 IP。
  const cfConnectingIp = req.headers.get('cf-connecting-ip');
  if (cfConnectingIp !== null) {
    // XFF fallback は呼出元が偽装できるため、Cloudflare の IP を名乗っても trust を昇格させない。
    const hasVercelForwardedFor = req.headers.has('x-vercel-forwarded-for');
    if (hasVercelForwardedFor && connecting !== null && isCloudflareIp(connecting)) {
      const real = normalizeIp(cfConnectingIp);
      if (real !== null) return real;
    } else if (!warnedCfIpUntrusted) {
      warnedCfIpUntrusted = true;
      logger.warn('ratelimit.cf_ip_untrusted', {
        connectingIpVersion: connecting === null ? null : isIP(connecting),
        hasVercelForwardedFor,
      });
    }
  }
  return connecting;
}

export function hashIp(ip: string | null): string | null {
  if (ip === null) return null;
  const normalized = normalizeIp(ip);
  if (normalized === null) return null;

  const secret = process.env.IP_HASH_SECRET;
  if (!secret || Buffer.byteLength(secret, 'utf8') < MIN_SECRET_BYTES) {
    if (!warnedIpHashDisabled) {
      warnedIpHashDisabled = true;
      logger.warn('ratelimit.ip_hash_disabled', {
        reason: secret ? 'secret_too_short' : 'secret_missing',
        minBytes: MIN_SECRET_BYTES,
      });
    }
    return null;
  }

  return createHmac('sha256', secret).update(`ip:${normalized}`).digest('hex');
}
