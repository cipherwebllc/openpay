import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor, within } from '@testing-library/react';
import { getAddress } from 'viem';
import { renderWithIntl } from '../_helpers/i18n';
import { MAX_PROFILE_LINKS } from '@/lib/handle';

const ADDR = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';
const ADDR2 = '0x000000000000000000000000000000000000dead';
const h = vi.hoisted(() => ({
  enableHandles: true,
  enableJpycAvalanche: false,
  connectedAddress: undefined as string | undefined,
}));

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
vi.mock('wagmi', () => ({
  useAccount: () => ({ address: h.connectedAddress }),
}));
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
    payload,
    onEdit,
    onPublished,
    expectedUpdatedAt,
  }: {
    payload: { config: { to: string }; profile: unknown } | null;
    onEdit?: (
      handle: string,
      config: unknown,
      profile?: unknown,
      updatedAt?: number,
    ) => void;
    onPublished?: (snapshot: {
      handle: string;
      payload: { config: { to: string }; profile: unknown };
      updatedAt: number;
    }) => void;
    expectedUpdatedAt?: number;
  }) => (
    <div
      data-testid="claim"
      data-expected-updated-at={expectedUpdatedAt ?? ''}
    >
      {payload ? `config-ready:${payload.config.to}` : 'no-config'}
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
          }, undefined, Date.UTC(2026, 6, 10, 10, 0, 0))
        }
      />
      <button
        type="button"
        data-testid="edit-avalanche"
        onClick={() =>
          onEdit?.('alice', {
            to: ADDR,
            methods: [
              { token: 'jpyc', chain: 'polygon' },
              { token: 'jpyc', chain: 'avalanche' },
            ],
          })
        }
      />
      <button
        type="button"
        data-testid="edit-named"
        onClick={() =>
          onEdit?.(
            'alice',
            {
              to: ADDR,
              name: 'Published Alice',
              methods: [{ token: 'jpyc', chain: 'polygon' }],
            },
            { bio: 'Published bio', theme: 'clean' },
            Date.UTC(2026, 6, 10, 10, 0, 0),
          )
        }
      />
      <button
        type="button"
        data-testid="edit-missing-updated-at"
        onClick={() =>
          onEdit?.('alice', {
            to: ADDR,
            methods: [{ token: 'jpyc', chain: 'polygon' }],
          })
        }
      />
      <button
        type="button"
        data-testid="publish-mock"
        onClick={() =>
          payload &&
          onPublished?.({
            handle: 'alice',
            payload,
            updatedAt: Date.UTC(2026, 6, 10, 12, 0, 0),
          })
        }
      />
    </div>
  ),
}));

import { HandleProfileBuilder } from '@/components/HandleProfileBuilder';

