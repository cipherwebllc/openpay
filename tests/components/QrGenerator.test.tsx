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

// Step 2 (受取先) は localStorage に有効 address があると default 折り畳まれる
// (returning user 向け UX、3-step UI refactor 2026-05-23 後追い)。Step 2 内の
// receiver / storeName / posterNote / 高度な設定 を触るテストは Step 2 を先に
// 開く必要がある。Step 2 が既に open のときは no-op。
async function openStep2(
  user: ReturnType<typeof userEvent.setup>,
): Promise<void> {
  // h2 内の toggle button は accessible name = "受取先" + (任意で summary)。
  // 単純 substring 一致 (`/受取先/`) で取れる。
  const toggle = await screen.findByRole('button', { name: /受取先/ });
  if (toggle.getAttribute('aria-expanded') !== 'true') {
    await user.click(toggle);
  }
}

// 高度な設定 accordion は default 閉なので、payMode / gas / split / quickAmount
// editor を触るテストはまず accordion を開く必要がある。さらに Step 2 が折り畳ま
// れていると accordion 自体が unmount されるので、Step 2 → 高度な設定 の順で開く。
async function openAdvanced(
  user: ReturnType<typeof userEvent.setup>,
): Promise<void> {
  await openStep2(user);
  const toggle = await screen.findByRole('button', { name: /高度な設定/ });
  if (toggle.getAttribute('aria-expanded') !== 'true') {
    await user.click(toggle);
  }
}

