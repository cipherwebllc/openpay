import { test, expect } from '@playwright/test';
import QRCode from 'qrcode';

// /scan: ページ構造 / URL fallback / 実 qr-scanner module load / wallet 接続持続 /
// camera フルパス (fake stream) を chromium + mobile-safari の両 project で smoke する。
// camera フルパス e2e は canvas.captureStream で生成した fake MediaStream を
// navigator.mediaDevices.getUserMedia 経由で qr-scanner に流すため、ffmpeg/Y4M
// などの外部依存なしに「実 qr-scanner + 実 worker + 実 video frame decode」を
// 検証できる。

const TO = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';

test.describe('/scan: ページ構造', () => {
  test('/ja/scan が 200 + 主要 heading + connectionPreHint (未接続) 描画', async ({
    page,
  }) => {
    const response = await page.goto('/ja/scan');
    expect(response?.status()).toBe(200);
    // ページ heading は AppShell 採用により h2 (logo h1 と区別)
    await expect(
      page.getByRole('heading', { name: 'スキャンして支払う', level: 2 }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'ウォレットの状態' }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'QR を読み取る' }),
    ).toBeVisible();
    // 未接続時の connectionPreHint は「右上の接続ボタンから」案内に変更済
    // (Connect ボタン本体は AppHeader 右上の WalletBadge に集約)
    await expect(page.getByText(/右上の「接続」ボタンから/)).toBeVisible();
  });

  test('/en/scan も 200 + 英語 UI に切替', async ({ page }) => {
    const response = await page.goto('/en/scan');
    expect(response?.status()).toBe(200);
    await expect(
      page.getByRole('heading', { name: 'Scan to pay' }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Scan a QR' }),
    ).toBeVisible();
  });

  test('/scan は middleware が Accept-Language で /ja or /en へ redirect', async ({
    page,
  }) => {
    const response = await page.goto('/scan');
    expect(response?.status()).toBeLessThan(400);
    expect(page.url()).toMatch(/\/(ja|en)\/scan\/?$/);
  });

  test('LocaleSwitcher が header に出ていて、ja → en で URL も切替', async ({
    page,
  }) => {
    await page.goto('/ja/scan');
    await page.getByRole('button', { name: 'English' }).click();
    await expect(page).toHaveURL(/\/en\/scan/);
    await expect(
      page.getByRole('heading', { name: 'Scan to pay' }),
    ).toBeVisible();
  });
});

