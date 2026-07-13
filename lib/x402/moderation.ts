import 'server-only';

// x402 facilitator の出品モデレーション: 「無料で公開されている URL を価格付きで登録する」濫用を弾く。
//
// x402 は本来「リソース提供者が自分の API を支払いでゲート (HTTP 402 等) し、支払った相手にだけ
// 提供する」前提。誰でも無料で 200 を取得できる URL を有料登録すると、買い手は無料アクセス相当に
// 課金され (迂回も可能)、第三者リソースの無断転売にもなりうる。登録時に URL を best-effort で probe し、
// **200 (無料公開) を確認したら登録を拒否**する。3xx/402/401/403/5xx/エラー/タイムアウト (不明) は通す
// = **fail-open** で正当な売り手を一時障害で弾かない (確実に無料と分かったときだけ締める)。
//
// SSRF 対策 (probe は外部 URL を fetch するため多層で防御):
//   1. parseResourceInput (registry.ts) が literal な private/loopback ホストを事前に弾く。
//   2. probe 前に DNS 解決し、解決先 IP が private なら probe しない (早期拒否 + テスト用)。
//   3. **接続時 (connect-time) にも解決先 IP を検証する undici Agent で fetch する**。precheck は public・
//      実接続は private に解決する DNS rebinding を connect の瞬間に塞ぐ (precheck と接続で同じ解決を
//      使わない TOCTOU を解消)。
//   4. redirect: 'manual' でリダイレクト追跡を止める (公開 URL→内部 URL への 3xx 誘導を防ぐ)。3xx は
//      「200 ではない」ので拒否対象外 (= 通す)。
//   5. gate 判定に読む body は 64KiB で打ち切り、短いタイムアウトを併用する。

import { readJsonBodyCapped } from '@/lib/httpBodyCap';
import { isPrivateHost, normalizeHost } from '@/lib/net/privateHost';

export { isPrivateHost } from '@/lib/net/privateHost';

const PROBE_TIMEOUT_MS = 5000;
export const GATE_BODY_MAX_BYTES = 64 * 1024;

type ResolvedAddr = { address: string };
export type LookupFn = (hostname: string) => Promise<ResolvedAddr[]>;

// 既定 DNS 解決 (node:dns)。動的 import で node:dns をモジュール静的グラフから外し、isPrivateHost を
// 別文脈で import しても node 依存を持ち込まない。test は opts.lookup で差し替える。
const defaultLookup: LookupFn = async (hostname) => {
  const dns = await import('node:dns/promises');
  return dns.lookup(hostname, { all: true });
};

// connect 時に解決先 IP を検証する SSRF-safe な undici Agent。net の lookup として実 DNS を呼び、
// 解決先のいずれかが private なら接続を拒否する → fetch 自身の再解決 (rebinding) を connect で塞ぐ。
// node 依存 (undici / node:dns) を静的グラフに載せないよう lazy 生成 + memo (defaultLookup と同流儀)。
let ssrfAgentPromise: Promise<unknown> | null = null;
function getSsrfAgent(): Promise<unknown> {
  if (!ssrfAgentPromise) {
    ssrfAgentPromise = (async () => {
      const { Agent } = await import('undici');
      const { lookup } = await import('node:dns');
      return new Agent({
        connect: {
          lookup: (hostname, options, cb) => {
            lookup(hostname, { ...options, all: true, verbatim: true }, (err, addresses) => {
              if (err) return cb(err, '', 0);
              const addrs = addresses as unknown as Array<{ address: string; family: number }>;
              if (addrs.length === 0 || addrs.some((a) => isPrivateHost(a.address))) {
                return cb(new Error('ssrf_blocked_private_address'), '', 0);
              }
              cb(null, addrs[0].address, addrs[0].family);
            });
          },
        },
      });
    })();
  }
  return ssrfAgentPromise;
}

// 既定 probe: undici + SSRF-safe Agent で fetch (connect 時 IP 検証つき)。status のみ参照。
const defaultFetch = async (url: string, init: RequestInit): Promise<{ status: number }> => {
  const { fetch } = await import('undici');
  const dispatcher = await getSsrfAgent();
  return fetch(url, { ...init, dispatcher } as Parameters<typeof fetch>[1]);
};

export type SsrfSafeFetchOptions = {
  fetchImpl?: typeof fetch;
  lookup?: LookupFn;
  timeoutMs?: number;
  userAgent?: string;
};

