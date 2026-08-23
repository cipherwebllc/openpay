// buildPaywallSnippet: 外部サーバーがコピペで動く自己完結ゲートであることの構造検証。

import { describe, expect, it } from 'vitest';
import { buildPaywallSnippet } from '@/lib/x402/paywallSnippet';

describe('lib/x402/paywallSnippet', () => {
  const snippet = buildPaywallSnippet('https://api.example.jp/paid/translate');

  it('登録 URL が焼き込まれ、リポ内 import を含まない (外部サーバーで動く)', () => {
    // URL は JSON.stringify で JS 文字列リテラル化 (ダブルクオート)。
    expect(snippet).toContain('MY_RESOURCE_URL = "https://api.example.jp/paid/translate"');
    expect(snippet).not.toContain("@/lib");
    expect(snippet).not.toContain("from '");
  });

  it('P2-K: 登録 URL の特殊文字が JS へ注入されない (JSON.stringify エスケープ)', () => {
    // registry の URL 検証は http(s) + 長さのみで、path/query の特殊文字は WHATWG URL 上は合法ゆえ
    // 通過しうる。生テンプレート埋め込み ('${url}') だと URL 内のクオートで文字列を閉じて任意 JS を
    // 注入できた (加盟店がコピペで本番サーバーに貼る前提ゆえ実害あり)。ダブルクオート JS 文字列を
    // 破れるのは `"` と `\` のみで、JSON.stringify が両者をエスケープするため注入は成立しない。
    const evil = 'https://x.test/x"; process.exit(1); const y="';
    const s = buildPaywallSnippet(evil);
    // URL は 1 個のエスケープ済み JS 文字列リテラルとして埋め込まれる (= 注入不成立の証明)。
    // JSON.stringify(evil) は内部の `"` を `\"` にエスケープし、URL 全体が単一の "..." に収まる。
    expect(s).toContain(`MY_RESOURCE_URL = ${JSON.stringify(evil)};`);
    // 生テンプレート時代の壊れた形 (URL がクオートを閉じて JS 文が始まる) は存在しない。
    expect(s).not.toContain('MY_RESOURCE_URL = "https://x.test/x"; process.exit');
  });

  it('ゲートの 3 要素を含む: 402+accepts / verify→settle 転送 / X-PAYMENT-RESPONSE', () => {
    expect(snippet).toContain('402');
    expect(snippet).toContain('/api/facilitator/');
    expect(snippet).toContain("'verify'");
    expect(snippet).toContain("'settle'");
    expect(snippet).toContain('X-PAYMENT-RESPONSE');
  });

  it('同等の npm SDK ゲートを案内する', () => {
    expect(snippet).toContain(
      'openpay-x402-sdk の createJpycGate でも同等のゲートを import できます。',
    );
  });

  it('accepts は自分のカタログ掲載から取得する (手数料改定に自動追従する設計)', () => {
    expect(snippet).toContain('/api/discovery');
    expect(snippet).toContain('open-pay.jp');
  });
});

describe('lib/x402/paywallSnippet dual-rail (usdcResourceId 指定時)', () => {
  const dual = buildPaywallSnippet('https://api.example.jp/paid/translate', {
    usdcResourceId: 'res-abc',
  });

  it('opts なしの JPYC 版出力は dual 化の影響を受けない (回帰フェンス)', () => {
    const jpycOnly = buildPaywallSnippet('https://api.example.jp/paid/translate');
    expect(jpycOnly).toContain('export async function jpycGate');
    expect(jpycOnly).not.toContain('/api/x402/relay/');
    expect(jpycOnly).not.toContain('MY_RESOURCE_ID');
  });

  it('URL と出品 ID が焼き込まれ、リレー 3 endpoint を使う', () => {
    expect(dual).toContain('MY_RESOURCE_URL = "https://api.example.jp/paid/translate"');
    expect(dual).toContain('MY_RESOURCE_ID = "res-abc"');
    expect(dual).toContain('/api/x402/relay/requirements?resourceId=');
    expect(dual).toContain("'/api/x402/relay/' + path");
    expect(dual).toContain('export async function x402Gate');
    expect(dual).not.toContain('@/lib');
  });

  it('USDC 面の障害隔離: 取得失敗は null → JPYC のみで継続する記述を含む', () => {
    // usdcFace() が try-catch + !res.ok → null で、accepts は usdc なしでも JPYC で成立する。
    expect(dual).toContain('async function usdcFace()');
    expect(dual).toContain('return null');
    expect(dual).toContain('usdc ? [...jpycAccepts, usdc.v1Accepts] : jpycAccepts');
  });

  it('v2 ヘッダ (PAYMENT-SIGNATURE) と v1 (x-payment) の両レール分岐を含む', () => {
    expect(dual).toContain("request.headers.get('payment-signature')");
    expect(dual).toContain("request.headers.get('x-payment')");
    expect(dual).toContain('PAYMENT-REQUIRED');
    expect(dual).toContain('paymentSignatureHeader');
    expect(dual).toContain('paymentHeader');
  });

  it('P2-K 同等: 出品 ID の特殊文字も注入不成立 (JSON.stringify エスケープ)', () => {
    const evilId = 'x"; process.exit(1); const y="';
    const s = buildPaywallSnippet('https://x.test/ok', { usdcResourceId: evilId });
    expect(s).toContain(`MY_RESOURCE_ID = ${JSON.stringify(evilId)};`);
  });
});
