import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/react';
import { renderWithIntl as render } from '../_helpers/i18n';

const hold = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  platform: 'other' as 'ios' | 'android' | 'other',
  standalone: false,
}));
vi.mock('@/hooks/useStoreGasWallet', () => ({
  useStoreGasWallet: () => hold.state,
}));
// 端末の種類とホーム画面のアプリかどうか (iPhone・iPad のブラウザでは鍵が消えうる)。
vi.mock('@/lib/walletDeepLink', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/walletDeepLink')>()),
  detectMobilePlatform: () => hold.platform,
}));
vi.mock('@/hooks/usePwaDisplayMode', () => ({
  usePwaDisplayMode: () => ({ isStandalone: hold.standalone }),
}));
// 補充 (wagmi を使う) は別のテストで確かめる。ここでは渡すチェーンだけ見る。
vi.mock('@/components/StoreGasWalletTopUp', () => ({
  StoreGasWalletTopUp: ({
    chains,
    onPendingChange,
  }: {
    chains: { chainId: number }[];
    onPendingChange?: (p: boolean) => void;
  }) => (
    <div data-testid="topup">
      {chains.map((c) => c.chainId).join(',')}
      <button type="button" onClick={() => onPendingChange?.(true)}>
        topup-start
      </button>
      <button type="button" onClick={() => onPendingChange?.(false)}>
        topup-end
      </button>
    </div>
  ),
}));

import { StoreGasWalletPanel } from '@/components/StoreGasWalletPanel';

const ADDR = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const TX = `0x${'ab'.repeat(32)}`;

type ChainRead = { balance?: bigint | null; gasPrice?: bigint | null; readFailed?: boolean };
const AMOY = { id: 80002, name: 'Polygon Amoy' };
const KAIROS = { id: 1001, name: 'Kairos' };
function chain(c: { id: number; name: string }, read: ChainRead & { active?: boolean } = {}) {
  return { chainId: c.id, chain: c, active: true, balance: null, gasPrice: null, readFailed: false, ...read };
}

/** 既定は Amoy だけ。balance/gasPrice/readFailed は Amoy の読み取り (chains を渡せば複数チェーン)。 */
function base({ balance, gasPrice, readFailed, ...over }: Record<string, unknown> & ChainRead = {}) {
  return {
    chains: [chain(AMOY, { balance: balance ?? null, gasPrice: gasPrice ?? null, readFailed: readFailed ?? false })],
    hydrated: true,
    walletState: { state: 'none' },
    address: null,
    withdrawStatus: { phase: 'idle' },
    removeBlocked: false,
    staleTopUps: [],
    refreshStaleTopUps: vi.fn(),
    refresh: vi.fn(),
    create: vi.fn(async () => ({ ok: true })),
    remove: vi.fn(async () => true),
    withdraw: vi.fn(async () => ({ phase: 'confirmed', chainId: 80002, hash: TX })),
    ...over,
  };
}

function ready(over: Record<string, unknown> & ChainRead = {}) {
  return base({ walletState: { state: 'ok', info: { address: ADDR, createdAt: 1 } }, address: ADDR, ...over });
}

