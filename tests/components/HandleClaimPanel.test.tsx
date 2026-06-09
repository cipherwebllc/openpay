import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { screen } from '@testing-library/react';
import { renderWithIntl } from '../_helpers/i18n';
import type { PublishableTipConfig } from '@/lib/handle';

// env フラグ / SIWE 状態を制御する hoisted state。
const h = vi.hoisted(() => ({ enableHandles: true, isSignedIn: false }));
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      get enableHandles() {
        return h.enableHandles;
      },
    },
  };
});
vi.mock('@/hooks/useOrigin', () => ({ useOrigin: () => 'https://test.local' }));
vi.mock('@/hooks/useSiweSession', () => ({
  useSiweSession: () => ({
    isSignedIn: h.isSignedIn,
    signIn: vi.fn(),
    isSigningIn: false,
    signInError: null,
  }),
}));

import { HandleClaimPanel } from '@/components/HandleClaimPanel';

const CONFIG: PublishableTipConfig = {
  to: '0x52d4901142e2B5680027da5EB47C86CB02a3cA81',
  token: 'jpyc',
};

function renderPanel(config: PublishableTipConfig | null) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderWithIntl(
    <QueryClientProvider client={qc}>
      <HandleClaimPanel config={config} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  h.enableHandles = true;
  h.isSignedIn = false;
});

describe('HandleClaimPanel', () => {
  it('flag OFF → 何も描画しない (inert)', () => {
    h.enableHandles = false;
    const { container } = renderPanel(CONFIG);
    expect(container).toBeEmptyDOMElement();
  });

  it('flag ON + config 無し → 受取先設定の案内', () => {
    renderPanel(null);
    expect(
      screen.getByText('先に受取先を設定すると取得できます。'),
    ).toBeInTheDocument();
  });

  it('flag ON + config あり + 未サインイン → サインインボタン', () => {
    renderPanel(CONFIG);
    expect(
      screen.getByRole('button', { name: 'サインインして取得' }),
    ).toBeInTheDocument();
  });
});
