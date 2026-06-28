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
//   2. probe 前に DNS 解決し、解決先 IP のいずれかが private/loopback/link-local/CGNAT なら probe しない
//      (DNS rebinding / 公開ドメイン→内部IP を防ぐ)。
//   3. redirect: 'manual' でリダイレクト追跡を止める (公開 URL→内部 URL への 3xx 誘導を防ぐ)。3xx は
//      「200 ではない」ので拒否対象外 (= 通す)。
//   4. body は読まず status のみ参照・短いタイムアウト。
// 残存 TOCTOU (解決と接続の間に DNS が変わる) は許容: probe は status の真偽のみで応答本文を取らないため
// 情報露出はほぼ無く、fail-open ゆえ誤判定でも登録を不正に通すことはあっても内部到達は上記で抑止される。

const PROBE_TIMEOUT_MS = 5000;

type ResolvedAddr = { address: string };
type LookupFn = (hostname: string) => Promise<ResolvedAddr[]>;

// 既定 DNS 解決 (node:dns)。動的 import で node:dns をモジュール静的グラフから外し、isPrivateHost を
// 別文脈で import しても node 依存を持ち込まない。test は opts.lookup で差し替える。
const defaultLookup: LookupFn = async (hostname) => {
  const dns = await import('node:dns/promises');
  return dns.lookup(hostname, { all: true });
};

// URL が「無料で誰でも取得できる (= status 200)」かを判定する。true なら有料登録は不当 → 拒否。
// opts.fetchImpl / opts.lookup は test 注入用。例外/非 200/private 解決は false (= 弾かない・fail-open)。
export async function isFreelyAccessible(
  url: string,
  opts: { fetchImpl?: typeof fetch; lookup?: LookupFn } = {},
): Promise<boolean> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const lookup = opts.lookup ?? defaultLookup;

  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return false;
  }

  // DNS rebinding 対策: 解決先 IP のいずれかが private/loopback 系なら probe しない (内部到達を防ぐ)。
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

// hostname / IP リテラルが private / loopback / link-local / CGNAT / ULA かを判定 (SSRF ガード)。
// registry.parseResourceInput (literal 事前ガード) と isFreelyAccessible (解決先 IP 検査) の両方で使う。
export function isPrivateHost(hostname: string): boolean {
  let h = hostname.toLowerCase().replace(/^\[|\]$/g, ''); // [::1] → ::1
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return true;
  // IPv4-mapped IPv6 (::ffff:127.0.0.1) は内側 IPv4 を検査対象にする。
  const mapped = h.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped) h = mapped[1];
  // IPv6 loopback / unspecified / ULA (fc00::/7) / link-local (fe80::/10)。
  if (h === '::1' || h === '::') return true;
  if (/^f[cd]/.test(h)) return true;
  if (/^fe[89ab]/.test(h)) return true;
  // IPv4 リテラル。
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a === 0 || a === 127 || a === 10) return true; // this-host / loopback / private
    if (a === 169 && b === 254) return true; // link-local (cloud metadata 169.254.169.254 等)
    if (a === 192 && b === 168) return true; // private
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  }
  return false;
}
