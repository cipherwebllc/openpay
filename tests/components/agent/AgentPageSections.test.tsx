import { renderToString } from 'react-dom/server';
import { hydrateRoot } from 'react-dom/client';
import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AGENT_VIEW_PREPAINT, AgentPageSections } from '@/components/agent/AgentPageSections';
import { resetAgentView, setAgentHasWallet } from '@/hooks/useAgentView';

const WALLET = '0x1111111111111111111111111111111111111111';

function page() {
  return (
    <AgentPageSections hero={<header id="h">hero</header>} connect={<section id="c">connect</section>} wallet={<section id="w"><input aria-label="w" /></section>} tryPrompts={<section id="t">try</section>}>
      <section id="rest">rest</section>
    </AgentPageSections>
  );
}
const order = (root: ParentNode) => [...root.querySelectorAll('section')].map((section) => section.id);

// jsdom は innerHTML で入れた script を実行しないので、document.currentScript をその script にして中身を実行する。
function execScript(script: HTMLScriptElement) {
  Object.defineProperty(document, 'currentScript', { configurable: true, get: () => script });
  try {
    new Function(script.textContent ?? '')();
  } finally {
    Reflect.deleteProperty(document, 'currentScript');
  }
}
function runPrepaint(parent: HTMLElement) {
  const script = document.createElement('script');
  script.textContent = AGENT_VIEW_PREPAINT;
  parent.appendChild(script);
  execScript(script);
}

beforeEach(() => {
  resetAgentView();
  window.localStorage.clear();
  window.history.replaceState(null, '', '/');
});

