// レジ standard 決済の fee tx hash をサーバへ通知するだけの client helper。
//
// 送金そのものは従来どおり plain な ERC20.transfer (顧客の署名回数・ガス・フローは不変)。
// サーバはこの通知を受けて fee tx を on-chain 検証し、用途を束縛した global payment claim を
// 置く → 同じ fee tx を「注文の独立 fee leg」として二重充当する経路を塞ぐ。
//
// 掟13 の隔離: 通知は **付帯処理**。決済本体 (merchant/fee の 2 tx) は既に確定しているため、
// ここでの失敗を呼び出し側へ throw しない (fail-open)。claim が作られなければ anti-abuse
// ガードが 1 件分掛からないだけで、資金は動かず顧客の決済も成功したままになる。逆に throw して
// 決済 UI を失敗表示にすると、確定済み送金に対して顧客が再送を試みる実害へ波及する。
// viem など重い依存を持たない (= /pay・/tip の初期 bundle へ影響しない) こと。

export type RegisterStandardFeeNotice = {
  chainId: number;
  tokenAddress: string;
  merchant: string;
  saleAmount: bigint;
  merchantTxHash: string;
  feeTxHash: string;
};

export async function notifyRegisterStandardFee(
  notice: RegisterStandardFeeNotice,
): Promise<void> {
  try {
    await fetch('/api/register/claim', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      keepalive: true,
      body: JSON.stringify({
        chainId: notice.chainId,
        tokenAddress: notice.tokenAddress,
        merchant: notice.merchant,
        saleAmount: notice.saleAmount.toString(),
        merchantTxHash: notice.merchantTxHash,
        feeTxHash: notice.feeTxHash,
      }),
    });
  } catch {
    // ネットワーク断・ページ遷移・server 障害を決済完了画面へ波及させない (上記 fail-open)。
  }
}
