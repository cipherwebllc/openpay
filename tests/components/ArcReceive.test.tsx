import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, renderHook } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithIntl as render } from '../_helpers/i18n';

const flags = vi.hoisted(() => ({ arc: true, tip: false, xchain: false }));
vi.mock('@/components/TipForm', () => ({ TipForm: ({ params }: { params: unknown }) => <div data-testid="tip-preview">{JSON.stringify(params)}</div> }));
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return { ...actual, isArcTipEnabled: () => flags.arc && flags.tip, isArcCrossChainEnabled: () => flags.arc && flags.xchain, env: { ...actual.env, get enableUsdcArc() { return flags.arc; }, get enableUsdcArcTip() { return flags.tip; }, get enableUsdcArcCrossChain() { return flags.xchain; } } };
});
vi.mock('@/hooks/useResolveAddress', () => ({
  useResolveAddress: () => ({ data: null, isFetching: false, error: null }),
}));
vi.mock('wagmi', () => ({
  useAccount: () => ({ address: undefined, isConnected: false }),
  useReadContract: () => ({ data: undefined }),
}));
vi.mock('@/hooks/useOrigin', () => ({ useOrigin: () => 'https://test.local' }));
vi.mock('@/hooks/useMarketRates', () => ({
  useMarketRates: () => ({ data: { usdcJpy: 150 }, isLoading: false, isError: false, refetch: vi.fn() }),
}));

import { QrGenerator } from '@/components/QrGenerator';
import { USDC_CHAINS } from '@/lib/chains';

const receiver = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
beforeEach(() => { window.localStorage.clear(); flags.arc = true; flags.tip = false; flags.xchain = false; });

describe('Arc receive UI with flag ON', () => {
  it('QR lists seven chains and corrects gasless when Arc is selected', async () => {
    window.localStorage.setItem('openpay:qr-settings:v2', JSON.stringify({
      receiver, token: 'usdc', chain: 'base', payMode: 'gasless',
    }));
    render(<QrGenerator />);
    expect(USDC_CHAINS).toHaveLength(7);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /^Arc Testnet/ }));
    await waitFor(() => {
      const saved = JSON.parse(window.localStorage.getItem('openpay:qr-settings:v2')!);
      expect(saved).toMatchObject({ chain: 'arc', payMode: 'standard', crossChain: false });
    });
    await user.click(screen.getByRole('button', { name: /高度な設定/ }));
    expect(screen.getByRole('button', { name: /^ガス代不要/ })).toBeDisabled();
  });

  it('QR preserves Arc standard mode, removes cross-chain offer, and uses USDC gas copy', async () => {
    window.localStorage.setItem('openpay:qr-settings:v2', JSON.stringify({
      receiver, token: 'usdc', chain: 'arc', payMode: 'gasless', crossChain: true,
    }));
    render(<QrGenerator />);
    await waitFor(() => {
      const saved = JSON.parse(window.localStorage.getItem('openpay:qr-settings:v2')!);
      expect(saved).toMatchObject({ chain: 'arc', payMode: 'standard', crossChain: false });
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /高度な設定/ }));
    expect(screen.getByRole('button', { name: /^ガス代不要/ })).toBeDisabled();
    expect(screen.getAllByText(/ガスは USDC で支払われるため別トークン不要/).length).toBeGreaterThan(0);
    expect(screen.queryByRole('checkbox', { name: /別チェーン/ })).not.toBeInTheDocument();
  });
});


