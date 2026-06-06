import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
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
// 受取先の自動補完 (useReceiverAutofill) が useAccount を読むため最小モック。
// 既定は未接続 = 自動補完もチップも出ない (既存テストの挙動を維持)。
vi.mock('wagmi', () => ({
  useAccount: vi.fn(() => ({ address: undefined, isConnected: false })),
}));

// useOrigin を関数経由でモックして、特定テストだけ空文字列に倒せるようにする
// (qrPlaceholderGenerating の検証で payUrl 不在 + 受信者 / 金額 valid という
//  本来は一瞬の遷移状態を再現するため)。
const useOriginMock = vi.fn(() => 'https://test.local');
vi.mock('@/hooks/useOrigin', () => ({
  useOrigin: () => useOriginMock(),
}));

// useMarketRates は React Query 経由で /api/market/rates を叩く。テストでは
// QueryClientProvider を張らない renderWithIntl を使うため、hook ごとモックして
// 固定レート (1 USDC = 150 円) を返す。convert (他トークン建て) テストで参照。
type MarketRatesResult = {
  data: { usdcJpy: number; updatedAt: string } | undefined;
  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
};
const marketRatesData = vi.fn((): MarketRatesResult => ({
  data: { usdcJpy: 150, updatedAt: '2026-06-03T00:00:00.000Z' },
  isLoading: false,
  isError: false,
  refetch: vi.fn(),
}));
vi.mock('@/hooks/useMarketRates', () => ({
  useMarketRates: () => marketRatesData(),
}));

// JPYC ガス無料化: 負担者トグルは「JPYC EIP-3009 relay free 経路」のときだけ隠れる。
// その判定は resolveJpycGaslessProvider(=relay) かつ forwarder 未設定。テスト env は
// relay flag OFF なので既定は 'pimlico-7702' (= 負担者トグル表示)。free 経路の検証
// テストだけ provider を 'eip3009-relay' に上書きする (forwarder は env 未設定で null)。
vi.mock('@/lib/jpycGaslessProvider', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/jpycGaslessProvider')>();
  return {
    ...actual,
    resolveJpycGaslessProvider: vi.fn(() => 'pimlico-7702' as const),
  };
});

import { QrGenerator } from '@/components/QrGenerator';
import { resolveJpycGaslessProvider } from '@/lib/jpycGaslessProvider';

const VALID = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

// UX 詰め (2026-06-05): 決済QR は ①金額 → ②受取先(折りたたみ) に戻した。② 受取先
// (アドレス / 店舗名 / ポスター補足文) は折りたたみ可能。受取先未設定なら default open
// なので空 LS のテストでは no-op。seeded receiver で閉じている場合のみ開く。
async function openStep2(
  user: ReturnType<typeof userEvent.setup>,
): Promise<void> {
  const toggle = screen.queryByRole('button', { name: /受取先/ });
  if (toggle && toggle.getAttribute('aria-expanded') === 'false') {
    await user.click(toggle);
  }
}

// 高度な設定 accordion は ② 受取先 の後ろの独立セクション (default 閉)。payMode / gas /
// split を触るテストはこの accordion を開く。
async function openAdvanced(
  user: ReturnType<typeof userEvent.setup>,
): Promise<void> {
  const toggle = await screen.findByRole('button', { name: /高度な設定/ });
  if (toggle.getAttribute('aria-expanded') !== 'true') {
    await user.click(toggle);
  }
}

// QR は即時表示せず「QRコードを表示する」ボタン → 全画面モーダルで提示。QR 本体 / 決済
// URL / 印刷・コピー・SVG・PNG ボタン / ポスター調プレビュー / EIP-681 fallback はすべて
// モーダル内 (閉じている間は DOM に無い)。それらを検証するテストは先にこれを呼ぶ。
async function openQrModal(
  user: ReturnType<typeof userEvent.setup>,
): Promise<void> {
  // CTA は右サイドバー (Step3) とモバイル下部バーの2箇所に描画される (jsdom は CSS
  // 非適用で両方 DOM に居る) ので先頭 (= Step3・DOM 先頭) をクリック。
  const btns = await screen.findAllByRole('button', {
    name: /QRコードを表示する/,
  });
  await user.click(btns[0]);
}

// モーダルを開き、その中の EIP-681 互換 QR (details) を展開する。
async function openEip681(
  user: ReturnType<typeof userEvent.setup>,
): Promise<void> {
  await openQrModal(user);
  const summary = await screen.findByText(/互換 QR \(EIP-681\)/);
  await user.click(summary);
}

// provider mock を各テスト前に既定 (pimlico-7702 = relay 非経路 = 負担者トグル表示) へ
// 戻す。free 経路テストの 'eip3009-relay' 上書きが他テストへ漏れないようにする。
beforeEach(() => {
  vi.mocked(resolveJpycGaslessProvider).mockReturnValue('pimlico-7702');
});