// moderation / 定期再検証で共有する SSRF-safe GET。URL parse・DNS precheck・connect-time
// private-IP guard・manual redirect・timeout を一箇所に固定し、呼び元は HTTP/body の意味だけを判定する。
// null は URL/DNS/private 解決/fetch failure のいずれかで、外部状態を確定できなかったことを表す。
export async function fetchSsrfSafe(
  url: string,
  opts: SsrfSafeFetchOptions = {},
): Promise<Response | null> {
  const fetchImpl = opts.fetchImpl ?? (defaultFetch as unknown as typeof fetch);
  const lookup = opts.lookup ?? defaultLookup;

  let hostname: string;
  try {
    hostname = normalizeHost(new URL(url).hostname);
  } catch {
    return null;
  }
  try {
    const addrs = await lookup(hostname);
    if (addrs.length === 0 || addrs.some((a) => isPrivateHost(a.address))) return null;
  } catch {
    return null;
  }

  try {
    return await fetchImpl(url, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(opts.timeoutMs ?? PROBE_TIMEOUT_MS),
      headers: {
        'user-agent': opts.userAgent ?? 'OpenPay-x402-facilitator-moderation/1.0',
      },
    });
  } catch {
    return null;
  }
}

// URL が「無料で誰でも取得できる (= status 200)」かを判定する。true なら有料登録は不当 → 拒否。
// opts.fetchImpl / opts.lookup は test 注入用。例外/非 200/private 解決は false (= 弾かない・fail-open)。
export async function isFreelyAccessible(
  url: string,
  opts: { fetchImpl?: typeof fetch; lookup?: LookupFn } = {},
): Promise<boolean> {
  const res = await fetchSsrfSafe(url, opts);
  return res?.status === 200;
}

// 登録 URL のゲートが「OpenPay の JPYC accepts を返す」実装かを判定する。
//   'openpay' = 402 の accepts に extra.openpay.mode === 'forwarder-split' がある (掲載可)
//   'foreign' = 402 は返すが accepts が他 facilitator (USDC/Base 等)・または解釈不能 (掲載拒否 —
//               「JPYC で払える」というカタログの約束を守れないため)
//   'unknown' = 200/402 以外・ネットワーク失敗・private 解決など判定不能 (fail-open で掲載可 —
//               サーバー到達性は保証しない従来意味論を維持)
// v1 (JSON body) と v2 (PAYMENT-REQUIRED ヘッダ) の両輸送を見る。
export type GateProbeResult = 'openpay' | 'foreign' | 'unknown';

export function acceptsLookLikeOpenPay(accepts: unknown): boolean {
  if (!Array.isArray(accepts)) return false;
  return accepts.some((a) => {
    if (typeof a !== 'object' || a === null) return false;
    const extra = (a as { extra?: unknown }).extra;
    if (typeof extra !== 'object' || extra === null) return false;
    const openpay = (extra as { openpay?: unknown }).openpay;
    return (
      typeof openpay === 'object' &&
      openpay !== null &&
      (openpay as { mode?: unknown }).mode === 'forwarder-split'
    );
  });
}

export async function probeGate(
  url: string,
  opts: { fetchImpl?: typeof fetch; lookup?: LookupFn } = {},
): Promise<GateProbeResult> {
  try {
    const res = await fetchSsrfSafe(url, opts);
    if (!res) return 'unknown';
    if (res.status !== 402) return 'unknown';
    // v2: PAYMENT-REQUIRED ヘッダ (base64 JSON)
    const v2Header = res.headers?.get?.('payment-required');
    if (v2Header) {
      try {
        const decoded = JSON.parse(Buffer.from(v2Header, 'base64').toString('utf8')) as {
          accepts?: unknown;
        };
        if (acceptsLookLikeOpenPay(decoded.accepts)) return 'openpay';
      } catch {
        /* v2 ヘッダが読めなければ body 判定へ */
      }
    }
    // v1: JSON body。巨大・stream failure・非 UTF-8・非 JSON は「JPYC で払える」と解釈できないため
    // unknown へ fail-open せず foreign として掲載を拒否する。
    const body = await readJsonBodyCapped(res, GATE_BODY_MAX_BYTES);
    if (
      body.ok &&
      typeof body.value === 'object' &&
      body.value !== null &&
      acceptsLookLikeOpenPay((body.value as { accepts?: unknown }).accepts)
    ) {
      return 'openpay';
    }
    return 'foreign';
  } catch {
    return 'unknown';
  }
}
