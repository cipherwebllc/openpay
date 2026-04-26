import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithIntl } from '../_helpers/i18n';

const replace = vi.fn();
const pathname = vi.fn<() => string>();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace }),
  usePathname: () => pathname(),
}));

import { LocaleSwitcher } from '@/components/LocaleSwitcher';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('LocaleSwitcher', () => {
  it('LOCALES の各ボタンを描画 (日本語 / English)', () => {
    pathname.mockReturnValue('/ja');
    renderWithIntl(<LocaleSwitcher />);
    expect(screen.getByRole('button', { name: /日本語/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /English/ })).toBeInTheDocument();
  });

  it('現在の locale ボタンに aria-pressed=true', () => {
    pathname.mockReturnValue('/ja');
    renderWithIntl(<LocaleSwitcher />, { locale: 'ja' });
    expect(
      screen.getByRole('button', { name: /日本語/ }).getAttribute('aria-pressed'),
    ).toBe('true');
    expect(
      screen.getByRole('button', { name: /English/ }).getAttribute('aria-pressed'),
    ).toBe('false');
  });

  it('現在 locale ボタンクリック → router.replace は呼ばれない (no-op)', async () => {
    pathname.mockReturnValue('/ja/pay');
    const user = userEvent.setup();
    renderWithIntl(<LocaleSwitcher />, { locale: 'ja' });
    await user.click(screen.getByRole('button', { name: /日本語/ }));
    expect(replace).not.toHaveBeenCalled();
  });

  it('別 locale ボタン → /ja/x/y → /en/x/y に置換', async () => {
    pathname.mockReturnValue('/ja/pay');
    const user = userEvent.setup();
    renderWithIntl(<LocaleSwitcher />, { locale: 'ja' });
    await user.click(screen.getByRole('button', { name: /English/ }));
    expect(replace).toHaveBeenCalledWith('/en/pay');
  });

  it('深い path も正しく置換 (/ja/tip/0xabc → /en/tip/0xabc)', async () => {
    pathname.mockReturnValue('/ja/tip/0x52d4901142e2B5680027da5EB47C86CB02a3cA81');
    const user = userEvent.setup();
    renderWithIntl(<LocaleSwitcher />, { locale: 'ja' });
    await user.click(screen.getByRole('button', { name: /English/ }));
    expect(replace).toHaveBeenCalledWith(
      '/en/tip/0x52d4901142e2B5680027da5EB47C86CB02a3cA81',
    );
  });

  it('locale prefix が無い path (raw /pay) → prefix を前置 (/en + /pay)', async () => {
    // middleware を経由していない異常系。コードはそのまま prefix を頭に追加する
    pathname.mockReturnValue('/pay');
    const user = userEvent.setup();
    renderWithIntl(<LocaleSwitcher />, { locale: 'ja' });
    await user.click(screen.getByRole('button', { name: /English/ }));
    expect(replace).toHaveBeenCalledWith('/en/pay');
  });

  it('aria-label にラベル + locale 名が入る (a11y)', () => {
    pathname.mockReturnValue('/ja');
    renderWithIntl(<LocaleSwitcher />, { locale: 'ja' });
    const ja = screen.getByRole('button', { name: /日本語/ });
    expect(ja.getAttribute('aria-label')).toBe('言語: 日本語');
  });
});