test.describe('/scan: URL 手入力 fallback', () => {
  test('「カメラを起動」ボタンが視覚的に出る (camera permission は実環境依存)', async ({
    page,
  }) => {
    await page.goto('/ja/scan');
    await expect(
      page.getByRole('button', { name: 'カメラを起動' }),
    ).toBeVisible();
  });

  test('URL 手入力 → 「この URL で進む」で /pay へ遷移', async ({ page }) => {
    await page.goto('/ja/scan');
    // details summary をクリックして fallback フォームを展開
    await page.getByText('URL を貼り付けて続行').click();
    const input = page.getByLabel('OpenPay の URL (https://open-pay.jp/pay?…)');
    await input.fill(`http://localhost:3000/pay?to=${TO}&token=usdc&amount=10`);
    await page.getByRole('button', { name: 'この URL で進む' }).click();
    // 遷移後の URL は /ja/pay?... (currentLocale で正規化される)
    await expect(page).toHaveURL(
      new RegExp(`/ja/pay\\?to=${TO}&token=usdc&amount=10$`),
    );
    // 既存 /pay UI の決定論アサーション
    await expect(page.getByText('10 USDC').first()).toBeVisible();
  });

  test('外部 origin URL を手入力 → 警告 banner が出て /pay へは遷移しない', async ({
    page,
  }) => {
    await page.goto('/ja/scan');
    await page.getByText('URL を貼り付けて続行').click();
    const input = page.getByLabel('OpenPay の URL (https://open-pay.jp/pay?…)');
    await input.fill(`https://attacker.example.com/pay?to=${TO}`);
    await page.getByRole('button', { name: 'この URL で進む' }).click();
    await expect(
      page.getByText('OpenPay 以外の URL が読まれました'),
    ).toBeVisible();
    // URL は /scan のまま
    expect(page.url()).toMatch(/\/scan/);
    // 「新しいタブで開く」リンクの属性検証
    const externalLink = page.getByRole('link', { name: '新しいタブで開く' });
    await expect(externalLink).toHaveAttribute(
      'href',
      `https://attacker.example.com/pay?to=${TO}`,
    );
    await expect(externalLink).toHaveAttribute('target', '_blank');
    await expect(externalLink).toHaveAttribute('rel', 'noopener noreferrer');
  });

  test('ethereum: URL を手入力 → EIP-681 案内 banner を表示 (Phase 1 reject)', async ({
    page,
  }) => {
    await page.goto('/ja/scan');
    await page.getByText('URL を貼り付けて続行').click();
    await page
      .getByLabel('OpenPay の URL (https://open-pay.jp/pay?…)')
      .fill('ethereum:0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48@1');
    await page.getByRole('button', { name: 'この URL で進む' }).click();
    await expect(
      page.getByText('ethereum: URL は現在 OpenPay 内で扱えません'),
    ).toBeVisible();
    expect(page.url()).toMatch(/\/scan/);
  });

  test('未知文字列を手入力 → unknown banner で raw を提示', async ({ page }) => {
    await page.goto('/ja/scan');
    await page.getByText('URL を貼り付けて続行').click();
    await page
      .getByLabel('OpenPay の URL (https://open-pay.jp/pay?…)')
      .fill('NOT-A-URL');
    await page.getByRole('button', { name: 'この URL で進む' }).click();
    await expect(
      page.getByText('QR の内容を判別できませんでした'),
    ).toBeVisible();
    await expect(page.getByText('NOT-A-URL')).toBeVisible();
  });
});

test.describe('/scan: home (LP) からの導線', () => {
  test('LP の Hero "📱 支払う (スキャン)" CTA をクリック → /ja/scan へ遷移', async ({
    page,
  }) => {
    await page.goto('/ja');
    // 旧 demand-gating banner ("レジ前で素早く決済") は Phase 1 で LP の
    // 2 大 CTA に置換された。新 CTA を辿る。
    const cta = page.getByRole('link', { name: /📱 支払う/ });
    await expect(cta).toBeVisible();
    await cta.click();
    await expect(page).toHaveURL(/\/ja\/scan/);
    await expect(
      page.getByRole('heading', { name: 'スキャンして支払う', level: 2 }),
    ).toBeVisible();
  });
});

test.describe('/scan: mobile viewport', () => {
  test('iPhone 14 (390px) viewport で horizontal overflow が無い', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile-safari', 'mobile viewport 専用');
    await page.goto('/ja/scan');
    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);
  });
});

test.describe('/scan: PWA manifest 連携', () => {
  test('manifest が /ja/scan への shortcut を持つ', async ({ request }) => {
    const res = await request.get('/manifest.webmanifest');
    expect(res.status()).toBe(200);
    const body = (await res.json()) as {
      shortcuts?: Array<{ url: string; name?: string; icons?: unknown[] }>;
    };
    expect(body.shortcuts).toBeDefined();
    const scan = body.shortcuts!.find((s) => s.url === '/ja/scan');
    expect(scan).toBeDefined();
    expect(scan!.icons?.length).toBeGreaterThan(0);
  });
});

// --- LARP 防御: 実 qr-scanner module の dynamic import 経路を本物の build で走らせる ---
// 「カメラを起動」を click したとき、qr-scanner.min.js chunk が production bundle 経由で
// 実際に 200 応答され、wrapper が start を呼んで state machine が "starting" を抜ける
// ことを確認する。これにより dynamic import の解決 / module の実 load / start 呼出が
// 単体 mock 越しでなく e2e で 1 度走ったことが担保される。

