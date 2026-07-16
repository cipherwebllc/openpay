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
