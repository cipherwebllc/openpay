import { createTranslator } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import ja from '../../messages/ja.json';
import { LandingAiAgents } from '@/components/LandingAiAgents';

vi.mock('next-intl/server', () => ({
  getLocale: async () => 'ja',
  getTranslations: async () => createTranslator({ locale: 'ja', messages: ja, namespace: 'Landing' }),
}));
vi.mock('@/lib/env', () => ({ env: {} }));

describe('LandingAiAgents', () => {
  it('宛名は AI・開発者向け。決済の変遷の図は出さず、主導線 (Agent) と補助の入口だけを出す', async () => {
    render(await LandingAiAgents());
    expect(screen.getByText(ja.Landing.eyebrowAgent)).toBeInTheDocument();
    // 図 (現金 → カード → QR → AI のリスト) は外した (2026-10-25 引き算)。
    expect(screen.queryByRole('list')).toBeNull();
    expect(screen.getByRole('link', { name: ja.Landing.aiEraCtaAgent })).toHaveAttribute('href', '/ja/agent');
    expect(screen.getByRole('link', { name: ja.Landing.aiEraCtaPay })).toHaveAttribute('href', '/ja/guide/ai-pay');
    expect(screen.getByRole('link', { name: ja.Landing.aiEraCtaSell })).toHaveAttribute('href', '/ja/guide/sell');
  });
});
