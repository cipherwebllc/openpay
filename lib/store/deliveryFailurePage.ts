import 'server-only';

// 保護配布の 2 つの route (購入者の /api/store/delivery/<id>・出品者の /api/store/products/<id>/delivery-test) の
// 失敗を、ブラウザのナビゲーションのときだけ人が読めるページで返す (第 10 回レビュー D-5)。
// 画面のリンクは新しいタブで route を直接開くので、失敗すると `{"ok":false,"error":"rate_limited"}` がそのまま出ていた。
//
// 変えないもの: 成功 (302・format=json の 200)・ナビゲーションでない要求 (fetch・curl・SDK・agent) への JSON・status・
// rate limit・認可・チケットの発行の条件。この関数は handler が返した応答を受け取り、差し替えないときは同じ応答をそのまま返す。
//
// ページに入れるのは下の表の固定の文と、固定の path へのリンクだけ。商品名・URL・error の code・要求の中身は入れない
// (利用者や出品者が入れた文字列が HTML に入る道を作らない)。
import { NextResponse } from 'next/server';
import { DEFAULT_LOCALE, isLocale, type Locale } from '@/i18n';

export type DeliveryFailureAudience = 'buyer' | 'seller';

type FailureKind =
  | 'signIn' | 'crossSite' | 'badLink' | 'notFound' | 'ended' | 'notConfigured' | 'busy' | 'unavailable';
type PageCopy = { heading: string; body: string };
type AudienceCopy = { back: string; pages: Partial<Record<FailureKind, PageCopy>> };

// 2 つの route が今返している失敗 → ページの種類。ここに無い失敗は差し替えない (JSON のまま)。
// 案内は status で決まる: 400 invalid_selector・401 (SIWE の session が無い)・403 cross_site・404 not_found・
// 429 rate_limited (IP・ウォレット・チケットの 3 つの枠)・503 (storage_unavailable・session_storage_unavailable・
// license_rights_unknown・delivery_unavailable = どれも OpenPay の側でいま用意できない)。
// code を見るのは 409 だけ (provided_ended と delivery_not_configured で、できることが違う)。
function failureKind(status: number, code: unknown): FailureKind | null {
  if (status === 400) return 'badLink';
  if (status === 401) return 'signIn';
  if (status === 403) return 'crossSite';
  if (status === 404) return 'notFound';
  if (status === 409 && code === 'provided_ended') return 'ended';
  if (status === 409 && code === 'delivery_not_configured') return 'notConfigured';
  if (status === 429) return 'busy';
  if (status === 503) return 'unavailable';
  return null;
}

