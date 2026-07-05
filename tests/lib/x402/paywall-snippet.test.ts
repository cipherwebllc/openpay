// buildPaywallSnippet: 外部サーバーがコピペで動く自己完結ゲートであることの構造検証。

import { describe, expect, it } from 'vitest';
import { buildPaywallSnippet } from '@/lib/x402/paywallSnippet';

describe('lib/x402/paywallSnippet', () => {
  const snippet = buildPaywallSnippet('https://api.example.jp/paid/translate');

  it('登録 URL が焼き込まれ、リポ内 import を含まない (外部サーバーで動く)', () => {
    expect(snippet).toContain("MY_RESOURCE_URL = 'https://api.example.jp/paid/translate'");
    expect(snippet).not.toContain("@/lib");
    expect(snippet).not.toContain("from '");
  });

  it('ゲートの 3 要素を含む: 402+accepts / verify→settle 転送 / X-PAYMENT-RESPONSE', () => {
    expect(snippet).toContain('402');
    expect(snippet).toContain('/api/facilitator/');
    expect(snippet).toContain("'verify'");
    expect(snippet).toContain("'settle'");
    expect(snippet).toContain('X-PAYMENT-RESPONSE');
  });

  it('accepts は自分のカタログ掲載から取得する (手数料改定に自動追従する設計)', () => {
    expect(snippet).toContain('/api/discovery');
    expect(snippet).toContain('open-pay.jp');
  });
});