describe('Arc tip four-combination matrix', () => {
  it.each([[false, false], [false, true], [true, false], [true, true]])('arc=%s tip=%s: URL, saved settings, preview, publish validation and OG agree', async (arc, tip) => {
    flags.arc = arc; flags.tip = tip;
    const enabled = arc && tip;
    const { parseTipParams, resolveTipCapability } = await import('@/lib/url/tip');
    const { useTipSettings } = await import('@/hooks/useTipSettings');
    const { TipEmbedGenerator } = await import('@/components/TipEmbedGenerator');
    const { buildTipOgModel, buildTipOgImageUrl } = await import('@/lib/ogTipCard');
    const { buildPublishPayload } = await import('@/lib/handlePublish');
    const { DEFAULT_PROFILE_DRAFT } = await import('@/hooks/useHandleProfileDraft');
    const { validateHandleTipConfig } = await import('@/lib/handle');
    expect(resolveTipCapability('usdc', 'arc').ok).toBe(enabled);
    expect(resolveTipCapability('jpyc', 'base')).toEqual({ ok: false, reason: 'unsupported-pair' });
    const parsed = parseTipParams(receiver, new URLSearchParams('token=usdc&chain=arc&preset=0.5&crossChain=true'));
    expect(parsed.ok).toBe(enabled);
    if (parsed.ok) expect(parsed.params).toMatchObject({ mode: 'standard', crossChain: false, presets: ['0.5'] });
    window.localStorage.setItem('openpay:tip-settings:v2', JSON.stringify({ receiver, token: 'usdc', chain: 'arc', crossChain: true }));
    const hook = renderHook(() => useTipSettings());
    await waitFor(() => expect(hook.result.current.hydrated).toBe(true));
    expect(hook.result.current.settings.chain).toBe(enabled ? 'arc' : 'base');
    hook.unmount();
    render(<TipEmbedGenerator />);
    await waitFor(() => expect(JSON.parse(screen.getByTestId('tip-preview').textContent!).chain).toBe(enabled ? 'arc' : 'base'));
    const preview = JSON.parse(screen.getByTestId('tip-preview').textContent!);
    expect(preview.mode).toBe(enabled ? 'standard' : 'gasless');
    if (enabled) expect(preview.crossChain).toBe(false);
    const payload = buildPublishPayload({ ...DEFAULT_PROFILE_DRAFT, to: receiver, jpycPolygon: false, jpycKaia: false, usdcArc: true }, { receiver, enableJpycAvalanche: false, arcTip: enabled });
    // Disabled published Arc is retained in draft payload, but rejected for payment/publication.
    expect(payload?.config.methods).toEqual([{ token: 'usdc', chain: 'arc', crossChain: false }]);
    expect(validateHandleTipConfig(payload?.config).ok).toBe(enabled);
    const og = buildTipOgModel(new URL(buildTipOgImageUrl(receiver, { token: 'usdc', chain: 'arc' }, 'ja'), 'https://test.local').searchParams);
    expect(og.sub).not.toContain('ガス不要');
    expect(og.sub.includes('ガスも USDC')).toBe(enabled);
  });
});

// #508 点灯後: Arc チップも cross-chain flag に連動して他チェーン → Arc の forwarding を受ける
// (URL parser・URL builder・@handle 公開 payload が同じ述語 crossChainAllowed を見る)。
it('Arc tip cross-chain follows NEXT_PUBLIC_ENABLE_USDC_ARC_CROSSCHAIN: ON → crossChain true everywhere', async () => {
  flags.tip = true; flags.xchain = true;
  const { parseTipParams, buildTipPath } = await import('@/lib/url/tip');
  const { buildPublishPayload } = await import('@/lib/handlePublish');
  const { DEFAULT_PROFILE_DRAFT } = await import('@/hooks/useHandleProfileDraft');
  const parsed = parseTipParams(receiver, new URLSearchParams('token=usdc&chain=arc&preset=0.5'));
  expect(parsed.ok && parsed.params).toMatchObject({ mode: 'standard', crossChain: true });
  expect(buildTipPath({ to: receiver, token: 'usdc', chain: 'arc', presets: ['0.5'], crossChain: true })).not.toContain('crossChain=false');
  const payload = buildPublishPayload({ ...DEFAULT_PROFILE_DRAFT, to: receiver, jpycPolygon: false, jpycKaia: false, usdcArc: true }, { receiver, enableJpycAvalanche: false, arcTip: true });
  expect(payload?.config.methods).toEqual([{ token: 'usdc', chain: 'arc', crossChain: true }]);
  flags.xchain = false;
  const off = parseTipParams(receiver, new URLSearchParams('token=usdc&chain=arc&preset=0.5'));
  expect(off.ok && off.params.crossChain).toBe(false);
});
