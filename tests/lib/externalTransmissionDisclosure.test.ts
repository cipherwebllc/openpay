// 外部送信規律 (電気通信事業法 27 条の 12) の公表 = プライバシーポリシー 3-3「外部送信について」と、
// ブラウザが実際に通信を許されている送信先 (next.config.mjs の CSP) を突き合わせる。
// CSP に送信先を足したのに 3-3 を直さないと、ここで落ちる (公表が実態より狭くなるのを防ぐ)。
// env で足す送信先 (NEXT_PUBLIC_*_RPC_URL・NEXT_PUBLIC_SENTRY_DSN) は CSP の本文に無い。RPC は Alchemy・dRPC を
// 想定して CSP_RULES に、Sentry は EXTRA_NAMES に置く。ほかの提供者を env に入れたら、ここと 3-3 を直す。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import ja from '@/messages/ja.json';
import en from '@/messages/en.json';

type Rule = { host: RegExp; name: string | { ja: string; en: string } };

// CSP の各送信先 → 3-3 に書いた送信先の名前。
const CSP_RULES: readonly Rule[] = [
  // アクセス解析・表示速度 (Vercel の script は開発時だけ CSP に入る)
  { host: /(^|\.)vercel-scripts\.com$/, name: 'Vercel Inc.' },
  { host: /(^|\.)cloudflareinsights\.com$/, name: 'Cloudflare, Inc.' },
  // ウォレットの接続
  { host: /(^|\.)(walletconnect\.(org|com)|web3modal\.org)$/, name: 'WalletConnect' },
  { host: /^fonts\.(googleapis|gstatic)\.com$/, name: 'Google Fonts' },
  { host: /^(www\.walletlink\.org|rpc\.wallet\.coinbase\.com|cca-lite\.coinbase\.com)$/, name: 'Coinbase Wallet' },
  // ブロックチェーンとのやり取り
  { host: /^api\.coinbase\.com$/, name: 'Basenames' },
  { host: /^prd-api\.mynawallet\.jp$/, name: 'MynaWallet' },
  { host: /^api\.pimlico\.io$/, name: 'Pimlico Labs Inc.' },
  { host: /(^|\.)circle\.com$/, name: 'Circle Internet Financial, Inc.' },
  { host: /(^|\.)base\.org$/, name: 'Base' },
  { host: /(^|\.)arbitrum\.io$/, name: 'Arbitrum' },
  { host: /(^|\.)optimism\.io$/, name: 'Optimism' },
  { host: /(^|\.)drpc\.org$/, name: 'dRPC' },
  { host: /(^|\.)kaia\.io$/, name: 'Kaia' },
  { host: /(^|\.)avax(-test)?\.network$/, name: 'Avalanche' },
  { host: /(^|\.)arc\.io$/, name: 'Arc' },
  { host: /(^|\.)unichain\.org$/, name: 'Unichain' },
  { host: /(^|\.)alchemy\.com$/, name: 'Alchemy' },
  { host: /(^|\.)soniclabs\.com$/, name: 'Sonic' },
  { host: /(^|\.)sei-apis\.com$/, name: 'Sei' },
  { host: /(^|\.)hyperliquid(-testnet)?\.xyz$/, name: 'Hyperliquid' },
  { host: /(^|\.)llamarpc\.com$/, name: 'LlamaRPC' },
  { host: /(^|\.)publicnode\.com$/, name: 'PublicNode' },
  { host: /(^|\.)ankr\.com$/, name: 'Ankr' },
  // 埋め込みの動画・音楽 (@handle のプロフィール・ガイドの使い方動画)
  { host: /(^|\.)youtube-nocookie\.com$/, name: 'YouTube' },
  { host: /(^|\.)spotify\.com$/, name: 'Spotify' },
  { host: /(^|\.)nicovideo\.jp$/, name: { ja: 'ニコニコ動画', en: 'Niconico' } },
  { host: /(^|\.)vimeo\.com$/, name: 'Vimeo' },
  { host: /^embed\.music\.apple\.com$/, name: 'Apple Music' },
  { host: /(^|\.)tiktok\.com$/, name: 'TikTok' },
  { host: /(^|\.)suno\.com$/, name: 'Suno' },
  { host: /(^|\.)soundcloud\.com$/, name: 'SoundCloud' },
  { host: /(^|\.)audius\.co$/, name: 'Audius' },
];

// CSP の本文に無い送信先の名前 (同一オリジン経由の解析と、env で決まる送信先)。
const EXTRA_NAMES: readonly string[] = [
  'Vercel Web Analytics', // app/[locale]/layout.tsx の <Analytics />
  'Speed Insights', // 同 <SpeedInsights />
  'Functional Software, Inc.', // NEXT_PUBLIC_SENTRY_DSN (Sentry)
];

const nameFor = (rule: Rule, locale: 'ja' | 'en') => (typeof rule.name === 'string' ? rule.name : rule.name[locale]);

// next.config.mjs のコメント行を除いた本文から、外部の送信先 (https/wss) のホスト名を取り出す。
function cspHosts(): string[] {
  const source = readFileSync(join(process.cwd(), 'next.config.mjs'), 'utf8');
  const code = source
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
  const hosts = [...code.matchAll(/(?:https|wss):\/\/([a-z0-9.-]+)/gi)].map((m) => m[1].toLowerCase());
  return [...new Set(hosts)].sort();
}

describe('外部送信の公表 (プライバシーポリシー 3-3) と CSP の送信先', () => {
  it('CSP のすべての外部の送信先が、3-3 のどれかの送信先に対応している', () => {
    const hosts = cspHosts();
    // 取り出しが壊れて 0 件で素通りしないように (2026-10-13 時点で 60 前後)。
    expect(hosts.length).toBeGreaterThan(40);
    const unmapped = hosts.filter((h) => !CSP_RULES.some((r) => r.host.test(h)));
    expect(unmapped, 'CSP に足した送信先をプライバシーポリシー 3-3 とこのテストに足す').toEqual([]);
  });

  it.each(['ja', 'en'] as const)('%s: 3-3 の本文に、すべての送信先の名前が書かれている', (locale) => {
    const body = (locale === 'ja' ? ja : en).Privacy.sectionExternal.body;
    for (const rule of CSP_RULES) expect(body).toContain(nameFor(rule, locale));
    for (const name of EXTRA_NAMES) expect(body).toContain(name);
  });

  it.each(['ja', 'en'] as const)('%s: 3-3 は法の根拠・IP アドレス・広告目的でないことを書き、4 項の前に置く', (locale) => {
    const p = (locale === 'ja' ? ja : en).Privacy;
    expect(p.sectionExternal.title).toMatch(/^3-3\./);
    expect(p.sectionExternal.body).toContain(locale === 'ja' ? '電気通信事業法第 27 条の 12' : 'Article 27-12');
    expect(p.sectionExternal.body).toContain(locale === 'ja' ? 'IP アドレス' : 'IP address');
    expect(p.sectionExternal.body).toContain(locale === 'ja' ? '広告を目的とした外部送信を行いません' : 'do not send information externally for advertising');
    const keys = Object.keys(p);
    expect(keys.indexOf('sectionExternal')).toBe(keys.indexOf('sectionShops') + 1);
  });

  it.each(['ja', 'en'] as const)('%s: 委託先に Cloudflare・Upstash・Sentry (Functional Software) がある', (locale) => {
    const body = (locale === 'ja' ? ja : en).Privacy.section3.body;
    for (const name of ['Cloudflare, Inc.', 'Upstash, Inc.', 'Functional Software, Inc.']) expect(body).toContain(name);
  });
});