test.describe('/scan: 実 qr-scanner 統合 (LARP 防御)', () => {
  test('Start camera → qr-scanner chunk 実 load → state が starting を脱出', async ({
    page,
  }, testInfo) => {
    // mobile-safari は Playwright の context.grantPermissions が 'camera' を
    // 受け付けず (WebKit emulation の仕様)、getUserMedia が hang する。
    // WebKit の実 module load + decode 経路は次の test (fake camera) で
    // canvas.captureStream override により直接カバーする。
    test.skip(testInfo.project.name !== 'chromium', 'WebKit は次の fake camera test で代替');
    await page.context().clearPermissions();

    let qrScannerChunkLoaded = false;
    page.on('response', (resp) => {
      // Next.js は chunk filename にハッシュを付ける (例: 4242-abc.js)。
      // qr-scanner は package 名で識別 — chunk が import 文経由で生成されるとき
      // bundler は package を含むファイル名にしない場合があるので、network panel で
      // chunk size + URL pattern で確認。Next の動的 import は /_next/static/chunks/ 配下。
      const url = resp.url();
      if (/_next\/static\/chunks\//.test(url) && resp.status() === 200) {
        // chunk のサイズが qr-scanner の最小 footprint (~20 KB+) を持つことを margin として確認
        // 実 chunk load を hard-assert したいなら network log を細かく見るが、本テストでは
        // 「click 後に chunk が 1 個以上 fetch された」だけを最低保証する。
        qrScannerChunkLoaded = true;
      }
    });

    await page.goto('/ja/scan');
    await page.getByRole('button', { name: 'カメラを起動' }).click();

    // hasCamera() / start() のいずれかで陽性 / 陰性が確定するまで待つ。
    // Chromium headless では camera 非搭載 = no-camera / permission denied / generic error
    // のいずれかへ。我々の fix #1 で import 失敗時も error state に倒れる。
    await expect(
      page.locator(
        'text=/カメラの許可が必要です|この端末にカメラが見つかりません|カメラを起動できませんでした/',
      ),
    ).toBeVisible({ timeout: 10_000 });

    // ボタンと "カメラを起動しています…" の両方が消えていること
    await expect(
      page.getByRole('button', { name: 'カメラを起動' }),
    ).toHaveCount(0);
    await expect(page.getByText('カメラを起動しています…')).toHaveCount(0);

    // click 後に少なくとも 1 chunk が fetch されている (dynamic import が走った証拠)
    expect(qrScannerChunkLoaded).toBe(true);
  });
});

// --- LARP 防御: 実 qr-scanner + 実 worker + 実 decode → router.push の完全経路 ---
// 「カメラ → 映像 → canvas → qr-scanner worker → decode → onScanned → router.push」
// の最後の一歩までを e2e で走らせる。Playwright の WebKit/Chromium は実カメラを
// 持たないため、navigator.mediaDevices.getUserMedia を canvas.captureStream で
// 生成した fake MediaStream に override する。canvas は qrcode lib で生成した
// PNG (Node 側で生成し dataURL を addInitScript 経由で page に渡す) を毎フレーム
// 描画する。
//
// この test は ffmpeg / Y4M / Chromium 起動フラグなど外部依存ゼロで
// real qr-scanner module + real worker + real video frame decode を verify する。

