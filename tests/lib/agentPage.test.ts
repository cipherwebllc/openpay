import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { agentPageContentFor, agentPageMetadata } from '@/lib/agentPage';
import { DISCLOSED_X402_FEE } from '@/lib/legal';

function shape(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(shape);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, shape(item)]));
  return typeof value;
}

describe('agent page content', () => {
  it('has matching ja/en key structures', () => {
    expect(shape(agentPageContentFor('ja'))).toEqual(shape(agentPageContentFor('en')));
  });
  it.each(['ja', 'en'])('explains where the agent wallet comes from in the empty state in %s', (locale) => {
    const c = agentPageContentFor(locale);
    for (const value of [c.wallet.emptyLead, c.wallet.emptyConnectCta, c.wallet.manualEntry]) expect(value.trim().length).toBeGreaterThan(0);
    // ウォレットが作られるのは「Agent が支払う」のセットアップだけ (「人が支払う」では作られない)。モード名と接続カードの見出しを引用する。
    const agentPays = c.modes.items.find((item) => item.mode === 'agent-pays');
    expect(c.wallet.emptyLead).toContain(agentPays?.name);
    expect(c.wallet.emptyLead).toContain(c.connect.title);
  });
  it('provides matching, nonempty activity copy outside the wallet namespace', () => {
    const ja = agentPageContentFor('ja');
    const en = agentPageContentFor('en');
    expect(shape(ja.activity)).toEqual(shape(en.activity));
    expect(Object.keys(ja.activity)).toHaveLength(25);
    // 「取引ゼロ」と「表示できる取引がない」は別の文言 (0 円の送信が直近 50 件を埋めたとき、ゼロと断言しない)。
    expect(ja.activity.hiddenOnly).not.toBe(ja.activity.empty);
    expect(en.activity.hiddenOnly).not.toBe(en.activity.empty);
    for (const c of [ja, en]) {
      expect(c.wallet).not.toHaveProperty('activity');
      for (const value of Object.values(c.activity)) expect(value.length).toBeGreaterThan(0);
      expect(`${c.activity.stat24h} ${c.activity.stat7d}`).not.toMatch(/上限|limit/i);
    }
  });
  it.each(['ja', 'en'])('provides all disclosure and toggle copy in %s', (locale) => {
    const c = agentPageContentFor(locale);
    expect(c.safety.summary).toHaveLength(3);
    for (const value of [...c.safety.summary, c.safety.detailsLabel, c.connect.promptExpand, c.connect.promptCollapse, c.wallet.changeAddress, c.wallet.closeFund]) {
      expect(value.length).toBeGreaterThan(0);
    }
  });
  it('retains the complete Japanese spending and key disclosure', () => {
    expect(agentPageContentFor('ja').safety).toMatchObject({
      body: '支払い上限と接続先の制限は、Agent を動かすマシン上の MCP/SDK が適用するローカルの安全設定です。OpenPay のサーバーは上限を知らず、保証もしません。このページが設定を書き換えることもありません。',
      points: [
        '専用の Agent Wallet には、使ってよい金額だけを入れてください。残高が実質的な上限になります。',
        'このページに秘密鍵の入力欄はありません。鍵を求める OpenPay の画面があれば偽物です。',
        'ウォレットの鍵は、Agent を動かすあなたのマシン上で MCP が作って保管します。会話にも OpenPay にも出ません。ただし、あなたとしてコマンドを実行できるものはこの鍵を読めます。入れるのは失ってもよい少額だけにしてください。OpenPay は鍵を復元できません。',
      ],
    });
  });
  it('retains the complete English spending and key disclosure', () => {
    expect(agentPageContentFor('en').safety).toMatchObject({
      body: "Spending limits and allowed hosts are local safety settings applied by the MCP/SDK on the machine that runs your agent. OpenPay's servers do not know them and do not guarantee them. This page never changes your agent's settings.",
      points: [
        'Fund the dedicated agent wallet only with what you are willing to spend. Its balance is the effective ceiling.',
        'This page has no private-key field. Any OpenPay screen asking for a key is fake.',
        'The wallet key is created and kept by the MCP on your own machine, where your agent runs. It never enters the chat or reaches OpenPay. Anything that can run commands as you can still read it, so fund it only with a small amount you can afford to lose. OpenPay cannot recover the key.',
      ],
    });
  });
  it.each(['ja', 'en'])('states local enforcement and factual wallet status in %s', (locale) => {
    const c = agentPageContentFor(locale);
    expect(JSON.stringify(c)).not.toMatch(/稼働中|Active|接続済み/);
    expect(c.safety.enforcedBadge).toContain('MCP/SDK');
    expect(c.generator.feeNote).toContain(`${DISCLOSED_X402_FEE.bps / 100}%`);
    expect(c.generator.feeNote).toContain(`${DISCLOSED_X402_FEE.floorJpyc} JPYC`);
    expect(agentPageMetadata(locale).alternates?.canonical).toContain(`/${locale}/agent`);
  });
  it.each(['ja', 'en'])('ships dedicated social metadata for %s', (locale) => {
    const meta = agentPageMetadata(locale);
    const c = agentPageContentFor(locale);
    expect(meta.title).toBe(c.metaTitle);
    expect(String(meta.title)).not.toMatch(/OpenPay.*OpenPay.*OpenPay/);
    expect(meta.alternates?.canonical).toBe(`/${locale}/agent`);
    const og = meta.openGraph?.images as { url: string; width: number; height: number; alt: string }[];
    expect(og).toEqual([{ url: '/og-agent.webp', width: 1200, height: 630, alt: c.ogImageAlt }]);
    expect(meta.twitter).toMatchObject({ card: 'summary_large_image', title: c.metaTitle, description: c.metaDescription, images: ['/og-agent.webp'] });
    // X のカードは description を約 200 字で切る。
    expect(c.metaDescription.length).toBeLessThanOrEqual(200);
    expect(existsSync('public/og-agent.webp')).toBe(true);
  });
});
