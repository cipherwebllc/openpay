import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { useEffect, useRef, useState } from 'react';

// useStoreDeviceRegister を「描画ごとに同じ id を返す状態」に置き換え、どの実体 (Provider か部品か) を使っているかを見る。
const seen = vi.hoisted(() => ({ ids: [] as string[], enabledIds: new Set<string>() }));
let seq = 0;
vi.mock('@/hooks/useStoreDeviceRegister', () => ({
  useStoreDeviceToggle: () => [true, () => undefined],
  useStoreDeviceRegister: (input: { enabled: boolean }) => {
    const id = useRef(`i${++seq}`).current;
    if (input.enabled) seen.enabledIds.add(id);
    return { id, state: { phase: 'idle' }, busy: false } as unknown as ReturnType<
      typeof import('@/hooks/useStoreDeviceRegister').useStoreDeviceRegister
    >;
  },
}));
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return { ...actual, env: { ...actual.env, enableStoreGasWallet: true, feeReceiver: '0x428483FbA62eDCef1E3a100d3799F6d71759c560' } };
});
vi.mock('@/lib/relay/forwarderConfig', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/relay/forwarderConfig')>()),
  jpycForwarderFor: () => '0x752B7AaD0089286EB7b553d84D05233d80c9FCB4',
}));

import { StoreDeviceProvider, useStoreDeviceMode } from '@/components/StoreDeviceProvider';

function Consumer({ label }: { label: string }) {
  const mode = useStoreDeviceMode();
  // ガス用ウォレットがある (パネルが知らせる) 状態にする
  useEffect(() => {
    mode.setGasAddress('0x0000000000000000000000000000000000000abc');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  seen.ids.push((mode.device as unknown as { id: string }).id);
  return <p>{`${label}:${(mode.device as unknown as { id: string }).id}:${String(mode.enabled)}`}</p>;
}

function Tabs() {
  const [tab, setTab] = useState<'register' | 'qr'>('register');
  return (
    <>
      <button type="button" onClick={() => setTab(tab === 'register' ? 'qr' : 'register')}>switch</button>
      {tab === 'register' ? <Consumer label="register" /> : <Consumer label="qr" />}
    </>
  );
}

describe('StoreDeviceProvider (お店の端末で送るの状態を作成ページの両タブの外に 1 つ)', () => {
  beforeEach(() => {
    seen.ids.length = 0;
    seen.enabledIds.clear();
    Object.defineProperty(window.navigator, 'locks', { value: { request: vi.fn() }, configurable: true });
  });

  it('タブを切り替えて部品が外れても、同じ実体 (送信・結果・「次の QR を出せない間」) を使い続ける', async () => {
    render(
      <StoreDeviceProvider>
        <Tabs />
      </StoreDeviceProvider>,
    );
    const first = (await screen.findByText(/^register:/)).textContent!.split(':')[1];
    await act(async () => {
      screen.getByRole('button', { name: 'switch' }).click();
    });
    const second = (await screen.findByText(/^qr:/)).textContent!.split(':')[1];
    expect(second).toBe(first);
    // 動いている (enabled) 実体は Provider の 1 つだけ (部品側の実体は動かない)
    expect(screen.getByText(/^qr:/).textContent).toMatch(/:true$/);
    expect(seen.enabledIds.size).toBe(1);
    expect([...seen.enabledIds][0]).toBe(first);
  });

  it('Provider の外 (単独の描画) では、部品が自分の実体で動く (今までと同じ)', async () => {
    render(<Consumer label="alone" />);
    expect(await screen.findByText(/^alone:.*:true$/)).toBeTruthy();
  });
});
