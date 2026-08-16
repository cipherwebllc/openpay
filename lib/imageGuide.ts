// /guide/image-url 「画像 URL の用意のしかた」の content SOT (裁定 2026-08-17・user 原文ベース)。
// OpenPay は画像を預からず https:// の画像 URL を設定する方式 — その「URL の用意」を
// 初心者向けに 1 ページで案内する。画像 URL 欄 4 箇所 (プロフィール/出品/レジ商品/
// モバイル注文アイコン) のヒントからリンクされる実務ページ。
// 長文を messages/*.json に置かない方針は lib/qrGuide.ts 等と同じ。数値・料率は扱わない。

import type { Metadata } from 'next';
import { guidePageMetadata } from '@/lib/guideMetadata';

export type ImageGuideSection = {
  readonly title: string;
  readonly body: readonly string[];
  readonly steps?: readonly { readonly title: string; readonly body: string }[];
  readonly bullets?: readonly string[];
  readonly callout?: { readonly kind: 'warn' | 'tip'; readonly text: string };
};

export type ImageGuideContent = {
  readonly metaTitle: string;
  readonly metaDescription: string;
  readonly backHome: string;
  readonly heroTitle: string;
  readonly heroLead: readonly string[];
  readonly flowTitle: string;
  readonly flow: readonly string[];
  readonly sections: readonly ImageGuideSection[];
  readonly quickTitle: string;
  readonly quickSteps: readonly string[];
  readonly guidesTitle: string;
  readonly guideLinkStore: string;
  readonly guideLinkShop: string;
};

