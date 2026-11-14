// レジ (components/RegisterMode.tsx) が作る支払いの URL と、カートの境目の動きを固定する (characterization)。
// ほかの RegisterMode のテストは URL を項目ごと (parseCheckoutParams の一部) に見ていて、次が固定されていなかった:
//   - URL の全 param の完全一致 (とくに誰がガス代を払うかの gas)
//   - カートが空になったら値引きを外す (次のお客様に前の値引きを付けない)
//   - 数量の上限 999 (/checkout が受け付ける上限と同じ)
//   - 同じ品・同じオプションの行をまとめる / 違うオプションは別の行
//   - お店負担 (お店の端末で送る) の最低額 1 JPYC の境目
// 期待はどれも「今の動き」。QR の中身は qrcode.react を差し替えて読む (お客様が読み取る値そのもの)。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, type ReactElement } from 'react';
import userEvent from '@testing-library/user-event';
import { renderWithIntl } from '../_helpers/i18n';

vi.mock('@/hooks/useResolveAddress', () => ({
  useResolveAddress: vi.fn(() => ({ data: null, isFetching: false, error: null })),
}));
vi.mock('wagmi', () => ({
  useAccount: vi.fn(() => ({ address: undefined, isConnected: false })),
}));
vi.mock('@/hooks/useOrigin', () => ({ useOrigin: () => 'https://test.local' }));
vi.mock('@/hooks/useMarketRates', () => ({
  useMarketRates: () => ({ data: { usdcJpy: 150, updatedAt: '2026-06-03T00:00:00.000Z' }, isLoading: false, isError: false, refetch: vi.fn() }),
}));
vi.mock('@/hooks/useSiweSession', () => ({
  useSiweSession: () => ({ isSignedIn: false, sessionAddress: null, mismatch: false, isLoading: false, signIn: vi.fn(), isSigningIn: false, signInError: null, signOut: vi.fn() }),
}));

const hold = vi.hoisted(() => ({
  // JPYC のガスレスが EIP-3009 の中継か (false は Pimlico の経路)。
  eip3009: true,
  // 回収の forwarder (null = 中継が利用料を取らない経路)。
  forwarder: null as string | null,
  storeGasWallet: false,
  menuOptions: false,
  gas: '0x0000000000000000000000000000000000000abc' as string | null,
  state: { phase: 'idle' } as Record<string, unknown>,
  start: vi.fn(),
  stop: vi.fn(),
  release: vi.fn(),
}));
// QR の中身 (URL) を読む。お店負担の QR は URL を画面に出さないので、どの QR も同じ取り方にする。
vi.mock('qrcode.react', () => ({
  QRCodeSVG: ({ value }: { value: string }) => <svg data-testid="qr" data-value={value} />,
}));
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      networkEnv: 'testnet',
      feeReceiver: '0x428483FbA62eDCef1E3a100d3799F6d71759c560',
      enableShopLive: false,
      enableMobileOrder: false,
      get enableJpycEip3009() {
        return hold.eip3009;
      },
      get enableStoreGasWallet() {
        return hold.storeGasWallet;
      },
      get enableMenuOptions() {
        return hold.menuOptions;
      },
    },
  };
});
vi.mock('@/lib/relay/forwarderConfig', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/relay/forwarderConfig')>()),
  jpycForwarderFor: () => hold.forwarder,
}));
vi.mock('@/hooks/useStoreDeviceRegister', () => ({
  useStoreDeviceRegister: () => ({
    state: hold.state,
    busy: false,
    start: hold.start,
    stop: hold.stop,
    releaseForNormal: hold.release,
    checkNow: vi.fn(),
    retry: vi.fn(),
    dismiss: vi.fn(),
  }),
}));
vi.mock('@/components/StoreGasWalletPanel', () => ({
  StoreGasWalletPanel: ({ onAddressChange }: { onAddressChange?: (a: string | null) => void }) => {
    useEffect(() => {
      onAddressChange?.(hold.gas);
    }, [onAddressChange]);
    return <div>gas-wallet-panel</div>;
  },
}));

import { RegisterMode } from '@/components/RegisterMode';
import { calcCheckoutPayable, parseCheckoutParams } from '@/lib/url';

const VALID = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const FORWARDER = '0x752B7AaD0089286EB7b553d84D05233d80c9FCB4';
const HS = 'AbCdEfGhIjKlMnOpQrStUv';
const QR_KEY = 'openpay:qr-settings:v2';
const PRESETS_KEY = 'openpay:product-presets:v1';
const JPYC = 10n ** 18n;
const USDC = 10n ** 6n;

type User = ReturnType<typeof userEvent.setup>;
type Preset = Record<string, unknown>;

