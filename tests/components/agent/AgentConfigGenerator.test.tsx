import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { track } from '@vercel/analytics';
import { NextIntlClientProvider } from 'next-intl';
import { AgentConfigGenerator } from '@/components/agent/AgentConfigGenerator';
import { agentPageContentFor } from '@/lib/agentPage';
import ja from '@/messages/ja.json';
import en from '@/messages/en.json';

const C = agentPageContentFor('en').generator;
vi.mock('@vercel/analytics', () => ({ track: vi.fn() }));
beforeEach(() => vi.clearAllMocks());

function renderGenerator(locale = 'en') {
  return render(
    <NextIntlClientProvider locale={locale} messages={locale === 'ja' ? ja : en}>
      <AgentConfigGenerator locale={locale} c={agentPageContentFor(locale).generator} />
    </NextIntlClientProvider>,
  );
}

describe('AgentConfigGenerator', () => {
  it.each(['ja', 'en'])('starts closed and preserves inputs and output after toggling in %s', async (locale) => {
    const user = userEvent.setup();
    const c = agentPageContentFor(locale).generator;
    const { container } = renderGenerator(locale);
    const details = container.querySelector('details');
    const summary = screen.getByText(c.title);
    const limit = screen.getByLabelText(c.fields.maxPerCallJpyc.label);
    expect(details).not.toHaveAttribute('open');
    // 畳んでも見出し (h2) はアウトラインに残す (summary の中の見出し 1 つは HTML 仕様で許される)。
    expect(details?.querySelector('summary h2')).toHaveTextContent(agentPageContentFor(locale).generator.title);
    expect(limit).not.toBeVisible();
    await user.click(summary);
    fireEvent.change(limit, { target: { value: '25' } });
    await user.selectOptions(screen.getByLabelText(c.clientLabel), 'claude-desktop');
    const output = container.querySelector('pre')?.textContent;
    await user.click(summary);
    expect(limit).not.toBeVisible();
    await user.click(summary);
    expect(limit).toBeVisible();
    expect(limit).toHaveValue('25');
    expect(screen.getByLabelText(c.clientLabel)).toHaveValue('claude-desktop');
    expect(container.querySelector('pre')?.textContent).toBe(output);
    expect(screen.getByText(c.keyNote)).toBeVisible();
    expect(screen.getByText(c.feeNote)).toBeVisible();
  });
  it('hides invalid output, links errors, and records only the first change', () => {
    const { container } = renderGenerator();
    fireEvent.click(screen.getByText(C.title));
    expect(container.querySelector('pre')).not.toBeNull();
    expect(track).not.toHaveBeenCalled();
    const limit = screen.getByLabelText('Per-call limit (JPYC)');
    fireEvent.change(limit, { target: { value: '0' } });
    expect(container.querySelector('pre')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Copy config' })).toBeNull();
    expect(limit).toHaveAttribute('aria-invalid', 'true');
    expect(limit).toHaveAccessibleDescription(/Check this value/);
    fireEvent.change(limit, { target: { value: '20' } });
    expect(container.querySelector('pre')).not.toBeNull();
    expect(track).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledWith('agent_config_generate', { locale: 'en', client: 'claude-code', mode: 'agent-pays' });
  });
  it('human-pays ignores hidden invalid limits and emits no env', () => {
    const { container } = renderGenerator();
    fireEvent.click(screen.getByText(C.title));
    fireEvent.change(screen.getByLabelText('Per-call limit (JPYC)'), { target: { value: '0' } });
    fireEvent.change(screen.getByLabelText('Mode'), { target: { value: 'human-pays' } });
    expect(screen.queryByLabelText('Per-call limit (JPYC)')).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(container.querySelector('pre')?.textContent).toContain('openpay-order-mcp');
    expect(container.querySelector('pre')?.textContent).not.toMatch(/env|MAX_|PRIVATE_KEY/);
    fireEvent.change(screen.getByLabelText('Mode'), { target: { value: 'agent-pays' } });
    expect(container.querySelector('pre')).toBeNull();
  });
  it('copies JSON and sends only locale/client/mode', async () => {
    const user = userEvent.setup();
    renderGenerator();
    fireEvent.click(screen.getByText(C.title));
    await user.selectOptions(screen.getByLabelText('Environment'), 'claude-desktop');
    await user.click(screen.getByRole('button', { name: 'Copy config' }));
    expect(track).toHaveBeenLastCalledWith('agent_config_copy', { locale: 'en', client: 'claude-desktop', mode: 'agent-pays' });
    expect(JSON.parse(await navigator.clipboard.readText()).mcpServers['openpay-x402'].env.MAX_PER_CALL_JPYC).toBe('10');
  });
  it.each(['ja', 'en'])('shows Kova fields and disclosures only in Kova mode in %s, and hides invalid output', async (locale) => {
    const user = userEvent.setup();
    const { container } = renderGenerator(locale);
    const c = agentPageContentFor(locale).generator;
    const t = (locale === 'ja' ? ja : en).AgentConfigGenerator;
    await user.click(screen.getByText(c.title));
    const mode = screen.getByLabelText(c.modeLabel);
    expect(Array.from(mode.querySelectorAll('option')).map((option) => [option.value, option.textContent])).toEqual([
      ['human-pays', t.modeOptions['human-pays']],
      ['agent-pays', t.modeOptions['agent-pays']],
      ['agent-pays-kova', t.modeOptions['agent-pays-kova']],
    ]);
    expect(screen.queryByLabelText(t.kovaWallet.label)).toBeNull();
    expect(screen.queryByText(t.policyNote)).toBeNull();
    await user.selectOptions(mode, 'agent-pays-kova');
    const wallet = screen.getByLabelText(t.kovaWallet.label);
    const address = screen.getByLabelText(t.kovaAgentAddress.label);
    expect(wallet).toBeVisible();
    expect(address).toBeVisible();
    expect(address).toHaveAttribute('inputmode', 'text');
    expect(wallet).toHaveAttribute('aria-invalid', 'true');
    expect(container.querySelector('pre')).toBeNull();
    for (const field of Object.values(c.fields)) expect(screen.getByLabelText(field.label)).toBeVisible();
    expect(screen.getByRole('checkbox')).toBeVisible();
    for (const note of [t.providerNote, t.policyNote, t.balanceNote]) expect(screen.getByText(note)).toBeVisible();
    expect(screen.queryByText(c.keyNote)).toBeNull();
    expect(screen.queryByText(c.feeNote)).toBeNull();
    fireEvent.change(wallet, { target: { value: 'my-wallet' } });
    fireEvent.change(address, { target: { value: '0x1234' } });
    expect(address).toHaveAttribute('aria-invalid', 'true');
    expect(address).toHaveAccessibleDescription(`${t.kovaAgentAddress.hint} ${c.invalid}`);
    expect(container.querySelector('pre')).toBeNull();
    expect(screen.queryByRole('button', { name: c.copy })).toBeNull();
    fireEvent.change(address, { target: { value: '0x52908400098527886E0F7030069857D2E4169EE7' } });
    expect(address).toHaveAttribute('aria-invalid', 'false');
    expect(container.querySelector('pre')?.textContent).toContain('SIGNER_MODE=kova');
    await user.click(screen.getByRole('button', { name: c.copy }));
    const output = await navigator.clipboard.readText();
    expect(output).toContain('KOVA_WALLET=my-wallet');
    expect(output).toContain('KOVA_AGENT_ADDRESS=0x52908400098527886E0F7030069857D2E4169EE7');
    expect(output).not.toMatch(/BUYER_PRIVATE_KEY|KOVA_CREDENTIAL/);
    expect(track).toHaveBeenLastCalledWith('agent_config_copy', { locale, client: 'claude-code', mode: 'agent-pays-kova' });
    fireEvent.change(address, { target: { value: 'invalid' } });
    await user.selectOptions(mode, 'human-pays');
    expect(screen.queryByLabelText(t.kovaWallet.label)).toBeNull();
    expect(container.querySelector('pre')?.textContent).toContain('openpay-order-mcp');
    expect(container.querySelector('pre')?.textContent).not.toMatch(/SIGNER_MODE|KOVA_/);
    await user.selectOptions(mode, 'agent-pays');
    expect(screen.queryByLabelText(t.kovaAgentAddress.label)).toBeNull();
    expect(screen.queryByText(t.providerNote)).toBeNull();
    expect(container.querySelector('pre')?.textContent).toContain('SIGNER_MODE=keystore');
    expect(screen.getByText(c.keyNote)).toBeVisible();
    expect(screen.getByText(c.feeNote)).toBeVisible();
  });
});