// 公開文言。ja / en は同じ形 (tests/app/api/store-delivery-failure-page.test.ts が key の一致を固定する)。
// 画面の語に合わせる: 購入者のライブラリは「ログイン」・出品者の管理は「サインイン」(messages の CreatorStoreLibrary・
// CreatorStoreSeller)。出品者の route は 400 を返さないので、出品者の badLink は無い。
export const DELIVERY_FAILURE_COPY: Record<Locale, Record<DeliveryFailureAudience, AudienceCopy>> = {
  ja: {
    buyer: {
      back: '購入済みライブラリに戻る',
      pages: {
        signIn: {
          heading: 'ログインが必要です',
          body: 'ログインしていないか、ログインの期限が切れています。購入済みライブラリでログインしてから、もう一度開いてください。',
        },
        crossSite: {
          heading: 'このリンクは OpenPay の画面から開いてください',
          body: 'ほかのサイトに置かれたリンクからは開けません。購入済みライブラリから、もう一度開いてください。',
        },
        badLink: {
          heading: 'このリンクは使えません',
          body: 'リンクの形が正しくありません。購入済みライブラリから、もう一度開いてください。',
        },
        notFound: {
          heading: 'ダウンロードを開けません',
          body: 'この商品が見つからないか、ログイン中のウォレットではこの商品のダウンロードを開けません。別のウォレットでログインしていないか、ご確認ください。',
        },
        ended: {
          heading: 'この商品は現在提供されていません',
          body: 'この商品の内容は現在提供されていないため、ダウンロードを開けません。',
        },
        notConfigured: {
          heading: '配布先が設定されていません',
          body: 'この商品には、いま使える保護ダウンロードの配布先が設定されていません。',
        },
        busy: {
          heading: '少し待ってから開いてください',
          body: '短い時間に開いた回数が上限を超えました。1 分ほど待ってから、もう一度開いてください。',
        },
        unavailable: {
          heading: 'いまは開けません',
          body: 'OpenPay の側で、いまダウンロードの準備ができませんでした。時間をおいて、もう一度開いてください。',
        },
      },
    },
    seller: {
      back: 'デジタル商品の管理に戻る',
      pages: {
        signIn: {
          heading: 'サインインが必要です',
          body: 'サインインしていないか、サインインの期限が切れています。デジタル商品の管理でサインインしてから、もう一度「配布を試す」を押してください。',
        },
        crossSite: {
          heading: 'このリンクは OpenPay の画面から開いてください',
          body: 'ほかのサイトに置かれたリンクからは開けません。デジタル商品の管理から、もう一度「配布を試す」を押してください。',
        },
        notFound: {
          heading: '配布を試せません',
          body: 'この商品が見つからないか、サインイン中のウォレットが出品した商品ではありません。出品したウォレットでサインインしているか、ご確認ください。',
        },
        ended: {
          heading: 'この商品は現在提供されていません',
          body: 'この商品の内容は現在提供されていないため、配布を試せません。',
        },
        notConfigured: {
          heading: '保護配布先URL を確認してください',
          body: '保護配布先URL が設定されていないか、使えない形です。商品の編集で確認してください。',
        },
        busy: {
          heading: '少し待ってから開いてください',
          body: '短い時間に開いた回数が上限を超えました。1 分ほど待ってから、もう一度「配布を試す」を押してください。',
        },
        unavailable: {
          heading: 'いまは試せません',
          body: 'OpenPay の側で、いま配布の確認の準備ができませんでした。時間をおいて、もう一度「配布を試す」を押してください。',
        },
      },
    },
  },
  en: {
    buyer: {
      back: 'Back to your purchase library',
      pages: {
        signIn: {
          heading: 'Sign-in required',
          body: 'You are not signed in, or your sign-in has expired. Sign in from your purchase library, then open the link again.',
        },
        crossSite: {
          heading: 'Open this link from OpenPay',
          body: 'This can\'t be opened from a link placed on another site. Open it again from your purchase library.',
        },
        badLink: {
          heading: 'This link can\'t be used',
          body: 'The link is malformed. Open it again from your purchase library.',
        },
        notFound: {
          heading: 'Can\'t open this download',
          body: 'This product was not found, or the wallet you are signed in with can\'t open its download. Check that you are not signed in with a different wallet.',
        },
        ended: {
          heading: 'This product is not currently available',
          body: 'This product\'s content is not currently available, so the download can\'t be opened.',
        },
        notConfigured: {
          heading: 'No delivery destination is set',
          body: 'This product has no usable protected-download destination set right now.',
        },
        busy: {
          heading: 'Please wait a moment',
          body: 'This was opened too many times in a short period. Wait about a minute, then open it again.',
        },
        unavailable: {
          heading: 'Can\'t open this right now',
          body: 'OpenPay could not prepare the download right now. Try opening it again later.',
        },
      },
    },
    seller: {
      back: 'Back to your digital products',
      pages: {
        signIn: {
          heading: 'Sign-in required',
          body: 'You are not signed in, or your sign-in has expired. Sign in where you manage your digital products, then press "Test delivery" again.',
        },
        crossSite: {
          heading: 'Open this link from OpenPay',
          body: 'This can\'t be opened from a link placed on another site. Press "Test delivery" again where you manage your digital products.',
        },
        notFound: {
          heading: 'Can\'t test delivery',
          body: 'This product was not found, or it was not listed by the wallet you are signed in with. Check that you are signed in with the wallet you listed it with.',
        },
        ended: {
          heading: 'This product is not currently available',
          body: 'This product\'s content is not currently available, so delivery can\'t be tested.',
        },
        notConfigured: {
          heading: 'Check your protected delivery URL',
          body: 'The protected delivery URL is not set, or is not in a usable form. Check it in the product editor.',
        },
        busy: {
          heading: 'Please wait a moment',
          body: 'This was opened too many times in a short period. Wait about a minute, then press "Test delivery" again.',
        },
        unavailable: {
          heading: 'Can\'t test this right now',
          body: 'OpenPay could not prepare the delivery test right now. Press "Test delivery" again later.',
        },
      },
    },
  },
};

