import { describe, it, expect, afterEach, vi } from 'vitest';

// RELAYER_PRIVATE_KEY も GELATO_SPONSOR_API_KEY もテスト env に無いため、provider は起動時に
// null と判定され route は 503 relay_not_configured を返す = 設定するまで inert (client は
// 他 provider に fallback)。鍵が要る検証/submit/poll の分岐は DI コア (jpycRelay.test.ts) と
// self-host I/O (selfHostRelayer.test.ts) で担保。
//
// A5: POST の入口ゲートは status route (/api/relay/jpyc/status) と同じく
// 「flag (NEXT_PUBLIC_ENABLE_JPYC_EIP3009) + provider」の双方を要求する。本番は flag ON なので、
// ゲートより先を検証するテストは flag を明示 stub して本番と同じ前提で走らせる。
const EIP3009_ON = 'NEXT_PUBLIC_ENABLE_JPYC_EIP3009';

function req(body: unknown): Request {
  return new Request('http://localhost/api/relay/jpyc', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/relay/jpyc (env-gate)', () => {
  const DUMMY_RELAYER_KEY = `0x${'11'.repeat(32)}`;

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('GELATO_SPONSOR_API_KEY 未設定なら 503 relay_not_configured (inert・fallback signal)', async () => {
    vi.resetModules();
    vi.stubEnv(EIP3009_ON, '1');
    const mod = await import('@/app/api/relay/jpyc/route');
    const res = await mod.POST(req({ chainId: 137 }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      ok: false,
      error: 'relay_not_configured',
    });
  });

  // A5: client は flag OFF では relay を選ばないのに、直接 POST だけが provider さえあれば
  // 通っていた。status route と同じ条件を敷き、応答形は provider 未構成と byte-identical。
  it('flag OFF は provider があっても provider-null と同一の 503 relay_not_configured', async () => {
    vi.resetModules();
    // flag は stub しない (= 既定 OFF)。provider だけ有効にする。
    vi.stubEnv('RELAYER_PRIVATE_KEY', DUMMY_RELAYER_KEY); // PROVIDER='self-host'
    const mod = await import('@/app/api/relay/jpyc/route');
    const res = await mod.POST(req({ chainId: 80002 }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      ok: false,
      error: 'relay_not_configured',
    });
  });

  it('flag ON + provider あり → 入口ゲートを抜けて通常フローへ (503 relay_not_configured にならない)', async () => {
    vi.resetModules();
    vi.stubEnv(EIP3009_ON, '1');
    vi.stubEnv('RELAYER_PRIVATE_KEY', DUMMY_RELAYER_KEY);
    const mod = await import('@/app/api/relay/jpyc/route');
    // body 不足なので free 経路の payload 検証で 400 になる = ゲートは抜けている。
    const res = await mod.POST(req({ chainId: 80002 }));
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe('invalid_payload');
  });
});

