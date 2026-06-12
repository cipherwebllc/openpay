import { describe, it, expect } from 'vitest';
import { screen, within } from '@testing-library/react';
import { renderWithIntl as render } from '../_helpers/i18n';
import { getAddress, type Address } from 'viem';
import { SignReassurance } from '@/components/SignReassurance';
import type {
  JpycRelaySignPreview,
  JpycRecoverSignPreview,
} from '@/lib/signPreview';

const TO: Address = getAddress('0x1234567890123456789012345678901234567890');
const FORWARDER: Address = getAddress(
  '0x0f4560a777415580f0680f8b56a79b0022c6b848',
);

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

function makeRecover(
  over?: Partial<JpycRecoverSignPreview>,
): JpycRecoverSignPreview {
  return {
    kind: 'jpyc-recover',
    amountHuman: '1000',
    feeHuman: '2',
    totalHuman: '1002',
    totalAtomic: '1002000000000000000000',
    merchant: TO,
    forwarder: FORWARDER,
    storeName: 'OO商店',
    gasMode: 'customer',
    expiresInMin: 5,
    decimals: 18,
    symbol: 'JPYC',
    ...over,
  };
}

describe('SignReassurance — jpyc-relay-free 通常パネル (awaiting=false)', () => {
  it('見出し + バッジ3点 + Blockaid 注記を描画する', () => {
    render(
      <SignReassurance kind="jpyc-relay-free" preview={makePreview()} awaiting={false} />,
    );

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
    // 確認ガイダンス注記 (P4 で中立化: 金額/受け取り先の一致確認を促す)。
    expect(
      screen.getByText(
        /ウォレットの確認画面で、金額と受け取り先が下記の内容と一致していること/,
      ),
    ).toBeInTheDocument();
  });

  it('折りたたみ照合表に amountAtomic (生の数字) と to (全文) が出る', () => {
    render(
      <SignReassurance kind="jpyc-relay-free" preview={makePreview()} awaiting={false} />,
    );

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
        kind="jpyc-relay-free"
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
    render(
      <SignReassurance kind="jpyc-relay-free" preview={makePreview()} awaiting={false} />,
    );
    expect(
      screen.queryByText(/ウォレットの署名画面をご確認ください/),
    ).toBeNull();
  });
});