describe('AgentPageSections', () => {
  it('prerenders the first-visit order with the pre-paint script and no view attribute', () => {
    const html = renderToString(page());
    const host = document.createElement('div');
    host.innerHTML = html;
    expect(host.querySelector('script')?.textContent).toBe(AGENT_VIEW_PREPAINT);
    expect(host.firstElementChild).not.toHaveAttribute('data-agent-view');
    expect(order(host)).toEqual(['c', 'w', 't', 'rest']);
  });
  it('omits the script on client-only renders and reorders the DOM once the wallet card decides', () => {
    const { container } = render(page());
    expect(container.querySelector('script')).toBeNull();
    expect(order(container)).toEqual(['c', 'w', 't', 'rest']);
    const wallet = container.querySelector('#w');
    act(() => setAgentHasWallet(true));
    expect(order(container)).toEqual(['w', 't', 'c', 'rest']);
    expect(container.querySelector('[data-agent-view]')).toHaveAttribute('data-agent-view', 'wallet');
    // 並べ替えで Wallet の節を作り直さない (入力中のフォーカスや state を失わない)。
    expect(container.querySelector('#w')).toBe(wallet);
    act(() => setAgentHasWallet(false));
    expect(container.querySelector('[data-agent-view]')).toHaveAttribute('data-agent-view', 'setup');
    expect(order(container)).toEqual(['c', 'w', 't', 'rest']);
  });
  it('hydrates over the pre-paint attribute without warnings, then drops the script', async () => {
    window.localStorage.setItem('openpay.agent.address', WALLET);
    const host = document.createElement('div');
    host.innerHTML = renderToString(page());
    document.body.appendChild(host);
    // server の HTML に入っている script そのものを実行する (実ブラウザの parse 時と同じ)。
    execScript(host.querySelector('script')!);
    expect(host.firstElementChild).toHaveAttribute('data-agent-view', 'wallet');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const recoverable = vi.fn();
    let root: ReturnType<typeof hydrateRoot> | undefined;
    try {
      await act(async () => { root = hydrateRoot(host, page(), { onRecoverableError: recoverable }); });
      expect(errors).not.toHaveBeenCalled();
      expect(recoverable).not.toHaveBeenCalled();
      expect(host.firstElementChild).toHaveAttribute('data-agent-view', 'wallet');
      expect(host.querySelector('script')).toBeNull();
      // hydration 直後に client の推定 (控えあり) で DOM も Wallet 先頭へ。
      expect(order(host)).toEqual(['w', 't', 'c', 'rest']);
    } finally {
      errors.mockRestore();
      act(() => root?.unmount());
      host.remove();
    }
  });
  it('guesses the returning order on the first client render (in-app navigation has no pre-paint script)', () => {
    window.localStorage.setItem('openpay.agent.address', WALLET);
    const { container, unmount } = render(page());
    expect(order(container)).toEqual(['w', 't', 'c', 'rest']);
    expect(container.querySelector('[data-agent-view]')).toHaveAttribute('data-agent-view', 'wallet');
    // 残高カードの判定が推定より優先される。
    act(() => setAgentHasWallet(false));
    expect(order(container)).toEqual(['c', 'w', 't', 'rest']);
    // ページを離れたら判定を捨て、次に来たときは今の控えから推定し直す。
    unmount();
    window.localStorage.clear();
    const next = render(page());
    expect(order(next.container)).toEqual(['c', 'w', 't', 'rest']);
    next.unmount();
    window.localStorage.setItem('openpay.agent.address', WALLET);
    expect(order(render(page()).container)).toEqual(['w', 't', 'c', 'rest']);
  });
  it('keeps CSS order in step with the DOM order for both views', () => {
    const { container } = render(page());
    const slot = (id: string) => container.querySelector(`#${id}`)!.parentElement!;
    expect(slot('c')).toHaveClass('order-1', 'group-data-[agent-view=wallet]:order-3');
    expect(slot('w')).toHaveClass('order-2', 'group-data-[agent-view=wallet]:order-1');
    expect(slot('t')).toHaveClass('order-3', 'group-data-[agent-view=wallet]:order-2');
    expect(slot('rest')).toHaveClass('order-4');
    // PC の再訪はダッシュボード: 主列 = 残高 → 頼めること、右の列 = 接続 → 残り。要素の親は 1 つのまま (作り直さない)。
    expect(slot('w')).toHaveClass('lg:group-data-[agent-view=wallet]:col-start-1', 'lg:group-data-[agent-view=wallet]:row-[1/4]');
    expect(slot('t')).toHaveClass('lg:group-data-[agent-view=wallet]:col-start-1', 'lg:group-data-[agent-view=wallet]:row-[4/5]');
    expect(slot('c')).toHaveClass('lg:group-data-[agent-view=wallet]:col-start-2', 'lg:group-data-[agent-view=wallet]:row-[1/2]');
    expect(slot('rest')).toHaveClass('lg:group-data-[agent-view=wallet]:col-start-2', 'lg:group-data-[agent-view=wallet]:row-[2/3]');
    expect(new Set([slot('c'), slot('w'), slot('t'), slot('rest')].map((el) => el.parentElement)).size).toBe(1);
  });
  it.each([
    ['a saved address', () => window.localStorage.setItem('openpay.agent.address', WALLET), 'wallet'],
    ['an ?address= link', () => window.history.replaceState(null, '', `/?address=${WALLET}`), 'wallet'],
    ['nothing', () => {}, null],
    ['an invalid saved value', () => window.localStorage.setItem('openpay.agent.address', '0x123'), null],
  ])('pre-paint script marks the wallet view for %s', (_label, arrange, expected) => {
    arrange();
    const parent = document.createElement('div');
    runPrepaint(parent);
    expect(parent.getAttribute('data-agent-view')).toBe(expected);
  });
  it('pre-paint script never throws when storage is unavailable', () => {
    const original = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', { configurable: true, get: () => { throw new Error('blocked'); } });
    try {
      const parent = document.createElement('div');
      expect(() => runPrepaint(parent)).not.toThrow();
      expect(parent.getAttribute('data-agent-view')).toBeNull();
    } finally {
      if (original) Object.defineProperty(window, 'localStorage', original);
    }
  });
});