const JA: ImageGuideContent = {
  metaTitle: '画像 URL の用意のしかた — OpenPayで画像を設定する | OpenPay',
  metaDescription:
    'OpenPay は画像を預からず、公開されている画像の URL (https://〜) を設定する方式です。Imgur などへのアップロードから URL の確認方法、つまずきやすいポイントまでを 1 ページで案内します。',
  backHome: '← OpenPay トップへ',

  heroTitle: 'OpenPayで画像を設定する方法',
  heroLead: [
    'OpenPay では、できるだけユーザーのデータを OpenPay 側で預からない設計にしています。そのため、画像をアップロードするのではなく、インターネット上に公開されている画像の URL (https://〜) を設定する方式を採用しています。',
    '難しそうに見えますが、やることは簡単です。',
  ],
  flowTitle: 'やることはこれだけ',
  flow: ['画像をアップロード', '画像 URL をコピー', 'OpenPay に貼り付け'],

  sections: [
    {
      title: 'いちばん簡単な方法 (Imgur の例)',
      body: [
        '画像を公開できるサービスへアップロードして、その画像 URL を OpenPay へ貼り付けます。例えば Imgur (imgur.com) はアカウント登録なしでも使えます。',
      ],
      steps: [
        {
          title: 'Imgur を開く',
          body: 'ブラウザから imgur.com を開きます。',
        },
        {
          title: '画像をアップロードする',
          body: 'OpenPay で表示したい画像 (お店のロゴ・店舗の写真・クリエイターアイコン・商品画像など) を選択してアップロードします。',
        },
        {
          title: '画像の URL をコピーする',
          body: 'アップロードした画像そのものの URL (例: https://i.imgur.com/xxxxx.png) をコピーします。画像を右クリック (長押し) して「画像アドレスをコピー」でも取得できます。',
        },
        {
          title: 'OpenPay へ貼り付ける',
          body: 'コピーした URL を OpenPay の「画像 URL」欄へ貼り付けて保存します。例えばモバイル注文では、設定した画像が注文ページの先頭に丸く表示されます。',
        },
      ],
    },
    {
      title: '画像 URL が正しいか確認する方法',
      body: [
        '分からなくなった場合は、設定する URL をブラウザで直接開いてみてください。画像そのものが表示されれば OK です。ページの飾り (ボタンやコメント欄) と一緒に表示される場合、それはページの URL であって画像の URL ではありません。',
        'Imgur の場合、https://imgur.com/xxxxx (ページ) ではなく、https://i.imgur.com/xxxxx.png のような画像そのものを表示できる URL を使用してください。',
      ],
      callout: {
        kind: 'tip',
        text: '確認はシークレットウィンドウ (プライベートブラウズ) で開くのが確実です。ログイン中の自分にだけ見えている画像を、公開されていると勘違いするのを防げます。',
      },
    },
    {
      title: '自分の Web サイトがある場合',
      body: [
        '自分の Web サイトへ画像をアップロードできる方は、その画像 URL (例: https://example.com/images/shop-logo.webp) を使っても問題ありません。ブラウザから誰でも画像を表示できる状態になっていることを確認してください。',
      ],
    },
    {
      title: 'その他のサービスも利用できます',
      body: [
        'OpenPay は特定の画像サービスに限定していません。外部からアクセスできる https:// の画像 URL であれば利用できます。自分で管理している Web サーバーや画像配信サービス、クラウドストレージも使えます。',
      ],
      callout: {
        kind: 'warn',
        text: 'Google ドライブや Dropbox などの「共有リンク」は、画像そのものではなく共有ページを表示することがあります。初心者の方は、まず画像を直接公開できるサービスを使うのがおすすめです。',
      },
    },
    {
      title: '注意点',
      body: ['設定した画像はあなたの管理下にあります。次の点にご注意ください。'],
      bullets: [
        '画像を削除したり公開設定を変更したりすると、OpenPay でも表示されなくなります',
        '一定期間で URL が無効になるサービスや、ログインしないと見られない設定は避けてください',
        '自分が利用する権利を持っている画像を使ってください。他のサイトに掲載されている画像の URL をそのまま貼る行為 (直リンク) は、権利の面でも相手のサーバーに負担をかける面でも避けてください',
        'スマホで撮った写真には撮影場所の情報 (位置情報) が埋め込まれていることがあります。Imgur などの多くのサービスはアップロード時に削除しますが、自分のサーバーに置く場合はそのまま公開されるため、自宅などで撮影した画像は注意してください',
        '丸く表示される欄 (プロフィールや店舗のアイコン) には正方形の画像が最適です。縦長・横長の画像は端が切れます',
      ],
    },
    {
      title: 'なぜ OpenPay に画像をアップロードしないの?',
      body: [
        'OpenPay では、決済だけでなくサービス全体で、できるだけユーザーのデータを OpenPay 側で預からないことを重視しています。画像についても OpenPay が保管するのではなく、ユーザー自身が管理する画像を URL から表示します。',
        'つまり「画像はあなたが管理する。OpenPay は表示する」というシンプルな仕組みです。',
      ],
    },
  ],

  quickTitle: '迷ったらこれだけ',
  quickSteps: [
    'Imgur などへ画像をアップロード',
    'https:// から始まる画像 URL をコピー',
    'OpenPay の「画像 URL」に貼り付け',
    'シークレットウィンドウで公開ページを開き、画像を確認',
  ],

  guidesTitle: '関連ガイド',
  guideLinkStore: 'クリエイター向け — チップ・デジタル商品販売',
  guideLinkShop: 'レジ・モバイル注文 — 商品登録から注文受付まで',
};

