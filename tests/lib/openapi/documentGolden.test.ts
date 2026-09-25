// /openapi.json (と /api/openapi.json) の **バイト単位** の golden。
//
// OpenAPI 文書は x402 インデクサ・支払いエージェントが機械的に読む公開契約なので、
// lib/openapi/ の分割 (R9c) のような構造変更で key の挿入順・spread 順・flag の評価時点
// (import 時 / 文書生成時) が 1 つでもずれると、意味が同じでも契約面が変わる。既存の
// openapi-discovery.test.ts は構造と挙動を見るだけなので、ここで未整列の raw JSON
// (JSON.stringify そのまま) の sha256 を flag 構成ごとに固定する。
//
// 初期の期待値は分割前 (origin/main b13da8c2) のコードで採取した。B-R9d とレビュー指摘の
// 文言・example・Error schema の修正だけを raw JSON 比較で確認し、意図して再採取した。
// 文書の文言・構造を**意図して**
// 変えた PR では、差分を目視確認したうえでこの表を更新する (採取は
// `OPENAPI_GOLDEN_CAPTURE=1 CI=true npx vitest run tests/lib/openapi/documentGolden.test.ts` で
// hash と key 順を stdout に出す)。

import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

const SELLER = '0x00000000000000000000000000000000000000A1';

// 文書に影響する env をすべて明示する (シェル由来の env が profile に漏れないように)。
const BASE_ENV: Record<string, string> = {
  NEXT_PUBLIC_NETWORK_ENV: 'testnet',
  NEXT_PUBLIC_ENABLE_X402_FACILITATOR: '',
  NEXT_PUBLIC_ENABLE_WEB3_DIRECTORY: '',
  NEXT_PUBLIC_ENABLE_SHOPS_API: '',
  NEXT_PUBLIC_ENABLE_ORDER_RELAY: '',
  ENABLE_AGENT_ORDER: '',
  ENABLE_CREATOR_STORE: '',
  ENABLE_LICENSE_NFT: '',
  NEXT_PUBLIC_ENABLE_JPYC_AVALANCHE: '',
  NEXT_PUBLIC_ENABLE_JPYC_ETHEREUM: '',
  ENABLE_X402_ARC_GATEWAY: '',
  X402_NETWORK: '',
  X402_PAY_TO_ADDRESS: SELLER,
  X402_PRICE: '$0.01',
  X402_FEE_BPS: '',
  X402_FEE_FLOOR_JPYC: '',
};

const ALL_ON: Record<string, string> = {
  NEXT_PUBLIC_ENABLE_X402_FACILITATOR: '1',
  NEXT_PUBLIC_ENABLE_WEB3_DIRECTORY: '1',
  NEXT_PUBLIC_ENABLE_SHOPS_API: '1',
  NEXT_PUBLIC_ENABLE_ORDER_RELAY: '1',
  ENABLE_AGENT_ORDER: '1',
  ENABLE_CREATOR_STORE: '1',
  ENABLE_LICENSE_NFT: '1',
};

const SHOPS_ON: Record<string, string> = {
  NEXT_PUBLIC_ENABLE_SHOPS_API: '1',
  NEXT_PUBLIC_ENABLE_ORDER_RELAY: '1',
  ENABLE_AGENT_ORDER: '1',
};

type Profile = { name: string; env: Record<string, string> };

