import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { track } from '@vercel/analytics';
import { AgentStoreLink } from '@/components/agent/AgentStoreLink';

vi.mock('@vercel/analytics', () => ({ track: vi.fn() }));

describe('AgentStoreLink', () => {
  it('links to the AI Store and records the click without any wallet data', () => {
    render(<AgentStoreLink locale="ja">AI ストアを開く</AgentStoreLink>);
    const link = screen.getByRole('link', { name: 'AI ストアを開く' });
    expect(link).toHaveAttribute('href', '/ja/discovery');
    // jsdom は遷移を実装していないので既定動作だけ止める (onClick の計測は走る)。
    link.addEventListener('click', (event) => event.preventDefault());
    fireEvent.click(link);
    expect(track).toHaveBeenCalledWith('agent_store_click', { locale: 'ja' });
  });
});
