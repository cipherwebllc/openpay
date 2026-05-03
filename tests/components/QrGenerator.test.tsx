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

import { QrGenerator } from '@/components/QrGenerator';

const VALID = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

describe('QrGenerator', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  describe('初期レンダリング', () => {
    it('LocalStorage 空: アコーディオンは開いていて、JPYC が active (default)', async () => {
      render(<QrGenerator />);
      await waitFor(() => {
        expect(
          screen.getByRole('button', { name: /JPYC/ }),
        ).toBeInTheDocument();
      });
      const usdcBtn = screen.getByRole('button', { name: /USDC/ });
      const jpycBtn = screen.getByRole('button', { name: /JPYC/ });
      expect(jpycBtn.className).toMatch(/border-brand/);
      expect(usdcBtn.className).not.toMatch(/border-brand/);
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
      await waitFor(() => screen.getByRole('button', { name: /JPYC/ }));
      await user.click(screen.getByRole('button', { name: /JPYC/ }));
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
    // 境界 (== decimals 表示 / +1 桁 非表示 / 戻すと再表示) + Sentry 計測を 1 ケースで検証。
    it('USDC 桁数境界: == 6 桁表示 / +1 で非表示 + logger.warn / 戻すと再表示', async () => {
      const { logger } = await import('@/lib/logger');
      const warnSpy = vi.spyOn(logger, 'warn');

      const user = userEvent.setup();
      render(<QrGenerator />);
      await waitFor(() => screen.getByPlaceholderText(/0x\.\.\./));
      await user.type(screen.getByPlaceholderText(/0x\.\.\./), VALID);
      await user.click(screen.getByRole('button', { name: /USDC/ }));
      await user.click(screen.getByRole('checkbox', { name: /直接送金/ }));

      const amountInput = screen.getByPlaceholderText('10.00');
      await user.type(amountInput, '1.123456');
      const uri = (
        await screen.findByText((t) => t.startsWith('ethereum:'))
      ).textContent!;
      expect(uri).toContain('uint256=1123456');
      expect(warnSpy).not.toHaveBeenCalled();

      await user.type(amountInput, '7');
      await waitFor(() =>
        expect(screen.queryByText(/^ethereum:/)).toBeNull(),
      );
      // 監視メトリクス: decimals_overflow が token / 桁数情報付きで発火
      expect(warnSpy).toHaveBeenCalledWith(
        'eip681.decimals_overflow',
        expect.objectContaining({
          token: 'usdc',
          decimals: 6,
          fracDigits: 7,
        }),
      );

      await user.clear(amountInput);
      await user.type(amountInput, '1.123456');
      await waitFor(() =>
        expect(screen.getByText(/^ethereum:/)).toBeInTheDocument(),
      );

      warnSpy.mockRestore();
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
  });
});
