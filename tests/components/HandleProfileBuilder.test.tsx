import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, within } from '@testing-library/react';
import { getAddress } from 'viem';
import { renderWithIntl } from '../_helpers/i18n';

const ADDR = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';
const ADDR2 = '0x000000000000000000000000000000000000dead';
const h = vi.hoisted(() => ({ enableHandles: true, enableJpycAvalanche: false }));

vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      get enableHandles() {
        return h.enableHandles;
      },
      get enableJpycAvalanche() {
        return h.enableJpycAvalanche;
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
    onPublished,
  }: {
    config: unknown;
    onEdit?: (handle: string, config: unknown, profile?: unknown) => void;
    onPublished?: (handle: string) => void;
  }) => (
    <div data-testid="claim">
      {config ? `config-ready:${(config as { to: string }).to}` : 'no-config'}
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
      <button
        type="button"
        data-testid="publish-mock"
        onClick={() => onPublished?.('alice')}
      />
    </div>
  ),
}));

import { HandleProfileBuilder } from '@/components/HandleProfileBuilder';

beforeEach(() => {
  h.enableHandles = true;
  h.enableJpycAvalanche = false;
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

  it('enableJpycAvalanche OFF (既定) → JPYC (Avalanche) トグルは出ない (inert)', () => {
    renderWithIntl(<HandleProfileBuilder />);
    expect(
      screen.getByRole('checkbox', { name: 'JPYC (Polygon)' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('checkbox', { name: 'JPYC (Avalanche)' }),
    ).not.toBeInTheDocument();
  });

  it('enableJpycAvalanche ON → JPYC (Avalanche) を ON にすると methods に伝播し受取方法として描画される', () => {
    h.enableJpycAvalanche = true;
    renderWithIntl(<HandleProfileBuilder />);
    const avax = screen.getByRole('checkbox', { name: 'JPYC (Avalanche)' });
    expect(avax).toBeInTheDocument();
    expect(avax).not.toBeChecked(); // opt-in (flag ON でも既定 OFF)
    // 初期は avalanche 受取方法が描画されていない (checkbox→methods→描画の伝播を実証する前提条件)。
    expect(
      screen.queryByText('JPYC (Avalanche) で応援'),
    ).not.toBeInTheDocument();
    // 受取先解決 + Avalanche を ON。
    fireEvent.change(screen.getByTestId('addr'), { target: { value: ADDR } });
    fireEvent.click(avax);
    expect(avax).toBeChecked();
    // checkbox 状態だけでなく、config.methods への反映 → 受取方法サマリ/プレビュー描画まで実際に
    // 伝播していることを実出力で検証 (LARP: トグルが効いて method が描画されることの実証)。
    expect(
      screen.getAllByText('JPYC (Avalanche) で応援').length,
    ).toBeGreaterThan(0);
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

  it('SNS リンクをドラッグで並べ替えできる', () => {
    renderWithIntl(<HandleProfileBuilder />);
    fireEvent.click(screen.getByText('＋ SNS リンクを追加'));
    fireEvent.click(screen.getByText('＋ SNS リンクを追加'));
    const inputs = screen.getAllByPlaceholderText('https://x.com/yourname');
    fireEvent.change(inputs[0], { target: { value: 'https://x.com/one' } });
    fireEvent.change(inputs[1], { target: { value: 'https://github.com/two' } });
    // 1行目のハンドルを掴んで 2行目へドロップ → 順序が入れ替わる
    const grips = screen.getAllByLabelText('ドラッグで並べ替え');
    expect(grips).toHaveLength(2);
    fireEvent.dragStart(grips[0]);
    fireEvent.drop(grips[1].parentElement!);
    const after = screen.getAllByPlaceholderText('https://x.com/yourname');
    expect(after[0]).toHaveValue('https://github.com/two');
    expect(after[1]).toHaveValue('https://x.com/one');
  });

  it('▲▼ ボタンでも並べ替えできる (タッチ/キーボード fallback)', () => {
    renderWithIntl(<HandleProfileBuilder />);
    fireEvent.click(screen.getByText('＋ SNS リンクを追加'));
    fireEvent.click(screen.getByText('＋ SNS リンクを追加'));
    const inputs = screen.getAllByPlaceholderText('https://x.com/yourname');
    fireEvent.change(inputs[0], { target: { value: 'https://x.com/one' } });
    fireEvent.change(inputs[1], { target: { value: 'https://github.com/two' } });
    const downs = screen.getAllByRole('button', { name: '下へ移動' });
    // 先頭行の ▼ で入れ替え・末尾行の ▼ は disabled
    expect(downs[1]).toBeDisabled();
    fireEvent.click(downs[0]);
    const after = screen.getAllByPlaceholderText('https://x.com/yourname');
    expect(after[0]).toHaveValue('https://github.com/two');
    expect(after[1]).toHaveValue('https://x.com/one');
    // 先頭行の ▲ は disabled
    expect(screen.getAllByRole('button', { name: '上へ移動' })[0]).toBeDisabled();
  });

  it('リンク集もドラッグで並べ替えできる (SNS とは独立)', () => {
    renderWithIntl(<HandleProfileBuilder />);
    fireEvent.click(screen.getByText('＋ リンクを追加'));
    fireEvent.click(screen.getByText('＋ リンクを追加'));
    const labels = screen.getAllByPlaceholderText('ラベル (例: X)');
    fireEvent.change(labels[0], { target: { value: 'Blog' } });
    fireEvent.change(labels[1], { target: { value: 'Shop' } });
    const grips = screen.getAllByLabelText('ドラッグで並べ替え');
    expect(grips).toHaveLength(2); // links の 2 行のみ (socials は未追加)
    fireEvent.dragStart(grips[0]);
    fireEvent.drop(grips[1].parentElement!);
    const after = screen.getAllByPlaceholderText('ラベル (例: X)');
    expect(after[0]).toHaveValue('Shop');
    expect(after[1]).toHaveValue('Blog');
  });

  it('プレビューは受取先未確定でも常時表示される', () => {
    renderWithIntl(<HandleProfileBuilder />);
    expect(screen.getByText('プレビュー')).toBeInTheDocument();
  });

  it('4 ステップの番号見出しを描画する (① 恒久リンク / ② 受取先 / ③ プロフィール / ④ プレビュー)', () => {
    renderWithIntl(<HandleProfileBuilder />);
    // StepCard は section[aria-labelledby=step-N-heading] + 見出し内に番号 badge + title。
    for (const [step, title] of [
      [1, '恒久リンク (@handle)'],
      [2, '受取先'],
      [3, 'プロフィール'],
      [4, 'プレビュー'],
    ] as const) {
      const heading = document.getElementById(`step-${step}-heading`);
      expect(heading).not.toBeNull();
      expect(heading!.textContent).toContain(title);
      expect(heading!.textContent).toContain(String(step));
    }
  });

  it('表示名・テーマ色入力は ③ プロフィール step に置かれる (② 受取先 ではない)', () => {
    renderWithIntl(<HandleProfileBuilder />);
    const step3 = document.getElementById('step-3-body')!;
    const step2 = document.getElementById('step-2-body')!;
    // 表示名 (nameLabel)・テーマ色 (colorLabel) は ③ プロフィール側に存在。
    expect(within(step3).getByText('表示名')).toBeInTheDocument();
    expect(within(step3).getByText('テーマ色')).toBeInTheDocument();
    // 受取先 step には表示名/テーマ色を置かない。
    expect(within(step2).queryByText('表示名')).not.toBeInTheDocument();
    expect(within(step2).queryByText('テーマ色')).not.toBeInTheDocument();
  });

  it('金額プリセット editor は描画されない (UI 非表示・config 導出は温存)', () => {
    renderWithIntl(<HandleProfileBuilder />);
    fireEvent.change(screen.getByTestId('addr'), { target: { value: ADDR } });
    // 旧プリセット editor の追加ボタン文言は出ない。
    expect(screen.queryByText('＋ 金額を追加')).not.toBeInTheDocument();
    // 受取先が確定すれば config は完成 (プリセット非表示でも壊れない)。
    expect(screen.getByTestId('claim')).toHaveTextContent('config-ready');
  });

  it('④ プレビュー下: 新規 (未公開) では 開く/コピー/QR を出さない', () => {
    renderWithIntl(<HandleProfileBuilder />);
    expect(screen.queryByRole('link', { name: '開く' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'コピー' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'QRコード' })).not.toBeInTheDocument();
  });

  it('④ プレビュー下: 編集中 (editingHandle) に 開く/コピー/QR を出す', () => {
    renderWithIntl(<HandleProfileBuilder />);
    // mock の edit ボタンが onEdit('alice', ...) を発火 → editingHandle='alice'
    fireEvent.click(screen.getByTestId('edit-legacy-usdc'));
    const open = screen.getByRole('link', { name: '開く' });
    expect(open).toHaveAttribute('href', expect.stringContaining('/@alice'));
    expect(open).toHaveAttribute('target', '_blank');
    expect(screen.getByRole('button', { name: 'コピー' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'QRコード' })).toBeInTheDocument();
  });

  it('④ QR ボタンで LinkQrModal が開き 編集中 handle のフル URL を提示', () => {
    renderWithIntl(<HandleProfileBuilder />);
    fireEvent.click(screen.getByTestId('edit-legacy-usdc'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'QRコード' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '閉じる' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
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

  it('手入力した生 0x アドレスが stale な resolved を上書きする (誤送金防止)', () => {
    renderWithIntl(<HandleProfileBuilder />);
    // 編集 prefill で resolved に旧アドレス (ADDR) が入る
    fireEvent.click(screen.getByTestId('edit-legacy-usdc'));
    expect(screen.getByTestId('claim')).toHaveTextContent(`config-ready:${ADDR}`);
    // 別の生アドレスを手入力 — mock の AddressInput は常に stale な ADDR を
    // onResolved で発火し続けるが、isAddress な生入力が最優先で採用されること
    fireEvent.change(screen.getByTestId('addr'), { target: { value: ADDR2 } });
    expect(screen.getByTestId('claim')).toHaveTextContent(
      `config-ready:${getAddress(ADDR2)}`,
    );
    expect(screen.getByTestId('claim')).not.toHaveTextContent(`config-ready:${ADDR}`);
  });

  it('編集クリックでフォーム先頭へ smooth スクロールする (配線検証)', () => {
    // jsdom は scrollIntoView 未実装 → prototype に spy を立てて呼び出しを実証する
    const spy = vi.fn();
    Element.prototype.scrollIntoView = spy;
    try {
      renderWithIntl(<HandleProfileBuilder />);
      expect(spy).not.toHaveBeenCalled();
      fireEvent.click(screen.getByTestId('edit-legacy-usdc'));
      expect(spy).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' });
    } finally {
      delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });

  it('公開成功後は旧レコード由来の「USDC 提供終了」通知が消える (stale 通知防止)', () => {
    renderWithIntl(<HandleProfileBuilder />);
    fireEvent.click(screen.getByTestId('edit-legacy-usdc'));
    expect(
      screen.getByText(/USDC \(cross-chain\) のプロフでの提供は終了しました/),
    ).toBeInTheDocument();
    // 更新/取得が成功 → 公開後のレコードに usdc は無いので通知は stale
    fireEvent.click(screen.getByTestId('publish-mock'));
    expect(
      screen.queryByText(/USDC \(cross-chain\) のプロフでの提供は終了しました/),
    ).not.toBeInTheDocument();
    // 編集モード自体は継続 (公開した handle を編集中)
    expect(screen.getByText('「@alice」を編集中')).toBeInTheDocument();
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

  it('未公開の下書きは「編集」→「編集をやめる」で元通り復元される (作業を消さない)', () => {
    renderWithIntl(<HandleProfileBuilder />);
    // 新規作成中の下書きを作り込む (bio に未公開の入力)。
    const bio = screen.getByLabelText(/ひとこと/);
    fireEvent.change(bio, { target: { value: '未公開のメモ' } });
    expect(screen.getByLabelText(/ひとこと/)).toHaveValue('未公開のメモ');
    // 既存 @alice を編集 → bio はレコード値 (空) で上書きされる。
    fireEvent.click(screen.getByTestId('edit-legacy-usdc'));
    expect(screen.getByLabelText(/ひとこと/)).not.toHaveValue('未公開のメモ');
    // 編集をやめる → 編集前の下書きが丸ごと復元される。
    fireEvent.click(screen.getByRole('button', { name: '編集をやめる' }));
    expect(screen.getByLabelText(/ひとこと/)).toHaveValue('未公開のメモ');
  });
});
