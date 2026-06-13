import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithIntl as render } from '../_helpers/i18n';
import {
  PaymentSuccessOverlay,
  type PaymentSuccessOverlayPayload,
} from '@/components/PaymentSuccessOverlay';

// PaymentSuccessOverlay は PaymentForm / CheckoutForm / TipForm が経路ごとに 3 連 (tip は 1) で
// 複製していた SuccessOverlay 呼び出しを集約した薄いラッパ (Phase 1.4)。本テストは「描画する/しない」
// の選択 (dismissed / payload=null) と、payload の各フィールドが SuccessOverlay へ素通しされること
// (省略フィールド = 行/リンクを出さない) を additive に検証する。SuccessOverlay 自体の挙動 (時計/
// チャイム/ESC 等) は SuccessOverlay.test 側で担保済。

const TX_HASH = `0x${'a'.repeat(64)}`;
const USER_OP_HASH = `0x${'b'.repeat(64)}`;
const MERCHANT_ADDR = `0x${'c'.repeat(40)}`;

const FULL_PAYLOAD: PaymentSuccessOverlayPayload = {
  amountDisplay: '1,500 JPYC',
  txHash: TX_HASH,
  userOpHash: USER_OP_HASH,
  blockNumber: 12345n,
  explorerBase: 'https://basescan.org',
  merchantAddress: MERCHANT_ADDR,
};

describe('PaymentSuccessOverlay', () => {
  it('payload=null → 何も描画しない (未成功)', () => {
    const { container } = render(
      <PaymentSuccessOverlay
        dismissed={false}
        payload={null}
        onDismiss={() => undefined}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('dismissed=true → payload があっても描画しない (1 度閉じた後)', () => {
    const { container } = render(
      <PaymentSuccessOverlay
        dismissed
        payload={FULL_PAYLOAD}
        onDismiss={() => undefined}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('payload あり → SuccessOverlay を描画し全フィールドを素通しする', async () => {
    render(
      <PaymentSuccessOverlay
        dismissed={false}
        payload={FULL_PAYLOAD}
        onDismiss={() => undefined}
      />,
    );
    // SuccessOverlay は next/dynamic (ssr:false) のため findBy で await。
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('決済完了')).toBeInTheDocument();
    expect(screen.getByText('1,500 JPYC')).toBeInTheDocument();
    // txHash / userOpHash の短縮表示 (先頭 10 + … + 末尾 6)。
    expect(document.body.textContent).toContain('0xaaaaaaaa…aaaaaa');
    expect(document.body.textContent).toContain('0xbbbbbbbb…bbbbbb');
    expect(screen.getByText('12345')).toBeInTheDocument();
    // explorerBase + merchantAddress 指定 → Tx / 店舗アドレス両 Explorer link。
    expect(
      screen.getByRole('link', { name: /Tx を Explorer で確認/ }),
    ).toHaveAttribute('href', `https://basescan.org/tx/${TX_HASH}`);
    expect(
      screen.getByRole('link', { name: /店舗ウォレットの履歴を見る/ }),
    ).toHaveAttribute('href', `https://basescan.org/address/${MERCHANT_ADDR}`);
  });

  it('userOpHash / blockNumber / merchantAddress 省略 (relay 経路相当) → 該当行・リンクを出さない', async () => {
    render(
      <PaymentSuccessOverlay
        dismissed={false}
        payload={{
          amountDisplay: '300 JPYC',
          txHash: TX_HASH,
          explorerBase: 'https://basescan.org',
        }}
        onDismiss={() => undefined}
      />,
    );
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    // userOpHash 行・店舗アドレス link は出ない。Tx link は出る。
    expect(screen.queryByText('UserOp Hash')).toBeNull();
    expect(screen.queryByRole('link', { name: /店舗ウォレット/ })).toBeNull();
    expect(
      screen.getByRole('link', { name: /Tx を Explorer で確認/ }),
    ).toBeInTheDocument();
  });

  it('「閉じる」クリックで onDismiss が呼ばれる', async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    render(
      <PaymentSuccessOverlay
        dismissed={false}
        payload={FULL_PAYLOAD}
        onDismiss={onDismiss}
      />,
    );
    await user.click(await screen.findByRole('button', { name: '閉じる' }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});
