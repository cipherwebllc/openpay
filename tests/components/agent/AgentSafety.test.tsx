import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AgentSafety } from '@/components/agent/AgentSafety';
import { agentPageContentFor } from '@/lib/agentPage';

describe('AgentSafety', () => {
  it.each(['ja', 'en'])('shows the summary and badge while retaining the full disclosure in %s', async (locale) => {
    const user = userEvent.setup();
    const c = agentPageContentFor(locale).safety;
    const { container } = render(<AgentSafety c={c} />);
    expect(screen.getByText(c.enforcedBadge)).toBeVisible();
    for (const point of c.summary) expect(screen.getByText(point)).toBeVisible();
    expect(container.querySelector('details')).not.toHaveAttribute('open');
    for (const text of [c.body, ...c.points]) expect(screen.getByText(text)).not.toBeVisible();
    await user.click(screen.getByText(c.detailsLabel));
    for (const text of [c.body, ...c.points]) expect(screen.getByText(text)).toBeVisible();
  });
});