describe('SignReassurance — jpyc-relay-free awaiting variant (awaiting=true)', () => {
  it('署名待ち文言 + 金額 + 送金先 (店舗名 + 短縮アドレス) を出し、通常パネルは出さない', () => {
    render(
      <SignReassurance kind="jpyc-relay-free" preview={makePreview()} awaiting={true} />,
    );

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

describe('SignReassurance — usdc-permit パネル (Circle Paymaster)', () => {
  it('見出し + 有界 permit バッジ3点 + Blockaid 注記を描画する (permitCap なし)', () => {
    render(
      <SignReassurance
        kind="usdc-permit"
        amountHuman="100"
        symbol="USDC"
        awaiting={false}
      />,
    );

    // 見出し: 利用許可 + 署名の確認が表示される旨。
    expect(
      screen.getByText(/利用許可 \(Spending cap\).+署名/),
    ).toBeInTheDocument();
    // バッジ 1: 有界 permit (この決済額+ガス上限のみ・無制限ではない)。cap なし版。
    expect(
      screen.getByText(/この決済額\+ガス代上限のみ/),
    ).toBeInTheDocument();
    expect(screen.getByText(/無制限の Approve ではありません/)).toBeInTheDocument();
    // バッジ 2: 送金先はこの店だけ。
    expect(screen.getByText(/送金先はこのお店だけです/)).toBeInTheDocument();
    // バッジ 3: この決済にのみ使われる (金額が差し込まれる)。
    expect(
      screen.getByText(/この許可はこの決済 \(100 USDC\) にのみ使われます/),
    ).toBeInTheDocument();
    // 確認ガイダンス注記は jpyc-relay-free と共通文言を再利用 (P4 で中立化)。
    expect(
      screen.getByText(
        /ウォレットの確認画面で、金額と受け取り先が下記の内容と一致していること/,
      ),
    ).toBeInTheDocument();
  });

  it('permitCapHuman ありで「上限 {cap} {symbol} まで」を含める', () => {
    render(
      <SignReassurance
        kind="usdc-permit"
        amountHuman="100"
        symbol="USDC"
        permitCapHuman="100.5"
        awaiting={false}
      />,
    );
    expect(
      screen.getByText(/上限 100\.5 USDC まで/),
    ).toBeInTheDocument();
    expect(screen.getByText(/無制限の Approve ではありません/)).toBeInTheDocument();
  });

  it('transferCount>1 で「{n} 件の送金 (分割受取)」の分割文言を出す', () => {
    render(
      <SignReassurance
        kind="usdc-permit"
        amountHuman="100"
        symbol="USDC"
        transferCount={3}
        awaiting={false}
      />,
    );
    expect(
      screen.getByText(/3 件の送金 \(分割受取\) を 1 回の確認で行います/),
    ).toBeInTheDocument();
    // 単一送金文言は出さない。
    expect(screen.queryByText(/送金先はこのお店だけです/)).toBeNull();
  });

  it('照合表 (生フィールド) は出さない (P2 では非表示)', () => {
    render(
      <SignReassurance
        kind="usdc-permit"
        amountHuman="100"
        symbol="USDC"
        awaiting={false}
      />,
    );
    expect(
      screen.queryByText(/ウォレットに表示される内容を確認/),
    ).toBeNull();
  });

  it('awaiting=true で利用許可+送金の確認待ち文言に切替 (cap あれば cap を含める)', () => {
    render(
      <SignReassurance
        kind="usdc-permit"
        amountHuman="100"
        symbol="USDC"
        permitCapHuman="100.5"
        awaiting={true}
      />,
    );
    expect(
      screen.getByText(/利用許可 \(上限 100\.5 USDC\) と送金の確認/),
    ).toBeInTheDocument();
    // 通常パネルのバッジは置換されて出ない。
    expect(screen.queryByText(/この決済額\+ガス代上限のみ/)).toBeNull();
  });

  it('Approve を求めると誤解させる「Approve は求めません」は書かない (誠実性)', () => {
    render(
      <SignReassurance
        kind="usdc-permit"
        amountHuman="100"
        symbol="USDC"
        awaiting={false}
      />,
    );
    // jpyc-relay-free の「Approve (利用許可) は求めません」コピーは usdc-permit では出さない。
    expect(screen.queryByText(/Approve \(利用許可\) は求めません/)).toBeNull();
  });
});

describe('SignReassurance — jpyc-relay-recover パネル (P4・customer モード)', () => {
  it('customer: 見出し + 金額バッジ (合計 = 表示額 + 手数料) + 受け取りバッジ + 失効 + 確認ガイダンス', () => {
    render(
      <SignReassurance
        kind="jpyc-relay-recover"
        preview={makeRecover()}
        awaiting={false}
      />,
    );

    // 見出しは free と同一 (署名 1 回だけ)。
    expect(
      screen.getByText(/求められるのは「署名」1回だけ/),
    ).toBeInTheDocument();
    // Approve なし (receiveWithAuthorization は allowance を作らない)。
    expect(screen.getByText(/Approve \(利用許可\) は求めません/)).toBeInTheDocument();
    // 金額バッジ: 合計 1002 = お支払い 1000 + 手数料 2 の内訳を出す (P4 の核)。
    expect(
      screen.getByText(
        /動かせるのは 1002 JPYC ちょうど（お支払い 1000 \+ 手数料 2）/,
      ),
    ).toBeInTheDocument();
    // 受け取りバッジ: 決済コントラクトが同じ取引内で店へ振り分ける。
    expect(
      screen.getByText(/OpenPay の決済コントラクトが同じ取引の中でお店へ即時に振り分けます/),
    ).toBeInTheDocument();
    // 失効バッジ (free と共通)。
    expect(screen.getByText(/署名は 5 分で自動失効/)).toBeInTheDocument();
    // 確認ガイダンス (中立化済)。
    expect(
      screen.getByText(
        /ウォレットの確認画面で、金額と受け取り先が下記の内容と一致していること/,
      ),
    ).toBeInTheDocument();
  });

  it('customer: 照合表に signedTotal (1002 の生の数字) + forwarder 全文 + 内訳説明が出る', () => {
    render(
      <SignReassurance
        kind="jpyc-relay-recover"
        preview={makeRecover()}
        awaiting={false}
      />,
    );

    // value 欄にウォレットに出る生の数字 (signedTotal = value + fee) が出る。
    expect(screen.getByText('1002000000000000000000')).toBeInTheDocument();
    // to 欄に forwarder (決済コントラクト) の全文が出る (店アドレスではない)。
    expect(screen.getByText(FORWARDER)).toBeInTheDocument();
    // to 欄の意味は決済コントラクトであると説明する。
    expect(
      screen.getByText(/お店への振り分けを行う OpenPay の決済コントラクト/),
    ).toBeInTheDocument();
    // value 欄の意味で内訳 (1000 + 2 = 1002) を説明する。
    expect(
      screen.getByText(/お支払い 1000 \+ 手数料 2 = 1002 JPYC の内部表記/),
    ).toBeInTheDocument();
  });

  it('merchant: 金額バッジは「動かせるのは {amount} ちょうど」(ウォレット表示 = 表示価格)', () => {
    render(
      <SignReassurance
        kind="jpyc-relay-recover"
        preview={makeRecover({
          gasMode: 'merchant',
          totalHuman: '1000',
          totalAtomic: '1000000000000000000000',
        })}
        awaiting={false}
      />,
    );

    // merchant モードはウォレット表示 = 表示価格 (1000)。内訳は出さない。
    expect(
      screen.getByText(/動かせるのは 1000 JPYC ちょうど/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/お支払い 1000 \+ 手数料/)).toBeNull();
    // value 欄は free と同じ「内部表記 (18桁)」形式。
    expect(screen.getByText(/1000 JPYC の内部表記 \(18桁\)/)).toBeInTheDocument();
    expect(screen.getByText('1000000000000000000000')).toBeInTheDocument();
  });

  it('awaiting=true: 署名待ち文言 + 金額 = totalHuman (ウォレット表示) + 決済コントラクト経由', () => {
    render(
      <SignReassurance
        kind="jpyc-relay-recover"
        preview={makeRecover()}
        awaiting={true}
      />,
    );

    expect(
      screen.getByText(/ウォレットの署名画面をご確認ください/),
    ).toBeInTheDocument();
    const status = screen.getByRole('status');
    // 待機表示の金額はウォレットに出る合計 (1002) を出す (突合成立)。
    expect(within(status).getByText('1002 JPYC')).toBeInTheDocument();
    // 送金先は店舗名 + 決済コントラクト経由の補足。
    expect(within(status).getByText(/OO商店/)).toBeInTheDocument();
    expect(within(status).getByText(/決済コントラクト経由/)).toBeInTheDocument();
    // 通常パネルのバッジは置換されて出ない。
    expect(screen.queryByText(/動かせるのは 1002 JPYC ちょうど（お支払い/)).toBeNull();
  });

  it('FX 換算 (USDC 6 桁) でも total/fee/decimals が正確に出る (customer)', () => {
    render(
      <SignReassurance
        kind="jpyc-relay-recover"
        preview={makeRecover({
          amountHuman: '100',
          feeHuman: '0.02',
          totalHuman: '100.02',
          totalAtomic: '100020000',
          decimals: 6,
          symbol: 'USDC',
        })}
        awaiting={false}
      />,
    );
    expect(screen.getByText('100020000')).toBeInTheDocument();
    expect(
      screen.getByText(/お支払い 100 \+ 手数料 0\.02 = 100\.02 USDC の内部表記/),
    ).toBeInTheDocument();
  });
});

describe('SignReassurance — standard / native ヒント (1 行)', () => {
  it('standard: 通常の送金確認の 1 行ヒントのみ (フルパネルは出さない)', () => {
    render(<SignReassurance kind="standard" />);
    expect(
      screen.getByText(/通常の送金確認が表示されます/),
    ).toBeInTheDocument();
    // フルパネルの見出し / 照合表は出さない。
    expect(screen.queryByText(/求められるのは「署名」1回だけ/)).toBeNull();
    expect(
      screen.queryByText(/ウォレットに表示される内容を確認/),
    ).toBeNull();
  });

  it('native: 同じ 1 行ヒント文言を出す', () => {
    render(<SignReassurance kind="native" />);
    expect(
      screen.getByText(/通常の送金確認が表示されます/),
    ).toBeInTheDocument();
  });
});
