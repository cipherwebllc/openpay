import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildPaywallSnippet } from '@/lib/x402/paywallSnippet';

const RESOURCE = 'https://seller.test/paid';
const ID = 'seller-id';
const SELLER = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const USDC_SELLER = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const ATTACKER = '0x9999999999999999999999999999999999999999';
const FORWARDER = '0x4444444444444444444444444444444444444444';
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64');
const json = (value: unknown) => Response.json(value);
let testSequence = 0;
beforeEach(() => { testSequence += 1; });
function listing(id = ID, merchant = SELLER) {
  return { id, resource: RESOURCE, accepts: [{
    scheme: 'exact', network: 'eip155:137', resource: RESOURCE,
    payTo: FORWARDER, asset: '0x1111111111111111111111111111111111111111',
    maxAmountRequired: '100',
    extra: { openpay: { mode: 'forwarder-split', forwarder: FORWARDER, merchant } },
  }] };
}
function face(recipient = USDC_SELLER) {
  const v1Accepts = {
    scheme: 'exact', network: 'base', resource: RESOURCE, payTo: recipient,
    asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', maxAmountRequired: '1000',
  };
  const v2Accept = { ...v1Accepts, network: 'eip155:8453', amount: '1000' };
  return { resourceId: ID, v1Accepts, v2Accept,
    paymentRequiredHeader: b64({ x402Version: 2, accepts: [v2Accept] }) };
}
function usdcPayment(version = 2, nonce = '1', amount = '1000') {
  const payload = { signature: `0x${'c'.repeat(130)}`, authorization: {
    from: SELLER, to: USDC_SELLER, value: amount,
    nonce: `0x${nonce.repeat(60)}${testSequence.toString(16).padStart(4, '0')}`,
    validAfter: '0', validBefore: String(Math.ceil(Date.now() / 1000) + 600),
  } };
  return version === 2 ? { x402Version: 2, accepted: { ...face().v2Accept, amount }, payload }
    : { x402Version: 1, scheme: 'exact', network: 'base', payload };
}
const OPTIONS = { resourceUrl: RESOURCE, resourceId: ID, expectedRecipient: SELLER,
  expectedUsdcRecipient: USDC_SELLER };
type Payment = { paymentResponseHeader: string };
type Gate = { handle: (r: Request) => Promise<Response | Payment>;
  verify: (r: Request) => Promise<Response | { settle: () => Promise<Response | Payment> }> };
type Factory = (options: Record<string, unknown>) => Gate;
async function sdk() {
  return await import(pathToFileURL(resolve('packages/x402-sdk/src/index.mjs')).href) as {
    createJpycGate: Factory; createDualGate: Factory;
  };
}
afterEach(() => vi.restoreAllMocks());

