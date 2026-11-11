import type {
  RelayIntentMetadata,
  StandardPaymentIntentParams,
} from '@/lib/paymentIntentStorage';

// 復元した支払いの確定が、今の画面の支払いか (第 10 回レビュー H-S)。Pay / Checkout / Tip が同じ関数を使う。
// ブラウザに残る未解決の支払いの記録 (束縛しない relay の枠・通常決済の印・Pimlico の記録) は、どの画面の mount でも
// 復元される。別の画面で確定したときに、その画面の完了の題で出さないための判定。
//
// 返す値は意図して非対称: true は「この画面の支払いでない」と証明できたときだけ。何の波及を断つか: 同じ支払いを読み直した
// だけの画面に「この画面の支払いではありません」と出して、払い済みの人にもう一度払わせること (二重払い)。逆側 (別の支払いを
// 一致とする) は、今までの表示と同じ。
//
// 証明に使うのは、時間がたってもずれない事実だけ: 受取先・URL で決まる額と記録の額の形・別の token と分かる address・鍵を
// 付けない画面で鍵を持つこと・/checkout の通常決済の記録に会計の鍵が無いこと (枠と鍵は同じ 2026-07-26 の #273 で入った)。
// 今のコードと env で計算し直した値 (会計の鍵・注文リンクの鍵・受け付ける chain の組) と違うことは証明にしない: parser・
// 指紋の入力・chain の flag が払った後に変わると、同じ URL の同じ支払いでも値がずれる (廃止した fee_kind=register・
// 止めた chain など)。比べない欄: 支払い者 (from)・chain・入力で決まる額 (amount = null)・利用料の額・Pimlico の calls。
// 実行時の import を持たない (3 画面の First Load JS に載るため・型は import type だけ)。アドレスは小文字で比べる。

/** 今の画面が URL から決める支払いの形。 */
export type SettlementScreen = {
  /** 受取先。 */
  merchant: string;
  /**
   * URL で決まる売上の額 (/checkout の合計・/pay の固定額・token の最小単位)。入力で決まる画面 (/pay の自由入力・/tip) は
   * null = 額を比べない。
   */
  amount: bigint | null;
  /**
   * relay でお客様が利用料を上乗せして払う形 (お店の受取 = 額・受取 + 利用料 > 額) がありうる会計。URL だけで決める
   * (/checkout で事前注文 feeKind=preorder かつ負担者 fee_payer=customer)。上乗せになるのはこの URL で利用料の flag が ON の
   * ときだけで、flag が OFF なら同じ URL でも 受取 + 利用料 = 額 になる。flag・料率は払った後に変わりうるので使わず、この URL
   * ではどちらの形も一致とする。
   */
  customerFeeOnTop: boolean;
  /** 画面の token と別の token の address (別の symbol の deployment)。記録の token がこのどれかなら別の支払い。 */
  otherTokenAddresses: readonly string[];
  /** この画面の通常決済は会計の鍵 (contextKey) を記録に付ける (/checkout)。鍵を付けない画面 (/pay・/tip) は false。 */
  contextKeyed: boolean;
};

/** 復元した記録 (hook が返す値をそのまま渡す)。record が無ければ比べられない = 一致。 */
export type RestoredSettlement =
  | {
      kind: 'relay';
      /** 注文に束縛した記録 (matchesOrderDeliveryContext を通ったもの)。常に一致。 */
      bound: boolean;
      record: Pick<RelayIntentMetadata, 'merchant' | 'merchantValue' | 'feeValue' | 'orderLinkKey'> | null | undefined;
    }
  | {
      kind: 'standard';
      record:
        | Pick<StandardPaymentIntentParams, 'tokenAddress' | 'merchant' | 'saleAmount' | 'contextKey' | 'orderLinkKey'>
        | null
        | undefined;
    }
  | {
      kind: 'gasless';
      /** 保存した params (useBatchPayment の variables)。 */
      record: { tokenAddress: string; merchant: string; saleAmount?: bigint } | null | undefined;
    };

const same = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();

export function isForeignSettlement(screen: SettlementScreen, restored: RestoredSettlement): boolean {
  if (!restored.record || (restored.kind === 'relay' && restored.bound)) return false;
  if (!same(screen.merchant, restored.record.merchant)) return true;
  if (restored.kind === 'relay') {
    // 額: 「お店の受取 + 利用料」が画面の売上の額と同じなら一致 (free = 利用料 0・お店が利用料を負担 = 受取が減る)。
    // 保存した値をそのまま足し、利用料を今の設定で計算し直さない。URL がお客様の上乗せの形の会計 (customerFeeOnTop) だけ
    // 「お店の受取」が額と同じでも一致 (上乗せの形は 受取 + 利用料 が売上の額を超える)。
    const { merchantValue, feeValue, orderLinkKey } = restored.record;
    const received = BigInt(merchantValue);
    return (
      (screen.amount !== null &&
        received + BigInt(feeValue) !== screen.amount &&
        !(screen.customerFeeOnTop && received === screen.amount)) ||
      // 鍵を付けない画面 (/pay・/tip) で注文リンクの鍵を持つ記録は /checkout の支払い (付けるのは /checkout だけ)。
      (!screen.contextKeyed && !!orderLinkKey)
    );
  }
  const { tokenAddress, saleAmount } = restored.record;
  if (
    screen.otherTokenAddresses.some((token) => same(token, tokenAddress)) ||
    (screen.amount !== null && saleAmount !== undefined && saleAmount !== screen.amount)
  ) {
    return true;
  }
  // Pimlico の記録は会計の鍵・注文リンクの鍵を持たない (比べない)。
  if (restored.kind === 'gasless') return false;
  const { contextKey, orderLinkKey } = restored.record;
  // /checkout の通常決済は必ず会計の鍵を付ける: 鍵の無い記録は /pay・/tip の支払い (枠と鍵は同じ 2026-07-26 の #273 で
  // 入り、CheckoutForm の唯一の standard.mutate が毎回付ける・崩れた鍵は parser が記録ごと捨てる)。鍵の値は比べない (上)。
  // 鍵を付けない画面 (/pay・/tip) では、鍵を持つ記録は /checkout の支払い。
  return screen.contextKeyed ? !contextKey : !!(contextKey || orderLinkKey);
}