// recover (forwarder) × a1 (usage fee) の排他は resolver (jpycForwarderFor) で graceful に解決する:
// a1 が ON なら forwarderFor は全 chain で null を返すため recoverMode=false → handleFree に倒れ、
// 利用料ゲート/出来高メーターが効く。よって致命的な 503 (relay_misconfigured) は **出さない**
// (config guard が顧客の決済を壊すのは誤り)。両方を設定した運営の構成ミスは起動時 logger
// (configuredJpycForwarderFor 基準) で可視化される。
// module load では throw しない (開発 .env.local の併設や next build を壊さない)。
// 各 it は stub → resetModules → dynamic import で route を新規評価するので他テストとは独立。
describe('recover × a1 同時設定の排他 (a1 優先で graceful free 化)', () => {
  // 検証用 self-host 鍵 (秘密情報ではない・テスト専用の決定論値)。
  const DUMMY_RELAYER_KEY = `0x${'11'.repeat(32)}`;
  const DUMMY_FORWARDER = '0x0000000000000000000000000000000000000001';

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('mainnet forwarder + a1 + self-host → 503 relay_misconfigured を出さない (a1 優先で free モードに倒す)', async () => {
    vi.resetModules();
    vi.stubEnv(EIP3009_ON, '1');
    vi.stubEnv('NEXT_PUBLIC_ENABLE_USAGE_FEE', '1');
    vi.stubEnv('NEXT_PUBLIC_JPYC_FORWARDER_POLYGON', DUMMY_FORWARDER);
    vi.stubEnv('RELAYER_PRIVATE_KEY', DUMMY_RELAYER_KEY);
    const mod = await import('@/app/api/relay/jpyc/route');
    const res = await mod.POST(req({ chainId: 137 }));
    const body = (await res.json()) as { error?: string };
    // 致命的な排他 503 は出ない (顧客決済を壊さない)。a1 優先で forwarderFor=null → free モード。
    // このテスト env では mainnet self-host の B5 gas ceiling 未設定で 503 gas_ceiling_required に
    // 落ちるが、それは free 経路の前提条件であって recover 排他とは別物。
    expect(body.error).not.toBe('relay_misconfigured');
    expect(body.error).toBe('gas_ceiling_required');
  });

  it('mainnet forwarder + a1 でも module load は throw しない (next build を壊さない)', async () => {
    vi.resetModules();
    vi.stubEnv(EIP3009_ON, '1');
    vi.stubEnv('NEXT_PUBLIC_ENABLE_USAGE_FEE', '1');
    vi.stubEnv('NEXT_PUBLIC_JPYC_FORWARDER_POLYGON', DUMMY_FORWARDER);
    const mod = await import('@/app/api/relay/jpyc/route');
    expect(typeof mod.POST).toBe('function');
  });

  it('testnet forwarder (Amoy) + a1 → relay_misconfigured にはならない (free モードに倒れる)', async () => {
    vi.resetModules();
    vi.stubEnv(EIP3009_ON, '1');
    vi.stubEnv('NEXT_PUBLIC_ENABLE_USAGE_FEE', '1');
    vi.stubEnv('NEXT_PUBLIC_JPYC_FORWARDER_AMOY', DUMMY_FORWARDER);
    vi.stubEnv('RELAYER_PRIVATE_KEY', DUMMY_RELAYER_KEY);
    const mod = await import('@/app/api/relay/jpyc/route');
    const res = await mod.POST(req({ chainId: 80002 }));
    // testnet は free モードの通常フローへ進む (このリクエストは body 不足の 400 で落ちる)。
    const body = (await res.json()) as { error?: string };
    expect(body.error).not.toBe('relay_misconfigured');
    expect(body.error).toBe('invalid_payload');
  });

  it('a1 のみ (forwarder 無し) + self-host → mainnet でも relay_misconfigured にならない', async () => {
    vi.resetModules();
    vi.stubEnv(EIP3009_ON, '1');
    vi.stubEnv('NEXT_PUBLIC_ENABLE_USAGE_FEE', '1');
    vi.stubEnv('RELAYER_PRIVATE_KEY', DUMMY_RELAYER_KEY);
    const mod = await import('@/app/api/relay/jpyc/route');
    const res = await mod.POST(req({ chainId: 137 }));
    const body = (await res.json()) as { error?: string };
    // free モードの通常フロー (このテスト env では B5 gas ceiling 未設定の 503 に落ちる)
    expect(body.error).not.toBe('relay_misconfigured');
  });

  it('forwarder のみ (a1 無し) + self-host → relay_misconfigured にならない (recover 構成は許可)', async () => {
    vi.resetModules();
    vi.stubEnv(EIP3009_ON, '1');
    vi.stubEnv('NEXT_PUBLIC_JPYC_FORWARDER_POLYGON', DUMMY_FORWARDER);
    vi.stubEnv('RELAYER_PRIVATE_KEY', DUMMY_RELAYER_KEY);
    const mod = await import('@/app/api/relay/jpyc/route');
    const res = await mod.POST(req({ chainId: 137 }));
    const body = (await res.json()) as { error?: string };
    expect(body.error).not.toBe('relay_misconfigured');
  });
});

