import { describe, it, expect } from 'vitest';
import {
  fetchSsrfSafe,
  isFreelyAccessible,
  isPrivateHost,
} from '@/lib/x402/moderation';

const fetchWith = (status: number): typeof fetch =>
  (async () => ({ status }) as Response) as unknown as typeof fetch;
const fetchThrows: typeof fetch = (async () => {
  throw new Error('network');
}) as unknown as typeof fetch;
const lookupPublic = async () => [{ address: '93.184.216.34' }]; // example.com (public)
const lookupPrivate = async () => [{ address: '127.0.0.1' }];
const lookupMixed = async () => [
  { address: '93.184.216.34' },
  { address: '169.254.169.254' }, // 1つでも private なら拒否
];

describe('lib/x402/moderation isFreelyAccessible', () => {
  it('200 (公開 IP に解決) → true (= 登録拒否対象)', async () => {
    expect(
      await isFreelyAccessible('https://x.test', { fetchImpl: fetchWith(200), lookup: lookupPublic }),
    ).toBe(true);
  });

  it.each([301, 302, 307, 308, 402, 401, 403, 404, 500, 503])(
    '非 200 (%i・3xx は redirect 非追跡) → false (= 通す)',
    async (status) => {
      expect(
        await isFreelyAccessible('https://x.test', {
          fetchImpl: fetchWith(status),
          lookup: lookupPublic,
        }),
      ).toBe(false);
    },
  );

  it('fetch エラー/タイムアウト → false (fail-open)', async () => {
    expect(
      await isFreelyAccessible('https://x.test', { fetchImpl: fetchThrows, lookup: lookupPublic }),
    ).toBe(false);
  });

  it('DNS が private IP に解決 → probe せず false (SSRF rebinding 防止)', async () => {
    let fetched = false;
    const fetchSpy: typeof fetch = (async () => {
      fetched = true;
      return { status: 200 } as Response;
    }) as unknown as typeof fetch;
    expect(
      await isFreelyAccessible('https://evil.test', { fetchImpl: fetchSpy, lookup: lookupPrivate }),
    ).toBe(false);
    expect(fetched).toBe(false); // 内部宛 fetch を行わない
  });

  it('解決先に private が1つでも混ざれば → false', async () => {
    expect(
      await isFreelyAccessible('https://x.test', { fetchImpl: fetchWith(200), lookup: lookupMixed }),
    ).toBe(false);
  });

  it('DNS 解決失敗 → false (fail-open)', async () => {
    const lookupThrows = async () => {
      throw new Error('NXDOMAIN');
    };
    expect(
      await isFreelyAccessible('https://x.test', { fetchImpl: fetchWith(200), lookup: lookupThrows }),
    ).toBe(false);
  });

  it('実 node:dns (lookup 非注入)・localhost → 127.0.0.1 に解決し fetch せず false', async () => {
    // 既定 lookup (node:dns/promises) を実際に走らせる統合パス。localhost は常に loopback に解決され、
    // isPrivateHost が真 → probe (fetch) せず false。fetch が呼ばれたら SSRF ガード破れなので spy で検証。
    let fetched = false;
    const fetchSpy = (async () => {
      fetched = true;
      return { status: 200 } as Response;
    }) as unknown as typeof fetch;
    expect(await isFreelyAccessible('http://localhost', { fetchImpl: fetchSpy })).toBe(false);
    expect(fetched).toBe(false); // 解決先 127.0.0.1 が private → fetch しない
  });
});

describe('lib/x402/moderation fetchSsrfSafe options', () => {
  it('redirect は既定 manual を維持し、明示した error を fetch sink へ渡す', async () => {
    const redirects: RequestRedirect[] = [];
    const fetchSpy = (async (_url: string, init?: RequestInit) => {
      redirects.push(init?.redirect ?? 'follow');
      return new Response(null, { status: 204 });
    }) as typeof fetch;

    await fetchSsrfSafe('https://x.test/avatar.png', {
      fetchImpl: fetchSpy,
      lookup: lookupPublic,
    });
    await fetchSsrfSafe('https://x.test/avatar.png', {
      fetchImpl: fetchSpy,
      lookup: lookupPublic,
      redirect: 'error',
    });

    expect(redirects).toEqual(['manual', 'error']);
  });
});

describe('lib/x402/moderation isPrivateHost', () => {
  it.each([
    'localhost',
    '127.0.0.1',
    '0.0.0.0',
    '10.0.0.1',
    '192.168.1.1',
    '172.16.0.1',
    '172.31.255.255',
    '169.254.169.254',
    '100.64.0.1', // CGNAT 100.64.0.0/10
    '100.127.255.255',
    '::1',
    '::', // unspecified
    '[::1]', // bracketed (URL hostname 形)
    '::ffff:127.0.0.1', // IPv4-mapped IPv6 (dotted)
    '::ffff:7f00:1', // IPv4-mapped IPv6 (hex 圧縮形) = 127.0.0.1 — 旧 regex の取りこぼし
    '0:0:0:0:0:ffff:7f00:1', // mapped 完全表記 = 127.0.0.1
    '::ffff:a9fe:a9fe', // mapped 169.254.169.254 (cloud metadata)
    '::ffff:c0a8:101', // mapped 192.168.1.1
    '::ffff:0a00:1', // mapped 10.0.0.1
    'fe80::1', // link-local
    'fc00::1', // ULA
    'fd12::34',
    'svc.local',
    'db.internal',
    // 末尾ドット (FQDN root ラベル) を剥がして判定する — 旧実装は末尾ドットで localhost/IPv4 判定を素通り。
    'localhost.',
    'svc.local.',
    'db.internal.',
    '127.0.0.1.',
    '10.0.0.1.',
    '192.168.1.1.',
    '169.254.169.254.', // cloud metadata + 末尾ドット
  ])('private/loopback %s → true', (host) => {
    expect(isPrivateHost(host)).toBe(true);
  });

  it.each([
    'example.com',
    'api.aegis-ai.xyz',
    '8.8.8.8',
    '1.1.1.1',
    '172.32.0.1',
    '11.0.0.1',
    '100.63.0.1', // CGNAT 下限の直前
    '100.128.0.1', // CGNAT 上限の直後
    '2606:4700::1111', // 公開 IPv6 (Cloudflare)
    '::ffff:808:808', // mapped 8.8.8.8 (公開・mapped でも内側が公開なら通す)
    '::ffff:0808:0808', // 同 (zero-padded)
    'example.com.', // 公開 FQDN + 末尾ドット (正規化しても private にはしない)
    '8.8.8.8.', // 公開 IPv4 + 末尾ドット
  ])('public %s → false', (host) => {
    expect(isPrivateHost(host)).toBe(false);
  });
});

