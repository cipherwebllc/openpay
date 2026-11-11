import type { CheckoutParams } from '@/lib/url';

// /checkout の CheckoutForm を作り直す key (app/[locale]/checkout/page.tsx・第 10 回レビュー H-R)。URL から parse した
// 注文の中身全体 (chain・お店・品目・注文番号・合計に効く値・戻り先など) から作る。
// - 同じ URL は必ず同じ key (parse は決定的)。同じ URL のまま描き直す (router.refresh など) ときは作り直さない。
// - 注文の中身が 1 つでも違えば違う key。同じ chain の checkout は、同じタブのまま別の注文の URL へ移っても mount が続いて
//   いた (key が chain だけだった) ので、前の注文の支払いの状態 (IP 制限で保持した署名・署名の途中の試み・完了の画面) が
//   次の注文の画面に残り、前の注文の payload を次の注文の画面で送る・前の注文の成功を次の注文の画面に出す道があった。
// 断つのは memory の持ち越しだけ。作り直した画面は読み直しと同じく storage の復旧の記録を読むので、タブに 1 つの記録
// (束縛しない relay の枠・通常決済の印) や品目だけが違う注文の記録から、前の支払いの確定が今の注文の完了の欄に出る道は
// 残る (この key の前からある・H-S として別に直す)。
// 文字列にするとき object の key を並べ替える (parse の組み立ての順に依らない)。CheckoutParams の値は文字列・数・真偽・
// 配列・object だけで bigint を持たない (持たせると JSON.stringify が投げる)。
export function checkoutFormKey(params: CheckoutParams): string {
  return stableStringify(params);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
