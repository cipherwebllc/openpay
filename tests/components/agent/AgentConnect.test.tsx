import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { track } from '@vercel/analytics';
import { AgentConnect } from '@/components/agent/AgentConnect';
import { buildSetupPrompt } from '@/lib/agentSetup';
import { agentPageContentFor } from '@/lib/agentPage';

const C = agentPageContentFor('en').connect;
vi.mock('@vercel/analytics', () => ({ track: vi.fn() }));

beforeEach(() => vi.clearAllMocks());
describe('AgentConnect', () => {
  it.each(['ja', 'en'])('expands and collapses the prompt with an accessible toggle in %s', async (locale) => {
    const user = userEvent.setup();
    const c = agentPageContentFor(locale).connect;
    const { container } = render(<AgentConnect locale={locale} c={c} />);
    const toggle = screen.getByRole('button', { name: c.promptExpand });
    expect(toggle).toHaveAttribute('aria-controls', 'agent-setup-prompt');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(container.querySelector('#agent-connect')).toBeVisible();
    await user.click(toggle);
    expect(screen.getByRole('button', { name: c.promptCollapse })).toHaveAttribute('aria-expanded', 'true');
    expect(container.querySelector('pre')).not.toHaveClass('max-h-40');
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(container.querySelector('pre')?.textContent).toBe(buildSetupPrompt(locale));
  });
  it('shows the prompt and non-link host chips; tracks successful copy only', async () => {
    const user = userEvent.setup();
    const write = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    const { container } = render(<AgentConnect locale="en" c={C} />);
    expect(container.querySelector('pre')?.textContent).toBe(buildSetupPrompt('en'));
    expect(screen.getByText('Claude Code').closest('a')).toBeNull();
    expect(screen.getByRole('link', { name: /setup\.md/ })).toHaveAttribute('href', '/agent/setup.md');
    expect(screen.getByRole('button', { name: C.promptExpand })).toHaveAttribute('aria-expanded', 'false');
    expect(container.querySelector('pre')).toHaveClass('max-h-40');
    await user.click(screen.getByRole('button', { name: 'Copy setup prompt' }));
    expect(write).toHaveBeenCalledWith(buildSetupPrompt('en'));
    expect(track).toHaveBeenCalledWith('agent_prompt_copy', { locale: 'en' });
    write.mockRestore();
  });
  it('does not track a failed copy', async () => {
    const user = userEvent.setup();
    const write = vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'));
    render(<AgentConnect locale="en" c={C} />);
    await user.click(screen.getByRole('button', { name: C.copy }));
    expect(track).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: C.copy })).toBeInTheDocument();
    write.mockRestore();
  });
  it('keeps a selectable prompt without a clipboard button', () => {
    const descriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    try {
      const { container } = render(<AgentConnect locale="en" c={C} />);
      expect(screen.queryByRole('button')).toBeNull();
      expect(container.querySelector('pre')?.textContent).toBe(buildSetupPrompt('en'));
      expect(container.querySelector('pre')).not.toHaveClass('max-h-40', 'overflow-hidden');
    } finally {
      if (descriptor) Object.defineProperty(navigator, 'clipboard', descriptor);
      else Reflect.deleteProperty(navigator, 'clipboard');
    }
  });
  it('isolates analytics failures from successful copy', async () => {
    const user = userEvent.setup();
    vi.mocked(track).mockImplementationOnce(() => { throw new Error('analytics unavailable'); });
    render(<AgentConnect locale="en" c={C} />);
    await user.click(screen.getByRole('button', { name: C.copy }));
    expect(screen.getByRole('button', { name: C.copied })).toBeInTheDocument();
  });
  it('offers desktop-app deep links that carry the whole prompt and track only the app name', async () => {
    render(<AgentConnect locale="en" c={C} />);
    const prompt = buildSetupPrompt('en');
    const claude = screen.getByRole('link', { name: 'Claude' });
    const codex = screen.getByRole('link', { name: 'Codex' });
    expect(claude).toHaveAttribute('href', `claude://code/new?q=${encodeURIComponent(prompt)}`);
    expect(codex).toHaveAttribute('href', `codex://threads/new?prompt=${encodeURIComponent(prompt)}`);
    // Web チャットへの deep link は作らない (シェルが無く setup を実行できない)。
    expect(document.querySelector('a[href*="claude.ai"], a[href*="chatgpt.com"]')).toBeNull();
    claude.addEventListener('click', (event) => event.preventDefault());
    await userEvent.click(claude);
    expect(track).toHaveBeenCalledWith('agent_open_in', { locale: 'en', app: 'claude' });
  });
});