const PROFILES: Profile[] = [
  { name: 'all-on', env: ALL_ON },
  { name: 'all-on+arc', env: { ...ALL_ON, ENABLE_X402_ARC_GATEWAY: '1' } },
  { name: 'all-on+mainnet', env: { ...ALL_ON, NEXT_PUBLIC_NETWORK_ENV: 'mainnet' } },
  {
    name: 'all-on+mainnet+avalanche+ethereum',
    env: {
      ...ALL_ON,
      NEXT_PUBLIC_NETWORK_ENV: 'mainnet',
      NEXT_PUBLIC_ENABLE_JPYC_AVALANCHE: '1',
      NEXT_PUBLIC_ENABLE_JPYC_ETHEREUM: '1',
    },
  },
  { name: 'all-on+fee', env: { ...ALL_ON, X402_FEE_BPS: '250', X402_FEE_FLOOR_JPYC: '3' } },
  // X402_PRICE 未設定は既定 $0.001 で hello を掲載、変換不能な価格は hello を載せない。
  { name: 'all-on+default-hello-price', env: { ...ALL_ON, X402_PRICE: '' } },
  { name: 'all-on+invalid-hello-price-unlisted', env: { ...ALL_ON, X402_PRICE: 'abc' } },
  { name: 'directory-only', env: { NEXT_PUBLIC_ENABLE_WEB3_DIRECTORY: '1' } },
  { name: 'facilitator-only', env: { NEXT_PUBLIC_ENABLE_X402_FACILITATOR: '1' } },
  { name: 'facilitator+shops', env: { NEXT_PUBLIC_ENABLE_X402_FACILITATOR: '1', ...SHOPS_ON } },
  {
    name: 'directory+facilitator',
    env: { NEXT_PUBLIC_ENABLE_WEB3_DIRECTORY: '1', NEXT_PUBLIC_ENABLE_X402_FACILITATOR: '1' },
  },
  { name: 'license-only', env: { ENABLE_CREATOR_STORE: '1', ENABLE_LICENSE_NFT: '1' } },
  // 親 flag なしの子 flag は license を載せない (licenseNftEnabled の AND)。
  { name: 'directory+license-child-only', env: { NEXT_PUBLIC_ENABLE_WEB3_DIRECTORY: '1', ENABLE_LICENSE_NFT: '1' } },
];

// B-R9d の文書修正後に再採取した sha256 (JSON.stringify の生出力・key 未整列)。
const EXPECTED_SHA256: Record<string, string> = {
  'all-on':
    'ee21eaad787fe97b26f640b52d6512139c7c5aee9bf31e8f3f3569326e385f35',
  'all-on+arc':
    '38f750d78734147ebd3a8b2deb72642476811e6e08008f02703b681adc856dfd',
  'all-on+mainnet':
    'ffeae779d1cafb927f4ed5d0fa78e3c9c9c64cd0241b65449d1032fdf4c02f9b',
  'all-on+mainnet+avalanche+ethereum':
    '60fdccc805c3978b860332cffad8a4f0bfcaebeaf48da8a23562610d5ff94d53',
  'all-on+fee':
    'aefdff41f7fffa319d4025d48f51dfcbf4bf6103f56bdf397d0dc98a7d16a8a3',
  'all-on+default-hello-price':
    'a65c97abf7762f845bcc36b2ba7848468a5809779991d3e8aa243e4fec7946e3',
  'all-on+invalid-hello-price-unlisted':
    '4ea047ed23abfb8eea041dc00cbeea5aef8fafcd97d5dc3921666589ef7db1a1',
  'directory-only':
    '065ba3c26f996b54fbd1530812d78eb3cb4486c29bea3778585799a73c0bfcd9',
  'facilitator-only':
    '9b67a5dda6b5ebc7ca9421c329bd911d4f8fcee9c8c83a9603fd1832fc01c265',
  'facilitator+shops':
    '5baa7e721449b0f3b3cdcc1be9b01117cd8aa7a55eb9e014cf13828ab286e887',
  'directory+facilitator':
    'f00d900be605d099483eeeb63bac49d9e79732c9a301de71f733718daab8044e',
  'license-only':
    'c41e879807807f32d55b07731bc6a90f226abca9aff1f9f2f49f89250c9537c1',
  'directory+license-child-only':
    '065ba3c26f996b54fbd1530812d78eb3cb4486c29bea3778585799a73c0bfcd9',
  'late-mutation':
    'a99572780ecd725cd1c2cb198c84e70703bb7c456e9d994f6fd684327cc809b4',
  'late-facilitator':
    '65facd6b265dfa1ecef0fb542d1a7d06062c8eef5ef9cd397ac6a27e7d5a2c7a',
};