describe.each(['SDK JPYC', 'SDK dual', 'snippet JPYC', 'snippet dual'])('%s seller pins', (kind) => {
  async function setup(overrides: {
    item?: ReturnType<typeof listing>;
    usdc?: ReturnType<typeof face>;
    rejectRelay?: string;
    discovery?: () => Response;
    refreshedUsdc?: () => Response;
  } = {}) {
    let clock = 0;
    let requirementsReads = 0;
    const calls: Array<{ url: string; body?: Record<string, unknown> }> = [];
    const state = { item: listing(), usdc: face(), ...overrides };
    const fetchImpl = vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url.endsWith('/api/discovery')) return json({ items: [listing('attacker-id', ATTACKER), state.item] });
      if (url.endsWith(`/api/discovery/${ID}`)) return state.discovery?.() ?? json(state.item);
      if (url.includes('/relay/requirements?')) {
        requirementsReads++;
        return (requirementsReads > 1 ? state.refreshedUsdc?.() : undefined) ?? json(state.usdc);
      }
      if (state.rejectRelay && url.endsWith(`/relay/${state.rejectRelay}`)) {
        state.rejectRelay = undefined;
        return Response.json({ error: 'requirements_mismatch' }, { status: 409 });
      }
      if (url.endsWith('/verify')) return json({ isValid: true });
      if (url.endsWith('/settle')) return json({ success: true });
      throw new Error(`unexpected URL: ${url}`);
    });
    let handle: Gate['handle'];
    let gate: Gate | undefined;
    if (kind.startsWith('SDK')) {
      const mod = await sdk();
      gate = mod[kind.endsWith('dual') ? 'createDualGate' : 'createJpycGate']({ ...OPTIONS, fetchImpl, now: () => clock });
      handle = gate.handle;
    } else {
      const code = buildPaywallSnippet(RESOURCE, {
        ...OPTIONS, dualRail: kind.endsWith('dual'),
      });
      handle = new Function('fetch', code.replaceAll('export async function', 'async function') +
        `\nreturn ${kind.endsWith('dual') ? 'x402Gate' : 'jpycGate'};`)(fetchImpl);
    }
    return { handle, calls, state, gate, advance: () => { clock += 5 * 60_000; } };
  }

  if (kind.endsWith('JPYC')) {
    it.each([404, 503])('distinguishes catalog HTTP %s in gate errors', async (status) => {
      const { handle } = await setup({ discovery: () => Response.json({}, { status }) });
      await expect(handle(new Request(RESOURCE))).rejects.toThrow(status === 404 ? /not found/ : /HTTP 503/);
    });
  }

  it('selects the trusted ID even with a newer attacker listing at the same URL', async () => {
    const { handle, calls } = await setup();
    const res = await handle(new Request(RESOURCE)) as Response;
    expect(res.status).toBe(402);
    expect((await res.json()).accepts[0].extra.openpay.merchant).toBe(SELLER);
    expect(calls.some((c) => c.url.endsWith(`/api/discovery/${ID}`))).toBe(true);
    expect(calls.some((c) => c.url.endsWith('/api/discovery'))).toBe(false);
  });

  it.each([false, true])('recipient mismatch rejects before 402 or payment calls (paid=%s) and is not cached', async (paid) => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { handle, calls, state } = await setup({ item: listing(ID, ATTACKER) });
    const request = new Request(RESOURCE, { headers: paid ? { 'x-payment': b64({ network: 'eip155:137' }) } : {} });
    await expect(handle(request)).rejects.toThrow(/recipient/i);
    expect(calls.some((c) => /\/(verify|settle)$/.test(c.url))).toBe(false);
    expect(log).toHaveBeenCalled();
    state.item = listing();
    expect((await handle(new Request(RESOURCE)) as Response).status).toBe(402);
  });

  it('rejects a substituted ID even when the recipient matches', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { handle } = await setup({ item: listing('different-id') });
    await expect(handle(new Request(RESOURCE))).rejects.toThrow(/resource/i);
  });

  it('accepts a case-insensitive seller address distinct from the forwarder', async () => {
    const { handle } = await setup({ item: listing(ID, `0x${'A'.repeat(40)}`) });
    expect((await handle(new Request(RESOURCE)) as Response).status).toBe(402);
  });

  it('rejects an attacker in a later JPYC accept', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const item = listing();
    item.accepts.push(listing(ID, ATTACKER).accepts[0]);
    const { handle } = await setup({ item });
    await expect(handle(new Request(RESOURCE))).rejects.toThrow(/recipient/i);
  });

  if (kind.startsWith('SDK')) {
    it('retains the verified snapshot while another request refreshes the cache', async () => {
      const { gate, handle, calls, state, advance } = await setup();
      const dual = kind.endsWith('dual');
      const headers: Record<string, string> = dual ? { 'payment-signature': b64(usdcPayment()) }
        : { 'x-payment': b64({ network: 'eip155:137' }) };
      const verified = await gate!.verify(new Request(RESOURCE, { headers }));
      expect(verified).not.toBeInstanceOf(Response);
      advance();
      state.item.accepts[0].maxAmountRequired = '200';
      state.usdc.v1Accepts.maxAmountRequired = '2000';
      state.usdc.v2Accept.amount = '2000';
      state.usdc.paymentRequiredHeader = b64({ x402Version: 2, accepts: [state.usdc.v2Accept] });
      await handle(new Request(RESOURCE));
      await (verified as { settle: () => Promise<unknown> }).settle();
      const bodies = calls.filter((c) => /\/(verify|settle)$/.test(c.url)).map((c) => c.body!);
      expect(bodies).toHaveLength(2);
      expect(bodies[0].paymentRequirements).toEqual(bodies[1].paymentRequirements);
      expect(bodies[1].paymentRequirements).toMatchObject({ maxAmountRequired: dual ? '1000' : '100' });
    });
  }

  if (kind.endsWith('dual')) {
    it.each(['verify', 'settle'])('refreshes the USDC cache after relay %s returns 409 without replaying payment', async (rejectRelay) => {
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { handle, calls, state } = await setup({ rejectRelay });
      await handle(new Request(RESOURCE));
      state.usdc.v1Accepts.maxAmountRequired = '2000';
      state.usdc.v2Accept.amount = '2000';
      state.usdc.paymentRequiredHeader = b64({ x402Version: 2, accepts: [state.usdc.v2Accept] });
      const request = new Request(RESOURCE, { headers: { 'payment-signature': b64(usdcPayment()) } });
      const res = await handle(request) as Response;
      expect(res.status).toBe(402);
      expect((await res.json()).accepts.at(-1).maxAmountRequired).toBe('2000');
      expect(JSON.parse(Buffer.from(res.headers.get('payment-required')!, 'base64').toString()).accepts[0].amount).toBe('2000');
      expect(calls.filter((c) => c.url.includes('/relay/requirements?'))).toHaveLength(2);
      expect(calls.filter((c) => /\/(verify|settle)$/.test(c.url))).toHaveLength(rejectRelay === 'verify' ? 1 : 2);
      expect(log).not.toHaveBeenCalled();
      if (kind === 'SDK dual' && rejectRelay === 'settle') {
        expect(await (await handle(request) as Response).json()).toMatchObject({ error: 'authorization_reserved' });
      }
      const freshPayment = new Request(RESOURCE, {
        headers: { 'payment-signature': b64(usdcPayment(2, '2', '2000')) },
      });
      expect(await handle(freshPayment)).not.toBeInstanceOf(Response);
      expect(calls.at(-1)!.body!.paymentRequirements).toMatchObject({ maxAmountRequired: '2000' });
      expect(calls.filter((c) => c.url.includes('/relay/requirements?'))).toHaveLength(2);
    });

    it.each(['verify', 'settle'])('refuses a poisoned USDC refresh after %s 409 and never caches it', async (rejectRelay) => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const { handle, calls, state } = await setup({ rejectRelay });
      await handle(new Request(RESOURCE));
      state.usdc = face(ATTACKER);
      await expect(handle(new Request(RESOURCE, { headers: { 'payment-signature': b64(usdcPayment()) } }))).rejects.toMatchObject({ name: 'SellerPinError' });
      expect(calls.filter((c) => /\/(verify|settle)$/.test(c.url))).toHaveLength(rejectRelay === 'verify' ? 1 : 2);
      state.usdc = face();
      expect((await handle(new Request(RESOURCE)) as Response).status).toBe(402);
      expect(calls.filter((c) => c.url.includes('/relay/requirements?'))).toHaveLength(3);
    });

    it('never re-advertises a stale USDC face when the 409 refresh is unavailable', async () => {
      const { handle, calls, state } = await setup({ rejectRelay: 'verify',
        refreshedUsdc: () => Response.json({ error: 'storage_unavailable' }, { status: 503 }) });
      await handle(new Request(RESOURCE));
      await expect(handle(new Request(RESOURCE, { headers: { 'payment-signature': b64(usdcPayment()) } }))).rejects.toThrow(/unavailable/i);
      state.refreshedUsdc = undefined;
      expect((await handle(new Request(RESOURCE)) as Response).status).toBe(402);
      expect(calls.filter((c) => c.url.includes('/relay/requirements?'))).toHaveLength(3);
    });

    it.each(['404', '503', 'empty', 'network'])('continues USDC challenges and v1/v2 payments when JPYC is unavailable (%s)', async (failure) => {
      const discovery = () => {
        if (failure === 'network') throw new Error('network unavailable');
        if (failure === 'empty') return json({ ...listing(), accepts: [] });
        return Response.json({ error: 'unavailable' }, { status: Number(failure) });
      };
      const { handle, calls } = await setup({ discovery });
      const challenge = await handle(new Request(RESOURCE)) as Response;
      expect(challenge.status).toBe(402);
      expect((await challenge.json()).accepts).toEqual([face().v1Accepts]);
      for (const headers of [
        { 'payment-signature': b64(usdcPayment()) },
        { 'x-payment': b64(usdcPayment(1, '2')) },
      ] as Array<Record<string, string>>) {
        expect(await handle(new Request(RESOURCE, { headers }))).not.toBeInstanceOf(Response);
      }
      expect(calls.filter((c) => c.url.endsWith('/relay/settle'))).toHaveLength(2);
      expect(calls.some((c) => c.url.includes('/api/facilitator/'))).toBe(false);
    });

    it('rejects JPYC poisoning before USDC verification', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const { handle, calls } = await setup({ item: listing(ID, ATTACKER) });
      await expect(handle(new Request(RESOURCE, { headers: { 'payment-signature': b64(usdcPayment()) } }))).rejects.toMatchObject({ name: 'SellerPinError' });
      expect(calls.some((c) => /\/(verify|settle)$/.test(c.url))).toBe(false);
    });

    it.each(['v1', 'v2', 'header', 'extra-header'])('rejects an attacker in the USDC %s face without degrading to a 402', async (where) => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const usdc = face();
      if (where === 'v1') usdc.v1Accepts.payTo = ATTACKER;
      if (where === 'v2') usdc.v2Accept.payTo = ATTACKER;
      if (where === 'header' || where === 'extra-header') {
        usdc.paymentRequiredHeader = b64({ x402Version: 2,
          accepts: [...(where === 'extra-header' ? [usdc.v2Accept] : []), face(ATTACKER).v2Accept] });
      }
      const { handle, calls } = await setup({ usdc });
      await expect(handle(new Request(RESOURCE))).rejects.toThrow(/recipient/i);
      expect(calls.some((c) => /\/(verify|settle)$/.test(c.url))).toBe(false);
    });
  }
});

describe('required seller config', () => {
  it.each(['createJpycGate', 'createDualGate'] as const)('%s rejects missing pins at construction', async (name) => {
    const create = (await sdk())[name];
    for (const key of ['resourceId', 'expectedRecipient', ...(name === 'createDualGate' ? ['expectedUsdcRecipient'] : [])]) {
      for (const value of [undefined, '', '   ']) {
        expect(() => create({ ...OPTIONS, [key]: value })).toThrow(new RegExp(key));
      }
    }
  });
});


describe('generated snippet startup pins', () => {
  it.each([false, true])('fails before fetch with missing pins (dual=%s)', (dualRail) => {
    for (const key of ['resourceId', 'expectedRecipient', ...(dualRail ? ['expectedUsdcRecipient'] : [])]) {
      const code = buildPaywallSnippet(RESOURCE, { ...OPTIONS, dualRail, [key]: '' });
      const fetchImpl = vi.fn();
      expect(() => new Function('fetch', code.replaceAll('export async function', 'async function'))(fetchImpl)).toThrow(new RegExp(key));
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  });
});
