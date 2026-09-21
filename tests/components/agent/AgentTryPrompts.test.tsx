import { useLayoutEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hydrateRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { track } from '@vercel/analytics';
import { AgentTryPrompts } from '@/components/agent/AgentTryPrompts';
import { COPIED_FEEDBACK_MS } from '@/hooks/useCopyToClipboard';
import { agentPageContentFor } from '@/lib/agentPage';

vi.mock('@vercel/analytics', () => ({ track: vi.fn() }));

beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe.each(['ja', 'en'])('AgentTryPrompts (%s)', (locale) => {
  const c = agentPageContentFor(locale).tryPrompts;

  it('shows the heading, lead and five selectable prompts with payment notes only on paid items', () => {
    render(<AgentTryPrompts locale={locale} c={c} />);
    expect(screen.getByRole('heading', { level: 2, name: c.title })).toBeVisible();
    expect(screen.getByText(c.lead)).toBeVisible();
    const items = within(screen.getByRole('list')).getAllByRole('listitem');
    expect(items).toHaveLength(5);
    for (const [index, item] of c.items.entries()) {
      const row = within(items[index]);
      expect(row.getByText(item.tag)).toBeVisible();
      const prompt = row.getByText(item.prompt);
      expect(prompt.tagName).toBe('P');
      expect(prompt.textContent).toBe(item.prompt);
      if (item.kind === 'paid') expect(row.getByText(c.paidNote)).toBeVisible();
      else expect(row.queryByText(c.paidNote)).toBeNull();
    }
    expect(screen.getAllByText(c.paidNote)).toHaveLength(c.items.filter((item) => item.kind === 'paid').length);
  });

  it('copies each exact prompt, changes only its button and tracks only its ID after success', async () => {
    const user = userEvent.setup();
    const write = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    render(<AgentTryPrompts locale={locale} c={c} />);
    const buttons = screen.getAllByRole('button', { name: c.copy });
    expect(buttons).toHaveLength(5);

    for (const [index, item] of c.items.entries()) {
      await user.click(buttons[index]);
      expect(write).toHaveBeenNthCalledWith(index + 1, item.prompt);
      expect(track).toHaveBeenNthCalledWith(index + 1, 'agent_try_prompt_copy', { locale, id: item.id });
      expect(screen.getAllByRole('button', { name: c.copied })).toEqual([buttons[index]]);
      expect(screen.getAllByRole('button', { name: c.copy })).toHaveLength(4);
    }
    expect(write).toHaveBeenCalledTimes(5);
    expect(track).toHaveBeenCalledTimes(5);
  });

  it('uses visible button names and distinct prompt descriptions without aria-label overrides', () => {
    userEvent.setup();
    const { container } = render(<AgentTryPrompts locale={locale} c={c} />);
    expect(container.querySelector('[aria-label]')).toBeNull();
    const buttons = screen.getAllByRole('button', { name: c.copy });
    expect(buttons).toHaveLength(5);
    for (const [index, item] of c.items.entries()) {
      expect(buttons[index]).toHaveAccessibleName(c.copy);
      expect(buttons[index]).toHaveAccessibleDescription(item.prompt);
      expect(document.getElementById(buttons[index].getAttribute('aria-describedby')!)?.textContent).toBe(item.prompt);
    }
    expect(new Set(buttons.map((button) => button.getAttribute('aria-describedby'))).size).toBe(5);
  });

  it.each([false, true])('matches SSR to the initial client render and then respects clipboard availability (%s)', async (hasClipboard) => {
    const descriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    const container = document.createElement('div');
    document.body.appendChild(container);
    let root: Root | undefined;
    try {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
      const html = renderToString(<AgentTryPrompts locale={locale} c={c} />);
      container.innerHTML = html;
      expect(within(container).getAllByRole('button', { name: c.copy })).toHaveLength(5);
      if (hasClipboard) Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) } });

      let initialClientHtml = '';
      function HydrationProbe() {
        // passive effect が clipboard の有無を反映する前の、client 初回 commit を観測する。
        useLayoutEffect(() => { initialClientHtml = container.innerHTML; }, []);
        return <AgentTryPrompts locale={locale} c={c} />;
      }
      const onRecoverableError = vi.fn();
      await act(async () => {
        root = hydrateRoot(container, <HydrationProbe />, { onRecoverableError });
      });
      expect(initialClientHtml).toBe(html);
      expect(onRecoverableError).not.toHaveBeenCalled();
      expect(within(container).queryAllByRole('button')).toHaveLength(hasClipboard ? 5 : 0);
      for (const item of c.items) expect(within(container).getByText(item.prompt).textContent).toBe(item.prompt);
    } finally {
      if (root) await act(async () => root?.unmount());
      container.remove();
      if (descriptor) Object.defineProperty(navigator, 'clipboard', descriptor);
      else Reflect.deleteProperty(navigator, 'clipboard');
    }
  });

  it('does not show success or track while a copy is pending or after it fails', async () => {
    const user = userEvent.setup();
    let rejectCopy!: (reason: Error) => void;
    vi.spyOn(navigator.clipboard, 'writeText').mockReturnValue(new Promise<void>((_, reject) => { rejectCopy = reject; }));
    render(<AgentTryPrompts locale={locale} c={c} />);
    await user.click(screen.getAllByRole('button', { name: c.copy })[0]);
    expect(track).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: c.copied })).toBeNull();
    await act(async () => { rejectCopy(new Error('clipboard denied')); });
    expect(track).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: c.copied })).toBeNull();
    expect(screen.getAllByRole('button', { name: c.copy })).toHaveLength(5);
  });

  it('keeps successful copy feedback when analytics throws', async () => {
    const user = userEvent.setup();
    const write = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    vi.mocked(track).mockImplementationOnce(() => { throw new Error('analytics unavailable'); });
    render(<AgentTryPrompts locale={locale} c={c} />);
    const button = screen.getAllByRole('button', { name: c.copy })[1];
    await user.click(button);
    expect(write).toHaveBeenCalledWith(c.items[1].prompt);
    expect(button).toHaveAccessibleName(c.copied);
    expect(button).toHaveAccessibleDescription(c.items[1].prompt);
  });

  it('clears copied feedback after the shared hook timeout', async () => {
    userEvent.setup();
    vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    vi.useFakeTimers();
    render(<AgentTryPrompts locale={locale} c={c} />);
    await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: c.copy })[0]); });
    expect(screen.getAllByRole('button', { name: c.copied })).toHaveLength(1);
    act(() => { vi.advanceTimersByTime(COPIED_FEEDBACK_MS); });
    expect(screen.queryByRole('button', { name: c.copied })).toBeNull();
    expect(screen.getAllByRole('button', { name: c.copy })).toHaveLength(5);
  });
});
