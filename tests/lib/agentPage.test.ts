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
