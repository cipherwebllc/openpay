import type {
  RelayIntentMetadata,
  StandardPaymentIntentParams,
} from '@/lib/paymentIntentStorage';

// 復元した支払いの確定が、今の画面の支払いか (第 10 回レビュー H-S)。Pay / Checkout / Tip が同じ関数を使う。
// ブラウザに残る未解決の支払いの記録 (束縛しない relay の枠・通常決済の印・Pimlico の記録) は、どの画面の mount でも
// 復元される。別の画面で確定したときに、その画面の完了の題で出さないための判定。
//
// 返す値は意図して非対称: true は「この画面の支払いでない」と証明できたときだけ。記録に無い欄・画面で決まらない欄は
// 比べず、一致として扱う。何の波及を断つか: 同じ支払いを読み直しただけの画面に「この画面の支払いではありません」と
// 出して、払い済みの人にもう一度払わせること (二重払い)。逆側 (別の支払いを一致とする) は、今までの表示と同じ。
//
// 比べない欄 (同じ支払いを読み直しても変わりうる): 支払い者 (from・今つないでいるウォレットは変わる)・入力で決まる額
// (screen.amount = null)・今のウォレットの chain で決まる経路と内訳・利用料の額 (払った後に設定が変わる)・Pimlico の
// calls の fingerprint。
// 実行時の import を持たない (3 画面の First Load JS に載るため・型は import type だけ)。アドレスは小文字で比べる。

/** 今の画面が URL から決める支払いの形。 */
export type SettlementScreen = {
  /** 受け付ける chain の id (受け付ける chain が複数の注文リンクは全部)。 */
  chainIds: readonly number[];
  /** 受け付ける chain の token の address。 */
  tokenAddresses: readonly string[];
  /** 受取先。 */
  merchant: string;
  /**
   * URL で決まる売上の額 (/checkout の合計・/pay の固定額・token の最小単位)。入力で決まる画面 (/pay の自由入力・/tip) は
   * null = 額を比べない。
   */
  amount: bigint | null;
  /**
   * /checkout: 受け付ける全 chain の会計の鍵 (lib/orderPaidLookup の orderPaymentContextKey)。/checkout の通常決済は必ず
   * この鍵を記録に付ける。鍵を付けない画面 (/pay・/tip) は null。
   */
  contextKeys: readonly string[] | null;
  /** 注文リンクの画面: 受け付ける全 chain の注文リンクの鍵 (orderLinkContextFingerprint)。それ以外は null。 */
  orderLinkKeys: readonly string[] | null;
  /** この画面の relay は必ず注文に束縛される (/checkout で受注を同一 origin の notify へ送る会計)。 */
  relayAlwaysBound: boolean;
};

/** 復元した記録 (hook が返す値をそのまま渡す)。record が無ければ比べられない = 一致。 */
export type RestoredSettlement =
  | {
      kind: 'relay';
      /** 注文に束縛した記録 (matchesOrderDeliveryContext を通ったもの)。常に一致。 */
      bound: boolean;
      record:
        | Pick<RelayIntentMetadata, 'chainId' | 'merchant' | 'merchantValue' | 'feeValue' | 'orderLinkKey'>
        | null
        | undefined;
    }
  | {
      kind: 'standard';
      record:
        | Pick<
            StandardPaymentIntentParams,
            'chainId' | 'tokenAddress' | 'merchant' | 'saleAmount' | 'contextKey' | 'orderLinkKey'
          >
        | null
        | undefined;
    }
  | {
      kind: 'gasless';
      /** 保存した params (useBatchPayment の variables)。 */
      record: { tokenAddress: string; merchant: string; saleAmount?: bigint } | null | undefined;
    };

const same = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();

// 注文リンクの鍵 (relay と通常決済の記録だけが持つ)。注文リンクの画面は必ず付けるので、無い・受け付けるどの chain の
// 鍵とも違う記録は別の会計。鍵を付けない画面 (/pay・/tip) では、鍵を持つ記録は /checkout の支払い。
function orderLinkDiffers(screen: SettlementScreen, orderLinkKey: string | undefined): boolean {
  if (screen.orderLinkKeys) return !(orderLinkKey && screen.orderLinkKeys.includes(orderLinkKey));
  return !screen.contextKeys && !!orderLinkKey;
}

export function isForeignSettlement(screen: SettlementScreen, restored: RestoredSettlement): boolean {
  if (!restored.record) return false;
  if (restored.kind === 'relay') {
    const { chainId, merchant, merchantValue, feeValue, orderLinkKey } = restored.record;
    if (restored.bound) return false;
    if (screen.relayAlwaysBound) return true;
    // 額: 「お店の受取」か「受取 + 利用料」のどちらかが画面の額と同じなら一致 (free とお客様の上乗せ = 受取が額・お店が
    // 利用料を負担 = 受取 + 利用料が額)。利用料を今の設定で計算し直さない。
    const received = BigInt(merchantValue);
    return (
      !screen.chainIds.includes(chainId) ||
      !same(screen.merchant, merchant) ||
      (screen.amount !== null && received !== screen.amount && received + BigInt(feeValue) !== screen.amount) ||
      orderLinkDiffers(screen, orderLinkKey)
    );
  }
  const { tokenAddress, merchant, saleAmount } = restored.record;
  if (
    !screen.tokenAddresses.some((token) => same(token, tokenAddress)) ||
    !same(screen.merchant, merchant) ||
    (screen.amount !== null && saleAmount !== undefined && saleAmount !== screen.amount)
  ) {
    return true;
  }
  // Pimlico の記録は chain・会計の鍵・注文リンクの鍵を持たない (比べない)。
  if (restored.kind === 'gasless') return false;
  const { chainId, contextKey, orderLinkKey } = restored.record;
  if (!screen.chainIds.includes(chainId)) return true;
  // /checkout の通常決済は必ず会計の鍵を付ける: 鍵が無い・受け付けるどの chain の鍵とも違う記録は別の会計。
  // 鍵を付けない画面 (/pay・/tip) では、鍵を持つ記録は /checkout の支払い。
  if (screen.contextKeys ? !(contextKey && screen.contextKeys.includes(contextKey)) : !!contextKey) return true;
  return orderLinkDiffers(screen, orderLinkKey);
}