// all-on の paths の key 順 (spread 順の固定)。
const EXPECTED_ALL_ON_PATHS: string[] = [
  '/api/directory',
  '/api/directory/categories',
  '/api/directory/tags',
  '/api/paid/japan-web3-directory',
  '/api/paid/japan-web3-directory/search',
  '/api/paid/usdc/japan-web3-directory',
  '/api/paid/usdc/japan-web3-directory/licensed',
  '/api/paid/usdc/japan-web3-directory/search',
  '/api/paid/japan-web3-directory/{slug}',
  '/api/shops',
  '/api/shops/find',
  '/api/paid/jpyc-shops/search',
  '/api/discovery/{id}',
  '/api/discovery',
  '/api/paid/demo',
  '/api/paid/stores',
  '/api/license/metadata/{id}',
  '/api/license/products/{id}',
  '/api/license/verify',
  '/api/paid/usdc/jpyc/supply',
  '/api/paid/usdc/jpyc/balance',
  '/api/paid/usdc/jpyc/transfers',
  '/api/paid/usdc/jpyc/activity',
  '/api/paid/usdc/jpyc/attest',
  '/api/jpyc/activity/preview',
  '/api/paid/usdc/jpyc/services',
  '/api/jpyc/services/teaser',
  '/api/stablecoin-payments/teaser',
  '/api/paid/usdc/stablecoin-payments',
  '/api/paid/jpyc/services',
  '/api/paid/stablecoin-payments',
  '/api/paid/usdc/stores',
  '/api/paid/hello',
];

const EXPECTED_ALL_ON_SCHEMAS: string[] = [
  'DirectoryEntry',
  'DirectoryLicensedEnvelope',
  'DirectoryEnvelope',
  'Error',
  'ShopTeaser',
  'ShopFindItem',
  'ShopSearchItem',
  'ShopsTeaserEnvelope',
  'ShopsFindEnvelope',
  'ShopsSearchEnvelope',
  'ShopsEnvelopeBase',
  'DiscoveryItem',
  'DiscoveryEnvelope',
  'LicenseDescriptor',
  'LicenseVerification',
];

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function applyEnv(env: Record<string, string>): void {
  for (const [key, value] of Object.entries({ ...BASE_ENV, ...env })) vi.stubEnv(key, value);
}

type Served = { rootStatus: number; apiStatus: number; rootText: string; apiText: string; built: string };

