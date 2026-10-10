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
// 第 7 回レビュー E3 で Error の enum と 503 の説明に signer_unavailable を足したので全構成を再採取。
// 第 7 回レビュー B8 で license descriptor の productUrl を string | null・説明を 200 にしたので license を含む構成を再採取。
// 第 7 回レビュー E16 (user 裁定 R7) で directory の status クエリの enum を published だけにしたので、directory を
// 含む構成を再採取 (整形した JSON の差分は 3 つの operation の status enum から draft/review/rejected/archived が消えただけ)。
// 同レビュー E17 の follow-up で Payment Monitor の行に不変の slug を足し dedupe キーを改めたので、Monitor を含む構成を
// 再採取 (差分は 200 応答の schema/example への slug の追加と、x-agent-usage の dedupe キーの説明だけ)。
// 続けて x-agent-usage に slug が付く前に保存したイベントの照合手順を足したので再採取 (差分は Payment Monitor の x-agent-usage 2 本だけ)。
// さらに provider をイベントごとに固定したので、USDC 版の x-agent-usage の「改名で変わる」を直して再採取 (差分はその 1 文だけ)。
const EXPECTED_SHA256: Record<string, string> = {
  'all-on':
    'ec131172dd862e8377c83820ce550f5d65c273a60fd4af5e6d5344daedfc3252',
  'all-on+arc':
    'ad046ac30f673c0eb358d9d840933d8bb5255327a78981a706534550688cc874',
  'all-on+mainnet':
    '6d847a8c4fc7107b16cdaf78128d44d45c1e5edf3c7fd600332302a8447fd9fb',
  'all-on+mainnet+avalanche+ethereum':
    'fd9a2072328e3688caae436784538b1dec38773a8e2c92b834d3660cf4699488',
  'all-on+fee':
    '63adf900f467ca6e3ae3bf44d34c65217b623a9d01d463a9ded2cb07ecab9e36',
  'all-on+default-hello-price':
    '5bc16abf5a084afefc08da2f1c82ca845f337700dc625b113b7f29ce1a4b99d3',
  'all-on+invalid-hello-price-unlisted':
    'a3af0b09df497c33305ce0060a966f9a8c1d9cf3feb901776dbac77930f5411f',
  'directory-only':
    '8aa55afdc1f16731f5e289002aca149f4de5b63f23fd242617b86b9c3b526a81',
  'facilitator-only':
    '21ac634fe16c274ca3f1d66ef903d77839c67a4c92963b11b168d71418a191e0',
  'facilitator+shops':
    '935bca12f86224bafc76c3761bd32e5faaeda7398fde7ba557ab68b5618ee3b7',
  'directory+facilitator':
    '2550f1dc7bb550d7c6cb7211e3d434417b6def6ea18278d97b880758e1b5a31f',
  'license-only':
    'bdf3b0b4b901d5174663e0a74ebd070fb202326f20cee6bf9c193779fa2ac250',
  'directory+license-child-only':
    '8aa55afdc1f16731f5e289002aca149f4de5b63f23fd242617b86b9c3b526a81',
  'late-mutation':
    '2e63ea53cf8c0c69e29f523b0c99f2d75f39456995e9d9a22c282f3918bb7dee',
  'late-facilitator':
    'ca57dc1b29e7c026523fac40da5ecd9b89a32a131e64b0f8adbe41e52fe659ec',
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