// L5: forwarder を設定したのに relayer 鍵が無い (self-host でない) 構成は、recover payload を
// handleFree が 400 invalid_payload で弾いて全 JPYC 決済が汎用エラーで死ぬ。これを明示の 503
// relay_not_configured に倒し、client が standard へ綺麗に fallback できるようにする。a1 が ON の
// ときは resolver が free に倒し client も free payload を組むため 503 を出さず free 経路へ通す。
describe('L5: forwarder 設定 + relayer 鍵欠落 → 明示 503 relay_not_configured', () => {
  const DUMMY_RELAYER_KEY = `0x${'11'.repeat(32)}`;
  const DUMMY_FORWARDER = '0x0000000000000000000000000000000000000001';
  const DUMMY_GELATO_KEY = 'gelato-test-key';
  // recover payload の形 (merchant/merchantValue/feeValue/intentSalt 入り)。鍵欠落だと handleFree が
  // これを 400 invalid_payload で弾いていた (= バグ)。L5 で 503 relay_not_configured に倒す。
  const recoverBody = {
    chainId: 80002, // Amoy (testnet・mainnet hardening を回避)
    from: '0x0000000000000000000000000000000000000def',
    merchant: '0x0000000000000000000000000000000000000abc',
    merchantValue: (1_000n * 10n ** 18n).toString(),
    feeValue: (2n * 10n ** 18n).toString(),
    validAfter: '0',
    validBefore: String(Math.floor(Date.now() / 1000) + 600),
    intentSalt: `0x${'22'.repeat(32)}`,
    signature: `0x${'b'.repeat(130)}`,
  };

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('forwarder 設定 + GELATO 鍵あり (self-host でない) → recover payload は 503 relay_not_configured (400 invalid_payload にしない)', async () => {
    vi.resetModules();
    vi.stubEnv(EIP3009_ON, '1');
    vi.stubEnv('NEXT_PUBLIC_JPYC_FORWARDER_AMOY', DUMMY_FORWARDER);
    vi.stubEnv('GELATO_SPONSOR_API_KEY', DUMMY_GELATO_KEY);
    // RELAYER_PRIVATE_KEY は設定しない → PROVIDER='gelato' (recover 不可)。
    const mod = await import('@/app/api/relay/jpyc/route');
    const res = await mod.POST(req(recoverBody));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { ok: boolean; error?: string };
    expect(body).toEqual({ ok: false, error: 'relay_not_configured' });
  });

  it('forwarder 設定 + 鍵なし (relayer も gelato も無し) → 503 relay_not_configured', async () => {
    vi.resetModules();
    vi.stubEnv(EIP3009_ON, '1');
    vi.stubEnv('NEXT_PUBLIC_JPYC_FORWARDER_AMOY', DUMMY_FORWARDER);
    // RELAYER_PRIVATE_KEY も GELATO も無し → PROVIDER=null。recover 構成だが鍵が無いので 503。
    const mod = await import('@/app/api/relay/jpyc/route');
    const res = await mod.POST(req(recoverBody));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { ok: boolean; error?: string };
    expect(body.error).toBe('relay_not_configured');
  });

  it('a1 ON + forwarder 設定 + GELATO 鍵あり → L5 の 503 は出さない (free 経路へ・invalid_payload で落ちる)', async () => {
    vi.resetModules();
    vi.stubEnv(EIP3009_ON, '1');
    vi.stubEnv('NEXT_PUBLIC_ENABLE_USAGE_FEE', '1');
    vi.stubEnv('NEXT_PUBLIC_JPYC_FORWARDER_AMOY', DUMMY_FORWARDER);
    vi.stubEnv('GELATO_SPONSOR_API_KEY', DUMMY_GELATO_KEY);
    const mod = await import('@/app/api/relay/jpyc/route');
    // recover payload を送るが、a1 ON では free 経路に倒れ free の payload 検証で 400 になる
    // (L5 の 503 relay_not_configured ではない = free 挙動が変わっていない)。
    const res = await mod.POST(req(recoverBody));
    const body = (await res.json()) as { error?: string };
    expect(body.error).not.toBe('relay_not_configured');
    expect(body.error).toBe('invalid_payload');
  });

  it('a1 ON + forwarder 設定 + GELATO 鍵あり → free payload は通常フロー (503 を出さない)', async () => {
    vi.resetModules();
    vi.stubEnv(EIP3009_ON, '1');
    vi.stubEnv('NEXT_PUBLIC_ENABLE_USAGE_FEE', '1');
    vi.stubEnv('NEXT_PUBLIC_JPYC_FORWARDER_AMOY', DUMMY_FORWARDER);
    vi.stubEnv('GELATO_SPONSOR_API_KEY', DUMMY_GELATO_KEY);
    const mod = await import('@/app/api/relay/jpyc/route');
    // free payload (to/value/nonce 入り) は free 経路で処理される (L5 の 503 は出ない)。
    const freeBody = {
      chainId: 80002,
      from: '0x0000000000000000000000000000000000000def',
      to: '0x0000000000000000000000000000000000000abc',
      value: (1_000n * 10n ** 18n).toString(),
      validAfter: '0',
      validBefore: String(Math.floor(Date.now() / 1000) + 600),
      nonce: `0x${'33'.repeat(32)}`,
      signature: `0x${'b'.repeat(130)}`,
    };
    const res = await mod.POST(req(freeBody));
    const body = (await res.json()) as { error?: string };
    expect(body.error).not.toBe('relay_not_configured');
  });
});

