import { describe, expect, it } from 'vitest';
import { audienceOf, buildDeliveryRedirect, parseDeliveryUrl } from '@/lib/store/deliveryUrl';
import { OPENPAY_FIRST_PARTY_HOSTNAMES } from '@/lib/x402/firstParty';
import fixture from '@/tests/fixtures/delivery-ticket.v1.json';

describe('delivery URL profile', () => {
  it.each([null, undefined, 42, {}, '', '/files', '//files.example/f', 'http://files.example', 'ftp://files.example',
    'https://user:pass@files.example/f', 'https://user@files.example', 'https://files.example/#x', 'https://files.example/#',
    ' https://files.example', 'https://files.example ', 'https://files.example/\n', 'https://fi\tles.example/f',
    'https://files.example/\u0000', 'https://files.example/\u007f', 'https://files.example/\u0085',
    'https://files.example/?ticket=x', 'https://files.example/?ticket', 'https://files.example/?%74icket=x',
    'https://files.example/?ti%63ket=x&ticket=y', 'https://files.example./f', 'https://open-pay.jp./f',
    'https://127.1/f', 'https://127.0.0.1', 'https://2130706433', 'https://0x7f000001', 'https://0177.0.0.1',
    'https://10.0.0.1', 'https://192.168.0.1', 'https://8.8.8.8', 'https://[::1]/f', 'https://[2001:db8::1]/f',
    'https://[::ffff:127.0.0.1]/f', 'https://localhost/f', 'https://A.LOCALHOST:444/f',
    'https://files.example/' + 'a'.repeat(513 - 'https://files.example/'.length)])('rejects corpus case %#', (raw) => {
    expect(parseDeliveryUrl(raw).ok).toBe(false);
  });
  it('rejects canonical and alias hostnames regardless of port, case or percent encoding', () => {
    for (const host of OPENPAY_FIRST_PARTY_HOSTNAMES) for (const port of ['', ':443', ':444']) {
      expect(parseDeliveryUrl(`https://${host.toUpperCase()}${port}/f`).ok).toBe(false);
    }
    expect(parseDeliveryUrl('https://%6fpen-pay.jp/f').ok).toBe(false);
  });
  it.each([
    ['https://EXAMPLE.com:443/File?K=V', 'https://example.com/File?K=V', 'https://example.com'],
    ['https://example.com/File?K=V', 'https://example.com/File?K=V', 'https://example.com'],
    ['https://example.com:444/f', 'https://example.com:444/f', 'https://example.com:444'],
    ['https://bücher.example/f', 'https://xn--bcher-kva.example/f', 'https://xn--bcher-kva.example'],
    ['https://open-pay.jp.attacker.example/f', 'https://open-pay.jp.attacker.example/f', 'https://open-pay.jp.attacker.example'],
    ['https://notopen-pay.jp/f', 'https://notopen-pay.jp/f', 'https://notopen-pay.jp'],
    ['https://files.example/?Ticket=okay', 'https://files.example/?Ticket=okay', 'https://files.example'],
  ])('canonicalizes %s with stable audience', (raw, url, origin) => {
    expect(parseDeliveryUrl(raw)).toEqual({ ok: true, url, origin }); expect(audienceOf(url)).toBe(origin);
    expect(new URL(buildDeliveryRedirect(url, fixture.ticket)).origin).toBe(origin);
  });
  it('checks length both before and after serialization without truncation', () => {
    const exact = 'https://files.example/' + 'a'.repeat(512 - 'https://files.example/'.length);
    expect(parseDeliveryUrl(exact).ok).toBe(true); expect(parseDeliveryUrl(exact + 'a').ok).toBe(false);
    expect(parseDeliveryUrl('https://files.example/' + 'é'.repeat(100)).ok).toBe(false);
    expect(Buffer.byteLength(buildDeliveryRedirect(exact, fixture.ticket))).toBe(fixture.measurements.redirectBytes);
    const queryBase = 'https://files.example/?q=';
    const expanded = queryBase + '~'.repeat(512 - queryBase.length);
    expect(parseDeliveryUrl(expanded).ok).toBe(true);
    expect(Buffer.byteLength(buildDeliveryRedirect(expanded, fixture.ticket))).toBe(fixture.measurements.percentEncodedQueryRedirectBytes);
  });
  it('builds the exact redirect while preserving repeated nonreserved parameters and their values', () => {
    const raw = 'https://FILES.example:443/gate?part=A%2FB&part=C+D&tilde=~&empty=';
    const parsed = parseDeliveryUrl(raw); expect(parsed.ok).toBe(true); if (!parsed.ok) return;
    const result = buildDeliveryRedirect(parsed.url, 'abc.DEF_-123.sig');
    expect(result).toBe('https://files.example/gate?part=A%2FB&part=C+D&tilde=%7E&empty=&ticket=abc.DEF_-123.sig');
    expect(new URL(result).searchParams.getAll('part')).toEqual(['A/B', 'C D']);
  });
});
