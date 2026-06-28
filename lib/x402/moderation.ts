// x402 facilitator の出品モデレーション: 「無料で公開されている URL を価格付きで登録する」濫用を弾く。
//
// x402 は本来「リソース提供者が自分の API を支払いでゲート (HTTP 402 等) し、支払った相手にだけ
// 提供する」前提。誰でも無料で 200 を取得できる URL を有料登録すると、買い手は無料アクセス相当に
// 課金され (迂回も可能)、第三者リソースの無断転売にもなりうる。登録時に URL を best-effort で probe し、
// **200 (無料公開) を確認したら登録を拒否**する。402/401/403 (ゲート済) や 5xx/エラー/タイムアウト
// (不明) は通す = **fail-open** で正当な売り手を一時障害で弾かない (確実に無料と分かったときだけ締める)。
//
// SSRF: probe 先は外部 URL なので、private/loopback ホストは parseResourceInput (registry.ts) 側で
// 事前に弾く。本関数は public host 前提で呼ばれる。残存リスク (DNS rebinding 等) は許容 (probe は
// 読み取り GET のみ・body は読まない・短いタイムアウト)。

const PROBE_TIMEOUT_MS = 5000;

// URL が「無料で誰でも取得できる (= status 200)」かを判定する。true なら有料登録は不当 → 拒否。
// fetchImpl は test 注入用 (既定 = global fetch)。例外/非 200 は false (= 弾かない・fail-open)。
export async function isFreelyAccessible(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      redirect: 'follow',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      headers: { 'user-agent': 'OpenPay-x402-facilitator-moderation/1.0' },
    });
    // 200 = 支払い無しで取得できた = 無料公開。402/401/403 = ゲート済。その他/5xx = 不明。
    return res.status === 200;
  } catch {
    // ネットワークエラー / タイムアウト / abort 等は「無料と確認できない」→ fail-open (通す)。
    return false;
  }
}

// hostname が private / loopback / link-local かを判定 (SSRF 事前ガード)。registry.parseResourceInput
// から使い、private 宛の登録自体を弾く (probe 先を public host に限定する)。
export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, ''); // [::1] → ::1
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (h === '::1' || h === '0.0.0.0' || h.startsWith('fc') || h.startsWith('fd')) return true; // IPv6 loopback / ULA
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a === 0 || a === 127 || a === 10) return true; // this-host / loopback / private
    if (a === 169 && b === 254) return true; // link-local (cloud metadata 169.254.169.254 等)
    if (a === 192 && b === 168) return true; // private
    if (a === 172 && b >= 16 && b <= 31) return true; // private
  }
  return false;
}
