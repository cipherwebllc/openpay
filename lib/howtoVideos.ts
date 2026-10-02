// 日本語の使い方動画 (YouTube・OpenPay チャンネル) の単一情報源。
// ガイドページが components/guide/GuideVideo.tsx で埋め込む。動画は日本語の読み上げ + 字幕の
// 焼き込みなので ja のページにだけ出す (howtoVideoFor が en では null を返す)。
// サムネイルは public/guide/videos/<file> (動画のタイトル画面)。押すまで YouTube へは通信しない。

export type HowtoVideoKey = 'qr' | 'mobileOrder' | 'agent' | 'creator';

export type HowtoVideo = {
  readonly youtubeId: string;
  /** YouTube に載せたタイトルと同じ (サムネイルの alt と iframe の title にも使う)。 */
  readonly title: string;
  /** 表示用の長さ (m:ss)。YouTube の lengthSeconds (検索結果やサムネイルの長さ表示) と同じ値。 */
  readonly duration: string;
  /** public/ からのパス。 */
  readonly thumbnail: string;
};

export const HOWTO_VIDEOS: Readonly<Record<HowtoVideoKey, HowtoVideo>> = {
  qr: {
    youtubeId: '2uGhrn2islQ',
    title: 'OpenPay の使い方｜お店向け：決済QRを作って JPYC を受け取る',
    duration: '1:21',
    thumbnail: '/guide/videos/qr.webp',
  },
  mobileOrder: {
    youtubeId: '5Eh9DCeWjCk',
    title: 'OpenPay の使い方｜お店向け：モバイルオーダーを始める',
    duration: '1:48',
    thumbnail: '/guide/videos/mobile-order.webp',
  },
  agent: {
    youtubeId: '9l_23O6wsC8',
    title: 'OpenPay の使い方｜AI エージェントに JPYC で買い物を頼む',
    duration: '1:40',
    thumbnail: '/guide/videos/agent.webp',
  },
  creator: {
    youtubeId: 'Cg3SN_l00Ds',
    title: 'OpenPay の使い方｜クリエイター向け：プロフィールで応援とデジタル作品の販売',
    duration: '1:55',
    thumbnail: '/guide/videos/creator.webp',
  },
};

export const HOWTO_VIDEO_UI = {
  sectionTitle: '動画で見る',
  play: '動画を再生',
  openOnYouTube: 'YouTube で開く',
} as const;

// next.config.mjs の frame-src に含まれる origin (tests/app/next-config-headers.test.ts が検査)。
// youtube-nocookie は再生するまで Cookie を置かない埋め込み用ドメイン。
export const HOWTO_VIDEO_EMBED_ORIGIN = 'https://www.youtube-nocookie.com';

export function howtoVideoEmbedUrl(video: HowtoVideo): string {
  // 押してから iframe を作るので autoplay で 1 回のクリックで再生を始める。rel=0 = 終了後の関連動画を同じチャンネルに限る。
  return `${HOWTO_VIDEO_EMBED_ORIGIN}/embed/${video.youtubeId}?autoplay=1&rel=0`;
}

export function howtoVideoWatchUrl(video: HowtoVideo): string {
  return `https://www.youtube.com/watch?v=${video.youtubeId}`;
}

export function howtoVideoFor(locale: string, key: HowtoVideoKey): HowtoVideo | null {
  return locale === 'ja' ? HOWTO_VIDEOS[key] : null;
}
