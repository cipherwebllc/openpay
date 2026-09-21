# /agent の OG 画像

`public/og-agent.webp` (1200×630) の元。文字 (URL・コマンド) を正確に出すため、画像生成ではなく HTML を描画している。

再生成: `og.html` と `public/logo.svg` を同じフォルダに置き、Playwright (chromium・viewport 1200×630・deviceScaleFactor 1) で
スクリーンショット → `sharp(...).webp({ quality: 90 })` で `public/og-agent.webp` へ。ページ文言 (`lib/agentPage.ts`) を変えたらここも合わせる。
