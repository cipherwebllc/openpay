// public/llms.txt の開示ドリフト・フェンス (掟 14③)。
// 開示 3 点セットのうち LP (①) と法務文書 (②) は tests/app/legal.test.tsx 等が守るが、
// llms.txt は静的ファイルで今までフェンスが無く「変更時に目視 grep」の手動運用だった
// (放置すると AI 検索・AI エージェントが古い料率を引用し続ける)。
// 本テストは lib/legal.ts の DISCLOSED_* と各有料リソースの価格 SoT から期待文字列を
// **導出**して llms.txt に含まれることを検証する — 数値の直書きはしない (直書きすると
// フェンス自体がドリフト源になる)。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DISCLOSED_DUAL_RAIL_USDC,
  DISCLOSED_MOBILE_ORDER_FEE,
  DISCLOSED_RECOVER_FEE,
  DISCLOSED_STORE_USDC_PAYMENT,
  DISCLOSED_X402_FEE,
} from '@/lib/legal';
import {
  JPYC_PAYMENTS_RESOURCE,
  JPYC_SERVICES_RESOURCE,
} from '@/lib/directory/paidResources';
import {
  USDC_DIRECTORY_LIST,
  USDC_DIRECTORY_SEARCH,
  USDC_PAYMENT_MONITOR,
  USDC_SERVICE_MONITOR,
} from '@/lib/directory/usdcResource';
import {
  USDC_JPYC_BALANCE,
  USDC_JPYC_SUPPLY,
  USDC_JPYC_TRANSFERS,
} from '@/lib/jpyc/liveResources';
import { USDC_STORES } from '@/lib/x402/usdcStores';

const llms = readFileSync(join(process.cwd(), 'public', 'llms.txt'), 'utf8');
const lines = llms.split('\n');

/** path を `GET <path>` で言及している行 (無ければ fail — 商品が llms.txt から消えている)。 */
function lineMentioning(path: string): string {
  const hit = lines.find((l) => l.includes(`\`GET ${path}`));
  expect(hit, `llms.txt に \`GET ${path}\` の行が無い`).toBeDefined();
  return hit!;
}

/** regex の全一致について、捕捉した数値が期待どおりであることを検証 (少なくとも 1 件)。 */
function expectEveryMatch(re: RegExp, expected: string[], label: string): void {
  const matches = [...llms.matchAll(re)];
  expect(matches.length, `${label}: llms.txt に一致箇所が無い (文言の型が変わった?)`).toBeGreaterThan(0);
  for (const m of matches) {
    expect(m.slice(1), `${label}: ${m[0]}`).toEqual(expected);
  }
}

const pct = (bps: number): string => String(bps / 100);

