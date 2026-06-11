import { describe, it, expect } from 'vitest';
import { screen, within } from '@testing-library/react';
import { renderWithIntl as render } from '../_helpers/i18n';
import { getAddress, type Address } from 'viem';
import { SignReassurance } from '@/components/SignReassurance';
import type { JpycRelaySignPreview } from '@/lib/signPreview';

const TO: Address = getAddress('0x1234567890123456789012345678901234567890');

function makePreview(over?: Partial<JpycRelaySignPreview>): JpycRelaySignPreview {
  return {
    amountHuman: '300',
    symbol: 'JPYC',
    amountAtomic: '300000000000000000000',
    to: TO,
    storeName: 'OO商店',
    expiresInMin: 5,
    decimals: 18,
    ...over,
  };
}

describe('SignReassurance — 通常パネル (awaiting=false)', () => {
  it('見出し + バッジ3点 + Blockaid 注記を描画する', () => {
    render(<SignReassurance preview={makePreview()} awaiting={false} />);

    // 見出し (非技術主)。
    expect(
      screen.getByText(/求められるのは「署名」1回だけ/),
    ).toBeInTheDocument();
    // バッジ 1: Approve を求めない (技術従)。
    expect(screen.getByText(/Approve \(利用許可\) は求めません/)).toBeInTheDocument();
    // バッジ 2: 金額固定 + 送金先固定 (金額が差し込まれる)。
    expect(
      screen.getByText(/動かせるのは 300 JPYC ちょうど/),
    ).toBeInTheDocument();
    // バッジ 3: 5 分失効・1 回限り。
    expect(screen.getByText(/署名は 5 分で自動失効/)).toBeInTheDocument();
    // Blockaid 暫定注記 (計画 §10-6 準拠)。
    expect(
      screen.getByText(/セキュリティ警告が表示される場合があります/),
    ).toBeInTheDocument();
  });

  it('折りたたみ照合表に amountAtomic (生の数字) と to (全文) が出る', () => {
    render(<SignReassurance preview={makePreview()} awaiting={false} />);

    // details 内の value 欄に署名する生の数字が出る (ウォレット表示との突合用)。
    expect(screen.getByText('300000000000000000000')).toBeInTheDocument();
    // to 欄に受取アドレスの全文 (短縮ではない) が出る。
    expect(screen.getByText(TO)).toBeInTheDocument();
    // 折りたたみの summary。
    expect(
      screen.getByText(/ウォレットに表示される内容を確認/),
    ).toBeInTheDocument();
    // value 欄の意味説明に decimals (18) が差し込まれる。
    expect(screen.getByText(/300 JPYC の内部表記 \(18桁\)/)).toBeInTheDocument();
  });

  it('FX 換算 (USDC 6 桁) でも decimals が正確に出る', () => {
    render(
      <SignReassurance
        preview={makePreview({
          amountHuman: '6.4',
          symbol: 'USDC',
          amountAtomic: '6400000',
          decimals: 6,
        })}
        awaiting={false}
      />,
    );
    expect(screen.getByText('6400000')).toBeInTheDocument();
    expect(screen.getByText(/6\.4 USDC の内部表記 \(6桁\)/)).toBeInTheDocument();
  });

  it('awaiting=false では署名待ち文言を出さない', () => {
    render(<SignReassurance preview={makePreview()} awaiting={false} />);
    expect(
      screen.queryByText(/ウォレットの署名画面をご確認ください/),
    ).toBeNull();
  });
});

describe('SignReassurance — awaiting variant (awaiting=true)', () => {
  it('署名待ち文言 + 金額 + 送金先 (店舗名 + 短縮アドレス) を出し、通常パネルは出さない', () => {
    render(<SignReassurance preview={makePreview()} awaiting={true} />);

    // 署名待ちオーバーレイの見出し。
    expect(
      screen.getByText(/ウォレットの署名画面をご確認ください/),
    ).toBeInTheDocument();
    // 金額 (amountHuman + symbol)。
    const status = screen.getByRole('status');
    expect(within(status).getByText('300 JPYC')).toBeInTheDocument();
    // 店舗名 + 短縮アドレス。
    expect(within(status).getByText(/OO商店/)).toBeInTheDocument();
    expect(within(status).getByText(/0x1234…7890/)).toBeInTheDocument();
    // Approve/残高アクセスが渡らない旨の注記。
    expect(
      screen.getByText(/Approve や残高へのアクセス権が渡ることはありません/),
    ).toBeInTheDocument();

    // 通常パネルのバッジは出さない (置換表示)。
    expect(screen.queryByText(/Approve \(利用許可\) は求めません/)).toBeNull();
  });
});
