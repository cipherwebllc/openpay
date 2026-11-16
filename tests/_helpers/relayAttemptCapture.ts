import { vi } from 'vitest';

// JPYC ガスレス (useJpycEip3009Payment) の 1 回の試みが外へ出すものを、そのまま比べられる形で採る
// (bill key のテストが使う): ウォレットに渡す typed data・relay へ POST する body・POST の瞬間に storage にあるもの。
// 時刻と乱数を固定すれば、同じ入力の試みは 1 byte も違わない文字列になる。

// テストで固定する時刻 (2026-11-17T03:00:00Z)。validBefore = この秒 + 300。
export const FIXED_NOW_MS = Date.UTC(2026, 10, 17, 3, 0, 0);

// bigint を 10 進の文字列にして JSON にする (typed data の value・validBefore など)。
export function jsonWithBigint(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => (typeof v === 'bigint' ? `${v}n` : v));
}

// crypto.getRandomValues を「呼ばれた回数で決まる byte」で埋める (1 回目 0xa0…・2 回目 0xa1…)。
// 戻り値の calls で、乱数を何回引いたかを数える。
export function stubRandom(): { calls: () => number } {
  let n = 0;
  vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(
    <T extends ArrayBufferView | null>(array: T): T => {
      if (array) new Uint8Array(array.buffer, array.byteOffset, array.byteLength).fill(0xa0 + n);
      n += 1;
      return array;
    },
  );
  return { calls: () => n };
}

// n 回目 (0 始まり) の乱数が作る 32 byte の hex。
export function randomHex32(n: number): `0x${string}` {
  return `0x${(0xa0 + n).toString(16).repeat(32)}`;
}

function dump(storage: Storage): Record<string, string> {
  const out: Record<string, string> = {};
  const keys: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key !== null) keys.push(key);
  }
  for (const key of keys.sort()) out[key] = storage.getItem(key) ?? '';
  return out;
}

// sessionStorage と localStorage の中身の全部 (key の順をそろえる)。
export function dumpStorage(): string {
  return JSON.stringify({ session: dump(window.sessionStorage), local: dump(window.localStorage) });
}

export type RelayPost = { url: string; body: string; storageAtPost: string };

// fetch を差し替えて、/api/relay/jpyc への POST の body と、その瞬間の storage を採る。ほかの URL への fetch の body も
// others に残す (/api/log/payment など)。relay の応答は respond で決める (既定 = txHash つきの成功)。
export function stubRelayFetch(
  respond: () => Response = () =>
    new Response(JSON.stringify({ ok: true, txHash: `0x${'b'.repeat(64)}` }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
): { posts: RelayPost[]; others: { url: string; body: string }[] } {
  const posts: RelayPost[] = [];
  const others: { url: string; body: string }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const body = typeof init?.body === 'string' ? init.body : '';
      if (url === '/api/relay/jpyc') {
        posts.push({ url, body, storageAtPost: dumpStorage() });
        return respond();
      }
      others.push({ url, body });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  return { posts, others };
}
