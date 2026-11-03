// 注文リンクの「注文の送り先」: お客様が支払いの後に、お店へ注文の文を送る先 (LINE 公式アカウントかメール)。
// リンク (/checkout の contact) に載り、完了画面はこの送り先を開くリンクを作るだけ。OpenPay のサーバーは通らない
// (住所などのお客様の情報を受け取らない・plans/order-link-reusable.md)。
// URL は誰でも作れるので、形が決まった 2 種類だけを受ける (任意の URL・javascript: や外部のフォームへ誘導させない)。
// 完了画面は送り先をお客様に見せる (書き換えたリンクで住所だけ別の人へ行く形に気づけるように)。

export type ShopContact = { kind: 'line'; id: string } | { kind: 'mail'; address: string };
export type ShopContactKind = ShopContact['kind'];

export const SHOP_CONTACT_MAIL_MAX = 120;

// LINE 公式アカウントの ID (ベーシック ID・プレミアム ID)。英小文字・数字・. _ - で、先頭に @。
const LINE_ID = /^@[a-z0-9._-]{2,20}$/;
// メールは ASCII だけ。URL の区切りになる ? # & % ・空白・制御文字は受けない (mailto: の件名や本文を差し込ませない)。
const MAIL = /^[A-Za-z0-9._+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;

/** 画面で打った値を送り先にする。空は null、形が合わなければ 'invalid'。LINE の @ は省いて打ってもよい。 */
export function shopContactFromInput(kind: ShopContactKind, raw: string): ShopContact | null | 'invalid' {
  const value = raw.trim();
  if (value === '') return null;
  if (kind === 'line') {
    const id = (value.startsWith('@') ? value : `@${value}`).toLowerCase();
    return LINE_ID.test(id) ? { kind: 'line', id } : 'invalid';
  }
  return value.length <= SHOP_CONTACT_MAIL_MAX && MAIL.test(value) ? { kind: 'mail', address: value } : 'invalid';
}

/** URL の contact の値 (`line:@id` / `mail:addr`)。 */
export function formatShopContact(contact: ShopContact): string {
  return contact.kind === 'line' ? `line:${contact.id}` : `mail:${contact.address}`;
}

/** URL の contact を読む。形が合わなければ null (送り先なし = 共有とコピーだけ)。 */
export function parseShopContact(raw: string | null): ShopContact | null {
  if (raw === null) return null;
  if (raw.startsWith('line:')) {
    const id = raw.slice(5);
    return LINE_ID.test(id) ? { kind: 'line', id } : null;
  }
  if (raw.startsWith('mail:')) {
    const address = raw.slice(5);
    return address.length <= SHOP_CONTACT_MAIL_MAX && MAIL.test(address) ? { kind: 'mail', address } : null;
  }
  return null;
}

export function sameShopContact(a: ShopContact | null | undefined, b: ShopContact | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  return formatShopContact(a) === formatShopContact(b);
}

/** お客様に見せる送り先 (LINE @id か メールアドレス)。何で送るかが分かるよう LINE は名前を付ける。 */
export function shopContactLabel(contact: ShopContact): string {
  return contact.kind === 'line' ? `LINE ${contact.id}` : contact.address;
}

/** LINE 公式アカウントのトークを、文を入れた状態で開く URL (LINE の URL スキーム oaMessage)。 */
export function lineMessageUrl(id: string, text: string): string {
  return `https://line.me/R/oaMessage/${encodeURIComponent(id)}/?${encodeURIComponent(text)}`;
}

/** メールを、件名と本文を入れた状態で開く URL (改行は RFC 6068 の CRLF)。 */
export function mailtoUrl(address: string, subject: string, body: string): string {
  const crlf = (value: string) => encodeURIComponent(value.replace(/\r?\n/g, '\r\n'));
  return `mailto:${address}?subject=${crlf(subject)}&body=${crlf(body)}`;
}