describe('QrGenerator', () => {
  beforeEach(() => {
    window.localStorage.clear();
    useOriginMock.mockReturnValue('https://test.local');
  });

  describe('JPYC ガス無料化: free 経路 (EIP-3009 relay・forwarder 未設定)', () => {
    it('gas 負担者トグルが非表示・サマリは「OpenPay がガス負担」・gas=customer 固定', async () => {
      // free 経路を模す: provider=relay + forwarder=null (env 未設定で既定 null)。
      vi.mocked(resolveJpycGaslessProvider).mockReturnValue('eip3009-relay');
      window.localStorage.setItem(
        'openpay:qr-settings:v2',
        JSON.stringify({
          receiver: VALID,
          token: 'jpyc',
          chain: 'polygon',
          payMode: 'gasless',
          gasMode: 'merchant',
        }),
      );
      const user = userEvent.setup();
      render(<QrGenerator />);
      await openStep2(user);
      // accordion 閉のサマリ: 負担者ではなく「OpenPay がガス負担」
      const toggle = await screen.findByRole('button', { name: /高度な設定/ });
      expect(
        within(toggle).getByText(/ガスレス決済（OpenPay がガス負担）/),
      ).toBeInTheDocument();
      // accordion を開く → 負担者トグルは存在しない
      await openAdvanced(user);
      expect(
        screen.queryByRole('button', { name: /店主が gas 相当額/ }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: /顧客が gas 相当額/ }),
      ).not.toBeInTheDocument();
      // storage に gasMode=merchant が残っていても URL は gas=customer 固定 (merchant 出ない)
      await user.type(screen.getByPlaceholderText('1000'), '5');
      await openQrModal(user);
      await waitFor(() => {
        expect(screen.queryByText((t) => t.includes('gas=merchant'))).toBeNull();
      });
    });

    it('split 指定時は free 判定にせず負担者トグルを表示 (PaymentForm が relay を外し非 free 経路になるため)', async () => {
      // relay + forwarder null でも split があると決済側は sponsorship に倒れ非 free。
      // 生成側も isFreeGasless=false とし、QR が「無料」と偽らないようトグルを出す。
      vi.mocked(resolveJpycGaslessProvider).mockReturnValue('eip3009-relay');
      window.localStorage.setItem(
        'openpay:qr-settings:v2',
        JSON.stringify({
          receiver: VALID,
          token: 'jpyc',
          chain: 'polygon',
          payMode: 'gasless',
          gasMode: 'customer',
          splits: [
            { address: '0x2222222222222222222222222222222222222222', percent: '40' },
          ],
        }),
      );
      const user = userEvent.setup();
      render(<QrGenerator />);
      await openStep2(user);
      await openAdvanced(user);
      // split があるので free 扱いにならず、負担者トグルが表示される
      expect(
        await screen.findByRole('button', { name: /顧客が gas 相当額/ }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: /店主が gas 相当額/ }),
      ).toBeInTheDocument();
    });
  });

  describe('初期レンダリング', () => {
    it('LocalStorage 空: Step 1 で token chooser は常時表示、JPYC が active (default)', async () => {
      // 3-step refactor v2 (2026-05-23 追補): token / chain は顧客ごとに変更する
      // 頻度が高いため Step 1 (金額) に移動。Step 2 (受取先) は折り畳み可能で
      // 設定後変更しない情報のみを格納。
      render(<QrGenerator />);
      await waitFor(() => {
        expect(
          screen.getByRole('button', { name: /^JPYC$/ }),
        ).toBeInTheDocument();
      });
      const usdcBtn = screen.getByRole('button', { name: /^USDC$/ });
      const jpycBtn = screen.getByRole('button', { name: /^JPYC$/ });
      expect(jpycBtn.className).toMatch(/border-brand/);
      expect(usdcBtn.className).not.toMatch(/border-brand/);
    });

    it('Chain chooser: 公式ロゴ SVG (public/chains/{slug}.svg) が各 chain button 内に img として描画される', async () => {
      // 2026-05-24: chain button にも公式 logo を挿入 (token chooser と同 pattern)。
      // logo は aria-hidden で a11y tree から除外、accessible name は viem の
      // Chain.name のみ。ここでは img の src 属性に slug が含まれるかを検査する。
      const user = userEvent.setup();
      render(<QrGenerator />);
      await waitFor(() => screen.getByRole('button', { name: /^Polygon/ }));
      // 既定 JPYC: chain chooser は Polygon + Kaia (testnet env では Kairos)
      const polygonBtn = screen.getByRole('button', { name: /^Polygon/ });
      const kaiaBtn = screen.getByRole('button', { name: /^Kai/ });
      expect(polygonBtn.querySelector('img')?.getAttribute('src')).toMatch(
        /polygon\.svg/,
      );
      expect(kaiaBtn.querySelector('img')?.getAttribute('src')).toMatch(
        /kaia\.svg/,
      );
      // USDC に切替 → chain chooser に Base/Arbitrum/Optimism/Polygon/Ethereum logo
      await user.click(screen.getByRole('button', { name: /^USDC$/ }));
      await waitFor(() =>
        screen.getByRole('button', { name: /^Base/ }),
      );
      expect(
        screen
          .getByRole('button', { name: /^Base/ })
          .querySelector('img')
          ?.getAttribute('src'),
      ).toMatch(/base\.svg/);
      expect(
        screen
          .getByRole('button', { name: /^Arbitrum/ })
          .querySelector('img')
          ?.getAttribute('src'),
      ).toMatch(/arbitrum\.svg/);
    });

    it('Token chooser: 公式ロゴ SVG (public/tokens/{jpyc,usdc}.svg) が button 内に img として描画される', async () => {
      // 2026-05-24: chain hint 文言を削除して logo + symbol の 2 要素構成に変更。
      // logo は aria-hidden で a11y tree から除外、accessible name は span の
      // displaySymbol だけになる (上の test で button name='JPYC'/'USDC' 検証済)。
      // ここでは「ロゴ asset 経路 (public/tokens/...) が UI に出ているか」を
      // src 属性で検査する (alt は空 / aria-hidden なので role=img では取れない)。
      render(<QrGenerator />);
      await waitFor(() =>
        screen.getByRole('button', { name: /^JPYC$/ }),
      );
      const jpycBtn = screen.getByRole('button', { name: /^JPYC$/ });
      const usdcBtn = screen.getByRole('button', { name: /^USDC$/ });
      const jpycImg = jpycBtn.querySelector('img');
      const usdcImg = usdcBtn.querySelector('img');
      expect(jpycImg).not.toBeNull();
      expect(usdcImg).not.toBeNull();
      // next/image は src を加工する (e.g. _next/image?url=%2Ftokens%2Fjpyc.svg)
      // ため、URL 検査は素朴な substring match で十分。
      expect(jpycImg?.getAttribute('src')).toMatch(/jpyc\.svg/);
      expect(usdcImg?.getAttribute('src')).toMatch(/usdc\.svg/);
    });

    it('LocalStorage に有効アドレス + gasMode=merchant: サマリに「ガス代：店主負担」が出る', async () => {
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
      const user = userEvent.setup();
      render(<QrGenerator />);
      // Step 2 は preset receiver で default 折り畳まれる → 高度な設定 toggle が
      // 出るように Step 2 を expand。
      await openStep2(user);
      await waitFor(() => {
        const toggle = screen.getByRole('button', { name: /高度な設定/ });
        expect(toggle.getAttribute('aria-expanded')).toBe('false');
      });
      const toggle = screen.getByRole('button', { name: /高度な設定/ });
      // direct=false / gasMode=merchant → 日本語サマリ "ガス代：店主負担" (Phase 1: 手数料% 表記なし)
      expect(
        within(toggle).getByText(/ガスレス決済 \/ ガス代：店主負担/),
      ).toBeInTheDocument();
    });

    it('LocalStorage に有効アドレス: アコーディオンは閉じて payMode サマリ表示', async () => {
      // refactor 後 SettingsSummary は payMode + gasMode 由来の tail のみ表示
      // (token / chain は Step 1 で確認、receiver は Step 2 summary で確認できるため
      // 重複表示しない)。
      window.localStorage.setItem(
        'openpay:qr-settings:v2',
        JSON.stringify({
          receiver: VALID,
          token: 'jpyc',
          directTransfer: false,
        }),
      );
      const user = userEvent.setup();
      render(<QrGenerator />);
      await openStep2(user);
      await waitFor(() => {
        const toggle = screen.getByRole('button', { name: /高度な設定/ });
        expect(toggle.getAttribute('aria-expanded')).toBe('false');
      });
      const toggle = screen.getByRole('button', { name: /高度な設定/ });
      // gasMode default = customer → 日本語サマリ "ガス代：お客様負担" (Phase 1: 手数料% 表記なし)
      expect(
        within(toggle).getByText(/ガスレス決済 \/ ガス代：お客様負担/),
      ).toBeInTheDocument();
    });

    it('LocalStorage に無効アドレス: receiver field (Step 2 visible) に validation エラー', async () => {
      // 3-step refactor 後: receiver は Step 2 で常時 visible、accordion 開閉に
      // 関係なくエラー文言が見える。高度な設定 accordion はあくまで default 閉。
      window.localStorage.setItem(
        'openpay:qr-settings:v2',
        JSON.stringify({
          receiver: 'not-an-address',
          token: 'usdc',
          directTransfer: false,
        }),
      );
      render(<QrGenerator />);
      await screen.findByText(/アドレス形式が正しくありません/);
      const toggle = screen.getByRole('button', { name: /高度な設定/ });
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
    });
  });

  describe('入力 / 状態遷移', () => {
    it('有効アドレス + 金額 → QR (SVG) が描画される', async () => {
      const user = userEvent.setup();
      const { container } = render(<QrGenerator />);
      await waitFor(() => screen.getByPlaceholderText(/0x\.\.\./));

      await user.type(screen.getByPlaceholderText(/0x\.\.\./), VALID);
      await user.type(screen.getByPlaceholderText('1000'), '12.5');

      // QR / URL は「QRコードを表示する」→ モーダル内。
      await openQrModal(user);
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

    it('payUrl 有効時のみ「QRコードを表示する」CTA を2箇所 (右サイドバー + モバイル下部バー) 描画', async () => {
      const user = userEvent.setup();
      render(<QrGenerator />);
      await waitFor(() => screen.getByPlaceholderText(/0x\.\.\./));
      // 受取先/金額 未入力 → payUrl 無し → CTA は描画されない (空状態を維持)。
      expect(
        screen.queryAllByRole('button', { name: /QRコードを表示する/ }),
      ).toHaveLength(0);
      // 受取先 + 金額 → payUrl 有効 → デスクトップ右サイドバー + モバイル下部バーの2箇所。
      await user.type(screen.getByPlaceholderText(/0x\.\.\./), VALID);
      await user.type(screen.getByPlaceholderText('1000'), '500');
      await waitFor(() =>
        expect(
          screen.getAllByRole('button', { name: /QRコードを表示する/ }),
        ).toHaveLength(2),
      );
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

      // ポスター調プレビューはモーダル内。金額は下部バーにも出るため dialog 内に限定して照合。
      await openQrModal(user);
      const dialog = within(screen.getByRole('dialog'));
      expect(dialog.getByText('Kanda Coffee')).toBeInTheDocument();
      expect(dialog.getByText('Show success screen')).toBeInTheDocument();
      expect(dialog.getByText('750 JPYC')).toBeInTheDocument();
    });

    it('クイック金額を編集して追加ボタンに反映する', async () => {
      const user = userEvent.setup();
      render(<QrGenerator />);
      await waitFor(() => screen.getByPlaceholderText(/0x\.\.\./));
      await openAdvanced(user);

      await user.click(screen.getByRole('button', { name: /\+ 金額を追加/ }));
      const inputs = screen.getAllByPlaceholderText(/例: 1000/);
      await user.type(inputs[inputs.length - 1], '2500');

      expect(
        screen.getByRole('button', { name: /2500 JPYC/ }),
      ).toBeInTheDocument();
    });

    it('クイック金額: 現 token (USDC) の decimals に truncate (重複は dedup)', async () => {
      // USDC (6 decimals) の保存リストに高精度値が入っていても、ボタン表示・
      // クリック時の amount 反映ともに 6 桁に truncate される。truncate 後に
      // 重複した値は 1 ボタンにマージ。token ごと独立保存なので USDC リストを直接 seed。
      window.localStorage.setItem(
        'openpay:qr-settings:v2',
        JSON.stringify({
          token: 'usdc',
          chain: 'polygon',
          receiver: '',
          gasMode: 'customer',
          splits: [],
          storeName: '',
          posterNote: '',
          quickAmounts: {
            jpyc: ['500', '1000', '1500', '3000'],
            usdc: ['0.1234567890123', '0.1234567890124', '500'],
          },
        }),
      );
      const user = userEvent.setup();
      render(<QrGenerator />);
      await waitFor(() => screen.getByPlaceholderText('10.00'));

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

    it('クイック金額: JPYC と USDC は独立 (token 切替で別リストを表示・連動しない)', async () => {
      // バグ修正の本丸: 以前は単一リストを共有し JPYC/USDC で同じ金額が出ていた。
      // token ごと独立保存され、切替時はその token のリストだけが出る。
      window.localStorage.setItem(
        'openpay:qr-settings:v2',
        JSON.stringify({
          token: 'jpyc',
          chain: 'polygon',
          receiver: '',
          gasMode: 'customer',
          splits: [],
          storeName: '',
          posterNote: '',
          quickAmounts: {
            jpyc: ['200', '800'],
            usdc: ['7', '30', '90'],
          },
        }),
      );
      const user = userEvent.setup();
      render(<QrGenerator />);
      await waitFor(() => screen.getByPlaceholderText('1000'));

      // JPYC では JPYC リスト
      expect(
        screen.getByRole('button', { name: /^200 JPYC/ }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: /^800 JPYC/ }),
      ).toBeInTheDocument();

      // USDC へ切替 → USDC リスト。JPYC の値は出ない (= 連動しない)。
      await user.click(screen.getByRole('button', { name: /^USDC$/ }));
      await waitFor(() => screen.getByPlaceholderText('10.00'));

      expect(
        screen.getByRole('button', { name: /^7 USDC/ }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: /^30 USDC/ }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: /^90 USDC/ }),
      ).toBeInTheDocument();
      // 数値付き JPYC クイックボタンは消える (bare な token tab 'JPYC' は除外)
      expect(
        screen.queryByRole('button', { name: /\d+ JPYC$/ }),
      ).toBeNull();
    });

    it('クイック金額の × 削除: 中間 index を削除しても他要素が詰まらない (off-by-one なし)', async () => {
      const user = userEvent.setup();
      render(<QrGenerator />);
      await waitFor(() => screen.getByPlaceholderText('1000'));
      await openAdvanced(user);

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
      await openAdvanced(user);

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
      // クイックボタン (表示側) は何も表示されない (quick-amount は "<数値> JPYC"
      // の形式、token chooser の bare "JPYC" ボタンは除外する正規表現で照合する)。
      expect(
        screen.queryAllByRole('button', { name: /\d+ JPYC$/ }).length,
      ).toBe(0);
    });

    it('クイック金額の上限 (8 件) に到達すると + 追加ボタンが消える', async () => {
      // 既定 4 件 + 4 回押下 → 8 件
      const user = userEvent.setup();
      render(<QrGenerator />);
      await waitFor(() => screen.getByPlaceholderText('1000'));
      await openAdvanced(user);

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
      await openAdvanced(user);

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

    it('クイック金額: truncate 結果が 0 になるエントリは除外 (USDC)', async () => {
      // USDC (6 dec) で 0.0000001 (7 fracs, valid) を保存 → sanitizeAmount で
      // '0.000000' に潰れる (Number=0) → activeQuickAmounts は 0 値を弾く
      // (Number(truncated) <= 0 分岐)。token ごと独立保存なので USDC を直接 seed。
      window.localStorage.setItem(
        'openpay:qr-settings:v2',
        JSON.stringify({
          token: 'usdc',
          chain: 'polygon',
          receiver: '',
          gasMode: 'customer',
          splits: [],
          storeName: '',
          posterNote: '',
          quickAmounts: {
            jpyc: ['500', '1000', '1500', '3000'],
            usdc: ['0.0000001', '500'],
          },
        }),
      );
      render(<QrGenerator />);
      await waitFor(() => screen.getByPlaceholderText('10.00'));

      // 0.0000001 は truncate→'0.000000' (=0) になり除外、500 のみ残る
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
      await openAdvanced(user);

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
      await openAdvanced(user);
      // URL はモーダル内。開いたまま gas トグル (背後の accordion ボタンは操作可)。
      await openQrModal(user);

      // 既定は customer → URL に gas= は付かない
      await waitFor(() => {
        expect(
          screen.queryByText((t) => t.includes('gas=')),
        ).toBeNull();
      });

      // 店主 gas 負担ボタン → URL に gas=merchant が出る
      await user.click(screen.getByRole('button', { name: /店主が gas 相当額/ }));
      await waitFor(() => {
        expect(
          screen.getByText((t) => t.includes('gas=merchant')),
        ).toBeInTheDocument();
      });

      // 顧客 gas 負担に戻す → gas= が消える
      await user.click(screen.getByRole('button', { name: /顧客が gas 相当額/ }));
      await waitFor(() => {
        expect(
          screen.queryByText((t) => t.includes('gas=')),
        ).toBeNull();
      });
    });

    it('店主 gas 負担モード: localStorage に gasMode=merchant が保存される', async () => {
      const user = userEvent.setup();
      render(<QrGenerator />);
      await openAdvanced(user);
      await waitFor(() =>
        screen.getByRole('button', { name: /店主が gas 相当額/ }),
      );
      await user.click(screen.getByRole('button', { name: /店主が gas 相当額/ }));

      await waitFor(() => {
        const raw = window.localStorage.getItem('openpay:qr-settings:v2');
        expect(raw).not.toBeNull();
        expect(JSON.parse(raw!).gasMode).toBe('merchant');
      });
    });

    it('直接送金 ON で gas トグル UI が消える', async () => {
      const user = userEvent.setup();
      render(<QrGenerator />);
      await openAdvanced(user);
      await waitFor(() => screen.getByRole('button', { name: /通常決済（ガスあり）/ }));
      // 切替前は表示
      expect(
        screen.getByRole('button', { name: /顧客が gas 相当額/ }),
      ).toBeInTheDocument();
      // 直接送金 ON
      await user.click(screen.getByRole('button', { name: /通常決済（ガスあり）/ }));
      // トグル消失
      expect(
        screen.queryByRole('button', { name: /顧客が gas 相当額/ }),
      ).toBeNull();
    });

    it('JPYC タブへ切替で chainId 表記が変わる', async () => {
      const user = userEvent.setup();
      render(<QrGenerator />);
      await waitFor(() =>
        screen.getByRole('button', { name: /^JPYC$/ }),
      );
      await user.click(screen.getByRole('button', { name: /^JPYC$/ }));
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
      await openStep2(user);
      const toggle = await screen.findByRole('button', {
        name: /高度な設定/,
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

  describe('店舗ウォレット Explorer リンク (Phase 1)', () => {
    it('receiver 有効 + JPYC (Polygon) のとき、PolygonScan の address ページへ link する', async () => {
      window.localStorage.setItem(
        'openpay:qr-settings:v2',
        JSON.stringify({
          receiver: VALID,
          token: 'jpyc',
          directTransfer: false,
        }),
      );
      render(<QrGenerator />);
      const user = userEvent.setup();
      // preset receiver → Step 2 default 折り畳まれているので展開。
      // Explorer link は receiver Field 内 (Step 2 visible 領域) にあるため、
      // 高度な設定 accordion は開かなくて良い。
      await openStep2(user);
      const link = await screen.findByRole('link', {
        name: /店舗ウォレットの履歴を.+Explorer で見る/,
      });
      // testnet env なので Polygon Amoy → amoy.polygonscan.com
      expect(link).toHaveAttribute(
        'href',
        expect.stringMatching(
          new RegExp(`^https?://[^/]+/address/${VALID}$`),
        ),
      );
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'noreferrer noopener');
    });

    it('receiver 未入力 → link は描画しない', async () => {
      render(<QrGenerator />);
      const user = userEvent.setup();
      const toggle = await screen.findByRole('button', { name: /高度な設定/ });
      if (toggle.getAttribute('aria-expanded') === 'false') {
        await user.click(toggle);
      }
      expect(
        screen.queryByRole('link', { name: /店舗ウォレットの履歴を/ }),
      ).toBeNull();
    });

    it('receiver 不正 (not-an-address) → link は描画しない', async () => {
      window.localStorage.setItem(
        'openpay:qr-settings:v2',
        JSON.stringify({
          receiver: 'not-an-address',
          token: 'jpyc',
          directTransfer: false,
        }),
      );
      render(<QrGenerator />);
      await screen.findByText(/アドレス形式が正しくありません/);
      expect(
        screen.queryByRole('link', { name: /店舗ウォレットの履歴を/ }),
      ).toBeNull();
    });
  });

  describe('決済モード切替 (gasless / 通常決済（ガスあり）)', () => {
    it('「通常決済（ガスあり）」を選択すると URL に mode=standard が出る + 説明バッジが表示される', async () => {
      const user = userEvent.setup();
      render(<QrGenerator />);
      await waitFor(() => screen.getByPlaceholderText(/0x\.\.\./));
      await user.type(screen.getByPlaceholderText(/0x\.\.\./), VALID);
      await user.type(screen.getByPlaceholderText('1000'), '5');
      await openAdvanced(user);

      // mode radio (gasless / 通常決済) のうち standard 側を click
      const standardBtn = screen.getByRole('button', {
        name: /通常決済（ガスあり）/,
      });
      await user.click(standardBtn);

      // URL はモーダル内に表示。
      await openQrModal(user);
      // URL に mode=standard が出る (font-mono の payUrl 表示 + 警告文等にも
      // "mode=standard" 文字列が含まれるため、payUrl 限定で /pay?... 形式の URL を assert)
      await waitFor(() => {
        expect(
          screen.getByText((t) => /\/pay\?[^ ]*mode=standard/.test(t)),
        ).toBeInTheDocument();
      });

      // Phase 1: 通常決済モードの説明 (hint) が表示される (手数料% 表記なし)
      expect(
        screen.getByText(/OpenPay は gas を肩代わりしません/),
      ).toBeInTheDocument();

      // gas 負担方法 (顧客 / 店主) フィールドは消える (standard モードでは irrelevant)
      expect(screen.queryByRole('button', { name: /顧客が gas/ })).toBeNull();
    });

    it('payMode は LocalStorage に永続化される', async () => {
      const user = userEvent.setup();
      render(<QrGenerator />);
      await openAdvanced(user);
      await waitFor(() =>
        screen.getByRole('button', { name: /通常決済（ガスあり）/ }),
      );
      await user.click(
        screen.getByRole('button', { name: /通常決済（ガスあり）/ }),
      );

      await waitFor(() => {
        const raw = window.localStorage.getItem('openpay:qr-settings:v2');
        expect(raw).not.toBeNull();
        const parsed = JSON.parse(raw!);
        expect(parsed.payMode).toBe('standard');
      });
    });

    it('Phase 1: payMode=standard でアコーディオン閉時のサマリに「通常決済（ガスあり）」と出る', async () => {
      window.localStorage.setItem(
        'openpay:qr-settings:v2',
        JSON.stringify({
          receiver: VALID,
          token: 'usdc',
          payMode: 'standard',
        }),
      );
      const user = userEvent.setup();
      render(<QrGenerator />);
      await openStep2(user);
      const toggle = await screen.findByRole('button', {
        name: /高度な設定/,
      });
      // 自動閉じ
      await waitFor(() =>
        expect(toggle.getAttribute('aria-expanded')).toBe('false'),
      );
      expect(
        within(toggle).getByText(/通常決済（ガスあり）/),
      ).toBeInTheDocument();
    });

    it('Phase 1: payMode=gasless (default) でサマリに「ガスレス決済 / ガス代：お客様負担」と出る', async () => {
      window.localStorage.setItem(
        'openpay:qr-settings:v2',
        JSON.stringify({
          receiver: VALID,
          token: 'usdc',
          payMode: 'gasless',
          gasMode: 'customer',
        }),
      );
      const user = userEvent.setup();
      render(<QrGenerator />);
      await openStep2(user);
      const toggle = await screen.findByRole('button', {
        name: /高度な設定/,
      });
      await waitFor(() =>
        expect(toggle.getAttribute('aria-expanded')).toBe('false'),
      );
      expect(
        within(toggle).getByText(/ガスレス決済 \/ ガス代：お客様負担/),
      ).toBeInTheDocument();
    });
  });

  describe('Poster: pay mode badge (高度な設定を閉じた creator が気付ける可視化)', () => {
    it('JPYC + Polygon (gasless 平常時): "ガスレス決済" badge が poster に出る', async () => {
      window.localStorage.setItem(
        'openpay:qr-settings:v2',
        JSON.stringify({
          receiver: VALID,
          token: 'jpyc',
          chain: 'polygon',
          payMode: 'gasless',
          gasMode: 'customer',
        }),
      );
      const user = userEvent.setup();
      render(<QrGenerator />);
      await openStep2(user);
      await user.type(screen.getByPlaceholderText('1000'), '100');
      // payMode バッジはポスター調プレビュー (モーダル内)。
      await openQrModal(user);
      await waitFor(() => {
        expect(screen.getByText('ガスレス決済')).toBeInTheDocument();
      });
    });

    it('USDC + Ethereum + payMode=standard: "通常決済（ETH ガス代を別途用意）" badge', async () => {
      window.localStorage.setItem(
        'openpay:qr-settings:v2',
        JSON.stringify({
          receiver: VALID,
          token: 'usdc',
          chain: 'ethereum',
          // 2026-05 以降 Ethereum L1 も gasless 対応だが、merchant が明示的に
          // standard を選んだケースを検証 (印刷物に出る ETH ガス代警告 badge)。
          payMode: 'standard',
          gasMode: 'customer',
        }),
      );
      const user = userEvent.setup();
      render(<QrGenerator />);
      await openStep2(user);
      // USDC placeholder は '10.00' (decimals=6 想定の例値)
      await user.type(screen.getByPlaceholderText('10.00'), '5');
      // payMode バッジはポスター調プレビュー (モーダル内)。
      await openQrModal(user);
      await waitFor(() => {
        // {nativeToken} = ETH (Ethereum L1)、印刷物にも出る要注意警告
        expect(
          screen.getByText(/通常決済（ETH ガス代を別途用意）/),
        ).toBeInTheDocument();
      });
      // gasless badge は出ない (誤って併発しないこと)
      expect(screen.queryByText('ガスレス決済')).toBeNull();
    });

    it('USDC + Polygon (gasless 対応): "ガスレス決済" badge (色 emerald 系)', async () => {
      window.localStorage.setItem(
        'openpay:qr-settings:v2',
        JSON.stringify({
          receiver: VALID,
          token: 'usdc',
          chain: 'polygon',
          payMode: 'gasless',
          gasMode: 'customer',
        }),
      );
      const user = userEvent.setup();
      render(<QrGenerator />);
      await openStep2(user);
      await user.type(screen.getByPlaceholderText('10.00'), '5');
      // payMode バッジはポスター調プレビュー (モーダル内)。
      await openQrModal(user);
      await waitFor(() => {
        const badge = screen.getByText('ガスレス決済');
        expect(badge).toBeInTheDocument();
        // gasless = emerald 系 (creator/顧客の安心 visual cue)
        expect(badge.className).toMatch(/emerald/);
      });
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
      await openAdvanced(user);
      await user.click(screen.getByRole('button', { name: /通常決済（ガスあり）/ }));
      // QR / EIP-681 fallback はモーダル内。
      await openQrModal(user);

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

      // Phase 1: 旧 fee bypass 警告 banner は撤去済 (手数料 0% で bypass する意味がない)
      expect(
        screen.queryByText(/この QR では OpenPay 利用手数料/),
      ).toBeNull();
    });

    it('EIP-681 section は default で閉じている (details summary が初期状態 closed)', async () => {
      const user = userEvent.setup();
      render(<QrGenerator />);
      await waitFor(() => screen.getByPlaceholderText(/0x\.\.\./));
      await user.type(screen.getByPlaceholderText(/0x\.\.\./), VALID);
      await user.type(screen.getByPlaceholderText('1000'), '1000');
      await openAdvanced(user);
      await user.click(screen.getByRole('button', { name: /通常決済（ガスあり）/ }));
      await openQrModal(user);

      // details 要素が DOM に存在 + 初期 open=false
      const summary = await screen.findByText(/互換 QR \(EIP-681\)/);
      const detailsEl = summary.closest('details');
      expect(detailsEl).not.toBeNull();
      expect(detailsEl?.open).toBe(false);

      // summary clickで open=true
      summary.click();
      expect(detailsEl?.open).toBe(true);
    });

    it('EIP-681 section の summary に「上級者向け」 badge が表示される', async () => {
      const user = userEvent.setup();
      render(<QrGenerator />);
      await waitFor(() => screen.getByPlaceholderText(/0x\.\.\./));
      await user.type(screen.getByPlaceholderText(/0x\.\.\./), VALID);
      await user.type(screen.getByPlaceholderText('1000'), '1000');
      await openAdvanced(user);
      await user.click(screen.getByRole('button', { name: /通常決済（ガスあり）/ }));
      await openQrModal(user);

      // summary 内の badge (default 閉でも DOM には存在)
      expect(screen.getByText('上級者向け')).toBeInTheDocument();
    });

    it('fee bypass 警告は EIP-681 section に紐付く (EIP-681 非表示時は警告も非表示)', async () => {
      const user = userEvent.setup();
      render(<QrGenerator />);
      await waitFor(() => screen.getByPlaceholderText(/0x\.\.\./));
      await user.type(screen.getByPlaceholderText(/0x\.\.\./), VALID);
      // gasless モード (default) では EIP-681 が出ない → 警告も出ない
      await user.type(screen.getByPlaceholderText('1000'), '1000');
      expect(
        screen.queryByText(/この QR では OpenPay 利用手数料.*徴収されません/),
      ).toBeNull();
    });

    it('direct ON + 据え置き (amount 無し) は section 非表示', async () => {
      const user = userEvent.setup();
      render(<QrGenerator />);
      await waitFor(() => screen.getByPlaceholderText(/0x\.\.\./));
      await user.type(screen.getByPlaceholderText(/0x\.\.\./), VALID);
      await openAdvanced(user);
      await user.click(screen.getByRole('button', { name: /通常決済（ガスあり）/ }));
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
      await openAdvanced(user);
      await user.click(screen.getByRole('button', { name: /通常決済（ガスあり）/ }));
      await openQrModal(user);

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
      await user.click(screen.getByRole('button', { name: /^USDC$/ }));
      await openAdvanced(user);
      await user.click(screen.getByRole('button', { name: /通常決済（ガスあり）/ }));

      const amountInput = screen.getByPlaceholderText(
        '10.00',
      ) as HTMLInputElement;
      await user.type(amountInput, '1.123456');
      // EIP-681 URI はモーダル内 (amount 確定後に開く)。
      await openQrModal(user);
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
      await user.click(screen.getByRole('button', { name: /^USDC$/ }));
      await openAdvanced(user);
      await user.click(screen.getByRole('button', { name: /通常決済（ガスあり）/ }));

      const amountInput = screen.getByPlaceholderText(
        '10.00',
      ) as HTMLInputElement;
      // paste は userEvent.paste で発火 (selection は input にフォーカス済の前提)
      amountInput.focus();
      await user.paste('1.1234567890');
      // USDC decimals=6 に truncate
      expect(amountInput.value).toBe('1.123456');
      await openQrModal(user);
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
      await user.click(screen.getByRole('button', { name: /^USDC$/ }));
      const usdcInput = screen.getByPlaceholderText(
        '10.00',
      ) as HTMLInputElement;
      expect(usdcInput.value).toBe('1.123456');
    });

    it('状態遷移: 通常決済 ON → URI 表示 → ガスレス決済 へ戻すと URI 非表示', async () => {
      const user = userEvent.setup();
      render(<QrGenerator />);
      await waitFor(() => screen.getByPlaceholderText(/0x\.\.\./));
      await user.type(screen.getByPlaceholderText(/0x\.\.\./), VALID);
      await user.type(screen.getByPlaceholderText('1000'), '100');
      await openAdvanced(user);

      await user.click(
        screen.getByRole('button', { name: /通常決済（ガスあり）/ }),
      );
      // URI はモーダル内。開いたまま payMode を切替 (背後の accordion は操作可)。
      await openQrModal(user);
      await waitFor(() =>
        expect(screen.getByText(/^ethereum:/)).toBeInTheDocument(),
      );

      // ガスレス決済に戻すと EIP-681 URI は非表示 (gasless では EIP-681 で表現不可)
      await user.click(screen.getByRole('button', { name: /ガスレス決済/ }));
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
      await openAdvanced(user);
      await user.click(screen.getByRole('button', { name: /\+ 受取人を追加/ }));
      const splitInputs = screen.getAllByPlaceholderText('0x...');
      await user.type(
        splitInputs[0],
        '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
      );
      await user.type(screen.getByPlaceholderText('%'), '30');
      await user.click(screen.getByRole('button', { name: /通常決済（ガスあり）/ }));
      await openQrModal(user);

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
      await openAdvanced(user);
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
      await openAdvanced(user);
      await user.click(screen.getByRole('button', { name: /通常決済（ガスあり）/ }));
      await openQrModal(user);
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
      await openAdvanced(user);
      await user.click(screen.getByRole('button', { name: /通常決済（ガスあり）/ }));
      await openQrModal(user);

      // JPYC: 1 JPYC = 1e18 wei
      const jpycUri = (
        await screen.findByText((t) => t.startsWith('ethereum:'))
      ).textContent!;
      expect(jpycUri).toContain('uint256=1000000000000000000');

      // amount state は token 切替で reset されず、新しい decimals で再評価される。
      await user.click(screen.getByRole('button', { name: /^USDC$/ }));
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
      await user.click(screen.getByRole('button', { name: /^USDC$/ }));
      await user.type(screen.getByPlaceholderText('10.00'), '1');
      await openAdvanced(user);
      await user.click(screen.getByRole('button', { name: /通常決済（ガスあり）/ }));
      await openQrModal(user);

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

      // URLをコピー ボタンはモーダル内。
      await openQrModal(user);
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

      // 保存 / 印刷ボタンはモーダル内。
      await openQrModal(user);
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

      await openQrModal(user);
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

      await openQrModal(user);
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

      await openQrModal(user);
      await user.click(await screen.findByRole('button', { name: /SVG保存/ }));
      const filename = captured[0];
      // 全ての禁止文字が - に置換され、連続する - は 1 つに collapse される
      expect(filename).not.toMatch(/[\\/:*?"<>|]/);
      expect(filename).toMatch(/^a-b-c-d-e-f-g-h-i-j-jpyc-polygon-5\.svg$/);
    });
  });

  describe('3-step UI refresh', () => {
    it('Step 1 / 2 / 3 の heading が見える (aria-labelledby = step-N-heading)', async () => {
      const { container } = render(<QrGenerator />);
      await waitFor(() => screen.getByPlaceholderText(/0x\.\.\./));

      const step1 = container.querySelector('[aria-labelledby="step-1-heading"]');
      const step2 = container.querySelector('[aria-labelledby="step-2-heading"]');
      const step3 = container.querySelector('[aria-labelledby="step-3-heading"]');
      expect(step1).not.toBeNull();
      expect(step2).not.toBeNull();
      expect(step3).not.toBeNull();
      // step badge と icon は aria-hidden、accessible name は title text のみ。
      expect(screen.getByRole('heading', { name: /^金額$/ })).toBeInTheDocument();
      expect(screen.getByRole('heading', { name: /^受取先$/ })).toBeInTheDocument();
      expect(
        screen.getByRole('heading', { name: /^QR コード$/ }),
      ).toBeInTheDocument();
    });

    it('Step 3 (QR) card は qr-prominent variant の brand border / ring', async () => {
      const { container } = render(<QrGenerator />);
      await waitFor(() => screen.getByPlaceholderText(/0x\.\.\./));
      const step3 = container.querySelector('[aria-labelledby="step-3-heading"]')!;
      expect(step3.className).toMatch(/border-brand\/40/);
      expect(step3.className).toMatch(/ring-1/);
    });

    it('「ガスレス決済」option の傍に「おすすめ」 badge が出る (open advanced 後)', async () => {
      const user = userEvent.setup();
      render(<QrGenerator />);
      await openAdvanced(user);
      // gasless ボタンの accessible name 内に "おすすめ" を含む
      const gaslessBtn = await screen.findByRole('button', {
        name: /ガスレス決済.*おすすめ/,
      });
      expect(gaslessBtn).toBeInTheDocument();
      // 通常決済 ボタンは「おすすめ」 badge を含まない
      const standardBtn = screen.getByRole('button', {
        name: /^通常決済（ガスあり）/,
      });
      expect(standardBtn.textContent).not.toMatch(/おすすめ/);
    });

    it('QR empty state: receiver / amount いずれも未入力 → checklist で両方 ✗', async () => {
      const { container } = render(<QrGenerator />);
      await waitFor(() =>
        screen.getByText(/QR コードを作成する準備ができていません/),
      );
      // 不足項目が Step 3 内の ul に 2 件並ぶ (Step 2 visible 内の同名 label と
      // 区別するため、Step 3 領域に scope して assertion)。
      const list = container.querySelector(
        '[aria-labelledby="step-3-heading"] ul',
      );
      expect(list).not.toBeNull();
      expect(within(list as HTMLElement).getByText(/受取先ウォレットアドレス/)).toBeInTheDocument();
      expect(within(list as HTMLElement).getByText(/請求金額/)).toBeInTheDocument();
    });

    it('QR empty state: receiver のみ入力 → 受取先は done (✓)、金額は未 done', async () => {
      const user = userEvent.setup();
      const { container } = render(<QrGenerator />);
      await waitFor(() => screen.getByPlaceholderText(/0x\.\.\./));
      await user.type(screen.getByPlaceholderText(/0x\.\.\./), VALID);

      // empty state は依然表示 (金額未入力)
      await waitFor(() =>
        expect(
          screen.getByText(/QR コードを作成する準備ができていません/),
        ).toBeInTheDocument(),
      );

      // checklist items の done badge を class で識別
      // (done: bg-emerald-500、not done: border bg-white)
      const list = container.querySelector(
        '[aria-labelledby="step-3-heading"] ul',
      );
      expect(list).not.toBeNull();
      const items = list!.querySelectorAll('li');
      expect(items.length).toBe(2);
      // checklist 順は ①金額 → ②受取先。receiver のみ入力済なので:
      // 1 つ目 (金額) は未 done = border
      expect(items[0].querySelector('span')!.className).toMatch(/border/);
      // 2 つ目 (受取先) は done = emerald
      expect(items[1].querySelector('span')!.className).toMatch(/bg-emerald-500/);
    });

    it('Web3 用語の和らげ: gasless desc に「お客様はガス代を用意せず」が含まれる', async () => {
      const user = userEvent.setup();
      render(<QrGenerator />);
      await openAdvanced(user);
      const gaslessBtn = await screen.findByRole('button', {
        name: /ガスレス決済/,
      });
      expect(gaslessBtn.textContent).toMatch(/お客様はガス代を用意せず/);
      // 旧文言 (「OpenPay がガスを肩代わり。」) は消えている
      expect(gaslessBtn.textContent).not.toMatch(/OpenPay がガスを肩代わり/);
    });

    it('Web3 用語の和らげ: split label が「売上の自動分配」に変わっている', async () => {
      const user = userEvent.setup();
      render(<QrGenerator />);
      await openAdvanced(user);
      // 既定 (gasless) では split field が表示される
      expect(
        await screen.findByText(/売上の自動分配/),
      ).toBeInTheDocument();
      // split desc にも「スタッフ・共同運営者・クリエイター」が含まれる
      expect(
        screen.getByText(/スタッフ・共同運営者・クリエイター/),
      ).toBeInTheDocument();
      // 旧の「UserOperation でバッチ送金」表現は消えている
      expect(screen.queryByText(/UserOperation/)).toBeNull();
    });

    it('モーダルの印刷ボタンは brand color (primary CTA) として描画', async () => {
      const user = userEvent.setup();
      render(<QrGenerator />);
      await waitFor(() => screen.getByPlaceholderText(/0x\.\.\./));
      await user.type(screen.getByPlaceholderText(/0x\.\.\./), VALID);
      await user.type(screen.getByPlaceholderText('1000'), '500');

      // 印刷ボタンはモーダル内。
      await openQrModal(user);
      const printBtn = await screen.findByRole('button', { name: /印刷/ });
      expect(printBtn.className).toMatch(/bg-brand/);
      expect(printBtn.className).toMatch(/text-white/);
    });

    it('Step 1 内に token chooser (JPYC / USDC) が置かれている', async () => {
      const { container } = render(<QrGenerator />);
      await waitFor(() => screen.getByPlaceholderText(/0x\.\.\./));
      const step1 = container.querySelector(
        '[aria-labelledby="step-1-heading"]',
      ) as HTMLElement;
      expect(step1).not.toBeNull();
      // Step 1 領域内に JPYC / USDC ボタンが両方存在
      expect(
        within(step1).getByRole('button', { name: /^JPYC$/ }),
      ).toBeInTheDocument();
      expect(
        within(step1).getByRole('button', { name: /^USDC$/ }),
      ).toBeInTheDocument();
    });

    it('Step 1 内に chain chooser: USDC 5 chain + JPYC 2 chain (token 切替で内容変化)', async () => {
      // 2026-05-23 JPYC が Kaia 対応で multi-chain 化したため、JPYC 選択時も
      // chain chooser が出る (旧: JPYC は Polygon 固定で chain chooser 非表示)。
      // phase 4a で USDC は Ethereum L1 追加 (4 → 5 chain)。
      const user = userEvent.setup();
      const { container } = render(<QrGenerator />);
      await waitFor(() => screen.getByPlaceholderText(/0x\.\.\./));
      const step1 = container.querySelector(
        '[aria-labelledby="step-1-heading"]',
      ) as HTMLElement;
      // 既定 JPYC のとき chain chooser に Polygon / Kaia 両方が出る
      expect(
        within(step1).getByRole('button', { name: /^Polygon/ }),
      ).toBeInTheDocument();
      expect(
        within(step1).getByRole('button', { name: /^Kai/ }),
      ).toBeInTheDocument();
      // USDC chain (Base 等) は出ない
      expect(
        within(step1).queryByRole('button', { name: /^Base/ }),
      ).toBeNull();
      // USDC に切替 → chain chooser が USDC 5 chain に切替
      await user.click(within(step1).getByRole('button', { name: /^USDC$/ }));
      await waitFor(() => {
        expect(
          within(step1).getByRole('button', { name: /^Base/ }),
        ).toBeInTheDocument();
      });
      // Arbitrum / Optimism / Polygon / Ethereum (Sepolia in testnet) も Step 1 内に並ぶ
      expect(
        within(step1).getByRole('button', { name: /^Arbitrum/ }),
      ).toBeInTheDocument();
      // Ethereum L1 chain — testnet env では viem の sepolia.name = "Sepolia"
      expect(
        within(step1).getByRole('button', { name: /^(Sepolia|Ethereum)/ }),
      ).toBeInTheDocument();
      // Kaia は USDC では出ない (USDC は Kaia 未対応)
      expect(
        within(step1).queryByRole('button', { name: /^Kai/ }),
      ).toBeNull();
    });

    // UX 詰め (2026-06-05): ② 受取先は折りたたみに戻した (初期設定後あまり変えない)。
    // 受取先 seed 済 → default closed (toggle button あり・input は unmount)。開くと出る。
    it('② 受取先は折りたたみ: seed 済は閉じて開くと input が出る', async () => {
      window.localStorage.setItem(
        'openpay:qr-settings:v2',
        JSON.stringify({ receiver: VALID, token: 'jpyc' }),
      );
      const user = userEvent.setup();
      render(<QrGenerator />);
      // 受取先 seed 済 → ② は閉じる → toggle button が出て input は未 mount。
      const toggle = await screen.findByRole('button', { name: /受取先/ });
      await waitFor(() =>
        expect(toggle.getAttribute('aria-expanded')).toBe('false'),
      );
      expect(screen.queryByPlaceholderText(/0x\.\.\./)).toBeNull();
      // 開くと receiver input が出る。
      await user.click(toggle);
      expect(await screen.findByPlaceholderText(/0x\.\.\./)).toBeVisible();
    });
  });

  describe('3-step UI: 境界条件 / エッジケース', () => {
    // IA 統一で ① 受取先の折りたたみを廃止したため、collapsible 起因のエッジ
    // (init 一度のみ / clear で open 維持 / collapsed で input unmount 保護) は仕様消滅。
    it('据え置きモード: amount input 無し → QR empty state の "請求金額" は auto-done (✓)', async () => {
      // mode=static は amount input が存在せず、amountValid = true 固定。
      // empty state の checklist で「請求金額」項目が done 扱いになる検証。
      const user = userEvent.setup();
      const { container } = render(<QrGenerator />);
      await waitFor(() => screen.getByPlaceholderText(/0x\.\.\./));
      // 据え置きモードへ切替 (Step 1 内)
      await user.click(screen.getByRole('button', { name: /据え置き/ }));
      // 受取先未設定なので empty state は表示
      await waitFor(() =>
        expect(
          screen.getByText(/QR コードを作成する準備ができていません/),
        ).toBeInTheDocument(),
      );
      const list = container.querySelector(
        '[aria-labelledby="step-3-heading"] ul',
      )!;
      const items = list.querySelectorAll('li');
      expect(items.length).toBe(2);
      // checklist 順は ①金額 → ②受取先。
      // 1 つ目 (金額) は据え置きなので auto-done = emerald
      expect(items[0].querySelector('span')!.className).toMatch(/bg-emerald-500/);
      // 2 つ目 (受取先) は未入力 = border
      expect(items[1].querySelector('span')!.className).toMatch(/border/);
    });

    it('据え置きモード + 受取先 valid → "生成中" でも空状態でもなく QR が出る', async () => {
      const user = userEvent.setup();
      const { container } = render(<QrGenerator />);
      await waitFor(() => screen.getByPlaceholderText(/0x\.\.\./));
      await user.type(screen.getByPlaceholderText(/0x\.\.\./), VALID);
      await user.click(screen.getByRole('button', { name: /据え置き/ }));
      // 入力画面は empty state も "生成中" も出ず「QRコードを表示する」ボタンになる。
      expect(
        screen.queryByText(/QR コードを作成する準備ができていません/),
      ).toBeNull();
      expect(screen.queryByText(/QR を生成中/)).toBeNull();
      // QR 本体はモーダル内 (size=260)。
      await openQrModal(user);
      await waitFor(() => {
        const svgs = container.querySelectorAll('svg');
        const qrSvg = Array.from(svgs).find(
          (s) => s.getAttribute('width') === '260',
        );
        expect(qrSvg).toBeDefined();
      });
    });

    it('Step 1: rapid token switching (JPYC → USDC → JPYC) で chain が default に reset される', async () => {
      // USDC は Arbitrum 等の non-default chain も選べるが、JPYC へ切替時に
      // chain が polygon 固定にリセットされる。さらに再度 USDC に戻すと
      // default の base に戻る (= ユーザの直前選択は破棄)。
      const user = userEvent.setup();
      render(<QrGenerator />);
      await waitFor(() => screen.getByPlaceholderText(/0x\.\.\./));
      // USDC へ
      await user.click(screen.getByRole('button', { name: /^USDC$/ }));
      // chain chooser から Arbitrum を選択
      await user.click(screen.getByRole('button', { name: /^Arbitrum/ }));
      // chain=arbitrum を localStorage で確認
      await waitFor(() => {
        const raw = window.localStorage.getItem('openpay:qr-settings:v2');
        expect(JSON.parse(raw!).chain).toBe('arbitrum');
      });
      // JPYC へ戻す → chain は polygon にリセット
      await user.click(screen.getByRole('button', { name: /^JPYC$/ }));
      await waitFor(() => {
        const raw = window.localStorage.getItem('openpay:qr-settings:v2');
        expect(JSON.parse(raw!).chain).toBe('polygon');
      });
      // 再 USDC → chain は base に戻る (直前の arbitrum は引き継がない)
      await user.click(screen.getByRole('button', { name: /^USDC$/ }));
      await waitFor(() => {
        const raw = window.localStorage.getItem('openpay:qr-settings:v2');
        expect(JSON.parse(raw!).chain).toBe('base');
      });
    });

    it('Step 1: token + chain の組合せが Step 3 poster preview に伝播 (USDC + crossChain ON default)', async () => {
      const user = userEvent.setup();
      render(<QrGenerator />);
      await waitFor(() => screen.getByPlaceholderText(/0x\.\.\./));
      await user.type(screen.getByPlaceholderText(/0x\.\.\./), VALID);
      await user.click(screen.getByRole('button', { name: /^USDC$/ }));
      await user.click(screen.getByRole('button', { name: /^Arbitrum/ }));
      await user.type(screen.getByPlaceholderText('10.00'), '1');
      // poster はモーダル内。
      await openQrModal(user);
      // crossChain default=true (USDC は他 chain からも受信可能)、poster は
      // buyerUsdcChainNames() の対応 chain (merchant 受信 6: Base / Arbitrum /
      // Optimism / Polygon / Ethereum / Avalanche + buyer-only 5: Unichain /
      // World Chain / Sonic / Sei / HyperEVM) を全列挙する (お客向け = どの chain で
      // 持っていれば払えるか明示)。
      // 2026-05-27: Ethereum L1 を merchant-and-buyer に復帰 (戻し忘れ修正、commit
      // 2f0c53f) したため poster にも Ethereum (testnet env では viem .name =
      // "Sepolia") が出る。
      await waitFor(() => {
        const el = screen.getByText(/USDC ·/);
        expect(el.textContent).toMatch(/Base/);
        expect(el.textContent).toMatch(/Arbitrum/);
        expect(el.textContent).toMatch(/(Optimism|OP Mainnet|OP Sepolia)/);
        expect(el.textContent).toMatch(/Polygon/);
        // Ethereum L1 (testnet env では .name = "Sepolia" 単独) も含まれる。
        // "Base Sepolia" / "OP Sepolia" / "Unichain Sepolia" は別物なので chain 名
        // list を split で正確に切り出して検査する。
        const usdcLine = el.textContent ?? '';
        const chainsPart = usdcLine.split('·')[1] ?? '';
        const chainTokens = chainsPart.split('/').map((s) => s.trim());
        expect(chainTokens).toContain('Sepolia');
        // phase 4b-1 buyer-only chains — testnet env では "Avalanche Fuji" /
        // "Unichain Sepolia"
        expect(el.textContent).toMatch(/(Avalanche|Fuji)/);
        expect(el.textContent).toMatch(/Unichain/);
      });
    });

    it('crossChain OFF (USDC + opt-out toggle) → poster は単一 chain 表示', async () => {
      const user = userEvent.setup();
      render(<QrGenerator />);
      await waitFor(() => screen.getByPlaceholderText(/0x\.\.\./));
      await user.type(screen.getByPlaceholderText(/0x\.\.\./), VALID);
      await user.click(screen.getByRole('button', { name: /^USDC$/ }));
      await user.click(screen.getByRole('button', { name: /^Arbitrum/ }));
      // 高度な設定 accordion を開く (cross-chain toggle が中にある)
      await user.click(screen.getByRole('button', { name: /高度な設定|Advanced settings/ }));
      // cross-chain toggle を OFF
      const toggle = screen.getByRole('checkbox', {
        name: /他チェーンからの支払を許可|Allow cross-chain payments/,
      });
      await user.click(toggle);
      await user.type(screen.getByPlaceholderText('10.00'), '1');
      // poster はモーダル内。
      await openQrModal(user);
      // crossChain OFF → 単一 chain 名 (Arbitrum 系) のみ表示、他 chain 名は出ない
      await waitFor(() => {
        const el = screen.getByText(/USDC ·/);
        expect(el.textContent).toMatch(/Arbitrum/);
        expect(el.textContent).not.toMatch(/Base/);
        expect(el.textContent).not.toMatch(/Polygon/);
      });
    });

    it('JPYC は crossChain ON でも単一 chain 表示 (JPYC は Gateway/CCTP 非対応)', async () => {
      const user = userEvent.setup();
      render(<QrGenerator />);
      await waitFor(() => screen.getByPlaceholderText(/0x\.\.\./));
      await user.type(screen.getByPlaceholderText(/0x\.\.\./), VALID);
      // JPYC は default、polygon chain も default
      await user.type(screen.getByPlaceholderText('1000'), '500');
      // poster はモーダル内。
      await openQrModal(user);
      await waitFor(() => {
        const el = screen.getByText(/JPYC ·/);
        // JPYC は 1 chain のみ ("·" の右側に / は出ない)
        expect(el.textContent).not.toMatch(/\//);
      });
    });

    it('Step 1: JPYC + Kaia 選択 → URL に chain=kaia + token=jpyc + amount が含まれる', async () => {
      // 2026-05-23 Kaia 対応の主要 invariant: JPYC chain chooser で Kaia を
      // 選んだ時に生成 URL が chain=kaia を含むこと、payUrl pipeline が壊れない
      // ことを実 component で確認。
      const user = userEvent.setup();
      const { container } = render(<QrGenerator />);
      await waitFor(() => screen.getByPlaceholderText(/0x\.\.\./));
      await user.type(screen.getByPlaceholderText(/0x\.\.\./), VALID);
      // JPYC は default なので Kaia chain button を直接 click
      await user.click(screen.getByRole('button', { name: /^Kai/ }));
      await user.type(screen.getByPlaceholderText('1000'), '500');
      // payUrl 表示 box / poster はモーダル内 (font-mono.text-xs.bg-slate-50)
      await openQrModal(user);
      await waitFor(() => {
        const urlBox = container.querySelector(
          '.font-mono.text-xs.bg-slate-50',
        )!;
        expect(urlBox.textContent).toContain(`to=${VALID}`);
        expect(urlBox.textContent).toContain('chain=kaia');
        expect(urlBox.textContent).toContain('token=jpyc');
        expect(urlBox.textContent).toContain('amount=500');
      });
      // poster preview の chain 表示は "JPYC · Kairos Testnet" (testnet env)
      // または "JPYC · Kaia" (mainnet env)、どちらも JPYC · Kai... で始まる
      await waitFor(() => {
        expect(screen.getByText(/JPYC · Kai/)).toBeInTheDocument();
      });
    });

    it('Step 1: JPYC chain を Polygon→Kaia→Polygon と切替 → localStorage と URL が同期', async () => {
      // chain selector の round-trip + localStorage 永続化を確認。
      const user = userEvent.setup();
      const { container } = render(<QrGenerator />);
      await waitFor(() => screen.getByPlaceholderText(/0x\.\.\./));
      await user.type(screen.getByPlaceholderText(/0x\.\.\./), VALID);
      await user.type(screen.getByPlaceholderText('1000'), '100');
      // URL box はモーダル内。開いたまま chain を切替 (背後の chooser は操作可)。
      await openQrModal(user);
      // 既定は polygon
      await waitFor(() => {
        const raw = window.localStorage.getItem('openpay:qr-settings:v2');
        expect(JSON.parse(raw!).chain).toBe('polygon');
      });
      // Kaia に切替
      await user.click(screen.getByRole('button', { name: /^Kai/ }));
      await waitFor(() => {
        const raw = window.localStorage.getItem('openpay:qr-settings:v2');
        expect(JSON.parse(raw!).chain).toBe('kaia');
        const urlBox = container.querySelector(
          '.font-mono.text-xs.bg-slate-50',
        )!;
        expect(urlBox.textContent).toContain('chain=kaia');
      });
      // Polygon に戻す
      await user.click(screen.getByRole('button', { name: /^Polygon/ }));
      await waitFor(() => {
        const raw = window.localStorage.getItem('openpay:qr-settings:v2');
        expect(JSON.parse(raw!).chain).toBe('polygon');
        const urlBox = container.querySelector(
          '.font-mono.text-xs.bg-slate-50',
        )!;
        // polygon は default なので chain= は URL に出ない (buildPayUrl の最適化)
        expect(urlBox.textContent).not.toContain('chain=kaia');
      });
    });

    it('Step 1 token chooser: USDC ↔ JPYC 切替で chain chooser の中身が入替 (USDC 5 chain / JPYC 2 chain)', async () => {
      // 2026-05-23 JPYC Kaia 対応で JPYC も multi-chain 化。USDC ↔ JPYC 切替で
      // chain chooser はどちらの token でも出るが、表示される chain set が変わる
      // (USDC: Base/Arb/Op/Polygon/Ethereum 5 chain、JPYC: Polygon/Kaia 2 chain)。
      const user = userEvent.setup();
      const { container } = render(<QrGenerator />);
      await waitFor(() => screen.getByPlaceholderText(/0x\.\.\./));
      // 一度 USDC にして USDC chain chooser を露出
      await user.click(screen.getByRole('button', { name: /^USDC$/ }));
      const step1 = container.querySelector(
        '[aria-labelledby="step-1-heading"]',
      ) as HTMLElement;
      expect(
        within(step1).getByRole('button', { name: /^Base/ }),
      ).toBeInTheDocument();
      // Kaia は USDC では出ない
      expect(
        within(step1).queryByRole('button', { name: /^Kai/ }),
      ).toBeNull();
      // JPYC へ戻す
      await user.click(screen.getByRole('button', { name: /^JPYC$/ }));
      // USDC chain (Base / Arbitrum) は消える
      expect(
        within(step1).queryByRole('button', { name: /^Base/ }),
      ).toBeNull();
      expect(
        within(step1).queryByRole('button', { name: /^Arbitrum/ }),
      ).toBeNull();
      // 代わりに JPYC chain chooser (Polygon / Kaia) が出る
      expect(
        within(step1).getByRole('button', { name: /^Polygon/ }),
      ).toBeInTheDocument();
      expect(
        within(step1).getByRole('button', { name: /^Kai/ }),
      ).toBeInTheDocument();
    });

    // IA 統一で ① 受取先は常時表示。payUrl 生成 + token 切替→poster 同期は折りたたみ
    // 非依存になったので、collapse 前提を外して再構成 (truncate summary テストは廃止)。
    it('受取先 preset + 金額入力 → payUrl に to/amount + QR が出る', async () => {
      window.localStorage.setItem(
        'openpay:qr-settings:v2',
        JSON.stringify({ receiver: VALID, token: 'jpyc' }),
      );
      const user = userEvent.setup();
      const { container } = render(<QrGenerator />);
      await screen.findByPlaceholderText('1000');
      await user.type(screen.getByPlaceholderText('1000'), '500');
      // QR / URL はモーダル内 (size=260)。
      await openQrModal(user);
      await waitFor(() => {
        const svgs = container.querySelectorAll('svg');
        const qrSvg = Array.from(svgs).find(
          (s) => s.getAttribute('width') === '260',
        );
        expect(qrSvg).toBeDefined();
      });
      // payUrl はモーダルの URL 表示にテキストとして出る (container 全体で確認)。
      expect(container.textContent).toContain(`to=${VALID}`);
      expect(container.textContent).toContain('amount=500');
    });

    it('Step 1 で token 切替 → poster preview の symbol が同期更新する', async () => {
      window.localStorage.setItem(
        'openpay:qr-settings:v2',
        JSON.stringify({ receiver: VALID, token: 'jpyc' }),
      );
      const user = userEvent.setup();
      render(<QrGenerator />);
      await screen.findByPlaceholderText('1000');
      await user.type(screen.getByPlaceholderText('1000'), '100');
      // poster preview はモーダル内。開いたまま token を切替 (背後の chooser は操作可)。
      await openQrModal(user);
      await waitFor(() =>
        expect(screen.getByText(/JPYC · Polygon/)).toBeInTheDocument(),
      );
      await user.click(screen.getByRole('button', { name: /^USDC$/ }));
      await waitFor(() =>
        expect(screen.getByText(/USDC · Base/)).toBeInTheDocument(),
      );
    });

    it('Phase 1: 手数料徴収先アドレスセクションは撤去されている (default + advanced 開いた状態の両方)', async () => {
      const user = userEvent.setup();
      render(<QrGenerator />);
      // default では advanced 閉、当然 fee 徴収先は出ない
      expect(screen.queryByText(/OpenPay 利用手数料の徴収先/)).toBeNull();
      // advanced を開いても fee 徴収先セクションは復活しない
      await openAdvanced(user);
      expect(screen.queryByText(/OpenPay 利用手数料の徴収先/)).toBeNull();
    });

    it('Sub-summary に開発者向け内部値 (gas:cust / 0.5%/std) が漏れていない', async () => {
      // 規制: 旧 mono サマリ (例 "1%/gas:cust") を 100% 撤去。Phase 1 で「手数料 X%」
      // 文言も撤去し、advanced summary は日本語の自然文のみで構成される。
      window.localStorage.setItem(
        'openpay:qr-settings:v2',
        JSON.stringify({
          receiver: VALID,
          token: 'usdc',
          payMode: 'gasless',
          gasMode: 'customer',
        }),
      );
      const user = userEvent.setup();
      const { container } = render(<QrGenerator />);
      await openStep2(user);
      const toggle = await screen.findByRole('button', { name: /高度な設定/ });
      // closed 状態でも summary 全体に旧トークンが含まれない
      expect(container.textContent).not.toMatch(/gas:cust|gas:merch|%\/std/);
      // toggle 内に新文言 (Phase 1: 手数料% 表記なし) が出る
      expect(
        within(toggle).getByText(/ガスレス決済 \/ ガス代：お客様負担/),
      ).toBeInTheDocument();
    });

    // en locale で advancedSummary.* 3 key を実 render 経路で exercise。
    // ja default のテストでは en 値のタイポ / 翻訳間違いを検知できないので、
    // payMode × gasMode の 3 組合せを localStorage で固定して i18n 経路を実走。
    it.each([
      {
        payMode: 'gasless',
        gasMode: 'customer',
        expected: /Gasless \/ gas: customer pays/,
      },
      {
        payMode: 'gasless',
        gasMode: 'merchant',
        expected: /Gasless \/ gas: merchant pays/,
      },
      {
        payMode: 'standard',
        gasMode: 'customer',
        expected: /Standard payment \(with gas\)/,
      },
    ] as const)(
      'en locale: payMode=$payMode gasMode=$gasMode → 英文サマリ "$expected"',
      async ({ payMode, gasMode, expected }) => {
        window.localStorage.setItem(
          'openpay:qr-settings:v2',
          JSON.stringify({
            receiver: VALID,
            token: 'usdc',
            payMode,
            gasMode,
          }),
        );
        render(<QrGenerator />, { locale: 'en' });
        // 高度な設定は ② の後の独立セクション (default 閉) なので直接 toggle を取る。
        const advancedToggle = await screen.findByRole('button', {
          name: /Advanced settings/,
        });
        await waitFor(() =>
          expect(advancedToggle.getAttribute('aria-expanded')).toBe('false'),
        );
        expect(within(advancedToggle).getByText(expected)).toBeInTheDocument();
      },
    );
  });
});

describe('QrGenerator: 他トークン建てで受け取る (FX 換算・有効期限付き)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    // convert ボタンは受取先確定が前提 (exp が QR 生成前に走らないようにするため)。
    // 既定で receiver を seed し (Step 2 折り畳み)、Step 1 の amount/convert を検証する。
    window.localStorage.setItem(
      'openpay:qr-settings:v2',
      JSON.stringify({ receiver: VALID, token: 'jpyc' }),
    );
    useOriginMock.mockReturnValue('https://test.local');
    marketRatesData.mockReturnValue({
      data: { usdcJpy: 150, updatedAt: '2026-06-03T00:00:00.000Z' },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
  });

  it('JPYC + 金額入力で convert ボタンが出る (金額未入力では出ない)', async () => {
    const user = userEvent.setup();
    render(<QrGenerator />);
    await waitFor(() => screen.getByPlaceholderText('1000'));
    expect(
      screen.queryByRole('button', { name: /USDC 建てで受取る/ }),
    ).toBeNull();
    await user.type(screen.getByPlaceholderText('1000'), '1000');
    expect(
      await screen.findByRole('button', { name: /USDC 建てで受取る/ }),
    ).toBeInTheDocument();
  });

  it('受取先 未設定では金額を入れても convert ボタンは出ない (exp の早期発火を防ぐ)', async () => {
    window.localStorage.clear(); // receiver seed を無効化 (受取先なし状態)
    const user = userEvent.setup();
    render(<QrGenerator />);
    await waitFor(() => screen.getByPlaceholderText('1000'));
    await user.type(screen.getByPlaceholderText('1000'), '1000');
    expect(
      screen.queryByRole('button', { name: /USDC 建てで受取る/ }),
    ).toBeNull();
  });

  it('クリックで USDC 建てに換算 (1000 JPYC @150 → 6.666667 USDC) + URL に exp/refAmt/fxRate', async () => {
    const user = userEvent.setup();
    render(<QrGenerator />);
    await waitFor(() => screen.getByPlaceholderText('1000'));
    await user.type(screen.getByPlaceholderText('1000'), '1000');
    await user.click(
      await screen.findByRole('button', { name: /USDC 建てで受取る/ }),
    );

    // token が USDC に切替 (placeholder 10.00) + amount は ceil 換算値
    const input = (await screen.findByPlaceholderText(
      '10.00',
    )) as HTMLInputElement;
    expect(input.value).toBe('6.666667');
    // 換算サマリ (anchor 円価格 ≈ USDC 額)
    expect(screen.getByText(/1000 JPYC ≈ 6\.666667 USDC/)).toBeInTheDocument();
    // URL はモーダル内。
    await openQrModal(user);
    // URL に変換情報が乗る
    await waitFor(() => {
      const url = screen.getByText(
        (t) => t.includes('/pay?') && t.includes('amount=6.666667'),
      );
      expect(url.textContent).toContain('token=usdc');
      expect(url.textContent).toContain('refAmt=1000');
      expect(url.textContent).toContain('fxRate=150');
      expect(url.textContent).toMatch(/exp=\d+/);
    });
  });

  it('換算後に金額を手動編集すると換算ロック解除 (URL から refAmt が消える)', async () => {
    const user = userEvent.setup();
    render(<QrGenerator />);
    await waitFor(() => screen.getByPlaceholderText('1000'));
    await user.type(screen.getByPlaceholderText('1000'), '1000');
    await user.click(
      await screen.findByRole('button', { name: /USDC 建てで受取る/ }),
    );
    const input = await screen.findByPlaceholderText('10.00');
    // URL はモーダル内。開いたまま amount を編集 (背後の input は操作可)。
    await openQrModal(user);
    await waitFor(() =>
      expect(
        screen.getByText((t) => t.includes('refAmt=1000')),
      ).toBeInTheDocument(),
    );
    await user.clear(input);
    await user.type(input, '5');
    await waitFor(() =>
      expect(screen.queryByText((t) => t.includes('refAmt='))).toBeNull(),
    );
  });

  it('据え置きモードでは convert ボタンは出ない', async () => {
    const user = userEvent.setup();
    render(<QrGenerator />);
    await waitFor(() => screen.getByPlaceholderText('1000'));
    await user.type(screen.getByPlaceholderText('1000'), '1000');
    expect(
      await screen.findByRole('button', { name: /USDC 建てで受取る/ }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /据え置き/ }));
    expect(
      screen.queryByRole('button', { name: /USDC 建てで受取る/ }),
    ).toBeNull();
  });

  it('「元の JPYC 建てに戻す」で anchor (JPYC 1000) に復帰', async () => {
    const user = userEvent.setup();
    render(<QrGenerator />);
    await waitFor(() => screen.getByPlaceholderText('1000'));
    await user.type(screen.getByPlaceholderText('1000'), '1000');
    await user.click(
      await screen.findByRole('button', { name: /USDC 建てで受取る/ }),
    );
    await screen.findByPlaceholderText('10.00');
    await user.click(
      await screen.findByRole('button', { name: /元の JPYC 建てに戻す/ }),
    );
    const input = (await screen.findByPlaceholderText(
      '1000',
    )) as HTMLInputElement;
    expect(input.value).toBe('1000');
    expect(screen.queryByRole('button', { name: /再計算/ })).toBeNull();
  });

  it('USDC 建て換算後、cross-chain 受取の注記が出る', async () => {
    const user = userEvent.setup();
    render(<QrGenerator />);
    await waitFor(() => screen.getByPlaceholderText('1000'));
    await user.type(screen.getByPlaceholderText('1000'), '1000');
    await user.click(
      await screen.findByRole('button', { name: /USDC 建てで受取る/ }),
    );
    expect(
      await screen.findByText(/他チェーンの USDC でも支払い/),
    ).toBeInTheDocument();
  });

  it('レート取得不可なら convert ボタンの代わりに注意文', async () => {
    marketRatesData.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      refetch: vi.fn(),
    });
    const user = userEvent.setup();
    render(<QrGenerator />);
    await waitFor(() => screen.getByPlaceholderText('1000'));
    await user.type(screen.getByPlaceholderText('1000'), '1000');
    expect(
      screen.queryByRole('button', { name: /USDC 建てで受取る/ }),
    ).toBeNull();
    expect(screen.getByText(/為替レートを取得できない/)).toBeInTheDocument();
  });

  it('再計算ボタンで換算パスが再実行される (額は同レートで維持・panel 継続)', async () => {
    const user = userEvent.setup();
    render(<QrGenerator />);
    await waitFor(() => screen.getByPlaceholderText('1000'));
    await user.type(screen.getByPlaceholderText('1000'), '1000');
    await user.click(
      await screen.findByRole('button', { name: /USDC 建てで受取る/ }),
    );
    const input = (await screen.findByPlaceholderText(
      '10.00',
    )) as HTMLInputElement;
    expect(input.value).toBe('6.666667');
    // 再計算 (同レート 150) → 換算パスが走り、額は維持・convert パネルは継続
    await user.click(await screen.findByRole('button', { name: /再計算/ }));
    expect(
      (screen.getByPlaceholderText('10.00') as HTMLInputElement).value,
    ).toBe('6.666667');
    expect(
      screen.getByRole('button', { name: /元の JPYC 建てに戻す/ }),
    ).toBeInTheDocument();
  });

  it('convert 後 180s 経過で「再計算してください」表示に変わる (fake timers)', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    try {
      vi.setSystemTime(new Date(2026, 5, 3, 12, 0, 0).getTime());
      const user = userEvent.setup();
      render(<QrGenerator />);
      await user.type(screen.getByPlaceholderText('1000'), '1000');
      await user.click(
        screen.getByRole('button', { name: /USDC 建てで受取る/ }),
      );
      // 期限内: 残り 3:00、期限切れ文言は無い
      expect(screen.getByText(/残り 3:00/)).toBeInTheDocument();
      expect(screen.queryByText(/再計算してください/)).toBeNull();
      // 181s 経過 → interval が convertExpired を flip
      await act(async () => {
        await vi.advanceTimersByTimeAsync(181_000);
      });
      expect(screen.getByText(/再計算してください/)).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('QrGenerator — 会計用任意項目 (記帳補助)', () => {
  beforeEach(() => window.localStorage.clear());

  it('seeded した商品名/税率/税区分が payUrl に乗る', async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(
      'openpay:qr-settings:v2',
      JSON.stringify({
        receiver: VALID,
        token: 'jpyc',
        chain: 'polygon',
        productName: 'コーヒー',
        taxRate: 10,
        taxCategory: 'taxable_10',
      }),
    );
    render(<QrGenerator />);
    await waitFor(() => screen.getByPlaceholderText('1000'));
    await user.type(screen.getByPlaceholderText('1000'), '500');
    // payUrl はモーダル内。
    await openQrModal(user);
    await waitFor(() =>
      expect(screen.getByText((t) => t.includes('tax=10'))).toBeInTheDocument(),
    );
    expect(
      screen.getByText((t) => t.includes('taxcat=taxable_10')),
    ).toBeInTheDocument();
    expect(screen.getByText((t) => t.includes('pname='))).toBeInTheDocument();
  });

  it('会計項目 未設定なら payUrl に税/商品 params は出ない (既存挙動)', async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(
      'openpay:qr-settings:v2',
      JSON.stringify({ receiver: VALID, token: 'jpyc', chain: 'polygon' }),
    );
    render(<QrGenerator />);
    await waitFor(() => screen.getByPlaceholderText('1000'));
    await user.type(screen.getByPlaceholderText('1000'), '500');
    // payUrl はモーダル内。
    await openQrModal(user);
    await waitFor(() =>
      expect(
        screen.getByText((t) => t.includes('amount=500')),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByText((t) => t.includes('tax='))).toBeNull();
    expect(screen.queryByText((t) => t.includes('pname='))).toBeNull();
  });
});

describe('QrGenerator: モバイル下部バー (請求金額 + QR ボタン重複回避)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    useOriginMock.mockReturnValue('https://test.local');
  });

  it('金額入力 → 下部バーに請求金額を表示・「QRコードを表示する」は重複しない (Step3=lg限定/バー=モバイル限定)', async () => {
    window.localStorage.setItem(
      'openpay:qr-settings:v2',
      JSON.stringify({ receiver: VALID, token: 'jpyc', chain: 'polygon' }),
    );
    const user = userEvent.setup();
    render(<QrGenerator />);
    await user.type(screen.getByPlaceholderText('1000'), '12345');

    // payUrl 確定後、CTA は Step3 (lg 右サイド) と下部バー (モバイル) の 2 箇所に出る。
    await waitFor(() =>
      expect(
        screen.getAllByRole('button', { name: /QRコードを表示する/ }),
      ).toHaveLength(2),
    );
    const btns = screen.getAllByRole('button', { name: /QRコードを表示する/ });
    // DOM 先頭 = Step3 ボタン。モバイル非表示 (lg のみ) になっている。
    expect(btns[0].className).toContain('hidden');
    expect(btns[0].className).toContain('lg:inline-flex');
    // 2 つ目 = 下部バー側。モバイル限定 (lg:hidden) コンテナで、請求金額を表示する。
    const bar = btns[1].closest('div');
    expect(bar?.className).toContain('lg:hidden');
    expect(bar?.textContent).toContain('12345 JPYC');
    // モバイルでは重複ボタンの代わりに誘導文を出す。
    expect(
      screen.getByText(/下のバーの「QRコードを表示する」から/),
    ).toBeInTheDocument();
  });

  it('据え置き (static) モードは固定額が無いので金額入力の案内を出す', async () => {
    window.localStorage.setItem(
      'openpay:qr-settings:v2',
      JSON.stringify({ receiver: VALID, token: 'jpyc', chain: 'polygon' }),
    );
    const user = userEvent.setup();
    render(<QrGenerator />);
    // 「金額を据え置きにしない」= static モードへ切替 (モード選択ボタン)。
    await user.click(screen.getByRole('button', { name: /据え置き|金額未指定|static/i }));
    await waitFor(() =>
      expect(
        screen.getAllByRole('button', { name: /QRコードを表示する/ }).length,
      ).toBeGreaterThanOrEqual(1),
    );
    const btns = screen.getAllByRole('button', { name: /QRコードを表示する/ });
    const bar = btns[btns.length - 1].closest('div');
    // static は posterOpenAmount = "{symbol} で金額を入力" を表示。
    expect(bar?.textContent).toContain('JPYC で金額を入力');
  });
});