const EN: ImageGuideContent = {
  metaTitle: 'How to prepare an image URL | OpenPay',
  metaDescription:
    'OpenPay never stores your images — you set a public image URL (https://…) instead. This page walks through uploading to a service like Imgur, copying the right URL, and the common pitfalls.',
  backHome: '← Back to OpenPay',

  heroTitle: 'Setting images on OpenPay',
  heroLead: [
    'OpenPay is designed to hold as little of your data as possible. So instead of uploading images to OpenPay, you set the URL (https://…) of an image that is publicly available on the internet.',
    'It sounds technical, but the whole job is simple.',
  ],
  flowTitle: 'The whole flow',
  flow: ['Upload the image', 'Copy the image URL', 'Paste it into OpenPay'],

  sections: [
    {
      title: 'The easiest way (using Imgur)',
      body: [
        'Upload the image to a service that hosts public images, then paste the image URL into OpenPay. Imgur (imgur.com), for example, works without an account.',
      ],
      steps: [
        { title: 'Open Imgur', body: 'Open imgur.com in your browser.' },
        {
          title: 'Upload your image',
          body: 'Pick the image you want to show on OpenPay — a shop logo, a storefront photo, a creator avatar, a product image.',
        },
        {
          title: 'Copy the image URL',
          body: 'Copy the URL of the image itself (e.g. https://i.imgur.com/xxxxx.png). Right-clicking (or long-pressing) the image and choosing "Copy image address" also works.',
        },
        {
          title: 'Paste it into OpenPay',
          body: 'Paste the URL into the "Image URL" field and save. In mobile ordering, for example, the image appears as a round icon at the top of the order page.',
        },
      ],
    },
    {
      title: 'How to check the URL is right',
      body: [
        'When in doubt, open the URL directly in your browser. If the image itself appears, it is correct. If it appears surrounded by page furniture (buttons, comments), that is a page URL, not an image URL.',
        'On Imgur, use the direct image URL like https://i.imgur.com/xxxxx.png — not the page URL https://imgur.com/xxxxx.',
      ],
      callout: {
        kind: 'tip',
        text: 'Check in a private/incognito window. That catches the case where the image is visible only to your own logged-in account.',
      },
    },
    {
      title: 'If you have your own website',
      body: [
        'If you can upload images to your own site, that URL works too (e.g. https://example.com/images/shop-logo.webp). Make sure anyone can view the image from a browser.',
      ],
    },
    {
      title: 'Other services work as well',
      body: [
        'OpenPay is not tied to any particular image service. Any https:// image URL that is reachable from outside works — your own web server, an image CDN, or cloud storage.',
      ],
      callout: {
        kind: 'warn',
        text: '"Share links" from Google Drive or Dropbox often show a sharing page rather than the image itself. If you are new to this, start with a service that serves the image directly.',
      },
    },
    {
      title: 'Things to watch out for',
      body: ['The image stays under your control. Keep these in mind.'],
      bullets: [
        'If you delete the image or change its visibility, it disappears from OpenPay too',
        'Avoid services where URLs expire, and settings that require login to view',
        'Use images you have the rights to. Do not hotlink images from other sites — it is a rights problem and a burden on their servers',
        'Phone photos can carry embedded location data. Most services (including Imgur) strip it on upload, but if you host the file yourself it stays — be careful with photos taken at home',
        'Fields shown as a circle (profile and shop icons) look best with square images; tall or wide images get cropped',
      ],
    },
    {
      title: 'Why not upload to OpenPay?',
      body: [
        'Across the whole service — not just payments — OpenPay holds as little of your data as it can. Images are no exception: rather than storing them, OpenPay displays the image you manage, from your URL.',
        'In short: you own the image; OpenPay displays it.',
      ],
    },
  ],

  quickTitle: 'If you remember one thing',
  quickSteps: [
    'Upload the image to a service like Imgur',
    'Copy the image URL starting with https://',
    'Paste it into the "Image URL" field on OpenPay',
    'Open your public page in a private window and confirm the image shows',
  ],

  guidesTitle: 'Related guides',
  guideLinkStore: 'For creators — tips & digital product sales',
  guideLinkShop: 'POS & mobile ordering — from product setup to order intake',
};

export function imageGuideContentFor(locale: string): ImageGuideContent {
  return locale === 'en' ? EN : JA;
}

export function imageGuideMetadata(locale: string): Metadata {
  const c = imageGuideContentFor(locale);
  return guidePageMetadata({
    locale,
    path: '/guide/image-url',
    title: c.metaTitle,
    description: c.metaDescription,
  });
}
