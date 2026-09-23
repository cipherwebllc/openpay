import { StrictMode, useState, type ReactNode } from 'react';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useFxConvert } from '@/hooks/useFxConvert';
import { useQrSettings } from '@/hooks/useQrSettings';

const KEY = 'openpay:qr-settings:v2';
const marketRates = { usdcJpy: 150, updatedAt: '2026-06-03T00:00:00.000Z' };

function useSettingsWithConversion() {
  const saved = useQrSettings();
  const [amount, setAmount] = useState('1000');
  return useFxConvert({
    settings: saved.settings, setSettings: saved.setSettings,
    amount, setAmount, marketRates,
  });
}

function mount() {
  return renderHook(useSettingsWithConversion, {
    wrapper: ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>,
  });
}

beforeEach(() => localStorage.clear());

describe('D7 review: settings setter semantics', () => {
  it('composes batched functional updates without persisting the converted selection', () => {
    const { result } = mount();
    act(() => result.current.applyConvert());
    expect(result.current.settings.token).toBe('usdc');
    act(() => {
      result.current.setSettings((s) => ({ ...s, storeName: s.storeName + 'A', chain: 'base' }));
      result.current.setSettings((s) => ({ ...s, storeName: s.storeName + 'B', memo: s.chain }));
    });
    expect(result.current.settings).toMatchObject({ storeName: 'AB', memo: 'base', chain: 'base', token: 'usdc' });
    expect(JSON.parse(localStorage.getItem(KEY)!)).toMatchObject({
      storeName: 'AB', memo: 'base', chain: 'polygon', token: 'jpyc', payMode: 'gasless',
    });
  });

  it('keeps setter identity stable across edits, conversion and revert', () => {
    const { result } = mount();
    const setter = result.current.setSettings;
    act(() => setter((s) => ({ ...s, storeName: 'Shop' })));
    expect(result.current.setSettings).toBe(setter);
    act(() => result.current.applyConvert());
    expect(result.current.setSettings).toBe(setter);
    act(() => setter((s) => ({ ...s, memo: 'Coffee' })));
    expect(result.current.setSettings).toBe(setter);
    act(() => result.current.revertConvert());
    expect(result.current.setSettings).toBe(setter);
    expect(result.current.settings).toMatchObject({ token: 'jpyc', storeName: 'Shop', memo: 'Coffee' });
  });
});