describe('StoreGasWalletPanel', () => {
  beforeEach(() => {
    hold.state = base();
    hold.platform = 'other';
    hold.standalone = false;
  });

  it('未作成: 説明と注意 (鍵は端末だけ・少額・JPYC を入れない) と作成ボタン', () => {
    render(<StoreGasWalletPanel />);
    expect(screen.getByText('お店の端末のガス用ウォレット')).toBeTruthy();
    expect(screen.getByText(/OpenPay は預かりません/)).toBeTruthy();
    expect(screen.getByText(/JPYC は入れないでください/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'この端末にガス用ウォレットを作る' }));
    expect(hold.state.create).toHaveBeenCalled();
  });

  it('読み込む前は「無い」と知らせない (タブを戻ったときに送信中の支払いを消さない)・読み込んだら知らせる', () => {
    const onAddressChange = vi.fn();
    hold.state = base({ hydrated: false, walletState: null });
    const r = render(<StoreGasWalletPanel onAddressChange={onAddressChange} />);
    expect(onAddressChange).not.toHaveBeenCalled();
    hold.state = ready();
    r.rerender(<StoreGasWalletPanel onAddressChange={onAddressChange} />);
    expect(onAddressChange).toHaveBeenCalledTimes(1);
    expect(onAddressChange).toHaveBeenLastCalledWith(ADDR);
  });

  it('使えるガス用ウォレットのアドレスを知らせる (無いときは null)・切替は出さない (決済QRタブの決済モードで選ぶ)', () => {
    const onAddressChange = vi.fn();
    const { unmount } = render(<StoreGasWalletPanel onAddressChange={onAddressChange} />);
    expect(onAddressChange).toHaveBeenLastCalledWith(null);
    unmount();
    hold.state = ready();
    render(<StoreGasWalletPanel onAddressChange={onAddressChange} />);
    expect(onAddressChange).toHaveBeenLastCalledWith(ADDR);
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('保存できない端末では作れなかったと出す', async () => {
    hold.state = base({ create: vi.fn(async () => ({ ok: false, reason: 'storage_unavailable' })) });
    render(<StoreGasWalletPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'この端末にガス用ウォレットを作る' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/保存できませんでした/);
  });

  it('保存データが壊れているときは作るボタンを出さず、上書きしない旨を出す', () => {
    hold.state = base({ walletState: { state: 'corrupt' } });
    render(<StoreGasWalletPanel />);
    expect(screen.queryByRole('button', { name: 'この端末にガス用ウォレットを作る' })).toBeNull();
    expect(screen.getByText(/上書きを防ぐため、新しく作れません/)).toBeTruthy();
  });

  it('作成済み: アドレス・残高・残り回数・少ないときの注意', () => {
    hold.state = ready({ balance: 10n ** 16n, gasPrice: 30n * 10n ** 9n });
    render(<StoreGasWalletPanel />);
    expect(screen.getByText(ADDR)).toBeTruthy();
    expect(screen.getAllByText('0.01 POL').length).toBeGreaterThan(0);
    expect(screen.getByText('あと約 1 回送れます')).toBeTruthy();
    expect(screen.getByText('残りわずか・POL を入れてください')).toBeTruthy();
  });

  it('残高を読めないときは 0 と見せず「読めませんでした」', () => {
    hold.state = ready({ readFailed: true });
    render(<StoreGasWalletPanel />);
    expect(screen.getByText('残高を読めませんでした')).toBeTruthy();
  });

  it('戻し先の欄は見出しで名前が付き、確認してから送る', () => {
    hold.state = ready({ balance: 10n ** 18n, gasPrice: 1n });
    render(<StoreGasWalletPanel />);
    expect(screen.queryByRole('combobox')).toBeNull(); // チェーンが 1 つなら選ばせない
    const input = screen.getByRole('textbox', { name: '残りを戻す' });
    fireEvent.change(input, { target: { value: '0x1111111111111111111111111111111111111111' } });
    fireEvent.click(screen.getByRole('button', { name: '戻す' }));
    expect(screen.getByText(/残りの POL を、Polygon Amoy でこのアドレスに送ります。.*少額が残ることがあります/)).toBeTruthy();
    expect(hold.state.withdraw).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '送る' }));
    expect(hold.state.withdraw).toHaveBeenCalledWith(80002, '0x1111111111111111111111111111111111111111');
  });

  it('結果は読み上げ領域に出す: 確定・確定待ち・不明・取り消し・拒否', () => {
    const cases: [Record<string, unknown>, RegExp, 'status' | 'alert'][] = [
      [{ phase: 'confirmed', chainId: 80002, hash: TX }, /戻しました/, 'status'],
      [{ phase: 'pending', chainId: 80002, hash: TX }, /確定を待っています/, 'status'],
      [{ phase: 'unknown', chainId: 80002, hash: TX }, /確かめられませんでした/, 'alert'],
      [{ phase: 'reverted', chainId: 80002, hash: TX }, /失敗しました/, 'alert'],
      [{ phase: 'rejected', reason: 'contract_recipient' }, /コントラクトのアドレスには戻せません/, 'alert'],
      [{ phase: 'rejected', reason: 'delegated_recipient' }, /スマートアカウント（委任）になっているため戻せません/, 'alert'],
    ];
    for (const [status, text, role] of cases) {
      hold.state = ready({ withdrawStatus: status });
      const { unmount } = render(<StoreGasWalletPanel />);
      expect(screen.getByRole(role)).toHaveTextContent(text);
      unmount();
    }
  });

  it('確定待ちの間は消せない', () => {
    hold.state = ready({ withdrawStatus: { phase: 'pending', chainId: 80002, hash: TX }, removeBlocked: true });
    render(<StoreGasWalletPanel />);
    expect(screen.getByRole('button', { name: 'この端末から消す' })).toBeDisabled();
    expect(screen.getByText(/確定を待っている間は消せません/)).toBeTruthy();
  });

  it('消す: 残高があるときは先に戻すよう注意し、確認してから消す・消せなければそう出す', async () => {
    hold.state = ready({ balance: 10n ** 18n, gasPrice: 1n, remove: vi.fn(async () => false) });
    render(<StoreGasWalletPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'この端末から消す' }));
    expect(screen.getByText(/まだ 1 POL 残っています/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '消す' }));
    expect(hold.state.remove).toHaveBeenCalled();
    expect(await screen.findByText('この端末から消せませんでした。もう一度お試しください。')).toBeTruthy();
  });

  it('複数チェーン: 残高・残り回数・少ないときの注意はチェーンごと (通貨の記号つき)', () => {
    hold.state = ready({
      chains: [
        chain(AMOY, { balance: 10n ** 18n, gasPrice: 1n }),
        chain(KAIROS, { balance: 10n ** 16n, gasPrice: 30n * 10n ** 9n }),
      ],
    });
    render(<StoreGasWalletPanel />);
    expect(screen.getAllByText('1 POL').length).toBeGreaterThan(0);
    expect(screen.getAllByText('0.01 KAIA').length).toBeGreaterThan(0);
    expect(screen.getByText('残りわずか・KAIA を入れてください')).toBeTruthy();
    expect(screen.queryByText('残りわずか・POL を入れてください')).toBeNull();
    // 入金の案内に、対象のチェーンの通貨を並べる (チェーン名は残高の行にマーク付きで出る)
    expect(screen.getByText('ここに POL・KAIA を送って入れます。')).toBeTruthy();
  });

  it('複数チェーン: 戻すチェーンを選び、確認文とお金の動きはそのチェーン', () => {
    hold.state = ready({
      chains: [chain(AMOY, { balance: 10n ** 18n, gasPrice: 1n }), chain(KAIROS, { balance: 10n ** 18n, gasPrice: 1n })],
    });
    render(<StoreGasWalletPanel />);
    fireEvent.change(screen.getByRole('combobox', { name: '戻すチェーン' }), { target: { value: '1001' } });
    fireEvent.change(screen.getByRole('textbox', { name: '残りを戻す' }), {
      target: { value: '0x1111111111111111111111111111111111111111' },
    });
    fireEvent.click(screen.getByRole('button', { name: '戻す' }));
    expect(screen.getByText(/残りの KAIA を、Kairos でこのアドレスに送ります/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '送る' }));
    expect(hold.state.withdraw).toHaveBeenCalledWith(1001, '0x1111111111111111111111111111111111111111');
  });

  it('使えないチェーンは、残高があるときだけ出し、戻せる (説明・入金の案内には出さない)', () => {
    const FUJI = { id: 43113, name: 'Avalanche Fuji' };
    hold.state = ready({
      chains: [
        chain(AMOY, { balance: 10n ** 18n, gasPrice: 1n }),
        chain(KAIROS, { balance: 2n * 10n ** 18n, gasPrice: 1n, active: false }),
        chain(FUJI, { balance: 0n, gasPrice: 1n, active: false }),
      ],
    });
    render(<StoreGasWalletPanel />);
    expect(screen.getAllByText('2 KAIA').length).toBeGreaterThan(0);
    expect(screen.getByText(/このチェーンでは今は送れません/)).toBeTruthy();
    expect(screen.queryByText(/Avalanche Fuji/)).toBeNull(); // 残高 0 の使えないチェーンは出さない
    // 入金の案内には使えるチェーンの通貨だけ (使えない Kairos の KAIA は出さない)
    expect(screen.getByText('ここに POL を送って入れます。')).toBeTruthy();
    const options = within(screen.getByRole('combobox', { name: '戻すチェーン' })).getAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual(['Polygon Amoy (POL)', 'Kairos (KAIA)']);
  });

  it('読み取りに失敗しても、前に読めた残高があれば消す前に「先に戻して」を出す (見出しと残り回数には古い値を出さない)', () => {
    hold.state = ready({ balance: 10n ** 18n, gasPrice: 1n, readFailed: true });
    render(<StoreGasWalletPanel />);
    expect(screen.getByText('残高を読めませんでした')).toBeTruthy();
    expect(screen.queryByText('1 POL')).toBeNull();
    expect(screen.queryByText(/あと約/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'この端末から消す' }));
    expect(screen.getByText(/まだ 1 POL 残っています/)).toBeTruthy();
  });

  it('一度も読めていないチェーンがあれば、消す前にそれを知らせる', () => {
    hold.state = ready({
      chains: [chain(AMOY, { balance: 0n, gasPrice: 1n }), chain(KAIROS, { readFailed: true, active: false })],
    });
    render(<StoreGasWalletPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'この端末から消す' }));
    expect(screen.getByText(/残高を読めていないチェーンがあります/)).toBeTruthy();
  });

  it('複数チェーン: 消す前の注意は残っているチェーンの額をすべて出す', () => {
    hold.state = ready({
      chains: [chain(AMOY, { balance: 0n, gasPrice: 1n }), chain(KAIROS, { balance: 2n * 10n ** 18n, gasPrice: 1n })],
    });
    render(<StoreGasWalletPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'この端末から消す' }));
    expect(screen.getByText(/まだ 2 KAIA 残っています/)).toBeTruthy();
  });

  describe('iPhone・iPad (ブラウザは 7 日ほど操作しないとデータを消す)', () => {
    it('ブラウザでは、ホーム画面に追加したアプリで作るよう手順を出し、作るボタンは「それでも」を押してから', () => {
      hold.platform = 'ios';
      render(<StoreGasWalletPanel />);
      expect(screen.getByText('iPhone・iPad では、ホーム画面に追加した OpenPay で作ってください')).toBeTruthy();
      expect(screen.getByText(/OpenPay をタップなどで操作しないまま、ブラウザを使った日が 7 日ほどたつと、この端末に保存した鍵が消えることがあります（開くだけでは防げません/)).toBeTruthy();
      expect(screen.getByText(/ホーム画面に追加/, { selector: 'li' })).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'この端末にガス用ウォレットを作る' })).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'それでもこのブラウザで作る' }));
      fireEvent.click(screen.getByRole('button', { name: 'この端末にガス用ウォレットを作る' }));
      expect(hold.state.create).toHaveBeenCalled();
    });

    it('ブラウザで作った鍵には、消えうることと作り直し方を出し続ける', () => {
      hold.platform = 'ios';
      hold.state = ready({ balance: 10n ** 18n, gasPrice: 1n });
      render(<StoreGasWalletPanel />);
      expect(screen.getByText(/この鍵はブラウザに保存されています。OpenPay をタップなどで操作しないまま、ブラウザを使った日が 7 日ほどたつと消えることがあります/)).toBeTruthy();
    });

    it('ホーム画面のアプリでは、手順を出さずにすぐ作れる・消えにくいことを出す', () => {
      hold.platform = 'ios';
      hold.standalone = true;
      render(<StoreGasWalletPanel />);
      expect(screen.queryByText('iPhone・iPad では、ホーム画面に追加した OpenPay で作ってください')).toBeNull();
      expect(screen.getByText(/ホーム画面のアプリに保存しています/)).toBeTruthy();
      expect(screen.queryByText(/Safari を使った日が 7 日ほどたつと/)).toBeNull();
      expect(screen.queryByText(/Cookie とサイトデータを削除する設定/)).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'この端末にガス用ウォレットを作る' }));
      expect(hold.state.create).toHaveBeenCalled();
    });

    it('iPhone・iPad 以外は手順を出さずに作れる・Safari 以外 (Chrome・Brave など) は閉じるときの削除設定の注意', () => {
      hold.platform = 'android';
      render(<StoreGasWalletPanel />);
      expect(screen.queryByText('iPhone・iPad では、ホーム画面に追加した OpenPay で作ってください')).toBeNull();
      expect(screen.getByText(/閉じるたびに鍵が消えます。この端末ではその設定を OFF にしてください。/)).toBeTruthy();
      expect(screen.queryByText(/Safari を使った日が 7 日ほどたつと/)).toBeNull();
      expect(screen.getByRole('button', { name: 'この端末にガス用ウォレットを作る' })).toBeTruthy();
    });

    it.each([
      ['Mac の Safari', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15', 'safari'],
      ['Mac の Brave (Chrome と同じ UA)', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36', 'clear'],
      ['Edge', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0', 'clear'],
      ['Firefox', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.6; rv:131.0) Gecko/20100101 Firefox/131.0', 'clear'],
    ] as const)('%s → 端末に合った注意', (_, ua, kind) => {
      const original = Object.getOwnPropertyDescriptor(window.navigator, 'userAgent');
      Object.defineProperty(window.navigator, 'userAgent', { value: ua, configurable: true });
      try {
        render(<StoreGasWalletPanel />);
        const safari = screen.queryByText(/Safari を使った日が 7 日ほどたつと、この端末の鍵が消えることがあります/);
        const clear = screen.queryByText(/閉じるたびに鍵が消えます/);
        expect(!!safari).toBe(kind === 'safari');
        expect(!!clear).toBe(kind === 'clear');
      } finally {
        if (original) Object.defineProperty(window.navigator, 'userAgent', original);
        else delete (window.navigator as { userAgent?: string }).userAgent;
      }
    });
  });

  it('消されにくい保存を認められたら、そう出す (iPhone・iPad では出さない = 7 日の消去を防ぐ根拠が無い)', () => {
    hold.state = ready({ balance: 10n ** 18n, gasPrice: 1n, persisted: true });
    const r = render(<StoreGasWalletPanel />);
    expect(screen.getByText(/データを消されにくくする保存を認めてもらっています/)).toBeTruthy();
    r.unmount();
    hold.platform = 'ios';
    render(<StoreGasWalletPanel />);
    expect(screen.getByText(/この鍵はブラウザに保存されています/)).toBeTruthy();
    expect(screen.queryByText(/データを消されにくくする保存を認めてもらっています/)).toBeNull();
  });

  it('補充の欄には、新しい会計に使えるチェーンだけを渡す', () => {
    hold.state = ready({
      chains: [chain(AMOY, { balance: 10n ** 18n, gasPrice: 1n }), chain(KAIROS, { balance: 10n ** 18n, gasPrice: 1n, active: false })],
    });
    render(<StoreGasWalletPanel />);
    expect(screen.getByTestId('topup')).toHaveTextContent('80002');
    expect(screen.getByTestId('topup')).not.toHaveTextContent('1001');
  });

  it('結果を確かめられていない補充 (1 日以上) があれば、消す前にそれを知らせる (取引へのリンクつき・消すのは止めない)', () => {
    hold.state = ready({
      balance: 0n,
      gasPrice: 1n,
      staleTopUps: [{ id: 's', address: ADDR, chainId: 80002, at: 1, hash: TX }],
    });
    render(<StoreGasWalletPanel />);
    const button = screen.getByRole('button', { name: 'この端末から消す' });
    expect(button).not.toBeDisabled();
    fireEvent.click(button);
    // 確認を開く時点で記録を読み直す (古い state で警告を出し損ねない)
    expect(hold.state.refreshStaleTopUps).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/結果を確かめられていない補充があります/)).toBeTruthy();
    expect(screen.getByRole('link', { name: '取引を見る' }).getAttribute('href')).toContain(TX);
  });

  it('補充の結果が出るまでは消せない (届く途中の宛先の鍵を消さない)', () => {
    hold.state = ready({ balance: 10n ** 18n, gasPrice: 1n });
    render(<StoreGasWalletPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'topup-start' }));
    expect(screen.getByRole('button', { name: 'この端末から消す' })).toBeDisabled();
    expect(screen.getByText('補充の結果が出るまでは消せません。')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'topup-end' }));
    expect(screen.getByRole('button', { name: 'この端末から消す' })).not.toBeDisabled();
  });
});
