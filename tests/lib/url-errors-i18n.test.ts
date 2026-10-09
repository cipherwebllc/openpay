import { createTranslator } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import jaMessages from '@/messages/ja.json';
import enMessages from '@/messages/en.json';
import {
  parseCheckoutParams,
  parseNativeTipParams,
  parsePayParams,
  parseTipParams,
  urlFail,
  type UrlErrorCode,
} from '@/lib/url';

// URL 検査の失敗は、画面で locale の文 (messages の UrlErrors) を出す。英語のページに日本語の固定文が
// 出ていた (2026-10-02) のを直したもので、日本語の表示は従来の固定文 (error) と 1 文字も変えない。

const VALUES: Record<UrlErrorCode, Record<string, string>> = {
  missingTo: {},
  invalidTo: {},
  missingRecipient: {},
  invalidRecipient: {},
  invalidToken: {},
  invalidMode: {},
  invalidChain: { chains: 'polygon / kaia / base' },
  tokenNotOnChain: { token: 'jpyc', chain: 'arbitrum' },
  gaslessUnsupported: { token: 'usdc', chain: 'arc' },
  invalidSplit: {},
  splitIncludesTo: {},
  missingItems: {},
  invalidItems: {},
  tipWidgetUnsupported: { token: 'usdc', chain: 'arc' },
  invalidNative: {},
  storeDeviceUnavailable: {},
  invalidDiscount: {},
};
const CODES = Object.keys(VALUES) as UrlErrorCode[];
const JAPANESE = /[ぁ-んァ-ヶ一-龠々〜]/;

const ja = createTranslator({ locale: 'ja', messages: jaMessages, namespace: 'UrlErrors' });
const en = createTranslator({ locale: 'en', messages: enMessages, namespace: 'UrlErrors' });

describe('URL 検査のエラー文 (UrlErrors)', () => {
  it('ja と en に全種類の文があり、余分な鍵が無い', () => {
    expect(Object.keys(jaMessages.UrlErrors).sort()).toEqual([...CODES].sort());
    expect(Object.keys(enMessages.UrlErrors).sort()).toEqual([...CODES].sort());
  });

  it.each(CODES)('%s: ja の文は従来の固定文 (error) と完全に同じ', (code) => {
    const values = VALUES[code];
    expect(ja(code, values)).toBe(urlFail(code, values).error);
  });

  it.each(CODES)('%s: en の文に日本語が混ざらず、値が埋め込まれる', (code) => {
    const values = VALUES[code];
    const text = en(code, values);
    expect(text).not.toMatch(JAPANESE);
    for (const v of Object.values(values)) expect(text).toContain(v);
  });

  it('urlFail は値が無ければ values を持たない (表示側で undefined を渡すだけ)', () => {
    expect(urlFail('invalidToken').urlError).toEqual({ code: 'invalidToken' });
    expect(urlFail('gaslessUnsupported', { token: 'usdc', chain: 'arc' }).urlError).toEqual({
      code: 'gaslessUnsupported',
      values: { token: 'usdc', chain: 'arc' },
    });
  });
});

describe('各 parser の失敗は種類 (urlError) を返す', () => {
  const sp = (q: string) => new URLSearchParams(q);
  const TO = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';

  it('/pay: 宛先なし・不正な mode・未対応の chain', () => {
    const missing = parsePayParams(sp('token=usdc'));
    expect(!missing.ok && missing.urlError).toEqual({ code: 'missingTo' });
    const mode = parsePayParams(sp(`to=${TO}&token=usdc&mode=fast`));
    expect(!mode.ok && mode.urlError).toEqual({ code: 'invalidMode' });
    const chain = parsePayParams(sp(`to=${TO}&token=usdc&chain=nowhere`));
    expect(!chain.ok && chain.urlError.code).toBe('invalidChain');
    expect(!chain.ok && en(chain.urlError.code, chain.urlError.values)).toMatch(/^Set chain to one of: /);
  });

  afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

  it('/pay: Arc の gasless 要求は gaslessUnsupported (2026-10-02 に英語のページで日本語が出ていた URL)', async () => {
    vi.resetModules();
    vi.stubEnv('NEXT_PUBLIC_NETWORK_ENV', 'testnet');
    vi.stubEnv('NEXT_PUBLIC_ENABLE_USDC_ARC', '1');
    vi.stubEnv('NEXT_PUBLIC_PIMLICO_API_KEY', 'test');
    vi.stubEnv('NEXT_PUBLIC_PIMLICO_SPONSORSHIP_POLICY_ID', 'test');
    vi.stubEnv('NEXT_PUBLIC_FEE_RECEIVER_ADDRESS', TO);
    const url = await import('@/lib/url');
    const arc = url.parsePayParams(sp(`to=${TO}&token=usdc&chain=arc&amount=5`));
    if (arc.ok) throw new Error('usdc on arc in gasless mode must be rejected');
    expect(arc.urlError).toEqual({ code: 'gaslessUnsupported', values: { token: 'usdc', chain: 'arc' } });
    expect(en(arc.urlError.code, arc.urlError.values)).toBe('usdc on arc does not support gasless payments. Use mode=standard.');
    expect(arc.error).toBe('usdc on arc は gasless mode 非対応です (mode=standard を指定してください)');
    expect(url.parsePayParams(sp(`to=${TO}&token=usdc&chain=arc&mode=standard&amount=5`)).ok).toBe(true);
  });

  it('/checkout: items なし・不正な宛先', () => {
    const items = parseCheckoutParams(sp(`to=${TO}&token=usdc&chain=base`));
    expect(!items.ok && items.urlError).toEqual({ code: 'missingItems' });
    const to = parseCheckoutParams(sp('to=0x123&token=usdc'));
    expect(!to.ok && to.urlError).toEqual({ code: 'invalidTo' });
  });

  it('/tip: 不正な宛先・token なし / native: 不正な native', () => {
    const bad = parseTipParams('0x123', sp('token=usdc'));
    expect(!bad.ok && bad.urlError).toEqual({ code: 'invalidRecipient' });
    const token = parseTipParams(TO, sp(''));
    expect(!token.ok && token.urlError).toEqual({ code: 'invalidToken' });
    const native = parseNativeTipParams(TO, sp('native=ethereum'));
    expect(!native.ok && native.urlError).toEqual({ code: 'invalidNative' });
  });
});
