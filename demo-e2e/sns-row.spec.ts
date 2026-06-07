import { test, expect } from '@playwright/test';

// SNS/README 用の 3 本横並び合成 (受取・レジ・支払い)。個別の mobile デモ mp4 を
// public/demo から読み込み、タイトル/ラベル/footer を付けた 1024x880 のカードレイアウトを
// chromium で録画する → ffmpeg で sns-row.mp4 / sns-row.gif に変換 (寸法は従来と同一)。
// 個別デモを録り直したら本 spec を再実行するだけで合成も更新できる (従来は ad-hoc だった)。
//
// 文言・配色は従来の sns-row を踏襲。背景=slate-50、タイトル=slate-900、補足=slate-500。
const HTML = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><style>
  * { margin:0; padding:0; box-sizing:border-box; }
  html,body { width:1024px; height:880px; overflow:hidden; background:#f8fafc;
    font-family:-apple-system,"Hiragino Kaku Gothic ProN","Noto Sans JP",system-ui,sans-serif;
    -webkit-font-smoothing:antialiased; }
  .wrap { width:1024px; height:880px; display:flex; flex-direction:column; align-items:center;
    justify-content:flex-start; padding:30px 24px 22px; }
  h1 { font-size:27px; font-weight:800; color:#0f172a; letter-spacing:.5px; }
  .sub { margin-top:8px; font-size:14px; color:#64748b; }
  .row { margin-top:20px; display:flex; gap:46px; align-items:flex-start; }
  figure { display:flex; flex-direction:column; align-items:center; }
  .card { width:282px; border-radius:16px; overflow:hidden; background:#fff;
    box-shadow:0 10px 30px rgba(15,23,42,.12); }
  .card video { display:block; width:282px; height:auto; }
  figcaption { margin-top:14px; text-align:center; }
  figcaption b { display:block; font-size:15px; font-weight:700; color:#0f172a; }
  figcaption span { display:block; margin-top:3px; font-size:12px; color:#94a3b8; }
  .foot { margin-top:16px; font-size:13px; color:#94a3b8; letter-spacing:.5px; }
</style></head><body>
  <div class="wrap">
    <h1>OpenPay — 実際の操作デモ</h1>
    <div class="sub">受け取りもお支払いも、スマホで完結。JPYC はガス代不要・100%着金。</div>
    <div class="row">
      <figure><div class="card"><video src="/demo/create-qr-mobile.mp4" autoplay loop muted playsinline></video></div>
        <figcaption><b>① 受取（決済QR）</b><span>金額を入れてQR</span></figcaption></figure>
      <figure><div class="card"><video src="/demo/register-mobile.mp4" autoplay loop muted playsinline></video></div>
        <figcaption><b>② レジ（POS）</b><span>商品を選んで会計</span></figcaption></figure>
      <figure><div class="card"><video src="/demo/pay-mobile.mp4" autoplay loop muted playsinline></video></div>
        <figcaption><b>③ 支払い（顧客）</b><span>スキャンするだけ</span></figcaption></figure>
    </div>
    <div class="foot">open-pay.jp</div>
  </div>
</body></html>`;

test('SNS 3本横並び合成 (受取/レジ/支払い)', async ({ page, baseURL }) => {
  // /demo/*.mp4 を絶対 URL で読めるよう baseURL 配下の空ページに移動してから差し込む。
  await page.goto(`${baseURL}/ja`);
  await page.setContent(HTML, { waitUntil: 'load' });
  // 3 本すべて再生開始するまで待つ (currentTime>0)。
  await page.waitForFunction(() => {
    const vs = Array.from(document.querySelectorAll('video'));
    return vs.length === 3 && vs.every((v) => v.readyState >= 2 && v.currentTime > 0);
  }, { timeout: 15000 });
  await expect(page.getByText('② レジ（POS）')).toBeVisible();
  // ループしている 8 秒ぶんを収録 (従来 sns-row と同尺)。
  await page.waitForTimeout(8000);
});
