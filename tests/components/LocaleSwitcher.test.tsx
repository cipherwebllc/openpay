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

// LocaleSwitcher は click 時に window.location.search を読むため、history API
// で URL を書き換えて jsdom に反映させる (search を直接代入すると read-only)。
function setSearch(value: string): void {
  window.history.replaceState(null, '', `${window.location.pathname}${value}`);
}

import { LocaleSwitcher } from '@/components/LocaleSwitcher';

beforeEach(() => {
  vi.clearAllMocks();
  setSearch('');
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

  it('search param が付いている path → query を維持して別 locale へ replace', async () => {
    // query は PayParams (金額・宛先) を表すので落とすと別ページ送りに等しい
    pathname.mockReturnValue('/ja/pay');
    setSearch('?to=0x52d4901142e2B5680027da5EB47C86CB02a3cA81&token=jpyc');
    const user = userEvent.setup();
    renderWithIntl(<LocaleSwitcher />, { locale: 'ja' });
    await user.click(screen.getByRole('button', { name: /English/ }));
    expect(replace).toHaveBeenCalledWith(
      '/en/pay?to=0x52d4901142e2B5680027da5EB47C86CB02a3cA81&token=jpyc',
    );
  });

  it('checkout の長い query (items / order_id / webhook) も維持', async () => {
    pathname.mockReturnValue('/en/checkout');
    setSearch(
      '?to=0x52d4901142e2B5680027da5EB47C86CB02a3cA81&token=usdc&items=Coffee%3A1%3A5.00&order_id=ORDER-42',
    );
    const user = userEvent.setup();
    renderWithIntl(<LocaleSwitcher />, { locale: 'en' });
    await user.click(screen.getByRole('button', { name: /日本語/ }));
    expect(replace).toHaveBeenCalledWith(
      '/ja/checkout?to=0x52d4901142e2B5680027da5EB47C86CB02a3cA81&token=usdc&items=Coffee%3A1%3A5.00&order_id=ORDER-42',
    );
  });

  it('aria-label にラベル + locale 名が入る (a11y)', () => {
    pathname.mockReturnValue('/ja');
    renderWithIntl(<LocaleSwitcher />, { locale: 'ja' });
    const ja = screen.getByRole('button', { name: /日本語/ });
    expect(ja.getAttribute('aria-label')).toBe('言語: 日本語');
  });

  // -- 境界条件 / pathname 形 --

  it('locale のみの path (/ja) → /en (subpath なし)', async () => {
    pathname.mockReturnValue('/ja');
    const user = userEvent.setup();
    renderWithIntl(<LocaleSwitcher />, { locale: 'ja' });
    await user.click(screen.getByRole('button', { name: /English/ }));
    expect(replace).toHaveBeenCalledWith('/en');
  });

  it('trailing slash 付き (/ja/pay/) → /en/pay/ (末尾保持)', async () => {
    // segments = ['', 'ja', 'pay', ''] のような形でも末尾の空セグメントを保つ
    pathname.mockReturnValue('/ja/pay/');
    const user = userEvent.setup();
    renderWithIntl(<LocaleSwitcher />, { locale: 'ja' });
    await user.click(screen.getByRole('button', { name: /English/ }));
    expect(replace).toHaveBeenCalledWith('/en/pay/');
  });

  it('深い path (/ja/tip/0xABC/extra) も全セグメント保持', async () => {
    // 設計上 /tip/[address] 配下に sub-route は無いが、将来の path 追加に耐える保証
    pathname.mockReturnValue('/ja/tip/0x52d4901142e2B5680027da5EB47C86CB02a3cA81/extra');
    const user = userEvent.setup();
    renderWithIntl(<LocaleSwitcher />, { locale: 'ja' });
    await user.click(screen.getByRole('button', { name: /English/ }));
    expect(replace).toHaveBeenCalledWith(
      '/en/tip/0x52d4901142e2B5680027da5EB47C86CB02a3cA81/extra',
    );
  });

  it('locale に類似する非 locale prefix (/api/foo) → prefix 前置', async () => {
    // /api/* は middleware の matcher で除外されるためここに来ないはずだが、
    // 万が一 client routing で叩かれても /en/api/foo にして安全側に倒す
    pathname.mockReturnValue('/api/foo');
    const user = userEvent.setup();
    renderWithIntl(<LocaleSwitcher />, { locale: 'ja' });
    await user.click(screen.getByRole('button', { name: /English/ }));
    expect(replace).toHaveBeenCalledWith('/en/api/foo');
  });

  it('URL encode された特殊文字 query (Unicode / %20 / +) を素のまま維持', async () => {
    // ja 名前 + 半角空白 + URL encode 済 webhook を含む現実的なケース
    pathname.mockReturnValue('/ja/tip/0x52d4901142e2B5680027da5EB47C86CB02a3cA81');
    setSearch(
      '?token=jpyc&name=%E5%B1%B1%E7%94%B0%20%E5%A4%AA%E9%83%8E&webhook=https%3A%2F%2Fexample.com%2Fhook%3Fx%3D1',
    );
    const user = userEvent.setup();
    renderWithIntl(<LocaleSwitcher />, { locale: 'ja' });
    await user.click(screen.getByRole('button', { name: /English/ }));
    expect(replace).toHaveBeenCalledWith(
      '/en/tip/0x52d4901142e2B5680027da5EB47C86CB02a3cA81?token=jpyc&name=%E5%B1%B1%E7%94%B0%20%E5%A4%AA%E9%83%8E&webhook=https%3A%2F%2Fexample.com%2Fhook%3Fx%3D1',
    );
  });

  it('hash fragment は維持しない (history.replaceState で search のみ扱うため)', async () => {
    // 設計上 hash を使う場面がないことの確認 (#tip / #foo を含む URL は来ない前提)。
    // 万が一来ても search 部だけ拾われ、hash は router.replace 後に Next が破棄する。
    pathname.mockReturnValue('/ja/pay');
    setSearch('?to=0x52d4901142e2B5680027da5EB47C86CB02a3cA81&token=jpyc');
    // hash を直接付与
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}${window.location.search}#anchor`,
    );
    const user = userEvent.setup();
    renderWithIntl(<LocaleSwitcher />, { locale: 'ja' });
    await user.click(screen.getByRole('button', { name: /English/ }));
    expect(replace).toHaveBeenCalledWith(
      '/en/pay?to=0x52d4901142e2B5680027da5EB47C86CB02a3cA81&token=jpyc',
    );
  });

  it('連続クリックで都度 replace が発火 (debounce しない)', async () => {
    // 別 locale → 同 locale (no-op) → 別 locale を素早く押されたケース。
    // 同 locale が間に入ると `next === current` で skip され、別 locale 2 回が replace 2 回。
    pathname.mockReturnValue('/ja/pay');
    const user = userEvent.setup();
    renderWithIntl(<LocaleSwitcher />, { locale: 'ja' });
    const en = screen.getByRole('button', { name: /English/ });
    const ja = screen.getByRole('button', { name: /日本語/ });
    await user.click(en);
    await user.click(ja); // ja は current=ja のため no-op (early return)
    await user.click(en);
    expect(replace).toHaveBeenCalledTimes(2);
    expect(replace).toHaveBeenNthCalledWith(1, '/en/pay');
    expect(replace).toHaveBeenNthCalledWith(2, '/en/pay');
  });

});