beforeEach(() => {
  h.enableHandles = true;
  h.enableJpycAvalanche = false;
  h.connectedAddress = undefined;
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
      screen.queryByText('JPYC · Avalanche'),
    ).not.toBeInTheDocument();
    // 受取先解決 + Avalanche を ON。
    fireEvent.change(screen.getByTestId('addr'), { target: { value: ADDR } });
    fireEvent.click(avax);
    expect(avax).toBeChecked();
    // checkbox 状態だけでなく、config.methods への反映 → 受取方法サマリ/プレビュー描画まで実際に
    // 伝播していることを実出力で検証 (LARP: トグルが効いて method が描画されることの実証)。
    expect(
      screen.getAllByText('JPYC · Avalanche').length,
    ).toBeGreaterThan(0);
  });

  it('enableJpycAvalanche ON + avalanche method を持つ既存設定を編集ロード → トグル ON 復元 + 受取方法も描画 (load 経路)', () => {
    h.enableJpycAvalanche = true;
    renderWithIntl(<HandleProfileBuilder />);
    fireEvent.click(screen.getByTestId('edit-avalanche'));
    // config.methods から draft.jpycAvalanche を復元 → checkbox checked + 受取方法も描画。
    expect(
      screen.getByRole('checkbox', { name: 'JPYC (Avalanche)' }),
    ).toBeChecked();
    expect(
      screen.getAllByText('JPYC · Avalanche').length,
    ).toBeGreaterThan(0);
  });

  it('enableJpycAvalanche OFF + avalanche method を持つ設定を編集ロード → method 非載・UI 非表示 (draft 値があっても flag OFF で inert)', () => {
    // flag OFF。古い/他環境由来の設定が jpyc/avalanche を持ち draft.jpycAvalanche=true に
    // なっても、methods 構築を env.enableJpycAvalanche でゲートするため受取方法に載らない
    // (option ゲートとは別の method ゲートの provably-inert を実証)。
    renderWithIntl(<HandleProfileBuilder />); // h.enableJpycAvalanche=false (beforeEach)
    fireEvent.click(screen.getByTestId('edit-avalanche'));
    // checkbox (option) も 受取方法 (method) も flag OFF では出ない。
    expect(
      screen.queryByRole('checkbox', { name: 'JPYC (Avalanche)' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText('JPYC · Avalanche'),
    ).not.toBeInTheDocument();
    // 対照: 同じ設定の polygon は通常どおり載る (avalanche だけが inert)。
    expect(
      screen.getAllByText('JPYC · Polygon').length,
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

  it('④ プレビュー下: 新規 (未公開) では 開く/コピー/QR/X を出さない', () => {
    renderWithIntl(<HandleProfileBuilder />);
    expect(screen.queryByRole('link', { name: '開く' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'コピー' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'QRコード' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'X でシェア' })).not.toBeInTheDocument();
  });

  it('④ プレビュー下: 編集中 (editingHandle) に 開く/コピー/QR/X を出す', () => {
    renderWithIntl(<HandleProfileBuilder />);
    // mock の edit ボタンが onEdit('alice', ...) を発火 → editingHandle='alice'
    fireEvent.click(screen.getByTestId('edit-legacy-usdc'));
    const open = screen.getByRole('link', { name: '開く' });
    expect(open).toHaveAttribute('href', expect.stringContaining('/@alice'));
    expect(open).toHaveAttribute('target', '_blank');
    expect(screen.getByRole('button', { name: 'コピー' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'QRコード' })).toBeInTheDocument();
    const share = screen.getByRole('link', { name: 'X でシェア' });
    expect(share).toHaveAttribute(
      'href',
      expect.stringContaining('twitter.com/intent/tweet'),
    );
    expect(new URL(share.getAttribute('href')!).searchParams.get('text')).toBe(
      '@alice をシェア',
    );
  });

  it('公開済み handle の選択と解除を親へ通知する', () => {
    const onPublishedHandleChange = vi.fn();
    renderWithIntl(
      <HandleProfileBuilder
        onPublishedHandleChange={onPublishedHandleChange}
      />,
    );
    fireEvent.change(screen.getByTestId('addr'), {
      target: { value: ADDR },
    });
    fireEvent.click(screen.getByTestId('publish-mock'));

    expect(onPublishedHandleChange).toHaveBeenLastCalledWith('alice');

    fireEvent.click(
      screen.getByRole('button', { name: '編集をやめる' }),
    );
    expect(onPublishedHandleChange).toHaveBeenLastCalledWith(null);
  });

  it('接続 wallet が変わったら旧 owner の公開 handle を親から解除する', async () => {
    h.connectedAddress = ADDR;
    const onPublishedHandleChange = vi.fn();
    const view = renderWithIntl(
      <HandleProfileBuilder
        onPublishedHandleChange={onPublishedHandleChange}
      />,
    );
    fireEvent.change(screen.getByTestId('addr'), {
      target: { value: ADDR },
    });
    fireEvent.click(screen.getByTestId('publish-mock'));
    expect(onPublishedHandleChange).toHaveBeenLastCalledWith('alice');

    h.connectedAddress = ADDR2;
    view.rerender(
      <HandleProfileBuilder
        onPublishedHandleChange={onPublishedHandleChange}
      />,
    );

    await waitFor(() =>
      expect(onPublishedHandleChange).toHaveBeenLastCalledWith(null),
    );
  });

  it('公開 snapshot の名前で X 文言を作り、dirty 中の未公開名を混ぜない', () => {
    renderWithIntl(<HandleProfileBuilder />);
    fireEvent.click(screen.getByTestId('edit-named'));
    const share = screen.getByRole('link', { name: 'X でシェア' });
    expect(new URL(share.getAttribute('href')!).searchParams.get('text')).toBe(
      '「Published Alice (@alice)」をシェア',
    );

    fireEvent.change(screen.getByLabelText('表示名'), {
      target: { value: 'Draft Alice' },
    });
    expect(screen.getByText('未公開の変更があります')).toBeInTheDocument();
    expect(new URL(share.getAttribute('href')!).searchParams.get('text')).toBe(
      '「Published Alice (@alice)」をシェア',
    );
  });

  it('公開ステータスは updatedAt を <time dateTime> で表示し、欠損時は fallback', () => {
    const { unmount } = renderWithIntl(<HandleProfileBuilder />);
    fireEvent.click(screen.getByTestId('edit-named'));
    expect(screen.getByText('公開中 @alice')).toBeInTheDocument();
    const time = screen.getByTestId('published-status').querySelector('time');
    expect(time).not.toBeNull();
    expect(time).toHaveAttribute('datetime', '2026-07-10T10:00:00.000Z');
    expect(screen.getByTestId('claim')).toHaveAttribute(
      'data-expected-updated-at',
      String(Date.UTC(2026, 6, 10, 10, 0, 0)),
    );

    unmount();
    renderWithIntl(<HandleProfileBuilder />);
    fireEvent.click(screen.getByTestId('edit-missing-updated-at'));
    expect(screen.getByText('最終更新時刻は不明')).toBeInTheDocument();
    expect(screen.getByTestId('published-status').querySelector('time')).toBeNull();
  });

  it('MobileOrderBuilder 方式のスマホフレーム + 枠内スクロールで、実プレビュー props とアクション行を分離', () => {
    renderWithIntl(<HandleProfileBuilder />);
    fireEvent.change(screen.getByLabelText('表示名'), {
      target: { value: 'Preview Alice' },
    });
    const frame = screen.getByTestId('handle-preview-frame');
    const scroll = screen.getByTestId('handle-preview-scroll');
    expect(frame.className).toContain('rounded-[2rem]');
    expect(frame.className).toContain('border-[6px]');
    expect(scroll.className).toContain('max-h-[46vh]');
    expect(scroll.className).toContain('overflow-y-auto');
    expect(within(frame).getByText('Preview Alice')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('edit-named'));
    expect(frame).not.toContainElement(
      screen.getByRole('link', { name: 'X でシェア' }),
    );
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
      screen.getByText(/プロフでの USDC 提供は終了しました/),
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
      screen.getByText(/プロフでの USDC 提供は終了しました/),
    ).toBeInTheDocument();
    // 更新/取得が成功 → 公開後のレコードに usdc は無いので通知は stale
    fireEvent.click(screen.getByTestId('publish-mock'));
    expect(
      screen.queryByText(/プロフでの USDC 提供は終了しました/),
    ).not.toBeInTheDocument();
    // 編集モード自体は継続 (公開した handle を編集中)
    expect(screen.getByText('公開中 @alice')).toBeInTheDocument();
  });

  it('編集開始でヘッダに「編集中」バッジ・「編集をやめる」でフォームを既定へ戻す', () => {
    renderWithIntl(<HandleProfileBuilder />);
    expect(screen.queryByText('公開中 @alice')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('edit-legacy-usdc'));
    expect(screen.getByText('公開中 @alice')).toBeInTheDocument();
    // やめる → バッジと USDC 通知が消え、新規作成モードへ
    fireEvent.click(screen.getByRole('button', { name: '編集をやめる' }));
    expect(screen.queryByText('公開中 @alice')).not.toBeInTheDocument();
    expect(
      screen.queryByText(/プロフでの USDC 提供は終了しました/),
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

  it('テーマピッカーが 6 タイルを描画し、既定は Clean が選択 (aria-pressed)', () => {
    renderWithIntl(<HandleProfileBuilder />);
    for (const name of ['Clean', 'Gradient', 'Bold', 'Outline', 'Night', 'Soft']) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument();
    }
    expect(screen.getByRole('button', { name: 'Clean' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: 'Night' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('テーマタイルをクリックすると選択が切り替わる (Night → 選択)', () => {
    renderWithIntl(<HandleProfileBuilder />);
    fireEvent.click(screen.getByRole('button', { name: 'Night' }));
    expect(screen.getByRole('button', { name: 'Night' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: 'Clean' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('リンク行の絵文字入力が保持される (controlled)', () => {
    renderWithIntl(<HandleProfileBuilder />);
    fireEvent.click(screen.getByText('＋ リンクを追加'));
    const emoji = screen.getByLabelText('絵文字 (任意)');
    fireEvent.change(emoji, { target: { value: '🌐' } });
    expect(screen.getByLabelText('絵文字 (任意)')).toHaveValue('🌐');
  });

  it('通常リンクの全入力に同スタイルの可視 label を表示し、値を保持する', () => {
    renderWithIntl(<HandleProfileBuilder />);
    fireEvent.click(screen.getByText('＋ リンクを追加'));
    const fields = [
      screen.getByRole('textbox', { name: '絵文字 (任意)' }),
      screen.getByRole('textbox', { name: '画像 URL (任意)' }),
      screen.getByRole('textbox', { name: 'ラベル' }),
      screen.getByRole('textbox', { name: 'URL' }),
    ];
    const fieldHeadingClasses = fields.map(
      (input) => input.closest('label')?.querySelector('span')?.className,
    );
    expect(fieldHeadingClasses.every(Boolean)).toBe(true);
    expect(new Set(fieldHeadingClasses).size).toBe(1);
    expect(fields[0]).not.toHaveAttribute('aria-label');

    const imageUrl = screen.getByRole('textbox', {
      name: '画像 URL (任意)',
    });
    expect(imageUrl).toHaveAttribute('type', 'url');
    expect(imageUrl).toHaveAttribute('maxlength', '512');
    fireEvent.change(imageUrl, {
      target: { value: 'https://cdn.example.com/link.jpg' },
    });
    expect(
      screen.getByRole('textbox', { name: '画像 URL (任意)' }),
    ).toHaveValue('https://cdn.example.com/link.jpg');
  });

  it('対応 URL のみ embed toggle を表示し、文字 click と非対応化の解除が動く', async () => {
    renderWithIntl(<HandleProfileBuilder />);
    fireEvent.click(screen.getByText('＋ リンクを追加'));
    const linksGroup = screen.getByRole('group', { name: 'リンク' });
    const linkUrl = within(linksGroup).getByRole('textbox', { name: 'URL' });

    fireEvent.change(linkUrl, {
      target: { value: 'https://example.com/video' },
    });
    expect(
      screen.queryByRole('checkbox', { name: '埋め込み表示' }),
    ).not.toBeInTheDocument();

    fireEvent.change(linkUrl, {
      target: { value: 'https://youtu.be/dQw4w9WgXcQ' },
    });
    const toggle = screen.getByRole('checkbox', { name: '埋め込み表示' });
    expect(toggle).not.toBeChecked();
    fireEvent.click(screen.getByText('埋め込み表示'));
    expect(toggle).toBeChecked();

    fireEvent.change(linkUrl, {
      target: { value: 'https://example.com/video' },
    });
    expect(
      screen.queryByRole('checkbox', { name: '埋め込み表示' }),
    ).not.toBeInTheDocument();
    await waitFor(() => {
      const stored = JSON.parse(
        localStorage.getItem('openpay:handle-profile-draft:v1') ?? '{}',
      ) as { links?: Array<Record<string, unknown>> };
      expect(stored.links?.[0]).not.toHaveProperty('embed');
    });
  });

  it('Audius URL に embed toggle と 9-provider hint を表示する', () => {
    renderWithIntl(<HandleProfileBuilder />);
    expect(
      screen.getByText(
        'リンクは https:// のみ。安全のため http や javascript は無効です。YouTube / Spotify / Audius / ニコニコ動画 / Vimeo / Apple Music / TikTok / Suno / SoundCloud は埋め込み表示に対応しています。',
      ),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByText('＋ リンクを追加'));
    const linksGroup = screen.getByRole('group', { name: 'リンク' });
    const linkUrl = within(linksGroup).getByRole('textbox', { name: 'URL' });

    fireEvent.change(linkUrl, {
      target: { value: 'https://audius.co/openpay/test-track' },
    });
    const toggle = screen.getByRole('checkbox', { name: '埋め込み表示' });
    fireEvent.click(toggle);
    expect(toggle).toBeChecked();
  });

  it('英語でも 9-provider hint と全入力の可視 label を表示する', () => {
    renderWithIntl(<HandleProfileBuilder />, { locale: 'en' });
    expect(
      screen.getByText(
        'Links must be https:// only. http and javascript are disabled for safety. YouTube / Spotify / Audius / Niconico Video / Vimeo / Apple Music / TikTok / Suno / SoundCloud links can be embedded.',
      ),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByText('＋ Add link'));
    for (const name of ['Emoji (optional)', 'Image URL (optional)', 'Label', 'URL']) {
      expect(screen.getByRole('textbox', { name })).toBeInTheDocument();
    }
  });

  it.each([
    ['ニコニコ動画', 'https://nicovideo.jp/watch/sm9'],
    ['Vimeo', 'https://vimeo.com/123456'],
    ['Apple Music', 'https://music.apple.com/jp/album/song/123?i=456'],
    ['TikTok', 'https://tiktok.com/@alice/video/123'],
    ['Suno', 'https://suno.com/song/123e4567-e89b-42d3-a456-426614174000'],
    ['SoundCloud', 'https://soundcloud.com/artist/track'],
  ])('%s URL に embed toggle を表示する', (_provider, url) => {
    renderWithIntl(<HandleProfileBuilder />);
    fireEvent.click(screen.getByText('＋ リンクを追加'));
    fireEvent.change(screen.getByRole('textbox', { name: 'URL' }), {
      target: { value: url },
    });
    expect(
      screen.getByRole('checkbox', { name: '埋め込み表示' }),
    ).toBeInTheDocument();
  });

  it('YouTube / Spotify / Audius の合算 3 件で 4 件目 toggle を disabled にする', () => {
    renderWithIntl(<HandleProfileBuilder />);
    for (let index = 0; index < 4; index += 1) {
      fireEvent.click(screen.getByText('＋ リンクを追加'));
    }
    const linksGroup = screen.getByRole('group', { name: 'リンク' });
    const linkUrls = within(linksGroup).getAllByRole('textbox', { name: 'URL' });
    const urls = [
      'https://youtu.be/dQw4w9WgXcQ',
      'https://open.spotify.com/track/0123456789ABCDEFGHIJKL',
      'https://audius.co/openpay/track-one',
      'https://audius.co/openpay/track-two',
    ];
    linkUrls.forEach((input, index) => {
      fireEvent.change(input, { target: { value: urls[index] } });
    });

    for (let index = 0; index < 3; index += 1) {
      fireEvent.click(
        screen.getAllByRole('checkbox', { name: '埋め込み表示' })[index],
      );
    }
    expect(
      screen.getAllByRole('checkbox', { name: '埋め込み表示' })[3],
    ).toBeDisabled();
  });

  it('embed が 3 件 ON なら 4 件目の未選択 toggle を disabled にする', () => {
    renderWithIntl(<HandleProfileBuilder />);
    for (let index = 0; index < 4; index += 1) {
      fireEvent.click(screen.getByText('＋ リンクを追加'));
    }
    const linksGroup = screen.getByRole('group', { name: 'リンク' });
    const linkUrls = within(linksGroup).getAllByRole('textbox', { name: 'URL' });
    for (const input of linkUrls) {
      fireEvent.change(input, {
        target: { value: 'https://youtu.be/dQw4w9WgXcQ' },
      });
    }

    for (let index = 0; index < 3; index += 1) {
      fireEvent.click(
        screen.getAllByRole('checkbox', { name: '埋め込み表示' })[index],
      );
    }
    const toggles = screen.getAllByRole('checkbox', {
      name: '埋め込み表示',
    });
    for (const toggle of toggles.slice(0, 3)) {
      expect(toggle).toBeChecked();
    }
    expect(toggles[3]).toBeDisabled();
  });

  it('見出しを追加・編集・削除でき、URL と featured UI を出さない', () => {
    renderWithIntl(<HandleProfileBuilder />);
    fireEvent.click(
      screen.getByRole('button', { name: '＋ 見出しを追加' }),
    );
    const label = screen.getByRole('textbox', { name: '見出し' });
    const row = screen.getByRole('button', { name: '見出しを削除' })
      .parentElement!;
    expect(label).toHaveAttribute('maxlength', '40');
    expect(label).not.toHaveAttribute('aria-label');
    expect(label.closest('label')?.querySelector('span')).toHaveClass(
      'mb-1',
      'block',
      'text-xs',
      'font-medium',
      'text-slate-600',
    );
    expect(within(row).queryByPlaceholderText('https://')).not.toBeInTheDocument();
    expect(
      within(row).queryByRole('textbox', { name: '画像 URL (任意)' }),
    ).not.toBeInTheDocument();
    expect(
      within(row).queryByRole('button', { name: /注目/ }),
    ).not.toBeInTheDocument();
    expect(
      within(row).queryByRole('checkbox', { name: '埋め込み表示' }),
    ).not.toBeInTheDocument();

    fireEvent.change(label, { target: { value: 'おすすめ' } });
    expect(
      screen.getByRole('heading', { level: 2, name: 'おすすめ' }),
    ).toBeInTheDocument();

    fireEvent.click(
      within(row).getByRole('button', { name: '見出しを削除' }),
    );
    expect(
      screen.queryByRole('textbox', { name: '見出し' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { level: 2, name: 'おすすめ' }),
    ).not.toBeInTheDocument();
  });

  it('見出しと通常リンクを同じ既存 drag 機構で並べ替えできる', () => {
    renderWithIntl(<HandleProfileBuilder />);
    fireEvent.click(
      screen.getByText('＋ リンクを追加'),
    );
    fireEvent.click(
      screen.getByRole('button', { name: '＋ 見出しを追加' }),
    );
    fireEvent.change(screen.getByRole('textbox', { name: 'ラベル' }), {
      target: { value: 'Blog' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: '見出し' }), {
      target: { value: 'News' },
    });

    const grips = screen.getAllByLabelText('ドラッグで並べ替え');
    expect(grips).toHaveLength(2);
    fireEvent.dragStart(grips[1]);
    fireEvent.drop(grips[0].parentElement!);

    const reordered = screen.getAllByLabelText('ドラッグで並べ替え');
    expect(
      within(reordered[0].parentElement!).getByRole('textbox', {
        name: '見出し',
      }),
    ).toHaveValue('News');
    expect(
      within(reordered[1].parentElement!).getByRole('textbox', {
        name: 'ラベル',
      }),
    ).toHaveValue('Blog');
  });

  it('見出しを含む全行で上限を共有し、満杯では両方の追加を止める', () => {
    renderWithIntl(<HandleProfileBuilder />);
    for (let i = 0; i < MAX_PROFILE_LINKS / 2; i += 1) {
      fireEvent.click(
        screen.getByText('＋ リンクを追加'),
      );
      fireEvent.click(
        screen.getByRole('button', { name: '＋ 見出しを追加' }),
      );
    }

    expect(
      screen.getAllByLabelText('ドラッグで並べ替え'),
    ).toHaveLength(MAX_PROFILE_LINKS);
    expect(
      screen.queryByText('＋ リンクを追加'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: '＋ 見出しを追加' }),
    ).not.toBeInTheDocument();

    fireEvent.click(
      screen.getAllByRole('button', { name: '見出しを削除' })[0],
    );
    expect(
      screen.getByText('＋ リンクを追加'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: '＋ 見出しを追加' }),
    ).toBeInTheDocument();
  });

  it('featured は通常リンクだけに隔離し、見出しへプロパティを混入させない', async () => {
    renderWithIntl(<HandleProfileBuilder />);
    fireEvent.click(
      screen.getByText('＋ リンクを追加'),
    );
    fireEvent.click(
      screen.getByRole('button', { name: '＋ 見出しを追加' }),
    );
    fireEvent.click(
      screen.getByText('＋ リンクを追加'),
    );

    const headingRow = screen.getByRole('button', {
      name: '見出しを削除',
    }).parentElement!;
    expect(
      within(headingRow).queryByRole('button', { name: /注目/ }),
    ).not.toBeInTheDocument();
    const toggles = screen.getAllByRole('button', { name: /注目/ });
    expect(toggles).toHaveLength(2);
    fireEvent.click(toggles[0]);
    fireEvent.click(screen.getAllByRole('button', { name: /注目/ })[1]);

    const after = screen.getAllByRole('button', { name: /注目/ });
    expect(after[0]).toHaveAttribute('aria-pressed', 'false');
    expect(after[1]).toHaveAttribute('aria-pressed', 'true');
    await waitFor(() => {
      const stored = JSON.parse(
        localStorage.getItem('openpay:handle-profile-draft:v1') ?? '{}',
      ) as { links?: Array<Record<string, unknown>> };
      expect(stored.links?.[1]).toEqual({ kind: 'heading', label: '' });
    });
  });

  it('「注目」トグルは 1 本だけ ON (別行を ON にすると前行は自動 OFF)', () => {
    renderWithIntl(<HandleProfileBuilder />);
    fireEvent.click(screen.getByText('＋ リンクを追加'));
    fireEvent.click(screen.getByText('＋ リンクを追加'));
    const toggles = screen.getAllByRole('button', { name: /注目/ });
    expect(toggles).toHaveLength(2);
    // 1 行目を注目に。
    fireEvent.click(toggles[0]);
    expect(toggles[0]).toHaveAttribute('aria-pressed', 'true');
    expect(toggles[1]).toHaveAttribute('aria-pressed', 'false');
    // 2 行目を注目に → 1 行目は自動 OFF (単一 enforce)。
    fireEvent.click(screen.getAllByRole('button', { name: /注目/ })[1]);
    const after = screen.getAllByRole('button', { name: /注目/ });
    expect(after[0]).toHaveAttribute('aria-pressed', 'false');
    expect(after[1]).toHaveAttribute('aria-pressed', 'true');
  });
});
