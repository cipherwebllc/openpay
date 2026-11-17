// 約束 3 の柵: 「お店の端末で送る」(useStoreDevicePayment) は、画面の URL に会計ごとの印 (`bk`) があっても見ない。
// intentSalt は今までどおり乱数 (bill key から作った値にならない)。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { getAddress } from 'viem';

const w = vi.hoisted(() => ({ signTypedData: vi.fn() }));
vi.mock('wagmi', () => ({
  useWalletClient: () => ({ data: { signTypedData: w.signTypedData } }),
  useAccount: () => ({ address: '0x0000000000000000000000000000000000000def', chainId: 80002 }),
}));
const FWD = '0x752B7AaD0089286EB7b553d84D05233d80c9FCB4';
vi.mock('@/lib/relay/forwarderConfig', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/relay/forwarderConfig')>()),
  jpycForwarderFor: () => FWD,
}));

import { STORE_DEVICE_INTENT_KEY, useStoreDevicePayment } from '@/hooks/useStoreDevicePayment';
import { buildForwarderNonce } from '@/lib/relay/forwarderIntent';
import { billKeySalt } from '@/lib/relay/billKeySalt';
import { env } from '@/lib/env';
import type { TokenDeployment } from '@/lib/tokens';
import { randomHex32, stubRandom } from '../_helpers/relayAttemptCapture';

const HS = 'AbCdEfGhIjKlMnOpQrStUv';
const VALID_BK = 'Zm9vYmFyYmE';
const SHOP = getAddress('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
const JPYC = getAddress('0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29');
const deployment = { chainId: 80002, address: JPYC, decimals: 18 } as unknown as TokenDeployment;
const BILL = 1000n * 10n ** 18n;
const SNAPSHOT = { storeName: 'OpenPay Cafe', items: [{ name: 'カフェラテ', qty: 1, price: '1000' }] };

let authBodies: string[];

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false });
  vi.setSystemTime(new Date('2026-11-17T03:00:00Z'));
  window.localStorage.clear();
  w.signTypedData.mockReset().mockResolvedValue(`0x${'1b'.repeat(65)}`);
  // Web Locks の代わり (jsdom には navigator.locks が無い)。
  Object.defineProperty(window.navigator, 'locks', {
    value: { request: (_name: string, fn: () => Promise<unknown>) => fn() },
    configurable: true,
  });
  authBodies = [];
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    if (url.endsWith('/auth')) authBodies.push(String(init?.body));
    const body = url.endsWith('/auth') ? { ok: true, idempotent: false } : { ok: true, state: 'signed', expiresAt: 0, txHash: null };
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));
  }));
  stubRandom();
});

afterEach(() => {
  Object.defineProperty(window.navigator, 'locks', { value: undefined, configurable: true });
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});

describe('useStoreDevicePayment は URL の bk を見ない', () => {
  it.each([
    ['bk の無い URL', `/ja/checkout?submit=store&hs=${HS}`],
    ['形の正しい bk のある URL', `/ja/checkout?submit=store&hs=${HS}&bk=${VALID_BK}`],
  ])('%s: intentSalt は乱数・nonce はその乱数から', async (_label, url) => {
    window.history.replaceState(null, '', url);
    const { result, unmount } = renderHook(() => useStoreDevicePayment(deployment, HS));
    await act(async () => {
      await result.current.pay({ merchant: SHOP, bill: BILL, snapshot: SNAPSHOT });
    });
    expect(authBodies).toHaveLength(1);
    const sent = JSON.parse(authBodies[0]) as { intentSalt: string; validBefore: string | number; merchantValue: string; feeValue: string };
    expect(sent.intentSalt).toBe(randomHex32(0));
    expect(sent.intentSalt).not.toBe(billKeySalt(VALID_BK));
    const typed = w.signTypedData.mock.calls[0][0] as { message: { nonce: string; validBefore: bigint } };
    expect(typed.message.nonce).toBe(buildForwarderNonce({
      from: getAddress('0x0000000000000000000000000000000000000def'),
      merchant: SHOP,
      merchantValue: BILL,
      feeReceiver: getAddress(env.feeReceiver),
      feeValue: BigInt(sent.feeValue),
      validAfter: 0n,
      validBefore: typed.message.validBefore,
      intentSalt: randomHex32(0),
    }, 80002, FWD));
    // 端末に残す記録にも、署名にも、受け渡しの body にも bk の値は無い。
    const everything = [authBodies[0], window.localStorage.getItem(STORE_DEVICE_INTENT_KEY) ?? '', String(typed.message.nonce)];
    expect(everything[1]).toContain(HS);
    for (const text of everything) expect(text).not.toContain(VALID_BK);
    unmount();
  });
});