describe('QrGenerator', () => {
  beforeEach(() => {
    window.localStorage.clear();
    useOriginMock.mockReturnValue('https://test.local');
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
      const usdcBtn = screen.getByRole('button', { name: /^USDC/ });
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
      await user.click(screen.getByRole('button', { name: /^USDC/ }));
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
      const usdcBtn = screen.getByRole('button', { name: /^USDC/ });
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
      // direct=false / gasMode=merchant → 日本語サマリ "ガス代：店主負担"
      expect(
        within(toggle).getByText(/手数料 1\.0% \/ ガス代：店主負担/),
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
      // gasMode default = customer → 日本語サマリ "ガス代：お客様負担"
      expect(
        within(toggle).getByText(/手数料 1\.0% \/ ガス代：お客様負担/),
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
      await openAdvanced(user);

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

      // URL に mode=standard が出る (font-mono の payUrl 表示 + 警告文等にも
      // "mode=standard" 文字列が含まれるため、payUrl 限定で /pay?... 形式の URL を assert)
      await waitFor(() => {
        expect(
          screen.getByText((t) => /\/pay\?[^ ]*mode=standard/.test(t)),
        ).toBeInTheDocument();
      });

      // 通常決済モードの説明 (hint) が表示される
      expect(
        screen.getByText(/OpenPay 利用手数料は決済金額の 0\.5%/),
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

    it('payMode=standard でアコーディオン閉時のサマリに「手数料 0.5%（通常決済）」と出る', async () => {
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
        within(toggle).getByText(/手数料 0\.5%（通常決済）/),
      ).toBeInTheDocument();
    });

    it('payMode=gasless (default) でアコーディオン閉時のサマリに「手数料 1.0% / ガス代：お客様負担」と出る', async () => {
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
        within(toggle).getByText(/手数料 1\.0% \/ ガス代：お客様負担/),
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
      await waitFor(() => {
        expect(screen.getByText('ガスレス決済')).toBeInTheDocument();
      });
    });

    it('USDC + Ethereum (= 強制 standard): "通常決済（ETH ガス代を別途用意）" badge', async () => {
      window.localStorage.setItem(
        'openpay:qr-settings:v2',
        JSON.stringify({
          receiver: VALID,
          token: 'usdc',
          chain: 'ethereum',
          // selectChain が payMode='standard' に強制するが、localStorage 直接
          // 注入の場合も sanitize で standard に倒れる (gasless 非対応 chain
          // + payMode=gasless saved 状態の migrate path)。
          payMode: 'gasless',
          gasMode: 'customer',
        }),
      );
      const user = userEvent.setup();
      render(<QrGenerator />);
      await openStep2(user);
      // USDC placeholder は '10.00' (decimals=6 想定の例値)
      await user.type(screen.getByPlaceholderText('10.00'), '5');
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

      // fee bypass 警告 banner が EIP-681 section と同時に表示される (store 向け透明化)
      expect(
        screen.getByText(/この QR では OpenPay 利用手数料.*徴収されません/),
      ).toBeInTheDocument();
      expect(
        screen.getByText(
          /両方を同時に掲示すると、顧客がどちらを scan するかで実質料率/,
        ),
      ).toBeInTheDocument();
    });

    it('EIP-681 section は default で閉じている (details summary が初期状態 closed)', async () => {
      const user = userEvent.setup();
      render(<QrGenerator />);
      await waitFor(() => screen.getByPlaceholderText(/0x\.\.\./));
      await user.type(screen.getByPlaceholderText(/0x\.\.\./), VALID);
      await user.type(screen.getByPlaceholderText('1000'), '1000');
      await openAdvanced(user);
      await user.click(screen.getByRole('button', { name: /通常決済（ガスあり）/ }));

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
      await user.click(screen.getByRole('button', { name: /^USDC/ }));
      await openAdvanced(user);
      await user.click(screen.getByRole('button', { name: /通常決済（ガスあり）/ }));

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
      await user.click(screen.getByRole('button', { name: /^USDC/ }));
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
      await user.click(screen.getByRole('button', { name: /^USDC/ }));
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

      // JPYC: 1 JPYC = 1e18 wei
      const jpycUri = (
        await screen.findByText((t) => t.startsWith('ethereum:'))
      ).textContent!;
      expect(jpycUri).toContain('uint256=1000000000000000000');

      // amount state は token 切替で reset されず、新しい decimals で再評価される。
      await user.click(screen.getByRole('button', { name: /^USDC/ }));
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
      await user.click(screen.getByRole('button', { name: /^USDC/ }));
      await user.type(screen.getByPlaceholderText('10.00'), '1');
      await openAdvanced(user);
      await user.click(screen.getByRole('button', { name: /通常決済（ガスあり）/ }));

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
      // 1 つ目 (receiver) は done = emerald
      expect(items[0].querySelector('span')!.className).toMatch(/bg-emerald-500/);
      // 2 つ目 (amount) は未 done = border
      expect(items[1].querySelector('span')!.className).toMatch(/border/);
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

    it('Step 3 印刷ボタンは brand color (primary CTA) として描画', async () => {
      const user = userEvent.setup();
      render(<QrGenerator />);
      await waitFor(() => screen.getByPlaceholderText(/0x\.\.\./));
      await user.type(screen.getByPlaceholderText(/0x\.\.\./), VALID);
      await user.type(screen.getByPlaceholderText('1000'), '500');

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
        within(step1).getByRole('button', { name: /^USDC/ }),
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
      await user.click(within(step1).getByRole('button', { name: /^USDC/ }));
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

    it('Step 2 は collapsible (LocalStorage 空時は default open)', async () => {
      render(<QrGenerator />);
      const toggle = await screen.findByRole('button', { name: /^受取先/ });
      // hydrated 後の useEffect で receiver=null → step2Open=true へ遷移
      await waitFor(() =>
        expect(toggle.getAttribute('aria-expanded')).toBe('true'),
      );
      // open 中なので receiver input が見える
      expect(screen.getByPlaceholderText(/0x\.\.\./)).toBeVisible();
    });

    it('Step 2 は preset receiver で default 閉じる + summary に short address', async () => {
      window.localStorage.setItem(
        'openpay:qr-settings:v2',
        JSON.stringify({
          receiver: VALID,
          token: 'jpyc',
          directTransfer: false,
        }),
      );
      render(<QrGenerator />);
      const toggle = await screen.findByRole('button', { name: /^受取先/ });
      // hydrated 後に default closed へ
      await waitFor(() =>
        expect(toggle.getAttribute('aria-expanded')).toBe('false'),
      );
      // closed 時は heading button 内に short address (0x8335...2913) が表示
      expect(within(toggle).getByText(/0x8335…2913/)).toBeInTheDocument();
      // closed 時は receiver input は unmount (DOM から消える)
      expect(screen.queryByPlaceholderText(/0x\.\.\./)).toBeNull();
    });

    it('Step 2 collapsed summary に storeName 設定済なら "name · short" 形式', async () => {
      window.localStorage.setItem(
        'openpay:qr-settings:v2',
        JSON.stringify({
          receiver: VALID,
          storeName: 'Kanda Coffee',
          token: 'jpyc',
          directTransfer: false,
        }),
      );
      render(<QrGenerator />);
      const toggle = await screen.findByRole('button', { name: /^受取先/ });
      await waitFor(() =>
        expect(toggle.getAttribute('aria-expanded')).toBe('false'),
      );
      // "Kanda Coffee · 0x8335…2913" 形式
      expect(
        within(toggle).getByText(/Kanda Coffee · 0x8335…2913/),
      ).toBeInTheDocument();
    });

    it('Step 2 を click で open → receiver input が再 mount される', async () => {
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
      const toggle = await screen.findByRole('button', { name: /^受取先/ });
      await waitFor(() =>
        expect(toggle.getAttribute('aria-expanded')).toBe('false'),
      );
      // closed → click → open
      await user.click(toggle);
      expect(toggle.getAttribute('aria-expanded')).toBe('true');
      // receiver input が出現
      expect(screen.getByPlaceholderText(/0x\.\.\./)).toBeVisible();
    });
  });

  describe('3-step UI: 境界条件 / エッジケース', () => {
    it('Step 2 init は hydrate 後 一度のみ — 受取先 type 中に勝手に折り畳まれない', async () => {
      // 新規 user: receiver=null → step2Open=true。input に typing して有効化
      // しても、step2Initialized=true 後は useEffect が再評価しないため
      // collapsed に反転しないことを保証 (= 入力フロー中断防止)。
      const user = userEvent.setup();
      render(<QrGenerator />);
      const toggle = await screen.findByRole('button', { name: /^受取先/ });
      await waitFor(() =>
        expect(toggle.getAttribute('aria-expanded')).toBe('true'),
      );
      // 完全な VALID address を type
      await user.type(screen.getByPlaceholderText(/0x\.\.\./), VALID);
      // typing 完了後も Step 2 は open のまま (race 防止が機能)
      expect(toggle.getAttribute('aria-expanded')).toBe('true');
      // 続けて store name も入力可能 (input が mounted)
      expect(screen.getByPlaceholderText(/OpenPay Coffee/)).toBeInTheDocument();
    });

    it('preset receiver + 手動 open → receiver clear → Step 2 は open 維持 (再 collapse しない)', async () => {
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
      const toggle = await screen.findByRole('button', { name: /^受取先/ });
      // hydrate 後 default closed
      await waitFor(() =>
        expect(toggle.getAttribute('aria-expanded')).toBe('false'),
      );
      // 手動 open
      await user.click(toggle);
      expect(toggle.getAttribute('aria-expanded')).toBe('true');
      // address input を clear
      const addrInput = screen.getByPlaceholderText(/0x\.\.\./);
      await user.clear(addrInput);
      // receiver が null になっても Step 2 は open 維持 (step2Initialized 後は
      // useEffect が一度のみで再評価しない invariant)
      expect(toggle.getAttribute('aria-expanded')).toBe('true');
    });

    it('Step 2 collapsed 状態で receiver を抹消できない (折り畳み中は input が unmount のため defacto 保護)', async () => {
      window.localStorage.setItem(
        'openpay:qr-settings:v2',
        JSON.stringify({
          receiver: VALID,
          storeName: 'Test Shop',
          token: 'jpyc',
          directTransfer: false,
        }),
      );
      render(<QrGenerator />);
      const toggle = await screen.findByRole('button', { name: /^受取先/ });
      await waitFor(() =>
        expect(toggle.getAttribute('aria-expanded')).toBe('false'),
      );
      // closed の間は input が DOM に存在しないため誤操作で clear できない
      expect(screen.queryByPlaceholderText(/0x\.\.\./)).toBeNull();
      // collapsed summary は valid な receiver で正しい形式
      expect(
        within(toggle).getByText(/Test Shop · 0x8335…2913/),
      ).toBeInTheDocument();
    });

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
      // 1 つ目 (receiver) は未 done = border
      expect(items[0].querySelector('span')!.className).toMatch(/border/);
      // 2 つ目 (amount) は据え置きなので auto-done = emerald
      expect(items[1].querySelector('span')!.className).toMatch(/bg-emerald-500/);
    });

    it('据え置きモード + 受取先 valid → "生成中" でも空状態でもなく QR が出る', async () => {
      const user = userEvent.setup();
      const { container } = render(<QrGenerator />);
      await waitFor(() => screen.getByPlaceholderText(/0x\.\.\./));
      await user.type(screen.getByPlaceholderText(/0x\.\.\./), VALID);
      await user.click(screen.getByRole('button', { name: /据え置き/ }));
      // payUrl 生成 (amount 無しでも static で OK)
      await waitFor(() => {
        const svgs = container.querySelectorAll('svg');
        // OpenPay QR (size=240) が描画される
        const qrSvg = Array.from(svgs).find(
          (s) => s.getAttribute('width') === '240',
        );
        expect(qrSvg).toBeDefined();
      });
      // empty state も "生成中" も出ない
      expect(
        screen.queryByText(/QR コードを作成する準備ができていません/),
      ).toBeNull();
      expect(screen.queryByText(/QR を生成中/)).toBeNull();
    });

    it('Step2Summary fallback: 受取先 null + 手動 open → 再 close で fallback ("未設定")', async () => {
      // edge: user が手動操作で receiver なし + Step 2 closed という珍しい状態
      // (preset 設定で default open になり、その後 user が手動 close した場合)
      // を作って Step2Summary の fallback branch を検証。
      window.localStorage.setItem(
        'openpay:qr-settings:v2',
        JSON.stringify({
          // receiver はあえて空にして default open + 手動 close を再現
          receiver: '',
          storeName: '',
          token: 'jpyc',
          directTransfer: false,
        }),
      );
      const user = userEvent.setup();
      render(<QrGenerator />);
      const toggle = await screen.findByRole('button', { name: /^受取先/ });
      await waitFor(() =>
        expect(toggle.getAttribute('aria-expanded')).toBe('true'),
      );
      // 手動 close
      await user.click(toggle);
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      // fallback text "未設定" が summary に出る
      expect(within(toggle).getByText('未設定')).toBeInTheDocument();
    });

    it('Step 1: rapid token switching (JPYC → USDC → JPYC) で chain が default に reset される', async () => {
      // USDC は Arbitrum 等の non-default chain も選べるが、JPYC へ切替時に
      // chain が polygon 固定にリセットされる。さらに再度 USDC に戻すと
      // default の base に戻る (= ユーザの直前選択は破棄)。
      const user = userEvent.setup();
      render(<QrGenerator />);
      await waitFor(() => screen.getByPlaceholderText(/0x\.\.\./));
      // USDC へ
      await user.click(screen.getByRole('button', { name: /^USDC/ }));
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
      await user.click(screen.getByRole('button', { name: /^USDC/ }));
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
      await user.click(screen.getByRole('button', { name: /^USDC/ }));
      await user.click(screen.getByRole('button', { name: /^Arbitrum/ }));
      await user.type(screen.getByPlaceholderText('10.00'), '1');
      // crossChain default=true (USDC は他 chain からも受信可能)、
      // poster は対応 6 chain (merchant-and-buyer 4: Base / Arbitrum / Optimism /
      // Polygon + buyer-only 2: Avalanche / Unichain) を全列挙する (お客向け =
      // どの chain で持っていれば払えるか明示)。
      // 2026-05-24 Ethereum L1 は merchant-only に変更 (address poisoning + RPC
      // 不安定) → buyer cross-chain source から除外。poster 表示も backend 挙動
      // (BUYER_SOURCE_TARGETS) と sync させて Ethereum を出さない。
      await waitFor(() => {
        const el = screen.getByText(/USDC ·/);
        expect(el.textContent).toMatch(/Base/);
        expect(el.textContent).toMatch(/Arbitrum/);
        expect(el.textContent).toMatch(/(Optimism|OP Mainnet|OP Sepolia)/);
        expect(el.textContent).toMatch(/Polygon/);
        // Ethereum L1 は出ない (testnet では viem .name = "Sepolia" 単独、
        // mainnet では "Ethereum")。"Base Sepolia" / "OP Sepolia" / "Unichain Sepolia"
        // は別物なので chain 名 list を split で正確に切り出して検査する。
        const usdcLine = el.textContent ?? '';
        const chainsPart = usdcLine.split('·')[1] ?? '';
        const chainTokens = chainsPart.split('/').map((s) => s.trim());
        expect(chainTokens).not.toContain('Sepolia');
        expect(chainTokens).not.toContain('Ethereum');
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
      await user.click(screen.getByRole('button', { name: /^USDC/ }));
      await user.click(screen.getByRole('button', { name: /^Arbitrum/ }));
      // 高度な設定 accordion を開く (cross-chain toggle が中にある)
      await user.click(screen.getByRole('button', { name: /高度な設定|Advanced settings/ }));
      // cross-chain toggle を OFF
      const toggle = screen.getByRole('checkbox', {
        name: /他チェーンからの支払を許可|Allow cross-chain payments/,
      });
      await user.click(toggle);
      await user.type(screen.getByPlaceholderText('10.00'), '1');
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
      // payUrl 表示 box (Step 3 内 font-mono.text-xs.bg-slate-50)
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
      await user.click(screen.getByRole('button', { name: /^USDC/ }));
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

    it('Step 2 collapsed 時の summary text は very long storeName を truncate (max-w 内に収まる)', async () => {
      // storeName 最大 (~30 char) を保存 + receiver 設定 → Step 2 collapsed
      // 状態で summary class に truncate が付くこと、text が縦に折り返さないこと。
      window.localStorage.setItem(
        'openpay:qr-settings:v2',
        JSON.stringify({
          receiver: VALID,
          // STORE_NAME_MAX 上限近い長文 (実 useQrSettings の input clamp に整合)
          storeName: '神田珈琲店本店 — 中央区銀座 6 丁目 12-3',
          token: 'jpyc',
          directTransfer: false,
        }),
      );
      const { container } = render(<QrGenerator />);
      const toggle = await screen.findByRole('button', { name: /^受取先/ });
      await waitFor(() =>
        expect(toggle.getAttribute('aria-expanded')).toBe('false'),
      );
      // summary の wrapper span に truncate class が付いている
      const summarySpan = container.querySelector(
        '#step-2-heading span.truncate',
      );
      expect(summarySpan).not.toBeNull();
      expect(summarySpan?.textContent).toContain('神田珈琲店本店');
      expect(summarySpan?.textContent).toContain('0x8335…2913');
    });

    it('Step 2 collapsed 状態で payUrl は生成され、Step 3 で QR が出る (collapse は payUrl に影響しない)', async () => {
      window.localStorage.setItem(
        'openpay:qr-settings:v2',
        JSON.stringify({
          receiver: VALID,
          token: 'jpyc',
          directTransfer: false,
        }),
      );
      const user = userEvent.setup();
      const { container } = render(<QrGenerator />);
      const toggle = await screen.findByRole('button', { name: /^受取先/ });
      await waitFor(() =>
        expect(toggle.getAttribute('aria-expanded')).toBe('false'),
      );
      // closed 状態のまま Step 1 で amount 入力
      await user.type(screen.getByPlaceholderText('1000'), '500');
      // QR (size=240) が描画される
      await waitFor(() => {
        const svgs = container.querySelectorAll('svg');
        const qrSvg = Array.from(svgs).find(
          (s) => s.getAttribute('width') === '240',
        );
        expect(qrSvg).toBeDefined();
      });
      // payUrl 内に正しい to / amount が含まれる
      const urlBox = container.querySelector('.font-mono.text-xs')!;
      expect(urlBox.textContent).toContain(`to=${VALID}`);
      expect(urlBox.textContent).toContain('amount=500');
    });

    it('Step 2 collapsed → Step 1 で token 切替 → poster preview の symbol も同期更新', async () => {
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
      const toggle = await screen.findByRole('button', { name: /^受取先/ });
      await waitFor(() =>
        expect(toggle.getAttribute('aria-expanded')).toBe('false'),
      );
      // amount 入力 → JPYC で poster
      await user.type(screen.getByPlaceholderText('1000'), '100');
      await waitFor(() =>
        expect(screen.getByText(/JPYC · Polygon/)).toBeInTheDocument(),
      );
      // USDC に切替 → poster の symbol も "USDC · Base" (default chain) に
      await user.click(screen.getByRole('button', { name: /^USDC/ }));
      await waitFor(() =>
        expect(screen.getByText(/USDC · Base/)).toBeInTheDocument(),
      );
      // Step 2 は collapsed のまま (token 切替で勝手に開かない)
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
    });

    it('手数料徴収先アドレスは default では visible でない (長 0x... を初見ノイズから排除)', async () => {
      render(<QrGenerator />);
      await waitFor(() => screen.getByPlaceholderText(/0x\.\.\./));
      // 「OpenPay 利用手数料の徴収先」 label が DOM に存在しない (closed accordion 内)
      expect(screen.queryByText(/OpenPay 利用手数料の徴収先/)).toBeNull();
    });

    it('高度な設定 を開くと 手数料徴収先アドレス が表示される (透明性は維持)', async () => {
      const user = userEvent.setup();
      render(<QrGenerator />);
      await openAdvanced(user);
      expect(
        await screen.findByText(/OpenPay 利用手数料の徴収先/),
      ).toBeInTheDocument();
      // env.feeReceiver の実値が表示される (test env では 0x...dEaD placeholder)
      const feeAddressMatch = await screen.findByText(/^0x[a-fA-F0-9]{40}$/);
      expect(feeAddressMatch.className).toMatch(/font-mono/);
    });

    it('Sub-summary に開発者向け内部値 (gas:cust / 0.5%/std) が漏れていない', async () => {
      // 規制: 旧 mono サマリ (例 "1%/gas:cust") を 100% 撤去する。新サマリは
      // 日本語/英語の自然文 ("ガス代：お客様負担") のみで構成される。
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
      // toggle 内に新文言が出る
      expect(
        within(toggle).getByText(/手数料 1\.0% \/ ガス代：お客様負担/),
      ).toBeInTheDocument();
    });

    // en locale で advancedSummary.* 3 key を実 render 経路で exercise。
    // ja default のテストでは en 値のタイポ / 翻訳間違いを検知できないので、
    // payMode × gasMode の 3 組合せを localStorage で固定して i18n 経路を実走。
    it.each([
      {
        payMode: 'gasless',
        gasMode: 'customer',
        expected: /Fee 1\.0% \/ gas: customer pays/,
      },
      {
        payMode: 'gasless',
        gasMode: 'merchant',
        expected: /Fee 1\.0% \/ gas: merchant pays/,
      },
      {
        payMode: 'standard',
        gasMode: 'customer',
        expected: /Fee 0\.5% \(standard payment\)/,
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
        const user = userEvent.setup();
        render(<QrGenerator />, { locale: 'en' });
        // en では Step 2 toggle button name = "Recipient"
        const step2Toggle = await screen.findByRole('button', {
          name: /Recipient/,
        });
        if (step2Toggle.getAttribute('aria-expanded') !== 'true') {
          await user.click(step2Toggle);
        }
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
