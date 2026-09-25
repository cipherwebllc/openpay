import { AGENT_PURCHASES_MAX, AGENT_PURCHASES_SINCE } from '@/lib/agent/purchases';
import { formatUnits, parseUnits } from 'viem';
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { agentPageContentFor, agentPageMetadata } from '@/lib/agentPage';
import { JPYC_SERVICES_RESOURCE } from '@/lib/directory/paidResources';
import { DISCLOSED_X402_FEE } from '@/lib/legal';
import jaMessages from '@/messages/ja.json';
import enMessages from '@/messages/en.json';

function shape(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(shape);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, shape(item)]));
  return typeof value;
}

describe('agent page content', () => {
  it.each([
    ['ja', jaMessages.AgentConfigGenerator.policyNote, '制限しません'],
    ['en', enMessages.AgentConfigGenerator.policyNote, 'does not limit'],
  ])('retains the measured Kova policy limitation in the %s generator namespace', (_locale, policyNote, limitation) => {
    expect(policyNote).toContain('0.1.2');
    expect(policyNote).toContain(limitation);
  });
  it('has matching ja/en key structures', () => {
    expect(shape(agentPageContentFor('ja'))).toEqual(shape(agentPageContentFor('en')));
  });
  it('keeps try-prompt IDs and payment kinds in the same order in ja/en', () => {
    const ja = agentPageContentFor('ja').tryPrompts.items;
    const en = agentPageContentFor('en').tryPrompts.items;
    expect(ja).toHaveLength(6);
    expect(new Set(ja.map((item) => item.id)).size).toBe(6);
    expect(ja.map(({ id, kind }) => ({ id, kind }))).toEqual(en.map(({ id, kind }) => ({ id, kind })));
  });
  it.each(['ja', 'en'])('keeps history-web free in %s', (locale) => {
    expect(agentPageContentFor(locale).tryPrompts.items.find((item) => item.id === 'history-web')?.kind).toBe('free');
  });
  it.each(['ja', 'en'])('includes a spending cap in every paid prompt in %s', (locale) => {
    const paid = agentPageContentFor(locale).tryPrompts.items.filter((item) => item.kind === 'paid');
    expect(paid.length).toBeGreaterThan(0);
    for (const item of paid) {
      expect(item.prompt).toMatch(locale === 'ja' ? /上限 \d+(?:\.\d+)? JPYC/ : /\d+(?:\.\d+)? JPYC cap/);
    }
  });
  it.each(['ja', 'en'])('keeps the purchases notes aligned with the index constants in %s', (locale) => {
    // 「2026-09-22 (UTC) 以降」「直近 200 件」は文言側の直書き。索引の定数を変えたら文言も変わるようフェンス。
    const p = agentPageContentFor(locale).purchases;
    expect(p.sinceNote).toContain(AGENT_PURCHASES_SINCE);
    expect(p.truncated).toContain(String(AGENT_PURCHASES_MAX));
  });
  it.each(['ja', 'en'])('shows one verifiable purchase example on the paid prompt in %s', (locale) => {
    const item = agentPageContentFor(locale).tryPrompts.items.find((item) => item.id === 'buy-monitor');
    // 実績は日付と当時の価格を明記し、Polygonscan の tx で誰でも検証できる形に固定する。
    expect(item?.example?.href).toMatch(/^https:\/\/polygonscan\.com\/tx\/0x[0-9a-f]{64}$/);
    expect(item?.example?.text).toMatch(/2026-09-22/);
    expect(item?.hint?.trim().length).toBeGreaterThan(0);
    for (const other of agentPageContentFor(locale).tryPrompts.items.filter((other) => other.id !== 'buy-monitor')) {
      expect(other.example).toBeUndefined();
    }
  });
  it.each(['ja', 'en'])('keeps the monitor prompt and tag total aligned with the price and disclosed fee in %s', (locale) => {
    // /api/paid/jpyc/services が handleFirstPartyPaidGet に渡す価格 SoT を直接参照する。
    // 実装 (lib/x402/fee.ts) と同じ atomic の整数演算。Number だと小数価格で 0.3 + 1 = 1.2999… の偽 fail になる。
    const priceWei = parseUnits(JPYC_SERVICES_RESOURCE.priceJpyc, 18);
    const floorWei = parseUnits(String(DISCLOSED_X402_FEE.floorJpyc), 18);
    const percentWei = priceWei * BigInt(DISCLOSED_X402_FEE.bps) / 10000n;
    const total = formatUnits(priceWei + (percentWei > floorWei ? percentWei : floorWei), 18);
    const item = agentPageContentFor(locale).tryPrompts.items.find((item) => item.id === 'buy-monitor');
    expect(item?.kind).toBe('paid');
    for (const text of [item?.prompt, item?.tag]) {
      const amounts = [...(text ?? '').matchAll(/(\d+(?:\.\d+)?) JPYC/g)].map((match) => match[1]);
      expect(amounts).toEqual([total]);
    }
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
