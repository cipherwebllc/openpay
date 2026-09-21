import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { track } from '@vercel/analytics';
import { AgentConfigGenerator } from '@/components/agent/AgentConfigGenerator';
import { agentPageContentFor } from '@/lib/agentPage';

const C = agentPageContentFor('en').generator;
vi.mock('@vercel/analytics', () => ({ track: vi.fn() }));
beforeEach(() => vi.clearAllMocks());

describe('AgentConfigGenerator', () => {
  it.each(['ja', 'en'])('starts closed and preserves inputs and output after toggling in %s', async (locale) => {
    const user = userEvent.setup();
    const c = agentPageContentFor(locale).generator;
    const { container } = render(<AgentConfigGenerator locale={locale} c={c} />);
    const details = container.querySelector('details');
    const summary = screen.getByText(c.title);
    const limit = screen.getByLabelText(c.fields.maxPerCallJpyc.label);
    expect(details).not.toHaveAttribute('open');
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
    const { container } = render(<AgentConfigGenerator locale="en" c={C} />);
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
    const { container } = render(<AgentConfigGenerator locale="en" c={C} />);
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
    render(<AgentConfigGenerator locale="en" c={C} />);
    fireEvent.click(screen.getByText(C.title));
    await user.selectOptions(screen.getByLabelText('Environment'), 'claude-desktop');
    await user.click(screen.getByRole('button', { name: 'Copy config' }));
    expect(track).toHaveBeenLastCalledWith('agent_config_copy', { locale: 'en', client: 'claude-desktop', mode: 'agent-pays' });
    expect(JSON.parse(await navigator.clipboard.readText()).mcpServers['openpay-x402'].env.MAX_PER_CALL_JPYC).toBe('10');
  });
});
