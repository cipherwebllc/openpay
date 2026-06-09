import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { screen } from '@testing-library/react';
import { renderWithIntl } from '../_helpers/i18n';
import type { HandleTipConfig } from '@/lib/handle';

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

const CONFIG: HandleTipConfig = {
  to: '0x52d4901142e2B5680027da5EB47C86CB02a3cA81',
  methods: [{ token: 'jpyc', chain: 'polygon' }],
};

function renderPanel(config: HandleTipConfig | null) {
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

  it('flag ON + 未サインイン → config の有無に関わらずサインインボタン (編集到達性)', () => {
    // config 無しでもサインインを出す (既存 handle の編集/解放を受取先未設定でも到達可能に)。
    renderPanel(null);
    expect(
      screen.getByRole('button', { name: 'サインインして取得' }),
    ).toBeInTheDocument();
  });

  it('flag ON + config あり + 未サインイン → サインインボタン', () => {
    renderPanel(CONFIG);
    expect(
      screen.getByRole('button', { name: 'サインインして取得' }),
    ).toBeInTheDocument();
  });
});