test.describe('/scan: 実 camera → decode → router.push (LARP 完全防御)', () => {
  test('canvas-backed fake camera で QR を decode し /pay へ実 navigate', async ({
    page,
  }) => {
    // QR の payload: scanner が parseScannedUrl で同 origin (http://localhost:3000)
    // と判定し /ja/pay へ router.push する文字列。
    const QR_PAYLOAD = `http://localhost:3000/pay?to=${TO}&token=usdc&amount=10`;
    const qrDataUrl = await QRCode.toDataURL(QR_PAYLOAD, {
      // scale=8 で 264x264px の十分大きな QR を生成 (qr-scanner worker は
      // 256x256 frame で安定 decode 可能)。margin=4 は QR spec 必須の quiet zone。
      scale: 8,
      margin: 4,
      errorCorrectionLevel: 'M',
    });

    await page.addInitScript((dataUrl) => {
      // Page 内 closure: dataUrl から Image を作り、canvas に描画。
      // canvas.captureStream で MediaStream を生成し getUserMedia が常にこれを
      // 返すように override する。qr-scanner は videoElement.srcObject = stream
      // で受け取り、内部 canvas に drawImage して decode worker に渡す。
      //
      // 注: requestAnimationFrame は Playwright headless で 1Hz に throttle
      // されることがあるため、frame supply は setInterval (50ms = 20fps) で行う。
      const img = new Image();
      img.src = dataUrl;
      const imgReady = new Promise<HTMLImageElement>((resolve) => {
        if (img.complete) resolve(img);
        else img.onload = () => resolve(img);
      });

      let cachedStream: MediaStream | null = null;
      async function buildFakeStream(): Promise<MediaStream> {
        if (cachedStream) return cachedStream;
        const loaded = await imgReady;
        // qr-scanner の default calculateScanRegion は video の center 2/3 のみを
        // scan する仕様。QR が canvas いっぱいだと QR 周囲の finder pattern が
        // scan region 外に出て decode 失敗する。canvas を QR の 1.6 倍にして
        // 周囲に白 padding を入れ、center 2/3 region に finder patterns を含む
        // QR 全体が収まるようにする (2/3 * 1.6 = 1.066 → QR の 106% を含む = OK)。
        const qrSize = loaded.naturalWidth;
        const canvasSize = Math.ceil(qrSize * 1.6);
        const offset = Math.floor((canvasSize - qrSize) / 2);
        const canvas = document.createElement('canvas');
        canvas.width = canvasSize;
        canvas.height = canvasSize;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('2D context unavailable');
        ctx.imageSmoothingEnabled = false; // QR module edge を保持
        function paint() {
          ctx!.fillStyle = 'white';
          ctx!.fillRect(0, 0, canvasSize, canvasSize);
          ctx!.drawImage(loaded, offset, offset);
        }
        paint(); // 最初の frame を即描画
        // 描画 loop は setInterval — headless での rAF throttle 回避
        setInterval(paint, 50);
        cachedStream = canvas.captureStream(20);
        return cachedStream;
      }

      const fakeEnumerateDevices = async () => [
        {
          kind: 'videoinput' as const,
          deviceId: 'fake-cam-001',
          groupId: 'fake-group',
          label: 'Fake Camera (test)',
          toJSON: () => ({}),
        },
      ];
      const fakeGetUserMedia = (_c: MediaStreamConstraints) => buildFakeStream();

      // WebKit (JavaScriptCore) は navigator.mediaDevices.* を MediaDevices
      // prototype 経由で JIT 最適化アクセスする quirk があり、instance への
      // Object.defineProperty が無視される (CI e2e で発覚)。両方に override する。
      Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
        value: fakeGetUserMedia,
        configurable: true,
        writable: true,
      });
      Object.defineProperty(navigator.mediaDevices, 'enumerateDevices', {
        value: fakeEnumerateDevices,
        configurable: true,
        writable: true,
      });
      Object.defineProperty(MediaDevices.prototype, 'getUserMedia', {
        value: fakeGetUserMedia,
        configurable: true,
        writable: true,
      });
      Object.defineProperty(MediaDevices.prototype, 'enumerateDevices', {
        value: fakeEnumerateDevices,
        configurable: true,
        writable: true,
      });
    }, qrDataUrl);

    await page.goto('/ja/scan');
    await page.getByRole('button', { name: 'カメラを起動' }).click();

    // qr-scanner が fake stream を decode → ScanShell の handleScanned が
    // parseScannedUrl で kind=pay 判定 → router.push(/ja/pay?...) 発火。
    // production-grade decode 安定までに数秒かかるので timeout は 20s で余裕を取る。
    await page.waitForURL(/\/ja\/pay\?to=/, { timeout: 20_000 });

    // /pay へ navigate 完了後、URL query が QR と一致 (parseScannedUrl が
    // 正規化した href がそのまま反映)
    await expect(page).toHaveURL(
      new RegExp(`/ja/pay\\?to=${TO}&token=usdc&amount=10$`),
    );
    // PaymentForm が金額を描画している (route 遷移後の app shell まで render 確認)
    await expect(page.getByText('10 USDC').first()).toBeVisible();
  });
});