describe('lib/x402/moderation IPv6 リテラル / 末尾ドット正規化 (fail-open バイパス封鎖)', () => {
  // 実 dns.lookup は角括弧付きホスト ([2606:..]) で ENOTFOUND を投げる。正規化しないと probe 関数の
  // catch で fail-open し、IPv6 リテラルで登録した URL のモデレーション (無料転売検出) が丸ごと無効化。
  const lookupBracketAware = async (h: string) => {
    if (h.startsWith('[') || h.endsWith(']')) throw new Error('ENOTFOUND');
    return [{ address: '2606:4700:4700::1111' }]; // 公開 IPv6 に解決
  };

  it('公開 IPv6 リテラル URL: 角括弧を剥がして解決 → 200 を検出 (旧実装は fail-open で false)', async () => {
    expect(
      await isFreelyAccessible('https://[2606:4700:4700::1111]/paid', {
        fetchImpl: fetchWith(200),
        lookup: lookupBracketAware,
      }),
    ).toBe(true); // moderation が実際に働き「無料公開 → 登録拒否対象」を返す
  });

  it('IPv6 リテラル [::1] (loopback): 正規化して private 判定 → probe せず false', async () => {
    let fetched = false;
    const fetchSpy = (async () => {
      fetched = true;
      return { status: 200 } as Response;
    }) as unknown as typeof fetch;
    // lookup は渡された (正規化済) hostname をそのまま IP として返す = 実 dns.lookup(リテラル) 相当。
    const r = await isFreelyAccessible('https://[::1]/', {
      fetchImpl: fetchSpy,
      lookup: async (h: string) => [{ address: h }],
    });
    expect(fetched).toBe(false); // 内部宛 fetch しない
    expect(r).toBe(false);
  });
});

describe('lib/x402/moderation bridgeLookupResult (undici connect.lookup 契約)', () => {
  // ⚠️ Node 20+ happy-eyeballs: net は options.all=true で lookup を呼び、callback 第2引数に
  // **LookupAddress の配列** を期待する。単一 (address, family) を返すと net が
  // `Invalid IP address: undefined` で即死し、SSRF Agent 経由の全 outbound fetch が失敗する
  // (2026-07-14 本番 reverify cron 全滅の実バグ)。この契約テストがその形を固定する。
  const publicV6First = [
    { address: '2606:4700:3036::ac43:cdad', family: 6 },
    { address: '172.67.205.173', family: 4 },
  ];

  it('wantAll=true → callback(null, 配列) — 各要素が address/family を持つ', async () => {
    const { bridgeLookupResult } = await import('@/lib/x402/moderation');
    const args: unknown[] = [];
    bridgeLookupResult(true, publicV6First, (...a: unknown[]) => args.push(...a));
    expect(args[0]).toBe(null);
    expect(Array.isArray(args[1])).toBe(true);
    const addrs = args[1] as Array<{ address: string; family: number }>;
    expect(addrs.map((a) => a.address)).toEqual(publicV6First.map((a) => a.address));
    expect(addrs.every((a) => typeof a.address === 'string' && a.address.length > 0)).toBe(true);
  });

  it('wantAll=false → callback(null, address, family) の単一形', async () => {
    const { bridgeLookupResult } = await import('@/lib/x402/moderation');
    const args: unknown[] = [];
    bridgeLookupResult(false, publicV6First, (...a: unknown[]) => args.push(...a));
    expect(args).toEqual([null, '2606:4700:3036::ac43:cdad', 6]);
  });

  it('private を1つでも含む → error callback (SSRF block・両形共通)', async () => {
    const { bridgeLookupResult } = await import('@/lib/x402/moderation');
    for (const wantAll of [true, false]) {
      const args: unknown[] = [];
      bridgeLookupResult(
        wantAll,
        [
          { address: '93.184.216.34', family: 4 },
          { address: '169.254.169.254', family: 4 },
        ],
        (...a: unknown[]) => args.push(...a),
      );
      expect(args[0]).toBeInstanceOf(Error);
      expect((args[0] as Error).message).toBe('ssrf_blocked_private_address');
    }
  });

  it('解決結果が空 → error callback', async () => {
    const { bridgeLookupResult } = await import('@/lib/x402/moderation');
    const args: unknown[] = [];
    bridgeLookupResult(true, [], (...a: unknown[]) => args.push(...a));
    expect(args[0]).toBeInstanceOf(Error);
  });
});
