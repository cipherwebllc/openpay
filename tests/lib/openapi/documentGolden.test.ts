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
const EXPECTED_SHA256: Record<string, string> = {
  'all-on':
    'a20191f764a507fc4197d82558a193f07323f76030d8564dce3b858fb0f3bc6b',
  'all-on+arc':
    '30211da5bfca610f4a7de1c9029f3bec21c506bf817381f5365f28e9c745f821',
  'all-on+mainnet':
    '86df962d6eef6f62e30b34a5e5a86b054b65939bc4eb37aad3b1d9d8e60ed95e',
  'all-on+mainnet+avalanche+ethereum':
    'c4bd74fdf2822262e722d06afba39557eecd72ccdf684d3a63eb46132c8f6da5',
  'all-on+fee':
    'a03c5c5a6423e65930b22364fa3787d28cb28e9831f4ddaaf4648643fb110451',
  'all-on+default-hello-price':
    'f3a113f473f9b8c45573fea22bc95f3630f682ed1eb1358f1ef04dab162db23e',
  'all-on+invalid-hello-price-unlisted':
    'a185f85de262d85a3b7618d57da001d69dd55e82d0e21a6e2405227416797e67',
  'directory-only':
    '2852604fa7d64f41cb78afc0229e1053f443dee209952caa77da582a80df266e',
  'facilitator-only':
    '21ac634fe16c274ca3f1d66ef903d77839c67a4c92963b11b168d71418a191e0',
  'facilitator+shops':
    '935bca12f86224bafc76c3761bd32e5faaeda7398fde7ba557ab68b5618ee3b7',
  'directory+facilitator':
    '485ad8e5046c107149f2d5d5150a46f5704914ff888bb12b6909e3cd48d2ad88',
  'license-only':
    'bdf3b0b4b901d5174663e0a74ebd070fb202326f20cee6bf9c193779fa2ac250',
  'directory+license-child-only':
    '2852604fa7d64f41cb78afc0229e1053f443dee209952caa77da582a80df266e',
  'late-mutation':
    '2e63ea53cf8c0c69e29f523b0c99f2d75f39456995e9d9a22c282f3918bb7dee',
  'late-facilitator':
    '7259c2119e234d63e02585bdd51a32a8938c372c23587ce22a5b5ca7d6351893',
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
