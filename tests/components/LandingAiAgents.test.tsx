import { createTranslator } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import ja from '../../messages/ja.json';
import { LandingAiAgents } from '@/components/LandingAiAgents';

vi.mock('next-intl/server', () => ({
  getLocale: async () => 'ja',
  getTranslations: async () => createTranslator({ locale: 'ja', messages: ja, namespace: 'Landing' }),
}));
vi.mock('@/lib/env', () => ({ env: {} }));

describe('LandingAiAgents', () => {
  it('QR 決済から AI が支払うまでを OpenPay の範囲として 1 つにまとめる (AI だけを OpenPay に見せない)', async () => {
    render(await LandingAiAgents());
    const items = within(screen.getByRole('list')).getAllByRole('listitem');
    const now = ja.Landing.aiEraNow;
    expect(items.map((item) => item.textContent?.replace(now, '').trim())).toEqual(['現金', 'カード', 'QR決済', 'AIが支払う']);
    // 読み上げでは、OpenPay の 2 マスだけに「OpenPay はここ」が付く。
    expect(items.map((item) => item.textContent?.includes(now))).toEqual([false, false, true, true]);
    // 枠とラベルは 1 つだけ。見た目の重ね描きなので読み上げない。
    const overlays = [...document.querySelectorAll('div[aria-hidden]')].filter((el) => el.textContent === now);
    expect(overlays).toHaveLength(1);
    // 行の高さをそろえる (囲みが「下半分」「右半分」と一致する前提)。
    expect(screen.getByRole('list')).toHaveClass('auto-rows-fr');
  });
});