const SELLER = '0x00000000000000000000000000000000000000A1';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('public/llms.txt 開示同期 (掟 14③)', () => {
  it('決済 QR (recover) 利用料 = DISCLOSED_RECOVER_FEE', () => {
    expectEveryMatch(
      /決済額の (\d+)%・最低 (\d+) JPYC/g,
      [pct(DISCLOSED_RECOVER_FEE.percentFromJulyBps), String(DISCLOSED_RECOVER_FEE.floorJpyc)],
      'recover',
    );
  });

  it('モバイル注文 利用料 = DISCLOSED_MOBILE_ORDER_FEE (本文 + 冒頭要約)', () => {
    expectEveryMatch(
      /店内 (\d+)%・時間指定の事前注文 (\d+)%/g,
      [pct(DISCLOSED_MOBILE_ORDER_FEE.storefrontBps), pct(DISCLOSED_MOBILE_ORDER_FEE.preorderBps)],
      'mobile order',
    );
    // 冒頭要約「手数料0〜N%（時間指定の事前モバイルオーダーのみM%）」
    const maxCommonBps = Math.max(
      DISCLOSED_RECOVER_FEE.percentFromJulyBps,
      DISCLOSED_MOBILE_ORDER_FEE.storefrontBps,
      DISCLOSED_X402_FEE.bps,
    );
    expectEveryMatch(
      /手数料0〜(\d+)%（時間指定の事前モバイルオーダーのみ(\d+)%）/g,
      [pct(maxCommonBps), pct(DISCLOSED_MOBILE_ORDER_FEE.preorderBps)],
      'summary',
    );
  });

  it('x402 利用料 (JPYC 購入の買い手負担) = DISCLOSED_X402_FEE — 言及箇所すべて', () => {
    expectEveryMatch(
      /x402 利用料[（ ](?:価格の )?(\d+)%・最低 (\d+) JPYC/g,
      [pct(DISCLOSED_X402_FEE.bps), String(DISCLOSED_X402_FEE.floorJpyc)],
      'x402 fee',
    );
  });

  it('ストア USDC 決済 / dual-rail USDC = チェーン名と 0% が開示定数と一致', () => {
    expectEveryMatch(
      /USDC 購入（(\w+)）では OpenPay の x402 利用料は (\d+)%/g,
      [DISCLOSED_STORE_USDC_PAYMENT.chainName, pct(DISCLOSED_STORE_USDC_PAYMENT.openPayFeeBps)],
      'store usdc',
    );
    expectEveryMatch(
      /OpenPay の USDC 側手数料 (\d+)%/g,
      [pct(DISCLOSED_DUAL_RAIL_USDC.openPayFeeBps)],
      'dual-rail',
    );
    expect(llms).toContain(`USDC（${DISCLOSED_DUAL_RAIL_USDC.chainName}・標準 x402）`);
  });

  // E17: FIRST_PARTY_RESOURCES はカタログ flag で伸び縮みするので、全 flag を ON にして
  // 最大のカタログ (openapi-discovery.test.ts の load() と同じ手順) で網羅性を検証する。
  // 個別 named import の手書きリストだと新規追加時の載せ忘れ (/api/paid/demo・/stores 等) を
  // 検出できない — カタログそのものを SoT にする。
  it('有料 API の価格 = 各リソース SoT (JPYC 建て・FIRST_PARTY_RESOURCES 全件を網羅)', async () => {
    vi.stubEnv('NEXT_PUBLIC_ENABLE_WEB3_DIRECTORY', '1');
    vi.stubEnv('NEXT_PUBLIC_ENABLE_X402_FACILITATOR', '1');
    vi.stubEnv('NEXT_PUBLIC_ENABLE_SHOPS_API', '1');
    vi.stubEnv('NEXT_PUBLIC_ENABLE_ORDER_RELAY', '1');
    vi.stubEnv('ENABLE_AGENT_ORDER', '1');
    vi.stubEnv('X402_PAY_TO_ADDRESS', SELLER);
    vi.resetModules();
    const { FIRST_PARTY_RESOURCES } = await import('@/lib/x402/firstParty');
    // flag の stub 漏れでカタログが縮んだまま「全件 OK」になるのを防ぐ (openapi-discovery.test.ts と同じ数)。
    expect(FIRST_PARTY_RESOURCES.length).toBe(7);
    for (const r of FIRST_PARTY_RESOURCES) {
      expect(lineMentioning(r.path), r.path).toContain(`${r.priceJpyc} JPYC`);
    }
  });

  it('有料 API の価格 = 各リソース SoT (USDC 建て)', () => {
    for (const r of [
      USDC_DIRECTORY_LIST,
      USDC_DIRECTORY_SEARCH,
      USDC_SERVICE_MONITOR,
      USDC_PAYMENT_MONITOR,
      USDC_JPYC_SUPPLY,
      USDC_JPYC_BALANCE,
      USDC_JPYC_TRANSFERS,
      USDC_STORES,
    ]) {
      expect(lineMentioning(r.path), r.path).toContain(`${r.priceUsd} USDC`);
    }
  });

  it('Monitor の無料 teaser と nextChangedSince エコーが両商品の行に載っている', () => {
    for (const [paid, teaser] of [
      [JPYC_SERVICES_RESOURCE.path, '/api/jpyc/services/teaser'],
      [JPYC_PAYMENTS_RESOURCE.path, '/api/stablecoin-payments/teaser'],
    ] as const) {
      const line = lineMentioning(paid);
      expect(line).toContain(`\`GET ${teaser}\``);
      expect(line).toContain('nextChangedSince');
    }
  });
});
