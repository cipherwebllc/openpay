import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { renderWithIntl } from '../_helpers/i18n';

const ADDR = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';
const h = vi.hoisted(() => ({ enableHandles: true }));

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
vi.mock('wagmi', () => ({ useAccount: () => ({ address: undefined }) }));
// AddressInput: 入力時に onResolved を ADDR で発火する軽量スタブ。
vi.mock('@/components/AddressInput', () => ({
  AddressInput: ({
    value,
    onChange,
    onResolved,
  }: {
    value: string;
    onChange: (v: string) => void;
    onResolved?: (a: string | null) => void;
  }) => (
    <input
      data-testid="addr"
      value={value}
      onChange={(e) => {
        onChange(e.target.value);
        onResolved?.(ADDR);
      }}
    />
  ),
}));
// claim panel は config の有無だけ反映 (SIWE/react-query を持ち込まない)。
// edit-legacy-usdc: 旧 USDC method 持ちレコードの「編集」を模擬し onEdit を発火する。
vi.mock('@/components/HandleClaimPanel', () => ({
  HandleClaimPanel: ({
    config,
    onEdit,
  }: {
    config: unknown;
    onEdit?: (handle: string, config: unknown, profile?: unknown) => void;
  }) => (
    <div data-testid="claim">
      {config ? 'config-ready' : 'no-config'}
      <button
        type="button"
        data-testid="edit-legacy-usdc"
        onClick={() =>
          onEdit?.('alice', {
            to: ADDR,
            methods: [
              { token: 'jpyc', chain: 'polygon' },
              { token: 'usdc', chain: 'base', crossChain: true },
            ],
          })
        }
      />
    </div>
  ),
}));

import { HandleProfileBuilder } from '@/components/HandleProfileBuilder';

beforeEach(() => {
  h.enableHandles = true;
  localStorage.clear();
});

describe('HandleProfileBuilder', () => {
  it('flag OFF → 何も描画しない (inert)', () => {
    h.enableHandles = false;
    const { container } = renderWithIntl(<HandleProfileBuilder />);
    expect(container).toBeEmptyDOMElement();
  });

  it('flag ON → JPYC 2 受取方法トグル + claim panel を描画 (USDC は提供終了)', () => {
    renderWithIntl(<HandleProfileBuilder />);
    expect(
      screen.getByRole('checkbox', { name: 'JPYC (Polygon)' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('checkbox', { name: 'JPYC (Kaia)' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('checkbox', { name: 'USDC (cross-chain)' }),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId('claim')).toBeInTheDocument();
  });

  it('受取先未確定では config=null・解決後に config-ready', () => {
    renderWithIntl(<HandleProfileBuilder />);
    // 初期は受取先未解決 → config null
    expect(screen.getByTestId('claim')).toHaveTextContent('no-config');
    // 受取先入力で onResolved 発火 → 方法は既定 3 つ ON なので config 完成
    fireEvent.change(screen.getByTestId('addr'), { target: { value: ADDR } });
    expect(screen.getByTestId('claim')).toHaveTextContent('config-ready');
  });

  it('SNS リンクを追加でき、非 https は警告が出て送信から除外される', () => {
    renderWithIntl(<HandleProfileBuilder />);
    // Field の label 内にあるためアクセシブル名は label 文字列になる → テキストで特定
    fireEvent.click(screen.getByText('＋ SNS リンクを追加'));
    const input = screen.getByPlaceholderText('https://x.com/yourname');
    // 非 https → 注意喚起 (送信からは除外)
    fireEvent.change(input, { target: { value: 'http://x.com/alice' } });
    expect(
      screen.getByText('https 以外のリンク / 画像は保存されません。'),
    ).toBeInTheDocument();
    // https に直すと警告が消える
    fireEvent.change(input, { target: { value: 'https://x.com/alice' } });
    expect(
      screen.queryByText('https 以外のリンク / 画像は保存されません。'),
    ).not.toBeInTheDocument();
  });

  it('プレビューは受取先未確定でも常時表示される', () => {
    renderWithIntl(<HandleProfileBuilder />);
    expect(screen.getByText('プレビュー')).toBeInTheDocument();
  });

  it('全方法 OFF にすると config=null (最低1必須の警告)', () => {
    renderWithIntl(<HandleProfileBuilder />);
    fireEvent.change(screen.getByTestId('addr'), { target: { value: ADDR } });
    expect(screen.getByTestId('claim')).toHaveTextContent('config-ready');
    fireEvent.click(screen.getByRole('checkbox', { name: 'JPYC (Polygon)' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'JPYC (Kaia)' }));
    expect(screen.getByTestId('claim')).toHaveTextContent('no-config');
    expect(screen.getByText('受取方法を 1 つ以上選んでください。')).toBeInTheDocument();
  });

  it('旧 USDC method 持ちレコードの編集時は「更新で外れる」通知を表示', () => {
    renderWithIntl(<HandleProfileBuilder />);
    fireEvent.click(screen.getByTestId('edit-legacy-usdc'));
    expect(
      screen.getByText(/USDC \(cross-chain\) のプロフでの提供は終了しました/),
    ).toBeInTheDocument();
    // ビルダーが組む methods には usdc が含まれない (JPYC のみで config 完成)
    expect(screen.getByTestId('claim')).toHaveTextContent('config-ready');
  });

  it('編集開始でヘッダに「編集中」バッジ・「編集をやめる」でフォームを既定へ戻す', () => {
    renderWithIntl(<HandleProfileBuilder />);
    expect(screen.queryByText('「@alice」を編集中')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('edit-legacy-usdc'));
    expect(screen.getByText('「@alice」を編集中')).toBeInTheDocument();
    // やめる → バッジと USDC 通知が消え、新規作成モードへ
    fireEvent.click(screen.getByRole('button', { name: '編集をやめる' }));
    expect(screen.queryByText('「@alice」を編集中')).not.toBeInTheDocument();
    expect(
      screen.queryByText(/USDC \(cross-chain\) のプロフでの提供は終了しました/),
    ).not.toBeInTheDocument();
  });
});