function render(ui: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderWithIntl(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

/** お店の設定 (決済QRタブと共有)。受取先は入れておく。 */
function seedSettings(extra: Record<string, unknown> = {}) {
  window.localStorage.setItem(QR_KEY, JSON.stringify({ receiver: VALID, token: 'jpyc', chain: 'polygon', ...extra }));
}
/** レジの商品。渡さなければ初期の見本 (コーヒー 500・Tシャツ 3000・イベント参加費 1000・Tip 300)。 */
function seedPresets(presets: Preset[]) {
  window.localStorage.setItem(
    PRESETS_KEY,
    JSON.stringify({
      presets: presets.map((p, i) => ({ token: 'jpyc', taxRate: 10, taxCategory: 'taxable_10', memo: null, sortOrder: i, enabled: true, ...p })),
      receipt: { day: '', n: 0 },
    }),
  );
}

const GYUDON: Preset = {
  id: 'gy',
  name: '牛丼',
  unitPrice: '500',
  options: [
    {
      id: 'g1',
      name: 'サイズ',
      type: 'single',
      required: true,
      choices: [
        { id: 's', label: '小盛り', priceDelta: '0' },
        { id: 'l', label: '大盛り', priceDelta: '200' },
      ],
    },
    { id: 'g2', name: 'トッピング', type: 'multi', choices: [{ id: 'ebi', label: 'えび', priceDelta: '150' }] },
  ],
};

async function findTile(name: RegExp) {
  const region = await screen.findByRole('region', { name: /^(商品|Products)$/ });
  return within(region).findByRole('button', { name });
}
async function tap(user: User, name: RegExp) {
  await user.click(await findTile(name));
}
function orderPanel() {
  return within(screen.getByRole('region', { name: /^(ご注文|Order)$/ }));
}
/** 注文パネルの 小計 / うち税額 / 合計 の行。 */
function summaryRow(label: string) {
  return within(orderPanel().getByText(label).closest('div') as HTMLElement);
}
/** カートの行 (名前のボタンを含む listitem)。 */
function cartLines() {
  return orderPanel().queryAllByRole('listitem');
}
function cartLine(name: string | RegExp) {
  const li = cartLines().find((el) => within(el).queryByRole('button', { name }) !== null);
  if (!li) throw new Error(`カートに行が無い: ${String(name)}`);
  return within(li);
}
function qtyOf(name: string | RegExp) {
  return cartLine(name).getByRole('textbox', { name: '数量' }) as HTMLInputElement;
}
async function openLine(user: User, name: string | RegExp) {
  const toggle = orderPanel().getByRole('button', { name });
  if (toggle.getAttribute('aria-expanded') !== 'true') await user.click(toggle);
}
async function deleteLine(user: User, name: string | RegExp) {
  await openLine(user, name);
  await user.click(screen.getByRole('button', { name: 'この商品を削除' }));
}
async function addDiscount(user: User, mode: 'amount' | 'percent', value: string) {
  await user.click(orderPanel().getByRole('button', { name: '＋ 値引きを追加' }));
  if (mode === 'percent') await user.click(orderPanel().getByRole('button', { name: '割引率' }));
  await user.type(orderPanel().getByLabelText(mode === 'amount' ? '値引きの金額' : '割引率 (%)'), value);
}
/** オプションつきの品を、選んだ選択肢でカートに入れる。 */
async function addWithOptions(user: User, tile: RegExp, choices: { radio?: RegExp; checkbox?: RegExp }) {
  await tap(user, tile);
  if (choices.radio) await user.click(screen.getByRole('radio', { name: choices.radio }));
  if (choices.checkbox) await user.click(screen.getByRole('checkbox', { name: choices.checkbox }));
  await user.click(screen.getByRole('button', { name: 'カートに追加' }));
}

/** QR のボタン (PC の注文パネルとスマホの下部バーの 2 つ・jsdom には両方ある) の 1 つ目を押し、QR の中身を返す。 */
async function openQr(user: User, cta: RegExp = /QRコードを表示する/) {
  const btns = await screen.findAllByRole('button', { name: cta });
  await waitFor(() => expect(btns[0]).toBeEnabled());
  await user.click(btns[0]);
  const qr = await screen.findByTestId('qr');
  return qr.getAttribute('data-value')!;
}
/** URL の path と、全 param (同じ名前が 2 回あれば落とす)。 */
function parts(value: string) {
  const url = new URL(value);
  const keys = [...url.searchParams.keys()];
  if (new Set(keys).size !== keys.length) throw new Error(`param が重なっている: ${keys.join(',')}`);
  return { base: `${url.origin}${url.pathname}`, query: Object.fromEntries(url.searchParams), searchParams: url.searchParams };
}
/** URL から /checkout が請求する額 (小計 − 値引き)。 */
function payableOf(searchParams: URLSearchParams, unit: bigint) {
  const parsed = parseCheckoutParams(searchParams);
  if (!parsed.ok) throw new Error(`/checkout が受け付けない URL: ${parsed.error}`);
  return calcCheckoutPayable(parsed.params, unit === JPYC ? 18 : 6);
}
const enc = encodeURIComponent;

describe('RegisterMode: 作られる支払い URL と、カートの境目', () => {
  beforeEach(() => {
    window.localStorage.clear();
    hold.eip3009 = true;
    hold.forwarder = null;
    hold.storeGasWallet = false;
    hold.menuOptions = false;
    hold.gas = '0x0000000000000000000000000000000000000abc';
    hold.state = { phase: 'idle' };
    hold.start.mockReset().mockResolvedValue({ id: HS, token: 'ab'.repeat(32), expiresAt: 0, merchant: VALID, amount: '1', chainId: 80002 });
    hold.stop.mockReset();
    hold.release.mockReset().mockResolvedValue(true);
    global.fetch = vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) }) as Response) as unknown as typeof fetch;
  });

  describe('支払い URL の完全一致 (path と全 param)・URL の額 = 画面の合計', () => {
    type Row = {
      name: string;
      settings?: Record<string, unknown>;
      eip3009?: boolean;
      forwarder?: string | null;
      menuOptions?: boolean;
      presets?: Preset[];
      build: (user: User) => Promise<void>;
      /** 注文パネルと QR の画面に出る合計。 */
      total: string;
      /** URL が請求する額 (最小単位)。 */
      payable: bigint;
      unit: bigint;
      query: Record<string, string>;
    };
    const COFFEE = `${enc('コーヒー')}:1:500:10:taxable_10:`;
    const SHIRT = `${enc('Tシャツ')}:1:3000:10:taxable_10:`;
    const STICKER: Preset = { id: 'u1', name: 'Sticker', unitPrice: '5.5', token: 'usdc' };

    const rows: Row[] = [
      {
        // 中継が利用料を取らない経路には負担者が無い。保存された gasMode (決済QRタブの名残) は URL に出さない。
        name: 'JPYC・Polygon・ガス代不要 (中継・forwarder なし): gas を書かない (保存された gasMode=merchant でも)',
        settings: { gasMode: 'merchant' },
        build: async (user) => {
          await tap(user, /コーヒー/);
        },
        total: '500 JPYC',
        payable: 500n * JPYC,
        unit: JPYC,
        query: { to: VALID, token: 'jpyc', items: COFFEE },
      },
      {
        // 回収の経路はお店が利用料を持つ固定。保存された gasMode=customer でも gas=merchant。
        name: 'JPYC・Polygon・ガス代不要 (回収・forwarder あり): gas=merchant (保存された gasMode=customer でも)・品 2 つ',
        settings: { gasMode: 'customer' },
        forwarder: FORWARDER,
        build: async (user) => {
          await tap(user, /コーヒー/);
          await tap(user, /Tシャツ/);
        },
        total: '3,500 JPYC',
        payable: 3500n * JPYC,
        unit: JPYC,
        query: { to: VALID, token: 'jpyc', items: `${COFFEE},${SHIRT}`, gas: 'merchant' },
      },
      {
        name: 'JPYC・Polygon・ガス代不要 (中継が無効 = Pimlico の経路): 保存された gasMode=merchant をそのまま書く・数量 3',
        settings: { gasMode: 'merchant' },
        eip3009: false,
        build: async (user) => {
          await tap(user, /コーヒー/);
          await tap(user, /コーヒー/);
          await tap(user, /コーヒー/);
        },
        total: '1,500 JPYC',
        payable: 1500n * JPYC,
        unit: JPYC,
        query: { to: VALID, token: 'jpyc', items: `${enc('コーヒー')}:3:500:10:taxable_10:`, gas: 'merchant' },
      },
      {
        name: 'JPYC・Polygon・ガス代不要 (中継が無効)・gasMode=customer: gas を書かない・金額の値引き 20',
        settings: { gasMode: 'customer' },
        eip3009: false,
        forwarder: FORWARDER,
        build: async (user) => {
          await tap(user, /コーヒー/);
          await tap(user, /Tシャツ/);
          await addDiscount(user, 'amount', '20');
        },
        total: '3,480 JPYC',
        payable: 3480n * JPYC,
        unit: JPYC,
        query: { to: VALID, token: 'jpyc', items: `${COFFEE},${SHIRT}`, disc: '20' },
      },
      {
        // USDC は JPYC の経路ごとの固定に当たらない (中継も forwarder もあっても、お店が選んだ負担者)。
        name: 'USDC・Base・ガス代不要・gasMode=merchant: gas=merchant・小数の単価 × 2',
        settings: { token: 'usdc', chain: 'base', gasMode: 'merchant' },
        forwarder: FORWARDER,
        presets: [STICKER],
        build: async (user) => {
          await tap(user, /Sticker/);
          await tap(user, /Sticker/);
        },
        total: '11 USDC',
        payable: 11n * USDC,
        unit: USDC,
        query: { to: VALID, token: 'usdc', items: 'Sticker:2:5.5:10:taxable_10:', gas: 'merchant' },
      },
      {
        name: 'USDC・Base・ガス代不要・gasMode=customer: gas を書かない・値引き 0.5',
        settings: { token: 'usdc', chain: 'base', gasMode: 'customer' },
        forwarder: FORWARDER,
        presets: [STICKER],
        build: async (user) => {
          await tap(user, /Sticker/);
          await tap(user, /Sticker/);
          await addDiscount(user, 'amount', '0.5');
        },
        total: '10.5 USDC',
        payable: 10_500_000n,
        unit: USDC,
        query: { to: VALID, token: 'usdc', items: 'Sticker:2:5.5:10:taxable_10:', disc: '0.5' },
      },
      {
        name: 'USDC・Arbitrum・通常決済・gasMode=merchant: chain と mode=standard を書き、gas は書かない',
        settings: { token: 'usdc', chain: 'arbitrum', payMode: 'standard', gasMode: 'merchant' },
        presets: [STICKER],
        build: async (user) => {
          await tap(user, /Sticker/);
        },
        total: '5.5 USDC',
        payable: 5_500_000n,
        unit: USDC,
        query: { to: VALID, token: 'usdc', chain: 'arbitrum', items: 'Sticker:1:5.5:10:taxable_10:', mode: 'standard' },
      },
      {
        name: 'JPYC・Kaia・通常決済 (forwarder あり)・gasMode=merchant: gas は書かない・割引率 2% は額 (70) で載る',
        settings: { chain: 'kaia', payMode: 'standard', gasMode: 'merchant' },
        forwarder: FORWARDER,
        build: async (user) => {
          await tap(user, /コーヒー/);
          await tap(user, /Tシャツ/);
          await addDiscount(user, 'percent', '2');
        },
        total: '3,430 JPYC',
        payable: 3430n * JPYC,
        unit: JPYC,
        query: { to: VALID, token: 'jpyc', chain: 'kaia', items: `${COFFEE},${SHIRT}`, disc: '70', mode: 'standard' },
      },
      {
        name: 'オプションつきの品・メモつきの品・自由入力 (税なし) と、店名・登録番号・管理番号',
        settings: { storeName: 'OpenPay Cafe', invoiceNo: 'T1234567890123' },
        menuOptions: true,
        presets: [GYUDON, { id: 'on', name: 'おにぎり', unitPrice: '120', taxRate: 8, taxCategory: 'taxable_8', memo: '温め' }],
        build: async (user) => {
          await addWithOptions(user, /牛丼/, { radio: /大盛り/, checkbox: /えび/ });
          await tap(user, /おにぎり/);
          await tap(user, /おにぎり/);
          await user.click(screen.getByRole('button', { name: '自由入力' }));
          await user.type(screen.getByRole('textbox', { name: '商品名' }), 'ふくろ');
          await user.type(screen.getByRole('textbox', { name: '単価 (JPYC)' }), '5');
          await user.type(orderPanel().getByLabelText('管理番号 / レシート番号'), 'R-001');
        },
        total: '1,095 JPYC',
        payable: 1095n * JPYC,
        unit: JPYC,
        query: {
          to: VALID,
          token: 'jpyc',
          // 税・メモのある行は 6 区切り、無い行 (自由入力) は 3 区切り。
          items: `${enc('牛丼（大盛り・えび）')}:1:850:10:taxable_10:,${enc('おにぎり')}:2:120:8:taxable_8:${enc('温め')},${enc('ふくろ')}:1:5`,
          store: 'OpenPay Cafe',
          rcpt: 'R-001',
          inv: 'T1234567890123',
        },
      },
    ];

    it.each(rows)('$name', async (row) => {
      hold.eip3009 = row.eip3009 ?? true;
      hold.forwarder = row.forwarder ?? null;
      hold.menuOptions = row.menuOptions ?? false;
      seedSettings(row.settings);
      if (row.presets) seedPresets(row.presets);
      const user = userEvent.setup();
      render(<RegisterMode />);
      await row.build(user);

      // 画面の合計 (注文パネル)。
      expect(summaryRow('合計').getByText(row.total)).toBeInTheDocument();
      const value = await openQr(user);
      const { base, query, searchParams } = parts(value);
      expect(base).toBe('https://test.local/checkout');
      expect(query).toEqual(row.query);
      // URL の額 (小計 − 値引き) = 画面の合計 = お客様に見せる QR の画面の額。
      expect(payableOf(searchParams, row.unit)).toBe(row.payable);
      const dialog = within(screen.getByRole('dialog'));
      expect(dialog.getByText(row.total)).toBeInTheDocument();
      // 画面に出す URL (コピーする値) も QR と同じ。
      expect(dialog.getByText(value)).toBeInTheDocument();
    });
  });

  describe('カートが空になったら値引きを外す (次のお客様に前の値引きを付けない)', () => {
    it('値引きを付けた会計の行を消して空にすると値引きが外れ、次の品の額にも URL にも乗らない', async () => {
      const user = userEvent.setup();
      seedSettings();
      render(<RegisterMode />);
      await tap(user, /コーヒー/);
      await addDiscount(user, 'amount', '20');
      expect(summaryRow('合計').getByText('480 JPYC')).toBeInTheDocument();

      await deleteLine(user, /コーヒー/);
      expect(orderPanel().getByText('商品を選ぶか「自由入力」で追加してください。')).toBeInTheDocument();

      // 次のお客様: 値引きは「追加」に戻っていて、額は値引きなし。
      await tap(user, /Tシャツ/);
      expect(orderPanel().getByRole('button', { name: '＋ 値引きを追加' })).toBeInTheDocument();
      expect(orderPanel().queryByText(/^−/)).toBeNull();
      expect(summaryRow('合計').getByText('3,000 JPYC')).toBeInTheDocument();
      const { query, searchParams } = parts(await openQr(user));
      expect(query).toEqual({ to: VALID, token: 'jpyc', items: `${enc('Tシャツ')}:1:3000:10:taxable_10:` });
      expect(payableOf(searchParams, JPYC)).toBe(3000n * JPYC);
    });

    it('外れた後に「値引きを追加」を開いても、前に入れた値は残っていない (割引率で入れた会計の後)', async () => {
      const user = userEvent.setup();
      seedSettings();
      render(<RegisterMode />);
      await tap(user, /コーヒー/);
      await addDiscount(user, 'percent', '10');
      expect(summaryRow('合計').getByText('450 JPYC')).toBeInTheDocument();
      await deleteLine(user, /コーヒー/);

      await tap(user, /Tシャツ/);
      await user.click(orderPanel().getByRole('button', { name: '＋ 値引きを追加' }));
      expect(within(orderPanel().getByRole('group', { name: /値引き/ })).getByRole('textbox')).toHaveValue('');
      expect(summaryRow('合計').getByText('3,000 JPYC')).toBeInTheDocument();
    });

    it('行を消してもカートに品が残っていれば、値引きは付いたまま', async () => {
      const user = userEvent.setup();
      seedSettings();
      render(<RegisterMode />);
      await tap(user, /コーヒー/);
      await tap(user, /Tシャツ/);
      await addDiscount(user, 'amount', '20');
      expect(summaryRow('合計').getByText('3,480 JPYC')).toBeInTheDocument();

      await deleteLine(user, /コーヒー/);
      expect(orderPanel().getByText('−20 JPYC')).toBeInTheDocument();
      expect(summaryRow('合計').getByText('2,980 JPYC')).toBeInTheDocument();
      const { query, searchParams } = parts(await openQr(user));
      expect(query).toEqual({ to: VALID, token: 'jpyc', items: `${enc('Tシャツ')}:1:3000:10:taxable_10:`, disc: '20' });
      expect(payableOf(searchParams, JPYC)).toBe(2980n * JPYC);
    });

    // 【気になる今の動き】外れるのは値引きだけ。管理番号は、カートを空にしても state に残り、次の会計の URL (rcpt) に
    // そのまま乗る。カートが空の間は管理番号の欄が画面から消え、次の品を入れると欄は閉じた状態で出直すので、
    // 店員には前の番号が残っていることが見えない。直すかどうかは別に決める (ここは今の動きを書いただけ)。
    it('【気になる今の動き】管理番号はカートを空にしても外れず、次の会計の URL に前の番号が乗る', async () => {
      const user = userEvent.setup();
      seedSettings();
      render(<RegisterMode />);
      await tap(user, /コーヒー/);
      await user.type(orderPanel().getByLabelText('管理番号 / レシート番号'), 'R-001');
      await deleteLine(user, /コーヒー/);
      expect(orderPanel().queryByLabelText('管理番号 / レシート番号')).toBeNull();

      await tap(user, /Tシャツ/);
      expect(orderPanel().getByLabelText('管理番号 / レシート番号')).toHaveValue('R-001');
      expect(orderPanel().getByText('管理番号を付ける（任意）').closest('details')).not.toHaveAttribute('open');
      const { query } = parts(await openQr(user));
      expect(query).toEqual({ to: VALID, token: 'jpyc', items: `${enc('Tシャツ')}:1:3000:10:taxable_10:`, rcpt: 'R-001' });
    });
  });

  describe('数量と行の額', () => {
    it('行の額 = 単価 × 数量・小計と合計は行の額の和', async () => {
      const user = userEvent.setup();
      seedSettings();
      render(<RegisterMode />);
      await tap(user, /コーヒー/);
      await tap(user, /コーヒー/);
      await tap(user, /コーヒー/);
      await tap(user, /Tシャツ/);
      expect(qtyOf(/コーヒー/)).toHaveValue('3');
      expect(cartLine(/コーヒー/).getByText('1,500 JPYC')).toBeInTheDocument();
      expect(cartLine(/Tシャツ/).getByText('3,000 JPYC')).toBeInTheDocument();
      expect(summaryRow('小計').getByText('4,500 JPYC')).toBeInTheDocument();
      expect(summaryRow('合計').getByText('4,500 JPYC')).toBeInTheDocument();
      expect(orderPanel().getByText('4 点')).toBeInTheDocument();
    });

    it('＋ は 998 → 999 で止まり、もう 1 回押しても 999 (URL の数量と額も 999 個分・/checkout が受け付ける)', async () => {
      const user = userEvent.setup();
      seedSettings();
      render(<RegisterMode />);
      await tap(user, /コーヒー/);
      fireEvent.change(qtyOf(/コーヒー/), { target: { value: '998' } });
      expect(qtyOf(/コーヒー/)).toHaveValue('998');
      expect(summaryRow('合計').getByText('499,000 JPYC')).toBeInTheDocument();

      const plus = cartLine(/コーヒー/).getByRole('button', { name: '数量を増やす' });
      await user.click(plus);
      expect(qtyOf(/コーヒー/)).toHaveValue('999');
      await user.click(plus);
      expect(qtyOf(/コーヒー/)).toHaveValue('999');
      expect(summaryRow('合計').getByText('499,500 JPYC')).toBeInTheDocument();
      expect(orderPanel().getByText('999 点')).toBeInTheDocument();

      const { query, searchParams } = parts(await openQr(user));
      expect(query).toEqual({ to: VALID, token: 'jpyc', items: `${enc('コーヒー')}:999:500:10:taxable_10:` });
      expect(payableOf(searchParams, JPYC)).toBe(499_500n * JPYC);
    });

    it('商品のタイルの足し込みも 998 → 999 で止まり、もう 1 回押しても 999', async () => {
      const user = userEvent.setup();
      seedSettings();
      render(<RegisterMode />);
      await tap(user, /コーヒー/);
      fireEvent.change(qtyOf(/コーヒー/), { target: { value: '998' } });
      await tap(user, /コーヒー/);
      expect(qtyOf(/コーヒー/)).toHaveValue('999');
      await tap(user, /コーヒー/);
      expect(qtyOf(/コーヒー/)).toHaveValue('999');
      expect(cartLines()).toHaveLength(1);
      expect(await findTile(/コーヒー/)).toHaveAccessibleName('コーヒー 500 JPYC カートに 999 点');
      expect(summaryRow('合計').getByText('499,500 JPYC')).toBeInTheDocument();
    });

    it('数量の欄に直接入れる: 1000 以上は 999 に、0・空・数字でないものは 1 に、数字以外の字は捨てる', async () => {
      const user = userEvent.setup();
      seedSettings();
      render(<RegisterMode />);
      await tap(user, /コーヒー/);
      const set = (value: string) => fireEvent.change(qtyOf(/コーヒー/), { target: { value } });
      set('999');
      expect(qtyOf(/コーヒー/)).toHaveValue('999');
      set('1000');
      expect(qtyOf(/コーヒー/)).toHaveValue('999');
      set('50000');
      expect(qtyOf(/コーヒー/)).toHaveValue('999');
      expect(summaryRow('合計').getByText('499,500 JPYC')).toBeInTheDocument();
      set('0');
      expect(qtyOf(/コーヒー/)).toHaveValue('1');
      set('12');
      expect(qtyOf(/コーヒー/)).toHaveValue('12');
      set('');
      expect(qtyOf(/コーヒー/)).toHaveValue('1');
      set('1a2');
      expect(qtyOf(/コーヒー/)).toHaveValue('12');
      set('abc');
      expect(qtyOf(/コーヒー/)).toHaveValue('1');
      expect(summaryRow('合計').getByText('500 JPYC')).toBeInTheDocument();
    });

    it('名前や単価を書き換えた行でも、同じ商品のタイルは同じ行に足し込む (書き換えた名前と単価のまま)', async () => {
      const user = userEvent.setup();
      seedSettings();
      render(<RegisterMode />);
      await tap(user, /コーヒー/);
      await openLine(user, /コーヒー/);
      const price = screen.getByRole('textbox', { name: '単価 (JPYC)' });
      await user.clear(price);
      await user.type(price, '450');
      await user.type(screen.getByRole('textbox', { name: '商品名' }), 'S');
      await tap(user, /コーヒー/);
      expect(cartLines()).toHaveLength(1);
      expect(qtyOf('コーヒーS')).toHaveValue('2');
      expect(summaryRow('合計').getByText('900 JPYC')).toBeInTheDocument();
      const { query } = parts(await openQr(user));
      expect(query).toEqual({ to: VALID, token: 'jpyc', items: `${enc('コーヒーS')}:2:450:10:taxable_10:` });
    });
  });

  describe('オプションつきの品の行 (flag ON)', () => {
    beforeEach(() => {
      hold.menuOptions = true;
      seedSettings();
      seedPresets([GYUDON]);
    });

    it('同じ品・同じオプションは 1 行にまとまり数量 +1、違うオプションは別の行 (URL の items も同じ並び)', async () => {
      const user = userEvent.setup();
      render(<RegisterMode />);
      await addWithOptions(user, /牛丼/, { radio: /大盛り/ });
      await addWithOptions(user, /牛丼/, { radio: /小盛り/ });
      await addWithOptions(user, /牛丼/, { radio: /大盛り/ });

      expect(cartLines()).toHaveLength(2);
      expect(qtyOf('牛丼（大盛り）')).toHaveValue('2');
      expect(qtyOf('牛丼（小盛り）')).toHaveValue('1');
      expect(cartLine('牛丼（大盛り）').getByText('1,400 JPYC')).toBeInTheDocument();
      expect(cartLine('牛丼（小盛り）').getByText('500 JPYC')).toBeInTheDocument();
      // タイルの数は、行が分かれていても同じ商品の合計。
      expect(await findTile(/牛丼/)).toHaveAccessibleName('牛丼 500 JPYC カートに 3 点');
      expect(summaryRow('合計').getByText('1,900 JPYC')).toBeInTheDocument();

      const { query, searchParams } = parts(await openQr(user));
      expect(query).toEqual({
        to: VALID,
        token: 'jpyc',
        items: `${enc('牛丼（大盛り）')}:2:700:10:taxable_10:,${enc('牛丼（小盛り）')}:1:500:10:taxable_10:`,
      });
      expect(payableOf(searchParams, JPYC)).toBe(1900n * JPYC);
    });

    it('選択肢の組が違えば別の行 (大盛り と 大盛り・えび)', async () => {
      const user = userEvent.setup();
      render(<RegisterMode />);
      await addWithOptions(user, /牛丼/, { radio: /大盛り/ });
      await addWithOptions(user, /牛丼/, { radio: /大盛り/, checkbox: /えび/ });
      expect(cartLines()).toHaveLength(2);
      expect(qtyOf('牛丼（大盛り）')).toHaveValue('1');
      expect(qtyOf('牛丼（大盛り・えび）')).toHaveValue('1');
      expect(summaryRow('合計').getByText('1,550 JPYC')).toBeInTheDocument();
    });

    it('名前を書き換えた行にはまとめない (同じオプションでも新しい行になる)', async () => {
      const user = userEvent.setup();
      render(<RegisterMode />);
      await addWithOptions(user, /牛丼/, { radio: /大盛り/ });
      await openLine(user, '牛丼（大盛り）');
      await user.type(screen.getByRole('textbox', { name: '商品名' }), '!');
      await addWithOptions(user, /牛丼/, { radio: /大盛り/ });
      expect(cartLines()).toHaveLength(2);
      expect(qtyOf('牛丼（大盛り）!')).toHaveValue('1');
      expect(qtyOf('牛丼（大盛り）')).toHaveValue('1');
    });

    it('同じオプションの足し込みも 998 → 999 で止まり、もう 1 回足しても 999', async () => {
      const user = userEvent.setup();
      render(<RegisterMode />);
      await addWithOptions(user, /牛丼/, { radio: /大盛り/ });
      fireEvent.change(qtyOf('牛丼（大盛り）'), { target: { value: '998' } });
      await addWithOptions(user, /牛丼/, { radio: /大盛り/ });
      expect(qtyOf('牛丼（大盛り）')).toHaveValue('999');
      await addWithOptions(user, /牛丼/, { radio: /大盛り/ });
      expect(qtyOf('牛丼（大盛り）')).toHaveValue('999');
      expect(cartLines()).toHaveLength(1);
      expect(summaryRow('合計').getByText('699,300 JPYC')).toBeInTheDocument();
    });
  });

  describe('お店負担 (お店の端末で送る) の最低額 1 JPYC の境目', () => {
    const BLOCKED = '1 JPYC 未満の会計ではガス代の肩代わりを使えません。';
    const BADGE = 'お店がガス代を肩代わり（利用料 0 円）';
    const CANDY = `${enc('あめ')}:1:0.5:10:taxable_10:`;
    const GUM = `${enc('ガム')}:1:1:10:taxable_10:`;

    beforeEach(() => {
      hold.storeGasWallet = true;
      hold.forwarder = FORWARDER;
      Object.defineProperty(window.navigator, 'locks', { value: { request: vi.fn() }, configurable: true });
      seedSettings({ payMode: 'gasless', storePays: true });
      seedPresets([
        { id: 'c', name: 'あめ', unitPrice: '0.5' },
        { id: 'g', name: 'ガム', unitPrice: '1' },
        { id: 'w', name: 'わずかに足りない', unitPrice: '0.999999999999999999' },
        { id: 'h', name: 'チョコ', unitPrice: '1.5' },
      ]);
    });
    afterEach(() => {
      Object.defineProperty(window.navigator, 'locks', { value: undefined, configurable: true });
    });

    it('合計が 1 JPYC ちょうど: お店負担の QR (submit=store と hs)・受け渡しの額は 1 JPYC・gas=merchant', async () => {
      const user = userEvent.setup();
      render(<RegisterMode />);
      await tap(user, /ガム/);
      expect(await screen.findByText(BADGE)).toBeInTheDocument();
      expect(screen.queryByText(BLOCKED, { exact: false })).toBeNull();
      const { base, query } = parts(await openQr(user));
      expect(hold.start).toHaveBeenCalledTimes(1);
      expect(hold.start).toHaveBeenCalledWith(VALID, 1n * JPYC, 80002);
      expect(base).toBe('https://test.local/checkout');
      expect(query).toEqual({ to: VALID, token: 'jpyc', items: GUM, gas: 'merchant', submit: 'store', hs: HS });
    });

    it.each([
      { name: '0.5 JPYC', tile: /あめ/, items: CANDY, total: '0.5 JPYC' },
      { name: '1 JPYC に 1 wei 足りない', tile: /わずかに足りない/, items: `${enc('わずかに足りない')}:1:0.999999999999999999:10:taxable_10:`, total: '0.999999999999999999 JPYC' },
    ])('合計が 1 JPYC 未満 ($name): 理由を出し、ボタンは「通常の QR を出す」・受け渡しを作らず通常の QR (submit なし・gas=merchant)', async ({ tile, items, total }) => {
      const user = userEvent.setup();
      render(<RegisterMode />);
      await tap(user, tile);
      expect(await screen.findByText(BLOCKED, { exact: false })).toBeInTheDocument();
      expect(screen.queryByText(BADGE)).toBeNull();
      expect(screen.queryByRole('button', { name: /QRコードを表示する/ })).toBeNull();
      expect(summaryRow('合計').getByText(total)).toBeInTheDocument();
      const { query } = parts(await openQr(user, /通常の QR を出す/));
      expect(hold.start).not.toHaveBeenCalled();
      expect(hold.release).toHaveBeenCalledTimes(1);
      expect(query).toEqual({ to: VALID, token: 'jpyc', items, gas: 'merchant' });
    });

    it('値引きの後の額で判定する: 2 JPYC から 1 JPYC 引いて 1 JPYC ちょうどなら使える (受け渡しの額 1 JPYC・disc=1)', async () => {
      const user = userEvent.setup();
      render(<RegisterMode />);
      await tap(user, /ガム/);
      await tap(user, /ガム/);
      await addDiscount(user, 'amount', '1');
      expect(summaryRow('合計').getByText('1 JPYC')).toBeInTheDocument();
      expect(screen.queryByText(BLOCKED, { exact: false })).toBeNull();
      const { query } = parts(await openQr(user));
      expect(hold.start).toHaveBeenCalledWith(VALID, 1n * JPYC, 80002);
      expect(query).toEqual({
        to: VALID,
        token: 'jpyc',
        items: `${enc('ガム')}:2:1:10:taxable_10:`,
        disc: '1',
        gas: 'merchant',
        submit: 'store',
        hs: HS,
      });
    });

    it('値引きの後の額で判定する: 1.5 JPYC は使えるが、1 JPYC 引いて 0.5 JPYC にすると使えない (通常の QR に disc=1)', async () => {
      const user = userEvent.setup();
      render(<RegisterMode />);
      await tap(user, /チョコ/);
      expect(await screen.findByText(BADGE)).toBeInTheDocument();
      await addDiscount(user, 'amount', '1');
      expect(await screen.findByText(BLOCKED, { exact: false })).toBeInTheDocument();
      expect(screen.queryByText(BADGE)).toBeNull();
      expect(summaryRow('合計').getByText('0.5 JPYC')).toBeInTheDocument();
      const { query } = parts(await openQr(user, /通常の QR を出す/));
      expect(hold.start).not.toHaveBeenCalled();
      expect(query).toEqual({ to: VALID, token: 'jpyc', items: `${enc('チョコ')}:1:1.5:10:taxable_10:`, disc: '1', gas: 'merchant' });
    });

    it('カートが空のうちは、最低額の理由を出さない', async () => {
      render(<RegisterMode />);
      await findTile(/ガム/);
      expect(await screen.findByText(BADGE)).toBeInTheDocument();
      expect(screen.queryByText(BLOCKED, { exact: false })).toBeNull();
    });
  });
});
