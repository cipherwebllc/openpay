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
});