// 戻る先は自分の origin の固定の path だけ (要求の値から組み立てない = open redirect を作らない)。
// 購入者 = 購入済みライブラリ (リンクの置き場所)・出品者 = /create の「プロフ」タブ (商品一覧の置き場所)。
function backPath(locale: Locale, audience: DeliveryFailureAudience): string {
  return audience === 'buyer' ? `/${locale}/store/library` : `/${locale}/create?tab=profile`;
}

/**
 * ブラウザが利用者のために開くトップレベルの遷移 (リンク・新しいタブ・URL の直打ち・ブックマーク) だけを true にする。
 * 今のブラウザ (Chrome 80・Firefox 90・Safari 16.4 以降) は遷移に Sec-Fetch-Mode: navigate と Sec-Fetch-Dest: document と
 * Accept: text/html を必ず付け、page の script の fetch はこの 2 つの Sec-Fetch を付けられない (forbidden header)。
 * 3 つのどれかが欠ける要求 (fetch・curl・SDK・agent・Fetch Metadata の無い古いブラウザ) は判定できないので false =
 * 今までどおり JSON。`format` を付けた要求は JSON の形を自分で選んでいるので、遷移でも差し替えない。
 */
export function isDocumentNavigation(req: Request): boolean {
  if (req.headers.get('sec-fetch-mode') !== 'navigate') return false;
  if (req.headers.get('sec-fetch-dest') !== 'document') return false;
  const accept = req.headers.get('accept') ?? '';
  if (!accept.split(',').some((range) => range.split(';')[0].trim().toLowerCase() === 'text/html')) return false;
  return !new URL(req.url).searchParams.has('format');
}

/**
 * ページの言語。route は /api の下で URL に locale が無く、リンクは noreferrer なので Referer も無い。
 * middleware (next-intl の localeDetection) と同じ順で決める: NEXT_LOCALE cookie (利用者が切り替えた言語) →
 * Accept-Language → 既定 (ja)。どの値も ja / en の一覧と照合してから使う。
 */
export function failurePageLocale(req: Request): Locale {
  const cookie = (req.headers.get('cookie') ?? '').split(';')
    .map((pair) => pair.trim().split('='))
    .find(([name]) => name === 'NEXT_LOCALE')?.[1];
  if (cookie && isLocale(cookie)) return cookie;
  const ranked = (req.headers.get('accept-language') ?? '').split(',')
    .map((range) => {
      const [tag, ...params] = range.trim().split(';');
      const q = params.map((param) => param.trim()).find((param) => param.startsWith('q='));
      return { primary: tag.trim().toLowerCase().split('-')[0], q: q ? Number(q.slice(2)) : 1 };
    })
    .filter((entry) => entry.q > 0)
    .sort((a, b) => b.q - a.q);
  for (const { primary } of ranked) if (isLocale(primary)) return primary;
  return DEFAULT_LOCALE;
}

// 表の文も text → HTML の変換を通す (文に & や < を書いても壊れない・表の外の文字列を足す変更が escape を素通りしない)。
function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

