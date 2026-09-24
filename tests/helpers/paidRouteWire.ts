// R2: captured from the original handlers before extraction. Preserve raw body and
// encoded headers; do not regenerate the snapshots to accommodate an extraction.
export async function paidRouteWire(response: Response) {
  return {
    status: response.status,
    headers: Object.fromEntries(response.headers),
    body: await response.text(),
  };
}

export function v2PaymentHeader(challenge: Response, payload: unknown): string {
  const required = JSON.parse(
    Buffer.from(challenge.headers.get('payment-required')!, 'base64').toString('utf8'),
  ) as { accepts: unknown[]; resource: unknown };
  return Buffer.from(JSON.stringify({
    x402Version: 2,
    resource: required.resource,
    accepted: required.accepts[0],
    payload,
  }), 'utf8').toString('base64');
}

export const forwardingCases: Array<{ name: string; incoming: Record<string, string>; expected: Record<string, string> }> = [
  {
    name: 'all allowed IP headers',
    incoming: {
      'x-forwarded-for': '198.51.100.7, 203.0.113.8',
      'x-real-ip': '198.51.100.9',
      'x-vercel-forwarded-for': '203.0.113.10',
      'cf-connecting-ip': '198.51.100.11',
    },
    expected: {
      'content-type': 'application/json',
      'x-forwarded-for': '198.51.100.7, 203.0.113.8',
      'x-real-ip': '198.51.100.9',
      'x-vercel-forwarded-for': '203.0.113.10',
      'cf-connecting-ip': '198.51.100.11',
    },
  },
  {
    name: 'empty and missing IP headers',
    incoming: { 'x-forwarded-for': '', 'cf-connecting-ip': '' },
    expected: { 'content-type': 'application/json' },
  },
];

export const unforwardedHeaders = {
  cookie: 'session=private',
  authorization: 'Bearer private',
  'proxy-authorization': 'Basic private',
  'content-type': 'text/plain',
  'x-unrelated': 'private',
};