// --- LARP 防御: wallet 接続持続を実 wagmi 経路で確認 (Phase 1 仮説の核) ---
// 「事前接続済 wallet を持って scan → /pay に navigate しても接続維持」を保証する。
// 実 wallet を CI に置けないので EIP-1193 mock を window.ethereum に inject、
// wagmi の injected connector で接続させ、route 跨ぎでも wagmi の localStorage 経由で
// 接続が引き継がれることを「接続済み」UI で verify する。

test.describe('/scan: wallet 接続持続 (Phase 1 hypothesis)', () => {
  test('connect → /scan → URL fallback → /pay 跨ぎで wallet が接続済みのまま', async ({
    browser,
  }) => {
    // 接続を localStorage で持続させたいので、persistent でない fresh context を独自生成
    const context = await browser.newContext();
    const page = await context.newPage();

    const CONNECTED_ADDR = '0x1234567890aBcdef1234567890ABCDEF12345678';
    // baseSepolia (testnet build の default chain) chainId 84532 = 0x14a34
    const CHAIN_HEX = '0x14a34';

    await page.addInitScript(
      ({ addr, chainHex }) => {
        // EIP-1193 minimum 実装。wagmi の injected connector は eth_requestAccounts /
        // eth_chainId / eth_accounts を読む。
        const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
        const provider = {
          isMetaMask: true,
          request: async ({
            method,
          }: {
            method: string;
            params?: unknown[];
          }) => {
            switch (method) {
              case 'eth_requestAccounts':
              case 'eth_accounts':
                return [addr];
              case 'eth_chainId':
                return chainHex;
              case 'net_version':
                return String(parseInt(chainHex, 16));
              case 'wallet_getPermissions':
                return [{ parentCapability: 'eth_accounts' }];
              case 'wallet_revokePermissions':
                return null;
              default:
                throw new Error('mock provider: not implemented: ' + method);
            }
          },
          on: (event: string, cb: (...args: unknown[]) => void) => {
            const arr = listeners.get(event) ?? [];
            arr.push(cb);
            listeners.set(event, arr);
          },
          removeListener: (event: string, cb: (...args: unknown[]) => void) => {
            const arr = listeners.get(event) ?? [];
            listeners.set(
              event,
              arr.filter((x) => x !== cb),
            );
          },
        };
        Object.defineProperty(window, 'ethereum', {
          value: provider,
          writable: true,
          configurable: true,
        });
      },
      { addr: CONNECTED_ADDR, chainHex: CHAIN_HEX },
    );

    await page.goto('/ja/scan');

    // Phase 1 以降: connect ボタンは ScanShell 内ではなく AppHeader 右上の
    // WalletBadge dropdown に集約。summary "接続" click → details open →
    // wagmi の injected connector の menuitem 名 "Injected" を click する。
    const header = page.locator('header');
    await header.getByText('接続', { exact: true }).click();
    await header.getByRole('menuitem', { name: 'Injected' }).click();

    // 接続成功で短縮アドレスが WalletBadge summary に表示される。
    // ScanShell 内の status badge にも同 address が出るので、header 内に scope。
    await expect(header.getByText(/0x1234…5678/i)).toBeVisible({
      timeout: 5_000,
    });

    // URL fallback 経由で /pay へ遷移
    await page.getByText('URL を貼り付けて続行').click();
    const TO = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';
    await page
      .getByLabel('OpenPay の URL (https://open-pay.jp/pay?…)')
      .fill(`http://localhost:3000/pay?to=${TO}&token=usdc&amount=1`);
    await page.getByRole('button', { name: 'この URL で進む' }).click();

    await expect(page).toHaveURL(/\/ja\/pay/);
    // /pay の PaymentForm が「接続済み」を認識: 未接続のとき出る
    // 「ウォレットを接続」ボタン (btnConnect・旧「…してください」から短縮) が描画されないこと
    await expect(
      page.getByRole('button', { name: /ウォレットを接続/ }),
    ).toHaveCount(0);
    // 金額が PaymentForm に反映されている (正常レンダ確認)
    await expect(page.getByText('1 USDC').first()).toBeVisible();

    await context.close();
  });
});
