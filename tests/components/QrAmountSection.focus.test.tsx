import { act, useRef, useState, type ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { hydrateRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ja from '../../messages/ja.json';
import { QrAmountSection } from '@/components/qr/QrAmountSection';
import { readQrSettings } from '@/hooks/useQrSettings';
import { useModalFocus } from '@/hooks/useModalFocus';
import { defaultDeploymentForSymbol } from '@/lib/tokens';

// 会計画面の金額欄の初期 focus。server の HTML の autofocus 属性に任せると、WebKit は描画が遅いと後から focus を
// 移し、そのとき設定ボタンや開いたシートにある focus も奪う。ページを開いた直後 (hydrate) は「まだ何も focus されて
// いない」ときだけ移し、タブの切替 (client だけでマウント) では押したタブのボタンからも移す (以前の autoFocus と同じ)。
// どちらでも開いているモーダルの focus は奪わない。

const noop = () => {};
const AMOUNT = '請求金額 (JPYC)';

function Providers({ children }: { children: ReactNode }) {
  return (
    <NextIntlClientProvider locale="ja" messages={ja}>
      {children}
    </NextIntlClientProvider>
  );
}

// 会計のカードの先頭 (お店の設定の要約) には「設定」ボタンがある。
function Section() {
  return (
    <QrAmountSection
      header={<button type="button">設定</button>}
      settings={readQrSettings()}
      setSettings={noop}
      deployment={defaultDeploymentForSymbol('jpyc')}
      mode="amount"
      setMode={noop}
      amount=""
      setAmount={noop}
      resetConvert={noop}
      fiatHint={null}
      rateHint={null}
      canShowConvert={false}
      rateOk={false}
      convert={null}
      convertExpired={false}
      convertRemaining={0}
      convertTargetDisplay=""
      convertAnchorDisplay=""
      applyConvert={noop}
      recalcConvert={noop}
      revertConvert={noop}
      fxWarning={null}
      acknowledgeFxWarning={noop}
      recoverBillAmount={null}
      recoverGasMode="customer"
      discount={null}
      chargeText={null}
    />
  );
}

function OpenSheet() {
  const ref = useRef<HTMLDivElement>(null);
  useModalFocus(ref, { open: true });
  return (
    <div ref={ref} role="dialog" aria-modal="true" aria-labelledby="sheet-title" tabIndex={-1}>
      <h2 id="sheet-title">お店の設定</h2>
    </div>
  );
}

// シートを開いたまま、あとから会計のカードがマウントされる。
function SheetThenSection({ showSection }: { showSection: boolean }) {
  return (
    <>
      <OpenSheet />
      {showSection && <Section />}
    </>
  );
}

// /create のタブと同じ形: タブのボタンを押すと、会計のカードが client だけでマウントされる。
function TabsThenSection() {
  const [tab, setTab] = useState<'register' | 'qr'>('register');
  return (
    <>
      <button type="button" onClick={() => setTab('qr')}>
        決済QR
      </button>
      {tab === 'qr' && <Section />}
    </>
  );
}

const amountInput = () => screen.getByRole('textbox', { name: AMOUNT });

let hydrated: { root: Root; container: HTMLElement } | null = null;
afterEach(() => {
  vi.restoreAllMocks();
  if (hydrated) {
    const { root, container } = hydrated;
    act(() => root.unmount());
    container.remove();
    hydrated = null;
  }
});

// server の HTML を置き、beforeHydrate (hydrate 前のユーザー操作) を済ませてから hydrate する。
async function hydrate(beforeHydrate: (container: HTMLElement) => void = noop) {
  const tree = (
    <Providers>
      <Section />
    </Providers>
  );
  const container = document.createElement('div');
  container.innerHTML = renderToString(tree);
  document.body.appendChild(container);
  beforeHydrate(container);
  // RTL を通さない hydrateRoot なので、act を使える環境だと React に伝える。
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  let root!: Root;
  await act(async () => {
    root = hydrateRoot(container, tree);
  });
  hydrated = { root, container };
}

describe('QrAmountSection: 金額欄の初期 focus', () => {
  it('server の HTML に autofocus 属性を出さない (focus を移すのをブラウザに任せない)', () => {
    const html = renderToString(
      <Providers>
        <Section />
      </Providers>,
    );
    expect(html).toContain(`aria-label="${AMOUNT}"`);
    expect(html).not.toMatch(/autofocus/i);
  });

  it('hydrate 後、まだ何も focus されていなければ金額欄へ focus を移す (スクロールはしない)', async () => {
    const focus = vi.spyOn(HTMLInputElement.prototype, 'focus');
    await hydrate();
    expect(amountInput()).toHaveFocus();
    expect(focus.mock.calls).toEqual([[{ preventScroll: true }]]);
  });

  it('hydrate の前にユーザーが設定ボタンへ移した focus は奪わない', async () => {
    await hydrate((container) => {
      (container.querySelector('button') as HTMLButtonElement).focus();
    });
    expect(screen.getByRole('button', { name: '設定' })).toHaveFocus();
    expect(amountInput()).not.toHaveFocus();
  });

  it('タブの切替 (client だけでマウント) では、押したタブのボタンに focus があっても金額欄へ移す', () => {
    render(<TabsThenSection />, { wrapper: Providers });
    const tab = screen.getByRole('button', { name: '決済QR' });
    // Chromium はクリックでボタンに focus を乗せる (Safari は乗せない = body のまま)。
    tab.focus();
    const focus = vi.spyOn(HTMLInputElement.prototype, 'focus');
    fireEvent.click(tab);
    expect(amountInput()).toHaveFocus();
    // 以前の autoFocus と同じく、見えていなければスクロールして見せる (preventScroll を付けない)。
    expect(focus).toHaveBeenCalledOnce();
    expect(focus.mock.calls[0][0]?.preventScroll ?? false).toBe(false);
  });

  it('モーダルが開いていれば奪わない (focus はシートの中のまま)', () => {
    const view = render(<SheetThenSection showSection={false} />, { wrapper: Providers });
    const sheet = screen.getByRole('dialog', { name: 'お店の設定' });
    expect(sheet).toHaveFocus();
    view.rerender(<SheetThenSection showSection />);
    expect(screen.getByRole('dialog', { name: 'お店の設定' })).toBe(sheet);
    expect(sheet).toHaveFocus();
    expect(amountInput()).not.toHaveFocus();
  });
});
