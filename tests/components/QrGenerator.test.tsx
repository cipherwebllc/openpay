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
    it('LocalStorage 空: アコーディオンは開いていて、USDC が active', async () => {
      render(<QrGenerator />);
      await waitFor(() => {
        expect(
          screen.getByRole('button', { name: /USDC/ }),
        ).toBeInTheDocument();
      });
      const usdcBtn = screen.getByRole('button', { name: /USDC/ });
      const jpycBtn = screen.getByRole('button', { name: /JPYC/ });
      expect(usdcBtn.className).toMatch(/border-brand/);
      expect(jpycBtn.className).not.toMatch(/border-brand/);
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
      await user.type(screen.getByPlaceholderText('10.00'), '12.5');

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
      await waitFor(() => screen.getByPlaceholderText('10.00'));
      const input = screen.getByPlaceholderText('10.00') as HTMLInputElement;
      await user.type(input, '10ab.5');
      expect(input.value).toBe('10.5');
    });

    it('gas トグル: 切替で URL に gas=merchant が付く / 外れる', async () => {
      const user = userEvent.setup();
      render(<QrGenerator />);
      await waitFor(() => screen.getByPlaceholderText(/0x\.\.\./));
      await user.type(screen.getByPlaceholderText(/0x\.\.\./), VALID);
      await user.type(screen.getByPlaceholderText('10.00'), '5');

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
      await user.type(screen.getByPlaceholderText('10.00'), '5');

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
      await user.type(screen.getByPlaceholderText('10.00'), '5');

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
