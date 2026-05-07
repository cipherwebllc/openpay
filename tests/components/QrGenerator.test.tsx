import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { renderWithIntl as render } from '../_helpers/i18n';
import userEvent from '@testing-library/user-event';

// AddressInput の useResolveAddress (react-query 経由で外 RPC を叩く) は
// テストでは fetch を発生させないために hook 単位でモック。0x アドレスの
// 直接入力は AddressInput 内で local 検証されるため、hook は呼ばれない。
vi.mock('@/hooks/useResolveAddress', () => ({
  useResolveAddress: vi.fn(() => ({
    data: null,
    isFetching: false,
    error: null,
  })),
}));

// useOrigin を関数経由でモックして、特定テストだけ空文字列に倒せるようにする
// (qrPlaceholderGenerating の検証で payUrl 不在 + 受信者 / 金額 valid という
//  本来は一瞬の遷移状態を再現するため)。
const useOriginMock = vi.fn(() => 'https://test.local');
vi.mock('@/hooks/useOrigin', () => ({
  useOrigin: () => useOriginMock(),
}));

import { QrGenerator } from '@/components/QrGenerator';

const VALID = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

describe('QrGenerator', () => {
  beforeEach(() => {
    window.localStorage.clear();
    useOriginMock.mockReturnValue('https://test.local');
  });

  describe('初期レンダリング', () => {
    it('LocalStorage 空: アコーディオンは開いていて、JPYC が active (default)', async () => {
      render(<QrGenerator />);
      await waitFor(() => {
        expect(
          screen.getByRole('button', { name: /^JPYC\s+Polygon/ }),
        ).toBeInTheDocument();
      });
      const usdcBtn = screen.getByRole('button', { name: /USDC/ });
      const jpycBtn = screen.getByRole('button', { name: /^JPYC\s+Polygon/ });
      expect(jpycBtn.className).toMatch(/border-brand/);
      expect(usdcBtn.className).not.toMatch(/border-brand/);
    });

    it('LocalStorage に有効アドレス + gasMode=merchant: サマリに gas:merch が出る', async () => {
      window.localStorage.setItem(
        'openpay:qr-settings:v2',
        JSON.stringify({
          receiver: VALID,
          token: 'usdc',
          chain: 'base',
          gasMode: 'merchant',
          directTransfer: false,
        }),
      );
      render(<QrGenerator />);
      await waitFor(() => {
        const toggle = screen.getByRole('button', { name: /詳細設定/ });
        expect(toggle.getAttribute('aria-expanded')).toBe('false');
      });
      const toggle = screen.getByRole('button', { name: /詳細設定/ });
      // direct=false / gasMode=merchant → tail = "gas:merch"
      expect(within(toggle).getByText(/gas:merch/)).toBeInTheDocument();
    });

    it('LocalStorage に有効アドレス: アコーディオンは閉じてサマリ表示', async () => {
      window.localStorage.setItem(
        'openpay:qr-settings:v2',
        JSON.stringify({
          receiver: VALID,
          token: 'jpyc',
          directTransfer: false,
        }),
      );
      render(<QrGenerator />);
      await waitFor(() => {
        const toggle = screen.getByRole('button', { name: /詳細設定/ });
        expect(toggle.getAttribute('aria-expanded')).toBe('false');
      });
      const toggle = screen.getByRole('button', { name: /詳細設定/ });
      expect(within(toggle).getByText(/JPYC/)).toBeInTheDocument();
      expect(within(toggle).getByText(/0x8335/)).toBeInTheDocument();
      // gasMode default = customer → "gas:cust" 表記
      expect(within(toggle).getByText(/gas:cust/)).toBeInTheDocument();
    });

    it('LocalStorage に無効アドレス: アコーディオン展開のままで修正を促す', async () => {
      window.localStorage.setItem(
        'openpay:qr-settings:v2',
        JSON.stringify({
          receiver: 'not-an-address',
          token: 'usdc',
          directTransfer: false,
        }),
      );
      render(<QrGenerator />);
      await waitFor(() => {
        const toggle = screen.getByRole('button', { name: /詳細設定/ });
        expect(toggle.getAttribute('aria-expanded')).toBe('true');
      });
    });
  });

  describe('入力 / 状態遷移', () => {
    it('有効アドレス + 金額 → QR (SVG) が描画される', async () => {
      const user = userEvent.setup();
      const { container } = render(<QrGenerator />);
      await waitFor(() => screen.getByPlaceholderText(/0x\.\.\./));

      await user.type(screen.getByPlaceholderText(/0x\.\.\./), VALID);
      await user.type(screen.getByPlaceholderText('1000'), '12.5');

      await waitFor(() => {
        expect(container.querySelector('svg')).not.toBeNull();
      });
      expect(
        screen.getByText((t) => t.includes('amount=12.5')),
      ).toBeInTheDocument();
      // gasless 既定なので mode は URL に出ない
      expect(
        screen.queryByText((t) => t.includes('mode=')),
      ).toBeNull();
    });

    it('据え置きモードへ切替: 金額入力が消えてもメッセージが出る', async () => {
      const user = userEvent.setup();
      render(<QrGenerator />);
      await waitFor(() => screen.getByPlaceholderText(/0x\.\.\./));
      await user.type(screen.getByPlaceholderText(/0x\.\.\./), VALID);

      await user.click(screen.getByRole('button', { name: /据え置き/ }));

      expect(screen.queryByPlaceholderText('10.00')).toBeNull();
      expect(
        screen.getByText(/据え置き QR では金額を顧客が入力/),
      ).toBeInTheDocument();
    });

    it('数値以外は除去される (10ab.5 → 10.5)', async () => {
      const user = userEvent.setup();
      render(<QrGenerator />);
      await waitFor(() => screen.getByPlaceholderText('1000'));
      const input = screen.getByPlaceholderText('1000') as HTMLInputElement;
      await user.type(input, '10ab.5');
      expect(input.value).toBe('10.5');
    });

    it('クイック金額ボタンでレジ入力を即時反映する', async () => {
      const user = userEvent.setup();
      render(<QrGenerator />);
      await waitFor(() => screen.getByPlaceholderText('1000'));

      await user.click(screen.getByRole('button', { name: /1500 JPYC/ }));

      const input = screen.getByPlaceholderText('1000') as HTMLInputElement;
      expect(input.value).toBe('1500');
    });

    it('店舗名とポスター補足文が印刷プレビューに反映される', async () => {
      const user = userEvent.setup();
      render(<QrGenerator />);
      await waitFor(() => screen.getByPlaceholderText(/0x\.\.\./));
      await user.type(screen.getByPlaceholderText(/0x\.\.\./), VALID);
      await user.type(screen.getByPlaceholderText('1000'), '750');

      await user.type(
        screen.getByPlaceholderText(/OpenPay Coffee/),
        'Kanda Coffee',
      );
      await user.type(
        screen.getByPlaceholderText(/完了画面をスタッフ/),
        'Show success screen',
      );

      expect(screen.getByText('Kanda Coffee')).toBeInTheDocument();
      expect(screen.getByText('Show success screen')).toBeInTheDocument();
      expect(screen.getByText('750 JPYC')).toBeInTheDocument();
    });

    it('クイック金額を編集して追加ボタンに反映する', async () => {
      const user = userEvent.setup();
      render(<QrGenerator />);
      await waitFor(() => screen.getByPlaceholderText(/0x\.\.\./));

      await user.click(screen.getByRole('button', { name: /\+ 金額を追加/ }));
      const inputs = screen.getAllByPlaceholderText(/例: 1000/);
      await user.type(inputs[inputs.length - 1], '2500');

      expect(
        screen.getByRole('button', { name: /2500 JPYC/ }),
      ).toBeInTheDocument();
    });

    it('クイック金額: token 切替で現 token decimals に truncate (JPYC→USDC で重複は dedup)', async () => {
      // JPYC (18 decimals) で高精度クイック金額を保存した状態で USDC (6 decimals) に
      // 切替えた場合、ボタン表示・クリック時の amount 反映ともに USDC の decimals に
      // truncate される必要がある。truncate 後に重複した値は 1 つにマージ。
      // receiver は意図的に未設定: accordion を開いた状態で token tab を露出する。
      window.localStorage.setItem(
        'openpay:qr-settings:v2',
        JSON.stringify({
          token: 'jpyc',
          chain: 'polygon',
          receiver: '',
          gasMode: 'customer',
          directTransfer: false,
          splits: [],
          storeName: '',
          posterNote: '',
          quickAmounts: ['0.1234567890123', '0.1234567890124', '500'],
        }),
      );
      const user = userEvent.setup();
      render(<QrGenerator />);
      await waitFor(() => screen.getByPlaceholderText('1000'));

      expect(
        screen.getByRole('button', { name: /0\.1234567890123 JPYC/ }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: /0\.1234567890124 JPYC/ }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: /^500 JPYC/ }),
      ).toBeInTheDocument();

      // USDC token tab へ切替 (accordion 内、左カラムの token grid)
      await user.click(screen.getByRole('button', { name: /^USDC/ }));

      // 高精度 2 件はどちらも 0.123456 (USDC 6 dec) に潰れて 1 ボタンに dedup
      const truncated = screen.getAllByRole('button', {
        name: /0\.123456 USDC/,
      });
      expect(truncated.length).toBe(1);
      expect(
        screen.getByRole('button', { name: /^500 USDC/ }),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: /0\.1234567890123/ }),
      ).toBeNull();
      expect(
        screen.queryByRole('button', { name: /0\.1234567890124/ }),
      ).toBeNull();

      // ボタン押下で truncate 後の値そのまま input に反映される (元の高精度値ではない)
      await user.click(truncated[0]);
      const input = screen.getByPlaceholderText('10.00') as HTMLInputElement;
      expect(input.value).toBe('0.123456');
    });

    it('クイック金額の × 削除: 中間 index を削除しても他要素が詰まらない (off-by-one なし)', async () => {
      const user = userEvent.setup();
      render(<QrGenerator />);
      await waitFor(() => screen.getByPlaceholderText('1000'));

      // 既定 ['500','1000','1500','3000'] のうち 2 番目 (1000) を削除
      const editInputs = screen.getAllByPlaceholderText(/例: 1000/);
      expect(editInputs.length).toBe(4);
      expect((editInputs[1] as HTMLInputElement).value).toBe('1000');

      const removeBtns = screen.getAllByRole('button', { name: /^クイック金額/ });
      expect(removeBtns.length).toBe(4);
      await user.click(removeBtns[1]);

      // 1000 だけ抜けて 500 / 1500 / 3000 の 3 件が正しい順序で残る
      const after = screen.getAllByPlaceholderText(/例: 1000/);
      expect(after.length).toBe(3);
      expect((after[0] as HTMLInputElement).value).toBe('500');
      expect((after[1] as HTMLInputElement).value).toBe('1500');
      expect((after[2] as HTMLInputElement).value).toBe('3000');
      // 表示側 (activeQuickAmounts) も同期: 1000 のクイックボタンは消える
      expect(
        screen.queryByRole('button', { name: /1000 JPYC/ }),
      ).toBeNull();
    });

    it('クイック金額: 4 件全部削除しても空 input が 1 行残る (UI 不変条件)', async () => {
      const user = userEvent.setup();
      render(<QrGenerator />);
      await waitFor(() => screen.getByPlaceholderText('1000'));

      // 全 4 件を順に削除
      for (let i = 0; i < 4; i++) {
        const removeBtns = screen.getAllByRole('button', {
          name: /^クイック金額/,
        });
        await user.click(removeBtns[0]);
      }

      // 空 input が 1 行残り、編集できる状態になっている
      const remaining = screen.getAllByPlaceholderText(/例: 1000/);
      expect(remaining.length).toBe(1);
      expect((remaining[0] as HTMLInputElement).value).toBe('');
      // クイックボタン (表示側) は何も表示されない
      expect(screen.queryAllByRole('button', { name: /JPYC$/ }).length).toBe(0);
    });

    it('クイック金額の上限 (8 件) に到達すると + 追加ボタンが消える', async () => {
      // 既定 4 件 + 4 回押下 → 8 件
      const user = userEvent.setup();
      render(<QrGenerator />);
      await waitFor(() => screen.getByPlaceholderText('1000'));

      const addBtn = screen.getByRole('button', { name: /\+ 金額を追加/ });
      await user.click(addBtn);
      await user.click(addBtn);
      await user.click(addBtn);
      await user.click(addBtn);

      expect(screen.getAllByPlaceholderText(/例: 1000/).length).toBe(8);
      expect(
        screen.queryByRole('button', { name: /\+ 金額を追加/ }),
      ).toBeNull();
    });

    it('受取人を split 中間 index で削除しても残りが正しい順序で残る (off-by-one なし)', async () => {
      const user = userEvent.setup();
      render(<QrGenerator />);
      await waitFor(() => screen.getByPlaceholderText(/0x\.\.\./));
      await user.type(screen.getByPlaceholderText(/0x\.\.\./), VALID);

      // 受取人 3 人追加 → 0xA / 0xB / 0xC の順
      const addSplit = screen.getByRole('button', { name: /\+ 受取人を追加/ });
      await user.click(addSplit);
      await user.click(addSplit);
      await user.click(addSplit);

      const splitInputs = screen.getAllByPlaceholderText('0x...');
      expect(splitInputs.length).toBe(3);
      await user.type(splitInputs[0], '0xA');
      await user.type(splitInputs[1], '0xB');
      await user.type(splitInputs[2], '0xC');

      // 中間 (0xB) を削除
      const removeBtns = screen.getAllByRole('button', { name: /^削除$/ });
      expect(removeBtns.length).toBe(3);
      await user.click(removeBtns[1]);

      // 0xA / 0xC が残る (0xB だけ抜ける)
      const after = screen.getAllByPlaceholderText('0x...');
      expect(after.length).toBe(2);
      expect((after[0] as HTMLInputElement).value).toBe('0xA');
      expect((after[1] as HTMLInputElement).value).toBe('0xC');
    });

    it('クイック金額: token 切替後の truncate 結果が 0 になるエントリは除外', async () => {
      // JPYC (18 dec) で 0.0000001 (7 fracs, valid) を保存 → USDC (6 dec) では
      // sanitizeAmount で '0.000000' に潰れる (Number=0) → activeQuickAmounts は
      // 0 値を弾く必要がある (Number(truncated) <= 0 分岐)。
      window.localStorage.setItem(
        'openpay:qr-settings:v2',
        JSON.stringify({
          token: 'jpyc',
          chain: 'polygon',
          receiver: '',
          gasMode: 'customer',
          directTransfer: false,
          splits: [],
          storeName: '',
          posterNote: '',
          quickAmounts: ['0.0000001', '500'],
        }),
      );
      const user = userEvent.setup();
      render(<QrGenerator />);
      await waitFor(() => screen.getByPlaceholderText('1000'));

      // JPYC では両方表示
      expect(
        screen.getByRole('button', { name: /0\.0000001 JPYC/ }),
      ).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: /^USDC/ }));

      // 0.0000001 は USDC で truncate→'0.000000' (=0) になり除外、500 のみ残る
      expect(
        screen.queryByRole('button', { name: /^0(\.0+)? USDC/ }),
      ).toBeNull();
      expect(
        screen.getByRole('button', { name: /^500 USDC/ }),
      ).toBeInTheDocument();
    });

    it('受信者を 3 人追加すると + 受取人を追加 ボタン自体が非表示になる (UI 条件付きレンダ)', async () => {
      // 関数内の `if (length >= MAX) return` ガードは button 条件付きレンダで unreachable。
      // このテストは UI 条件レンダの機能のみ検証する。
      const user = userEvent.setup();
      render(<QrGenerator />);
      await waitFor(() => screen.getByPlaceholderText(/0x\.\.\./));
      await user.type(screen.getByPlaceholderText(/0x\.\.\./), VALID);

      const addBtn = screen.getByRole('button', { name: /\+ 受取人を追加/ });
      await user.click(addBtn);
      await user.click(addBtn);
      await user.click(addBtn);

      expect(screen.getAllByPlaceholderText('0x...').length).toBe(3);
      // SPLIT_MAX_ENTRIES (3) 到達で button が DOM から消える
      expect(
        screen.queryByRole('button', { name: /\+ 受取人を追加/ }),
      ).toBeNull();
    });

    it('受信者 / 金額 valid + payUrl 空 → "生成中" プレースホルダ表示', async () => {
      // useOrigin を空に倒すと payUrl 計算が短絡 → QR ではなく「生成中」が出る。
      // hydrate 直後 / SSR 中継時の一瞬の遷移状態を再現。
      useOriginMock.mockReturnValue('');
      const user = userEvent.setup();
      render(<QrGenerator />);
      await waitFor(() => screen.getByPlaceholderText(/0x\.\.\./));
      await user.type(screen.getByPlaceholderText(/0x\.\.\./), VALID);
      await user.type(screen.getByPlaceholderText('1000'), '750');

      // payUrl が出ない → placeholder が描画される。受信者 + 金額両方 valid の枝。
      expect(screen.getByText(/生成中|generating/i)).toBeInTheDocument();
      // QR (SVG) と SVG保存ボタンは出ていない
      expect(screen.queryByRole('button', { name: /SVG保存/ })).toBeNull();
    });

    it('gas トグル: 切替で URL に gas=merchant が付く / 外れる', async () => {
      const user = userEvent.setup();
      render(<QrGenerator />);
      await waitFor(() => screen.getByPlaceholderText(/0x\.\.\./));
      await user.type(screen.getByPlaceholderText(/0x\.\.\./), VALID);
      await user.type(screen.getByPlaceholderText('1000'), '5');

      // 既定は customer → URL に gas= は付かない
      await waitFor(() => {
        expect(
          screen.queryByText((t) => t.includes('gas=')),
        ).toBeNull();
      });

      // 店主 gas 負担ボタン → URL に gas=merchant が出る
      await user.click(screen.getByRole('button', { name: /店主が gas 負担/ }));
      await waitFor(() => {
        expect(
          screen.getByText((t) => t.includes('gas=merchant')),
        ).toBeInTheDocument();
      });

      // 顧客 gas 負担に戻す → gas= が消える
      await user.click(screen.getByRole('button', { name: /顧客が gas 負担/ }));
      await waitFor(() => {
        expect(
          screen.queryByText((t) => t.includes('gas=')),
        ).toBeNull();
      });
    });

    it('店主 gas 負担モード: localStorage に gasMode=merchant が保存される', async () => {
      const user = userEvent.setup();
      render(<QrGenerator />);
      await waitFor(() =>
        screen.getByRole('button', { name: /店主が gas 負担/ }),
      );
      await user.click(screen.getByRole('button', { name: /店主が gas 負担/ }));

      await waitFor(() => {
        const raw = window.localStorage.getItem('openpay:qr-settings:v2');
        expect(raw).not.toBeNull();
        expect(JSON.parse(raw!).gasMode).toBe('merchant');
      });
    });

    it('直接送金 ON で gas トグル UI が消える', async () => {
      const user = userEvent.setup();
      render(<QrGenerator />);
      await waitFor(() => screen.getByRole('checkbox', { name: /直接送金/ }));
      // 切替前は表示
      expect(
        screen.getByRole('button', { name: /顧客が gas 負担/ }),
      ).toBeInTheDocument();
      // 直接送金 ON
      await user.click(screen.getByRole('checkbox', { name: /直接送金/ }));
      // トグル消失
      expect(
        screen.queryByRole('button', { name: /顧客が gas 負担/ }),
      ).toBeNull();
    });

    it('JPYC タブへ切替で chainId 表記が変わる', async () => {
      const user = userEvent.setup();
      render(<QrGenerator />);
      await waitFor(() =>
        screen.getByRole('button', { name: /^JPYC\s+Polygon/ }),
      );
      await user.click(screen.getByRole('button', { name: /^JPYC\s+Polygon/ }));
      // JPYC 用プレースホルダ '1000' に切替
      expect(screen.getByPlaceholderText('1000')).toBeInTheDocument();
    });
  });

  describe('アコーディオン操作', () => {
    it('クリックで開閉が切り替わる', async () => {
      const user = userEvent.setup();
      window.localStorage.setItem(
        'openpay:qr-settings:v2',
        JSON.stringify({
          receiver: VALID,
          token: 'usdc',
          directTransfer: false,
        }),
      );
      render(<QrGenerator />);
      const toggle = await screen.findByRole('button', {
        name: /詳細設定/,
      });
      await waitFor(() =>
        expect(toggle.getAttribute('aria-expanded')).toBe('false'),
      );
      await user.click(toggle);
      expect(toggle.getAttribute('aria-expanded')).toBe('true');
      await user.click(toggle);
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
    });
  });

  describe('直接送金 (上級者) トグル', () => {
    it('チェックすると URL に mode=direct が出る + 説明バッジが表示される', async () => {
      const user = userEvent.setup();
      render(<QrGenerator />);
      await waitFor(() => screen.getByPlaceholderText(/0x\.\.\./));
      await user.type(screen.getByPlaceholderText(/0x\.\.\./), VALID);
      await user.type(screen.getByPlaceholderText('1000'), '5');

      const directCheckbox = screen.getByRole('checkbox', {
        name: /直接送金/,
      });
      await user.click(directCheckbox);

      // URL に mode=direct が出る
      await waitFor(() => {
        expect(
          screen.getByText((t) => t.includes('mode=direct')),
        ).toBeInTheDocument();
      });

      // direct モードの説明バッジが表示される
      expect(
        screen.getByText(/直接送金モード: 運営手数料 0%/),
      ).toBeInTheDocument();

      // 「運営手数料の徴収先」エリアは消える
      expect(screen.queryByText(/運営手数料の徴収先/)).toBeNull();
    });

    it('LocalStorage に永続化される', async () => {
      const user = userEvent.setup();
      render(<QrGenerator />);
      await waitFor(() =>
        screen.getByRole('checkbox', { name: /直接送金/ }),
      );
      await user.click(screen.getByRole('checkbox', { name: /直接送金/ }));

      await waitFor(() => {
        const raw = window.localStorage.getItem('openpay:qr-settings:v2');
        expect(raw).not.toBeNull();
        const parsed = JSON.parse(raw!);
        expect(parsed.directTransfer).toBe(true);
      });
    });

    it('directTransfer=true でアコーディオン閉時のサマリに 0% と出る', async () => {
      window.localStorage.setItem(
        'openpay:qr-settings:v2',
        JSON.stringify({
          receiver: VALID,
          token: 'usdc',
          directTransfer: true,
        }),
      );
      render(<QrGenerator />);
      const toggle = await screen.findByRole('button', {
        name: /詳細設定/,
      });
      // 自動閉じ
      await waitFor(() =>
        expect(toggle.getAttribute('aria-expanded')).toBe('false'),
      );
      // i18n 後は言語非依存の "0%" 表記
      expect(within(toggle).getByText(/0%/)).toBeInTheDocument();
    });
  });

  describe('EIP-681 互換 QR セクション', () => {
    it('既定 (gasless) では section ごと非表示', async () => {
      const user = userEvent.setup();
      render(<QrGenerator />);
      await waitFor(() => screen.getByPlaceholderText(/0x\.\.\./));
      await user.type(screen.getByPlaceholderText(/0x\.\.\./), VALID);
      await user.type(screen.getByPlaceholderText('1000'), '5');

      expect(screen.queryByText(/互換 QR \(EIP-681\)/)).toBeNull();
      expect(screen.queryByText(/^ethereum:/)).toBeNull();
    });

    it('direct ON + amount で EIP-681 URI が表示される (JPYC × decimals=18)', async () => {
      const user = userEvent.setup();
      const { container } = render(<QrGenerator />);
      await waitFor(() => screen.getByPlaceholderText(/0x\.\.\./));
      await user.type(screen.getByPlaceholderText(/0x\.\.\./), VALID);
      await user.type(screen.getByPlaceholderText('1000'), '1000');
      await user.click(screen.getByRole('checkbox', { name: /直接送金/ }));

      const uri = (
        await screen.findByText((t) => t.startsWith('ethereum:'))
      ).textContent!;
      // mainnet=137 / testnet=80002 のいずれか
      expect(uri).toMatch(/@(137|80002)\/transfer\?/);
      expect(uri).toContain(`address=${VALID}`);
      expect(uri).toContain('uint256=1000000000000000000000');

      // ≈145 文字の URI は QR V8-V9 alphanumeric 容量境界に近いため、QR が
      // 黙って空で描画されるシナリオを排除する。EIP-681 QR は size=180 で識別
      // (本体 OpenPay QR は 240)。qrcode.react は (背景 path + matrix path) の
      // 2 つを描画するので最大の `d` 長で matrix encode 成否を判定。
      const svgs = container.querySelectorAll('svg');
      const eip681Svg = Array.from(svgs).find(
        (s) => s.getAttribute('width') === '180',
      );
      expect(eip681Svg).toBeDefined();
      const longestPath = Math.max(
        ...Array.from(eip681Svg!.querySelectorAll('path')).map(
          (p) => p.getAttribute('d')?.length ?? 0,
        ),
      );
      expect(longestPath).toBeGreaterThan(500);
    });

    it('direct ON + 据え置き (amount 無し) は section 非表示', async () => {
      const user = userEvent.setup();
      render(<QrGenerator />);
      await waitFor(() => screen.getByPlaceholderText(/0x\.\.\./));
      await user.type(screen.getByPlaceholderText(/0x\.\.\./), VALID);
      await user.click(screen.getByRole('checkbox', { name: /直接送金/ }));
      await user.click(screen.getByRole('button', { name: /据え置き/ }));

      expect(screen.queryByText(/互換 QR \(EIP-681\)/)).toBeNull();
    });

    it('URI コピーボタンが clipboard へ正確な値の ethereum: URI を書き込む', async () => {
      const user = userEvent.setup();
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText },
        configurable: true,
      });

      render(<QrGenerator />);
      await waitFor(() => screen.getByPlaceholderText(/0x\.\.\./));
      await user.type(screen.getByPlaceholderText(/0x\.\.\./), VALID);
      await user.type(screen.getByPlaceholderText('1000'), '500');
      await user.click(screen.getByRole('checkbox', { name: /直接送金/ }));

      // 形状 regex だけ pass する silent fund misdirection を排除するため、
      // 画面表示 URI と完全一致 + 受取人 + wei 値 + URL パーサ妥当性を全て assert。
      const onScreenUri = (
        await screen.findByText((t) => t.startsWith('ethereum:'))
      ).textContent!;

      await user.click(screen.getByRole('button', { name: /URI をコピー/ }));

      await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
      const copied = writeText.mock.calls[0][0] as string;
      expect(copied).toBe(onScreenUri);
      expect(copied).toContain(`address=${VALID}`);
      expect(copied).toContain('uint256=500000000000000000000'); // 500 JPYC × 1e18
      expect(URL.canParse(copied)).toBe(true);
    });

    // 回帰: USDC + decimals 超過小数で render crash する潜在バグ。
    // sanitizeAmount で入力時に decimals に切り詰めるため、+1 桁打ち込みは入力値が
    // truncate されて URI / section は維持される (silent 非表示にならない)。
    it('USDC 桁数: 入力時に decimals=6 へ truncate、URI は常に表示される', async () => {
      const user = userEvent.setup();
      render(<QrGenerator />);
      await waitFor(() => screen.getByPlaceholderText(/0x\.\.\./));
      await user.type(screen.getByPlaceholderText(/0x\.\.\./), VALID);
      await user.click(screen.getByRole('button', { name: /USDC/ }));
      await user.click(screen.getByRole('checkbox', { name: /直接送金/ }));

      const amountInput = screen.getByPlaceholderText(
        '10.00',
      ) as HTMLInputElement;
      await user.type(amountInput, '1.123456');
      const uri = (
        await screen.findByText((t) => t.startsWith('ethereum:'))
      ).textContent!;
      expect(uri).toContain('uint256=1123456');

      // 7 文字目の追加は truncate される (入力値は変化なし、URI も変化なし)
      await user.type(amountInput, '7');
      expect(amountInput.value).toBe('1.123456');
      expect(screen.getByText(/^ethereum:/).textContent).toContain(
        'uint256=1123456',
      );
    });

    it('paste で decimals 超過の長い小数を受けても truncate される', async () => {
      const user = userEvent.setup();
      render(<QrGenerator />);
      await waitFor(() => screen.getByPlaceholderText(/0x\.\.\./));
      await user.type(screen.getByPlaceholderText(/0x\.\.\./), VALID);
      await user.click(screen.getByRole('button', { name: /USDC/ }));
      await user.click(screen.getByRole('checkbox', { name: /直接送金/ }));

      const amountInput = screen.getByPlaceholderText(
        '10.00',
      ) as HTMLInputElement;
      // paste は userEvent.paste で発火 (selection は input にフォーカス済の前提)
      amountInput.focus();
      await user.paste('1.1234567890');
      // USDC decimals=6 に truncate
      expect(amountInput.value).toBe('1.123456');
      const uri = (
        await screen.findByText((t) => t.startsWith('ethereum:'))
      ).textContent!;
      expect(uri).toContain('uint256=1123456');
    });

    it('JPYC で長い小数を打って USDC 切替 → 6 桁に自動 truncate', async () => {
      const user = userEvent.setup();
      render(<QrGenerator />);
      await waitFor(() => screen.getByPlaceholderText(/0x\.\.\./));
      await user.type(screen.getByPlaceholderText(/0x\.\.\./), VALID);
      // JPYC decimals=18 で長い小数を入力
      const jpycInput = screen.getByPlaceholderText(
        '1000',
      ) as HTMLInputElement;
      await user.type(jpycInput, '1.1234567890');
      expect(jpycInput.value).toBe('1.1234567890');

      // USDC へ切替 → amount が 6 桁に truncate されているはず
      await user.click(screen.getByRole('button', { name: /USDC/ }));
      const usdcInput = screen.getByPlaceholderText(
        '10.00',
      ) as HTMLInputElement;
      expect(usdcInput.value).toBe('1.123456');
    });

    it('状態遷移: direct ON → URI 表示 → direct OFF → URI 非表示', async () => {
      const user = userEvent.setup();
      render(<QrGenerator />);
      await waitFor(() => screen.getByPlaceholderText(/0x\.\.\./));
      await user.type(screen.getByPlaceholderText(/0x\.\.\./), VALID);
      await user.type(screen.getByPlaceholderText('1000'), '100');

      const directCheckbox = screen.getByRole('checkbox', { name: /直接送金/ });
      await user.click(directCheckbox);
      await waitFor(() =>
        expect(screen.getByText(/^ethereum:/)).toBeInTheDocument(),
      );

      await user.click(directCheckbox);
      await waitFor(() =>
        expect(screen.queryByText(/^ethereum:/)).toBeNull(),
      );
    });

    it('direct ON は split state を無視 (splitsForUrl=undefined → EIP-681 表示)', async () => {
      // direct mode は OpenPay URL でも split を無視するので、EIP-681 でも同じ挙動。
      // 「split 入力済 → direct ON で URI 表示」が期待動作。
      const user = userEvent.setup();
      render(<QrGenerator />);
      await waitFor(() => screen.getByPlaceholderText(/0x\.\.\./));
      await user.type(screen.getByPlaceholderText(/0x\.\.\./), VALID);
      await user.type(screen.getByPlaceholderText('1000'), '100');
      await user.click(screen.getByRole('button', { name: /\+ 受取人を追加/ }));
      const splitInputs = screen.getAllByPlaceholderText('0x...');
      await user.type(
        splitInputs[0],
        '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
      );
      await user.type(screen.getByPlaceholderText('%'), '30');
      await user.click(screen.getByRole('checkbox', { name: /直接送金/ }));

      await waitFor(() =>
        expect(screen.getByText(/^ethereum:/)).toBeInTheDocument(),
      );
    });

    it('gasless mode で split 入力中は EIP-681 非表示 (まず direct ON が必要)', async () => {
      const user = userEvent.setup();
      render(<QrGenerator />);
      await waitFor(() => screen.getByPlaceholderText(/0x\.\.\./));
      await user.type(screen.getByPlaceholderText(/0x\.\.\./), VALID);
      await user.type(screen.getByPlaceholderText('1000'), '100');
      // direct OFF のまま split 追加
      await user.click(screen.getByRole('button', { name: /\+ 受取人を追加/ }));
      const splitInputs = screen.getAllByPlaceholderText('0x...');
      await user.type(
        splitInputs[0],
        '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
      );
      await user.type(screen.getByPlaceholderText('%'), '30');

      // direct OFF + split あり = eligibility 不満、section 非表示
      expect(screen.queryByText(/^ethereum:/)).toBeNull();
    });

    it('状態遷移: amount を空に戻すと URI 非表示', async () => {
      const user = userEvent.setup();
      render(<QrGenerator />);
      await waitFor(() => screen.getByPlaceholderText(/0x\.\.\./));
      await user.type(screen.getByPlaceholderText(/0x\.\.\./), VALID);
      const amountInput = screen.getByPlaceholderText('1000');
      await user.type(amountInput, '100');
      await user.click(screen.getByRole('checkbox', { name: /直接送金/ }));
      await waitFor(() =>
        expect(screen.getByText(/^ethereum:/)).toBeInTheDocument(),
      );

      await user.clear(amountInput);
      await waitFor(() =>
        expect(screen.queryByText(/^ethereum:/)).toBeNull(),
      );
    });

    it('JPYC → USDC 切替で URI の token / decimals / 単位が更新', async () => {
      const user = userEvent.setup();
      render(<QrGenerator />);
      await waitFor(() => screen.getByPlaceholderText(/0x\.\.\./));
      await user.type(screen.getByPlaceholderText(/0x\.\.\./), VALID);
      await user.type(screen.getByPlaceholderText('1000'), '1');
      await user.click(screen.getByRole('checkbox', { name: /直接送金/ }));

      // JPYC: 1 JPYC = 1e18 wei
      const jpycUri = (
        await screen.findByText((t) => t.startsWith('ethereum:'))
      ).textContent!;
      expect(jpycUri).toContain('uint256=1000000000000000000');

      // amount state は token 切替で reset されず、新しい decimals で再評価される。
      await user.click(screen.getByRole('button', { name: /USDC/ }));
      await waitFor(() => {
        const usdcUri = screen.getByText((t) => t.startsWith('ethereum:'))
          .textContent!;
        expect(usdcUri).toContain('uint256=1000000');
        expect(usdcUri).not.toContain('uint256=1000000000000000000');
      });
    });

    it('USDC chain 切替で URI の chainId が更新 (Base → Arbitrum)', async () => {
      const user = userEvent.setup();
      render(<QrGenerator />);
      await waitFor(() => screen.getByPlaceholderText(/0x\.\.\./));
      await user.type(screen.getByPlaceholderText(/0x\.\.\./), VALID);
      await user.click(screen.getByRole('button', { name: /USDC/ }));
      await user.type(screen.getByPlaceholderText('10.00'), '1');
      await user.click(screen.getByRole('checkbox', { name: /直接送金/ }));

      // 既定: Base
      const baseUri = (
        await screen.findByText((t) => t.startsWith('ethereum:'))
      ).textContent!;
      // mainnet=8453 / testnet (Base Sepolia)=84532
      expect(baseUri).toMatch(/@(8453|84532)\/transfer/);

      // Arbitrum へ切替
      await user.click(screen.getByRole('button', { name: /^Arbitrum/ }));
      await waitFor(() => {
        const arbUri = screen.getByText((t) => t.startsWith('ethereum:'))
          .textContent!;
        // mainnet=42161 / testnet (Arbitrum Sepolia)=421614
        expect(arbUri).toMatch(/@(42161|421614)\/transfer/);
      });
    });
  });

  describe('URL コピー', () => {
    it('navigator.clipboard.writeText が呼ばれる', async () => {
      const user = userEvent.setup();
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText },
        configurable: true,
      });

      render(<QrGenerator />);
      await waitFor(() => screen.getByPlaceholderText(/0x\.\.\./));
      await user.type(screen.getByPlaceholderText(/0x\.\.\./), VALID);
      await user.type(screen.getByPlaceholderText('1000'), '5');

      const copyBtn = await screen.findByRole('button', {
        name: /URLをコピー/,
      });
      await user.click(copyBtn);

      await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
      const copied = writeText.mock.calls[0][0] as string;
      expect(copied).toContain(`to=${VALID}`);
      expect(copied).toContain('amount=5');

      await waitFor(() =>
        expect(
          screen.getByRole('button', { name: /コピー済み/ }),
        ).toBeInTheDocument(),
      );
    });

    it('保存ボタンと印刷ボタンが機能する', async () => {
      const user = userEvent.setup();
      const createObjectURL = vi.fn(() => 'blob:qr');
      const revokeObjectURL = vi.fn();
      Object.defineProperty(URL, 'createObjectURL', {
        value: createObjectURL,
        configurable: true,
      });
      Object.defineProperty(URL, 'revokeObjectURL', {
        value: revokeObjectURL,
        configurable: true,
      });
      const click = vi
        .spyOn(HTMLAnchorElement.prototype, 'click')
        .mockImplementation(() => {});
      const print = vi.fn();
      Object.defineProperty(window, 'print', { value: print, configurable: true });

      render(<QrGenerator />);
      await waitFor(() => screen.getByPlaceholderText(/0x\.\.\./));
      await user.type(screen.getByPlaceholderText(/0x\.\.\./), VALID);
      await user.type(screen.getByPlaceholderText('1000'), '5');

      await user.click(await screen.findByRole('button', { name: /SVG保存/ }));
      expect(createObjectURL).toHaveBeenCalledOnce();
      expect(click).toHaveBeenCalledOnce();
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:qr');

      await user.click(screen.getByRole('button', { name: /印刷/ }));
      expect(print).toHaveBeenCalledOnce();
    });

    it('日本語の店舗名がそのまま download ファイル名に保存される', async () => {
      // fileSafe が ASCII 限定だと「神田珈琲」→ 'openpay' fallback に潰れて
      // merchant が複数ポスターを区別できなくなるため、UTF-8 を許容する。
      const user = userEvent.setup();
      Object.defineProperty(URL, 'createObjectURL', {
        value: vi.fn(() => 'blob:qr'),
        configurable: true,
      });
      Object.defineProperty(URL, 'revokeObjectURL', {
        value: vi.fn(),
        configurable: true,
      });
      const captured: string[] = [];
      vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(
        function (this: HTMLAnchorElement) {
          captured.push(this.download);
        },
      );

      render(<QrGenerator />);
      await waitFor(() => screen.getByPlaceholderText(/0x\.\.\./));
      await user.type(screen.getByPlaceholderText(/0x\.\.\./), VALID);
      await user.type(screen.getByPlaceholderText('1000'), '750');
      await user.type(
        screen.getByPlaceholderText(/OpenPay Coffee/),
        '神田珈琲',
      );

      await user.click(await screen.findByRole('button', { name: /SVG保存/ }));
      expect(captured.length).toBe(1);
      const filename = captured[0];
      expect(filename).toMatch(/^神田珈琲-jpyc-polygon-750\.svg$/);
    });

    it('PNG 保存: Image → canvas → toDataURL のパイプラインが実行され .png ファイル名で trigger', async () => {
      // JSDOM は Image / canvas がスタブなので、最小の shim を入れて downloadPng の
      // 全コードパス (img.onload → fillRect → drawImage → toDataURL → triggerDownload)
      // を実走行させる。テスト対象 (downloadPng) はモックしない。
      const user = userEvent.setup();
      const fillRect = vi.fn();
      const drawImage = vi.fn();
      const toDataURL = vi.fn(() => 'data:image/png;base64,fakebytes');
      const getContext = vi.fn(() => ({
        fillStyle: '',
        fillRect,
        drawImage,
      }));
      Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
        value: getContext,
        configurable: true,
      });
      Object.defineProperty(HTMLCanvasElement.prototype, 'toDataURL', {
        value: toDataURL,
        configurable: true,
      });

      // Image 自体を実走行: src setter で onload を 1 tick 後に発火させる。
      class FakeImage {
        width = 240;
        height = 240;
        onload: (() => void) | null = null;
        _src = '';
        get src() {
          return this._src;
        }
        set src(v: string) {
          this._src = v;
          queueMicrotask(() => this.onload?.());
        }
      }
      vi.stubGlobal('Image', FakeImage as unknown as typeof Image);

      const captured: { href: string; filename: string }[] = [];
      vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(
        function (this: HTMLAnchorElement) {
          captured.push({ href: this.href, filename: this.download });
        },
      );

      render(<QrGenerator />);
      await waitFor(() => screen.getByPlaceholderText(/0x\.\.\./));
      await user.type(screen.getByPlaceholderText(/0x\.\.\./), VALID);
      await user.type(screen.getByPlaceholderText('1000'), '750');

      await user.click(await screen.findByRole('button', { name: /PNG保存/ }));
      // queueMicrotask 経由で onload → triggerDownload
      await waitFor(() => expect(captured.length).toBe(1));

      // 入力データの検査
      expect(getContext).toHaveBeenCalledWith('2d');
      // 240×240 (Image の width/height をそのまま canvas.width に使う)
      // fillRect は (0, 0, 240, 240) で白背景塗り
      expect(fillRect).toHaveBeenCalledWith(0, 0, 240, 240);
      // drawImage は src の Image オブジェクトを (0, 0) に貼付
      expect(drawImage).toHaveBeenCalledTimes(1);
      expect(toDataURL).toHaveBeenCalledWith('image/png');
      // 出力 anchor: href = data:image/png;... / filename = openpay-jpyc-polygon-750.png
      expect(captured[0].href).toContain('data:image/png');
      expect(captured[0].filename).toMatch(
        /^openpay-jpyc-polygon-750\.png$/,
      );

      vi.unstubAllGlobals();
    });

    it('path separator や Windows 予約文字は - に置換される (filesystem 安全)', async () => {
      const user = userEvent.setup();
      Object.defineProperty(URL, 'createObjectURL', {
        value: vi.fn(() => 'blob:qr'),
        configurable: true,
      });
      Object.defineProperty(URL, 'revokeObjectURL', {
        value: vi.fn(),
        configurable: true,
      });
      const captured: string[] = [];
      vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(
        function (this: HTMLAnchorElement) {
          captured.push(this.download);
        },
      );

      render(<QrGenerator />);
      await waitFor(() => screen.getByPlaceholderText(/0x\.\.\./));
      await user.type(screen.getByPlaceholderText(/0x\.\.\./), VALID);
      await user.type(screen.getByPlaceholderText('1000'), '5');
      await user.type(
        screen.getByPlaceholderText(/OpenPay Coffee/),
        'a/b\\c:d*e?f"g<h>i|j',
      );

      await user.click(await screen.findByRole('button', { name: /SVG保存/ }));
      const filename = captured[0];
      // 全ての禁止文字が - に置換され、連続する - は 1 つに collapse される
      expect(filename).not.toMatch(/[\\/:*?"<>|]/);
      expect(filename).toMatch(/^a-b-c-d-e-f-g-h-i-j-jpyc-polygon-5\.svg$/);
    });
  });
});
