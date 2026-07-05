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
//   5. body は読まず status のみ参照・短いタイムアウト。

const PROBE_TIMEOUT_MS = 5000;

type ResolvedAddr = { address: string };
type LookupFn = (hostname: string) => Promise<ResolvedAddr[]>;

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

// URL が「無料で誰でも取得できる (= status 200)」かを判定する。true なら有料登録は不当 → 拒否。
// opts.fetchImpl / opts.lookup は test 注入用。例外/非 200/private 解決は false (= 弾かない・fail-open)。
export async function isFreelyAccessible(
  url: string,
  opts: { fetchImpl?: typeof fetch; lookup?: LookupFn } = {},
): Promise<boolean> {
  const fetchImpl = opts.fetchImpl ?? (defaultFetch as unknown as typeof fetch);
  const lookup = opts.lookup ?? defaultLookup;

  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return false;
  }

  // 早期拒否: 解決先 IP のいずれかが private 系なら probe しない (connect-time guard の前段 + テスト用)。
  // 解決不能・空も probe しない (fail-open)。
  try {
    const addrs = await lookup(hostname);
    if (addrs.length === 0 || addrs.some((a) => isPrivateHost(a.address))) return false;
  } catch {
    return false;
  }

  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      redirect: 'manual', // リダイレクト追跡で private へ飛ばす SSRF を防ぐ (3xx は 200 でないので通す)
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      headers: { 'user-agent': 'OpenPay-x402-facilitator-moderation/1.0' },
    });
    return res.status === 200;
  } catch {
    return false;
  }
}

// 登録 URL のゲートが「OpenPay の JPYC accepts を返す」実装かを判定する。
//   'openpay' = 402 の accepts に extra.openpay.mode === 'forwarder-split' がある (掲載可)
//   'foreign' = 402 は返すが accepts が他 facilitator (USDC/Base 等)・または解釈不能 (掲載拒否 —
//               「JPYC で払える」というカタログの約束を守れないため)
//   'unknown' = 200/402 以外・ネットワーク失敗・private 解決など判定不能 (fail-open で掲載可 —
//               サーバー到達性は保証しない従来意味論を維持)
// v1 (JSON body) と v2 (PAYMENT-REQUIRED ヘッダ) の両輸送を見る。
export type GateProbeResult = 'openpay' | 'foreign' | 'unknown';

function acceptsLookLikeOpenPay(accepts: unknown): boolean {
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
  const fetchImpl = opts.fetchImpl ?? (defaultFetch as unknown as typeof fetch);
  const lookup = opts.lookup ?? defaultLookup;

  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return 'unknown';
  }
  try {
    const addrs = await lookup(hostname);
    if (addrs.length === 0 || addrs.some((a) => isPrivateHost(a.address))) return 'unknown';
  } catch {
    return 'unknown';
  }

  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      headers: { 'user-agent': 'OpenPay-x402-facilitator-moderation/1.0' },
    });
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
    // v1: JSON body
    try {
      const body = (await res.json()) as { accepts?: unknown };
      if (acceptsLookLikeOpenPay(body.accepts)) return 'openpay';
    } catch {
      /* body が JSON でない → foreign 扱い (下) */
    }
    return 'foreign';
  } catch {
    return 'unknown';
  }
}

// IPv4 の先頭 2 オクテットで private/loopback/link-local/CGNAT/this-host を判定 (範囲は先頭 2 octet で確定)。
function isPrivateIpv4(a: number, b: number): boolean {
  if (a === 0 || a === 127 || a === 10) return true; // this-host / loopback / private
  if (a === 169 && b === 254) return true; // link-local (cloud metadata 169.254.169.254 等)
  if (a === 192 && b === 168) return true; // private
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  return false;
}

// IPv6 リテラルを 8 グループ (各 16bit) に展開する。:: を 0 で埋め、末尾の埋め込み IPv4 (a.b.c.d) は
// 2 グループの hex に正規化する。不正な形は null (呼び元が安全側に倒す)。
function expandIpv6(h: string): number[] | null {
  let s = h;
  const embeddedV4 = s.match(/^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (embeddedV4) {
    const o = embeddedV4[2].split('.').map(Number);
    if (o.some((n) => n > 255)) return null;
    s = `${embeddedV4[1]}${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : null;
  let groups: string[];
  if (tail === null) {
    groups = head; // :: 無し (完全表記)
  } else {
    const fill = 8 - head.length - tail.length;
    if (fill < 0) return null;
    groups = [...head, ...Array<string>(fill).fill('0'), ...tail];
  }
  if (groups.length !== 8) return null;
  const nums = groups.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : -1));
  return nums.some((n) => n < 0) ? null : nums;
}

// hostname / IP リテラルが private / loopback / link-local / CGNAT / ULA かを判定 (SSRF ガード)。
// registry.parseResourceInput (literal 事前ガード)・isFreelyAccessible (早期拒否 + connect 時検証) で使う。
export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, ''); // [::1] → ::1
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return true;

  // IPv6 リテラル (':' を含む)。展開して mapped-IPv4 / loopback / unspecified / ULA / link-local を判定。
  // 圧縮形 (::ffff:7f00:1) や完全表記も canonical 化するため regex だけの取りこぼしを防ぐ。
  if (h.includes(':')) {
    const g = expandIpv6(h);
    if (g === null) return true; // 解析不能な IPv6 リテラルは安全側で private 扱い
    if (g.every((x) => x === 0)) return true; // :: (unspecified)
    if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1 (loopback)
    // IPv4-mapped (::ffff:a.b.c.d) / IPv4-compatible (::a.b.c.d): 先頭 80bit=0 かつ次 16bit が ffff or 0。
    if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) {
      return isPrivateIpv4((g[6] >> 8) & 0xff, g[6] & 0xff);
    }
    if (g[0] >= 0xfc00 && g[0] <= 0xfdff) return true; // ULA fc00::/7
    if (g[0] >= 0xfe80 && g[0] <= 0xfebf) return true; // link-local fe80::/10
    return false; // 公開 IPv6
  }

  // IPv4 リテラル。
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) return isPrivateIpv4(Number(m[1]), Number(m[2]));
  return false;
}