async function serve(profile: Profile): Promise<Served> {
  applyEnv(profile.env);
  vi.resetModules();
  const root = (await import('@/app/openapi.json/route')) as { GET: () => Promise<Response> };
  const api = (await import('@/app/api/openapi.json/route')) as { GET: () => Promise<Response> };
  const { buildOpenApiDocument } = await import('@/lib/openapi/document');
  const rootRes = await root.GET();
  const apiRes = await api.GET();
  return {
    rootStatus: rootRes.status,
    apiStatus: apiRes.status,
    rootText: await rootRes.text(),
    apiText: await apiRes.text(),
    built: JSON.stringify(buildOpenApiDocument()),
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

const CAPTURE = process.env.OPENAPI_GOLDEN_CAPTURE === '1';
const captured: Record<string, unknown> = {};

describe('OpenAPI 文書のバイト golden (R9c)', () => {
  it.each(PROFILES.map((p) => [p.name, p] as const))('%s: 両 endpoint が同一バイトで sha256 が固定値', async (name, profile) => {
    const served = await serve(profile);
    expect(served.rootStatus).toBe(200);
    expect(served.apiStatus).toBe(200);
    expect(served.apiText).toBe(served.rootText);
    // route は builder の結果をそのまま JSON.stringify で返す (加工しない)。
    expect(served.rootText).toBe(served.built);
    const hash = sha256(served.rootText);
    if (CAPTURE) {
      captured[name] = hash;
      if (name === 'all-on') {
        const doc = JSON.parse(served.rootText) as { paths: object; components: { schemas: object } };
        captured.paths = Object.keys(doc.paths);
        captured.schemas = Object.keys(doc.components.schemas);
      }
      return;
    }
    expect(hash).toBe(EXPECTED_SHA256[name]);
  });

  it('all-on の paths / components.schemas の key 順が固定値', async () => {
    const served = await serve(PROFILES[0]);
    const doc = JSON.parse(served.rootText) as { paths: object; components: { schemas: object } };
    if (CAPTURE) return;
    expect(Object.keys(doc.paths)).toEqual(EXPECTED_ALL_ON_PATHS);
    expect(Object.keys(doc.components.schemas)).toEqual(EXPECTED_ALL_ON_SCHEMAS);
  });

  it('全機能 OFF は両 endpoint とも 404 で builder は null', async () => {
    const served = await serve({ name: 'all-off', env: {} });
    expect(served.rootStatus).toBe(404);
    expect(served.apiStatus).toBe(404);
    expect(served.built).toBe('null');
    expect(served.rootText).toBe(served.apiText);
    if (CAPTURE) captured['all-off-body'] = served.rootText;
    else expect(served.rootText).toBe('{"ok":false,"error":"not_found"}');
  });

  // 評価時点の固定: module 読み込み後に設定 object を書き換え、文書生成時に読むもの
  // (env の機能 flag・hello の価格と Arc 判定) だけが反映され、読み込み時に確定するもの
  // (JPYC 価格の手数料・hello 以外の USDC 支払い情報) は反映されないことを hash で固定する。
  it('late-mutation: import 時 / 生成時の評価の区別が変わらない', async () => {
    applyEnv(ALL_ON);
    vi.resetModules();
    const { buildOpenApiDocument } = await import('@/lib/openapi/document');
    const { env } = await import('@/lib/env');
    const { x402Config } = await import('@/lib/x402/config');
    const { x402FacilitatorConfig } = await import('@/lib/x402/facilitatorConfig');
    const mutableEnv = env as unknown as Record<string, unknown>;
    mutableEnv.enableWeb3Directory = false;
    mutableEnv.enableLicenseNft = false;
    const mutableX402 = x402Config as unknown as Record<string, unknown>;
    mutableX402.arcGateway = { enabled: true };
    mutableX402.defaultPrice = '$0.05';
    (x402FacilitatorConfig as unknown as Record<string, unknown>).feeBps = 9999;
    const text = JSON.stringify(buildOpenApiDocument());
    const hash = sha256(text);
    if (CAPTURE) {
      captured['late-mutation'] = hash;
      console.log(`OPENAPI_GOLDEN_CAPTURE ${JSON.stringify(captured, null, 2)}`);
      return;
    }
    expect(hash).toBe(EXPECTED_SHA256['late-mutation']);
  });

  // facilitator の flag は shops/facilitator の path 群の有無を決める。import 時に読む実装に変わると
  // ここが落ちる (レビュー S1: 上の case は enableX402Facilitator を触らず検出できなかった)。
  it('late-facilitator: enableX402Facilitator を import 後に切っても生成時に評価される', async () => {
    applyEnv(ALL_ON);
    vi.resetModules();
    const { buildOpenApiDocument } = await import('@/lib/openapi/document');
    const { env } = await import('@/lib/env');
    (env as unknown as Record<string, unknown>).enableX402Facilitator = false;
    const hash = sha256(JSON.stringify(buildOpenApiDocument()));
    if (CAPTURE) {
      captured['late-facilitator'] = hash;
      console.log(`OPENAPI_GOLDEN_CAPTURE ${JSON.stringify(captured, null, 2)}`);
      return;
    }
    expect(hash).toBe(EXPECTED_SHA256['late-facilitator']);
  });
});
