import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { getAddress, type Hex } from 'viem';

// 第 9 回レビュー E-8 (Codex MUST 3): 印の部品 (lib/storeDeviceSend の動的 import) そのものを読み込めないと、保存の中の
// 送った印 (未解決の送信がありうる) を確かめられない。「送っていない」と言わず (例外時)・「確かめている間」を外すだけに
// せず (起動時)、店員が入金の記録を確かめて閉じるまで次の決済を止める (一時的な失敗なので、閉じれば外れる)。
// 動的 import を失敗させるため、この file では module の mock 自体が throw する (全ての import が失敗する)。
vi.mock('@/lib/storeDeviceSend', () => {
  throw new Error('Failed to fetch dynamically imported module');
});
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: { ...actual.env, networkEnv: 'testnet', feeReceiver: '0x428483FbA62eDCef1E3a100d3799F6d71759c560' },
  };
});
vi.mock('@/lib/relay/forwarderConfig', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/relay/forwarderConfig')>()),
  jpycForwarderFor: (chainId: number) => (chainId === 80002 ? '0x752B7AaD0089286EB7b553d84D05233d80c9FCB4' : null),
}));

import { useStoreDeviceRegister, type StoreDeviceRegisterInput } from '@/hooks/useStoreDeviceRegister';

const SHOP = getAddress('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
const input: StoreDeviceRegisterInput = {
  enabled: true,
  gasAddress: getAddress('0x0000000000000000000000000000000000000abc'),
};
const AMOUNT = 1000n * 10n ** 18n;
const ID = 'AbCdEfGhIjKlMnOpQrStUv';
const AUTH = {
  from: '0x0000000000000000000000000000000000000def',
  merchantValue: AMOUNT.toString(),
  feeValue: '1',
  validAfter: '0',
  validBefore: '9999999999',
  intentSalt: `0x${'11'.repeat(32)}`,
  signature: `0x${'1b'.repeat(65)}`,
  nonce: `0x${'33'.repeat(32)}` as Hex,
};
const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
const nowSec = () => Math.floor(Date.now() / 1000);
let readRes: () => Promise<Response>;

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false });
  vi.setSystemTime(new Date('2026-10-07T03:00:00Z'));
  window.sessionStorage.clear();
  readRes = () => json({ ok: true, state: 'open', merchant: SHOP, amount: AMOUNT.toString(), auth: null });
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    if (url === '/api/register/handoff') return json({ ok: true, id: ID, token: 'ab'.repeat(32), expiresAt: nowSec() + 600 });
    if (url.endsWith('/close')) return json({ ok: true, closed: true });
    return readRes();
  }));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe('印の部品を読み込めないとき (第 9 回レビュー E-8)', () => {
  it('起動時: 前回の送信を確かめられないので、店員が閉じるまで次の QR も通常の QR も止める (閉じれば外れる)', async () => {
    const { result } = renderHook(() => useStoreDeviceRegister(input));
    await advance(0);
    expect(result.current.state).toEqual({ phase: 'marks_unreadable' });
    expect(result.current.busy).toBe(true);
    let normal!: boolean;
    await act(async () => {
      normal = await result.current.releaseForNormal();
    });
    expect(normal).toBe(false);
    act(() => result.current.dismiss());
    expect(result.current.state).toEqual({ phase: 'idle' });
    expect(result.current.busy).toBe(false);
    await act(async () => {
      normal = await result.current.releaseForNormal();
    });
    expect(normal).toBe(true);
  });

  it('例外時: 送信の部品も印の部品も読み込めないときは「送っていない」と言わず、次の決済を止める', async () => {
    // 起動時の確認を回さない (monitor: false) で、署名を受け取ってから読み込みに失敗させる
    const { result } = renderHook(() => useStoreDeviceRegister({ ...input, monitor: false }));
    let session: unknown;
    await act(async () => {
      session = await result.current.start(SHOP, AMOUNT, 80002);
    });
    expect(session).toMatchObject({ id: ID });
    readRes = () => json({ ok: true, state: 'signed', merchant: SHOP, amount: AMOUNT.toString(), auth: AUTH });
    await advance(3_000);
    expect(result.current.state).toEqual({ phase: 'marks_unreadable' });
    expect(result.current.busy).toBe(true);
    let normal!: boolean;
    await act(async () => {
      normal = await result.current.releaseForNormal();
    });
    expect(normal).toBe(false);
  });
});
