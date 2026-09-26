import { renderToString } from 'react-dom/server';
import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { AGENT_VIEW_PREPAINT, AgentPageSections } from '@/components/agent/AgentPageSections';
import { resetAgentViewForTest, setAgentHasWallet } from '@/hooks/useAgentView';

const WALLET = '0x1111111111111111111111111111111111111111';

function page() {
  return (
    <AgentPageSections connect={<section id="c">connect</section>} wallet={<section id="w"><input aria-label="w" /></section>} tryPrompts={<section id="t">try</section>}>
      <section id="rest">rest</section>
    </AgentPageSections>
  );
}
const order = (root: ParentNode) => [...root.querySelectorAll('section')].map((section) => section.id);

function runPrepaint(parent: HTMLElement) {
  const script = document.createElement('script');
  parent.appendChild(script);
  Object.defineProperty(document, 'currentScript', { configurable: true, get: () => script });
  try {
    new Function(AGENT_VIEW_PREPAINT)();
  } finally {
    Reflect.deleteProperty(document, 'currentScript');
  }
}

beforeEach(() => {
  resetAgentViewForTest();
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
  it('keeps CSS order in step with the DOM order for both views', () => {
    const { container } = render(page());
    const slot = (id: string) => container.querySelector(`#${id}`)!.parentElement!;
    expect(slot('c')).toHaveClass('order-1', 'group-data-[agent-view=wallet]:order-3');
    expect(slot('w')).toHaveClass('order-2', 'group-data-[agent-view=wallet]:order-1');
    expect(slot('t')).toHaveClass('order-3', 'group-data-[agent-view=wallet]:order-2');
    expect(slot('rest')).toHaveClass('order-4');
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
