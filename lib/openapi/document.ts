// OpenPay の OpenAPI 3.1 スペック (単一情報源)。/openapi.json と /api/openapi.json の
// 両ルートがこれを配信する。root 配信が必要なのは x402 のインデクサ (x402scan /
// @agentcash/discovery) が **origin 直下の /openapi.json しか読まない**ため
// (`.well-known/x402` は legacy 扱いで既にパースされない)。
//
// 有料 operation には `x-payment-info` を付ける。インデクサはこの有無で authMode='paid' を
// 判定し、無いと「有料エンドポイント」として登録されない。金額は 402 チャレンジと同じ
// x402FeeBreakdown から導出する (literal を書くと掟 14 のドリフト源になるため)。

// 領域ごとの operation / schema は同じディレクトリの module に置き (license / discovery / vanilla /
// activity / monitor / stores / shops / directory / components、共有 helper は payment / schema)、
// このファイルは基底文書と flag による組み立て (buildOpenApiDocument) だけを持つ。組み立ての
// spread 順が paths / tags / schemas の key 順 = 公開契約のバイト列を決めるので順序を変えない。

import { env } from '@/lib/env';
import { licenseNftEnabled } from '@/lib/license/config';
import { LICENSE_DESCRIPTOR_SCHEMA, LICENSE_VERIFY_SCHEMA } from '@/lib/license/schema';
import { shopsApiEnabled } from '@/lib/shops/flags';
import { ACTIVITY_OPENAPI_PATHS } from '@/lib/openapi/activity';
import { BASE_OPENAPI_RESPONSES, BASE_OPENAPI_SCHEMAS } from '@/lib/openapi/components';
import { DIRECTORY_OPENAPI_PATHS } from '@/lib/openapi/directory';
import { DISCOVERY_OPENAPI_PATHS, DISCOVERY_OPENAPI_SCHEMAS } from '@/lib/openapi/discovery';
import { LICENSE_OPENAPI_PATHS } from '@/lib/openapi/license';
import {
  JPYC_DIRECTORY_MONITOR_OPENAPI_PATHS,
  VANILLA_DIRECTORY_OPENAPI_PATHS,
} from '@/lib/openapi/monitor';
import { SHOPS_OPENAPI_PATHS, SHOPS_OPENAPI_SCHEMAS } from '@/lib/openapi/shops';
import { VANILLA_STORES_OPENAPI_PATHS } from '@/lib/openapi/stores';
import { VANILLA_OPENAPI_PATHS, vanillaHelloPath } from '@/lib/openapi/vanilla';

const OPENAPI_DOCUMENT = {
  openapi: '3.1.0',
  info: {
    title: 'OpenPay Japan Web3 Directory API',
    version: '1.0.0',
    description:
      'Published-only directory metadata with first-party attribution and source freshness. Paid routes use x402 with JPYC.',
  },
  servers: [{ url: 'https://open-pay.jp' }],
  tags: [
    { name: 'Directory Free' },
    { name: 'Directory Paid' },
  ],
  paths: DIRECTORY_OPENAPI_PATHS,
  components: {
    schemas: BASE_OPENAPI_SCHEMAS,
    responses: BASE_OPENAPI_RESPONSES,
  },
} as const;

/**
 * 現在の flag 構成に対応する OpenAPI 文書。全機能 OFF なら null (= route は 404)。
 * ルート (/openapi.json) と /api/openapi.json が同一文書を配信する単一情報源。
 */
export function buildOpenApiDocument(): Record<string, unknown> | null {
  const licensesEnabled = licenseNftEnabled();
  const shopsEnabled = shopsApiEnabled();
  const facilitatorEnabled = env.enableX402Facilitator;
  if (!env.enableWeb3Directory && !shopsEnabled && !facilitatorEnabled && !licensesEnabled) {
    return null;
  }
  const document = {
    ...OPENAPI_DOCUMENT,
    info: {
      ...OPENAPI_DOCUMENT.info,
      title: 'OpenPay Discovery, Directory and Shops APIs',
      description:
        'Payable x402 resources, structured Japan Web3 directory data, and opt-in JPYC shop discovery.',
    },
    tags: [
      ...(env.enableWeb3Directory ? OPENAPI_DOCUMENT.tags : []),
      ...(shopsEnabled
        ? [{ name: 'Shops Free' }, { name: 'Shops Paid' }]
        : []),
      ...(facilitatorEnabled ? [{ name: 'x402 Catalog' }] : []),
      ...(licensesEnabled ? [{ name: 'Licenses' }] : []),
      { name: 'x402 Vanilla (USDC)' },
    ],
    paths: {
      ...(env.enableWeb3Directory ? OPENAPI_DOCUMENT.paths : {}),
      ...(shopsEnabled ? SHOPS_OPENAPI_PATHS : {}),
      ...(facilitatorEnabled ? DISCOVERY_OPENAPI_PATHS : {}),
      ...(licensesEnabled ? LICENSE_OPENAPI_PATHS : {}),
      ...VANILLA_OPENAPI_PATHS,
      ...ACTIVITY_OPENAPI_PATHS,
      ...(env.enableWeb3Directory ? VANILLA_DIRECTORY_OPENAPI_PATHS : {}),
      // JPYC レールは guardPaidDirectoryApi と同じ条件 (両 flag) でのみ掲載する (E6)。
      ...(env.enableWeb3Directory && facilitatorEnabled
        ? JPYC_DIRECTORY_MONITOR_OPENAPI_PATHS
        : {}),
      ...VANILLA_STORES_OPENAPI_PATHS,
      ...vanillaHelloPath(),
    },
    components: {
      ...OPENAPI_DOCUMENT.components,
      schemas: {
        ...OPENAPI_DOCUMENT.components.schemas,
        ...SHOPS_OPENAPI_SCHEMAS,
        ...(facilitatorEnabled ? DISCOVERY_OPENAPI_SCHEMAS : {}),
        ...(licensesEnabled ? { LicenseDescriptor: LICENSE_DESCRIPTOR_SCHEMA, LicenseVerification: LICENSE_VERIFY_SCHEMA } : {}),
      },
      responses: {
        ...OPENAPI_DOCUMENT.components.responses,
        StorageUnavailable: {
          description:
            'The request could not be completed because required data or storage is temporarily unavailable.',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/Error' },
              example: { ok: false, error: 'storage_unavailable' },
            },
          },
        },
      },
    },
  } as const;
  return document;
}