// Avalanche は recover-required (free モード禁止)。client の paymasterMode ゲートを迂回する直接 POST
// でも server が止める (Codex P1#1)。実 route + 実 relayProvider/forwarderConfig を env-stub で走らせ、
// flag ON・relayer 鍵あり・forwarder 未設定の条件で各 503 を実際の status/error で検証する。
describe('Avalanche recover-required: 直接 POST の server ガード (P1#1 / P1#3)', () => {
  const DUMMY_RELAYER_KEY = `0x${'11'.repeat(32)}`;
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('Fuji (43113) + flag ON + self-host + forwarder 未設定 → 503 relay_not_configured (free に倒さない)', async () => {
    vi.resetModules();
    vi.stubEnv(EIP3009_ON, '1');
    vi.stubEnv('NEXT_PUBLIC_ENABLE_JPYC_AVALANCHE', '1');
    vi.stubEnv('RELAYER_PRIVATE_KEY', DUMMY_RELAYER_KEY); // PROVIDER=self-host
    // Fuji forwarder は未設定 → recoverMode=false。Fuji は testnet で MAINNET_CHAINS 外 (B5 回避) なので
    // recover-required ガードが発火する経路を分離して検証できる。
    const mod = await import('@/app/api/relay/jpyc/route');
    const res = await mod.POST(req({ chainId: 43113 }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: 'relay_not_configured' });
  });

  it('Avalanche mainnet (43114) + flag ON + self-host + per-chain ceiling 未設定 → 503 gas_ceiling_required (B5/P1#3)', async () => {
    vi.resetModules();
    vi.stubEnv(EIP3009_ON, '1');
    vi.stubEnv('NEXT_PUBLIC_ENABLE_JPYC_AVALANCHE', '1');
    vi.stubEnv('RELAYER_PRIVATE_KEY', DUMMY_RELAYER_KEY);
    // RELAY_MAX_GAS_COST_WEI_AVALANCHE 未設定 → relayMaxGasCostWei(43114)=0n (recover-required は
    // グローバル fallback を使わない)。mainnet self-host の B5 gate が点灯を止める。
    const mod = await import('@/app/api/relay/jpyc/route');
    const res = await mod.POST(req({ chainId: 43114 }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: 'gas_ceiling_required' });
  });

  it('flag OFF (既定): Avalanche mainnet (43114) は SUPPORTED_CHAINS 外 → recover-required ガードに到達しない (inert)', async () => {
    vi.resetModules();
    vi.stubEnv(EIP3009_ON, '1');
    vi.stubEnv('RELAYER_PRIVATE_KEY', DUMMY_RELAYER_KEY);
    // flag OFF では avalanche は SUPPORTED_CHAINS/MAINNET_CHAINS に出ない → recoverMode=false だが
    // recover-required ガードは flag 非依存で 503 relay_not_configured を返す (free に倒れない = 安全)。
    const mod = await import('@/app/api/relay/jpyc/route');
    const res = await mod.POST(req({ chainId: 43114 }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: 'relay_not_configured' });
  });
});

// Ethereum L1 (chainId 1) は **standard 固定** (forwarder を設けない設計・SUPPORTED_CHAINS にも入れない)。
// client の paymasterMode ゲート (unavailable→standard) を迂回する直接署名 POST が来ても、server が
// free relay を拒否して OpenPay relayer が ETH を持ち出さないことを保証する。recover-required 判定
// (isRecoverRequiredChain(mainnet.id)) は flag 非依存なので enableJpycEthereum の有無を問わず弾く。
describe('Ethereum L1 standard 固定: 直接 POST の server ガード (free relay 拒否)', () => {
  const DUMMY_RELAYER_KEY = `0x${'11'.repeat(32)}`;
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('Ethereum mainnet (1) + flag ON + self-host → 503 relay_not_configured (free relay に倒さない)', async () => {
    vi.resetModules();
    vi.stubEnv(EIP3009_ON, '1');
    vi.stubEnv('NEXT_PUBLIC_ENABLE_JPYC_ETHEREUM', '1');
    vi.stubEnv('RELAYER_PRIVATE_KEY', DUMMY_RELAYER_KEY); // PROVIDER=self-host (ETH 持ち出しの危険ケース)
    // Ethereum は SUPPORTED_CHAINS 外 (relay 非対応) + forwarder 永久未設定 → recoverMode=false。
    // mainnet.id は MAINNET_CHAINS 外 (relay 用) なので B5 ゲートには届かず、recover-required ガードが弾く。
    const mod = await import('@/app/api/relay/jpyc/route');
    const res = await mod.POST(req({ chainId: 1 }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: 'relay_not_configured' });
  });

  it('flag OFF (既定): Ethereum mainnet (1) + self-host → 503 relay_not_configured (flag 非依存・inert)', async () => {
    vi.resetModules();
    vi.stubEnv(EIP3009_ON, '1');
    vi.stubEnv('RELAYER_PRIVATE_KEY', DUMMY_RELAYER_KEY);
    // enableJpycEthereum 無しでも isRecoverRequiredChain(1)=true で free relay を拒否する。
    const mod = await import('@/app/api/relay/jpyc/route');
    const res = await mod.POST(req({ chainId: 1 }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: 'relay_not_configured' });
  });
});
