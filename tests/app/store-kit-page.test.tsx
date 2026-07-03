import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import ja from '@/messages/ja.json';
import en from '@/messages/en.json';
import StoreKitPage, {
  generateMetadata,
  StoreKitMaterials,
  type StoreKitLabels,
} from '@/app/[locale]/kit/page';

const setRequestLocaleSpy = vi.hoisted(() => vi.fn());

vi.mock('next-intl/server', () => ({
  getTranslations: async () => {
    const dict = ja.StoreKit as Record<string, string>;
    return (k: string) => dict[k] ?? k;
  },
  setRequestLocale: setRequestLocaleSpy,
}));

vi.mock('@/components/AppShell', () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => (
    <main>{children}</main>
  ),
}));

const labels: StoreKitLabels = ja.StoreKit;

beforeEach(() => {
  setRequestLocaleSpy.mockClear();
});

describe('StoreKitPage', () => {
  it('見出し・説明・印刷ボタン・素材文言を描画する', async () => {
    const ui = await StoreKitPage({
      params: Promise.resolve({ locale: 'ja' }),
    });
    render(ui);

    expect(
      screen.getByRole('heading', { level: 1, name: '店頭告知キット' }),
    ).toBeInTheDocument();
    expect(screen.getByText('印刷してレジ横・ドアに')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: '2ページまとめて印刷' }),
    ).toBeInTheDocument();
    expect(screen.getAllByText('現金・OpenPay 使えます')).toHaveLength(4);
    expect(screen.getByText('OpenPay 使えます')).toBeInTheDocument();
    expect(setRequestLocaleSpy).toHaveBeenCalledWith('ja');
  });

  it('metadata は StoreKit namespace から作る', async () => {
    const metadata = await generateMetadata({
      params: Promise.resolve({ locale: 'ja' }),
    });
    expect(metadata.title).toBe('店頭告知キット · OpenPay');
    expect(metadata.description).toBe('印刷してレジ横・ドアに');
  });
});

describe('StoreKitMaterials', () => {
  it('A6 POP 4面付けとドア用ステッカーを描画する', () => {
    render(<StoreKitMaterials labels={labels} />);

    expect(
      screen.getByRole('heading', { name: 'A6 POP (4面付け)' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'ドア用ステッカー風' }),
    ).toBeInTheDocument();
    expect(screen.getAllByText('現金・OpenPay 使えます')).toHaveLength(4);
    expect(screen.getByText('OpenPay 使えます')).toBeInTheDocument();
    expect(screen.getAllByText('open-pay.jp')).toHaveLength(5);
  });

  it('印刷時はA4 2ページ、1ページ目はA6 4面付けの寸法 class を持つ', () => {
    render(<StoreKitMaterials labels={labels} />);

    const a6Sheet = screen.getByRole('region', { name: 'A6 POP (4面付け)' });
    expect(a6Sheet.className).toContain('print:h-[297mm]');
    expect(a6Sheet.className).toContain('print:w-[210mm]');
    expect(a6Sheet.className).toContain('print:[break-after:page]');

    const doorSheet = screen.getByRole('region', {
      name: 'ドア用ステッカー風',
    });
    expect(doorSheet.className).toContain('print:h-[297mm]');
    expect(doorSheet.className).toContain('print:w-[210mm]');
  });
});

describe('StoreKit i18n', () => {
  it('StoreKit namespace は ja/en でキー集合が一致し、全 leaf が非空', () => {
    expect(Object.keys(ja.StoreKit).sort()).toEqual(
      Object.keys(en.StoreKit).sort(),
    );

    for (const messages of [ja.StoreKit, en.StoreKit]) {
      for (const value of Object.values(messages)) {
        expect(typeof value).toBe('string');
        expect(value).not.toBe('');
      }
    }
  });

  it('Landing の店頭キット導線 key が ja/en 両方にある', () => {
    expect(ja.Landing.cashStoreKitCta).toBe(
      '店頭キットを印刷する (無料)',
    );
    expect(en.Landing.cashStoreKitCta).toBe('Print the in-store kit (free)');
  });
});