// このページは script も外部の読み込みも使わない。next.config.mjs の全体の CSP は Next の inline script のために
// script-src 'unsafe-inline' を許しており、Next は config の header を route の同名の header より優先する
// (next.config.mjs の headers() の注記・`next start` の実測でも、下で応答に付ける CSP の header は config の値に
// 置き換わって届く)。応答の header だけではこのページの方針にならないので、同じ方針を <meta> でも置く
// (ブラウザは header の CSP と meta の CSP の両方を満たすものだけを通す = config の値が届いても script は動かない)。
export const DELIVERY_FAILURE_PAGE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";

const STYLE = 'body{margin:0;background:#f8fafc;color:#0f172a;font-family:system-ui,-apple-system,"Hiragino Sans","Noto Sans JP",sans-serif;line-height:1.7}' +
  'main{max-width:32rem;margin:0 auto;padding:3rem 1.25rem}' +
  '.brand{margin:0 0 1.5rem;font-size:.875rem;font-weight:700;color:#475569}' +
  'h1{margin:0 0 .75rem;font-size:1.25rem;line-height:1.4}' +
  'p{margin:0 0 1.5rem}' +
  'a{display:inline-flex;align-items:center;min-height:2.75rem;font-weight:700;color:#1d4ed8;text-underline-offset:2px}';

function renderPage(locale: Locale, copy: PageCopy, back: { href: string; label: string }): string {
  return '<!doctype html>\n' +
    `<html lang="${locale}">\n<head>\n<meta charset="utf-8">\n` +
    `<meta http-equiv="Content-Security-Policy" content="${escapeHtml(DELIVERY_FAILURE_PAGE_CSP)}">\n` +
    // 戻るリンクを押したときに、この route の URL (購入者のリンクは intentSalt を含むことがある) を Referer に載せない。
    // 出品者の route は next.config.mjs の no-referrer の rule (/api/store/delivery/ だけ) の外で、応答の header は
    // 全体の既定 (strict-origin-when-cross-origin) で届く (`next start` の実測) ので、ページの側で止める。
    '<meta name="referrer" content="no-referrer">\n' +
    '<meta name="robots" content="noindex">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    `<title>${escapeHtml(copy.heading)} · OpenPay</title>\n` +
    `<style>${STYLE}</style>\n</head>\n<body>\n<main>\n` +
    '<p class="brand">OpenPay</p>\n' +
    `<h1>${escapeHtml(copy.heading)}</h1>\n` +
    `<p>${escapeHtml(copy.body)}</p>\n` +
    `<a href="${escapeHtml(back.href)}">${escapeHtml(back.label)}</a>\n` +
    '</main>\n</body>\n</html>\n';
}

/**
 * handler の応答が失敗 (4xx / 5xx) で、要求がブラウザのナビゲーションのときだけ、同じ status の HTML に差し替える。
 * それ以外 (成功・ナビゲーションでない要求・表に無い失敗) は、受け取った応答をそのまま返す。
 * 元の応答の header (Cache-Control: private, no-store・Vary・Referrer-Policy・429 の Retry-After) は引き継ぐ。
 */
export async function deliveryFailurePage(
  req: Request,
  response: NextResponse,
  audience: DeliveryFailureAudience,
): Promise<NextResponse> {
  if (!isDocumentNavigation(req)) return response;
  // 成功 (302・200) はここで返す。下で読むのは失敗の本文だけ (2 つの route の失敗はすべて `{ ok: false, error }` の JSON)。
  if (response.status < 400) return response;
  const parsed: unknown = await response.clone().json();
  const code = typeof parsed === 'object' && parsed !== null && 'error' in parsed ? parsed.error : undefined;
  const kind = failureKind(response.status, code);
  const locale = failurePageLocale(req);
  const copy = kind ? DELIVERY_FAILURE_COPY[locale][audience].pages[kind] : undefined;
  if (!copy) return response;

  const headers = new Headers(response.headers);
  headers.set('Content-Type', 'text/html; charset=utf-8');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Content-Security-Policy', DELIVERY_FAILURE_PAGE_CSP);
  const html = renderPage(locale, copy, { href: backPath(locale, audience), label: DELIVERY_FAILURE_COPY[locale][audience].back });
  return new NextResponse(html, { status: response.status, headers });
}
