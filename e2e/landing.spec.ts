import { test, expect } from '@playwright/test';

test.describe('landing / (LP)', () => {
  // 2026-10-25: 5 秒で誰向けか分かるよう、ヒーローはお店向けの見出し + 主ボタン 1 つ (決済QRを作る) +
  // お店以外の方の入口 1 行 (クリエイター向け / AI・開発者向け / お客様向け)。旧「支払う / 受け取る」の 2 大 CTA は撤去。
  test('ja: Hero はお店向けの見出し・主ボタン 1 つ・お店以外の方の入口を描画する', async ({
    page,
  }) => {
    await page.goto('/ja');

    // AppHeader: logo は alt='OpenPay' の h1
    await expect(page.getByRole('heading', { name: 'OpenPay' }).first()).toBeVisible();

    // Hero leadline (h2) — お店向け。「0円〜」の条件 (通常決済) は副文に同じ文で書く。
    await expect(
      page.getByRole('heading', { name: 'お店のJPYC決済を、利用料0円から。' }),
    ).toBeVisible();
    await expect(page.getByText('お客様がガス代を払う通常決済なら、利用料は0円（モバイル注文を除く）。', { exact: false })).toBeVisible();
    await expect(
      page.getByRole('heading', { name: '売上を待たない。' }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: '人だけじゃない。AIも JPYC を使う時代へ。' }),
    ).toBeVisible();
    const agentCta = page.getByRole('link', { name: 'OpenPay Agent を試す', exact: true });
    await expect(agentCta).toBeVisible();
    await expect(agentCta).toHaveAttribute('href', '/ja/agent');
    await expect(
      page.getByRole('heading', { name: '人にも、AIにも。オープンな決済を。' }),
    ).toBeVisible();

    // 主ボタンは 1 つ (お店が最初にすること)。旧 2 大 CTA は無い。
    // 締めの節にも同じ名前のボタンがある (行動を 1 つにそろえた) ので、ヒーローの節の中で探す。
    const hero = page.locator('section').filter({ has: page.getByRole('heading', { name: 'お店のJPYC決済を、利用料0円から。' }) });
    const createCta = hero.getByRole('link', { name: '決済QRを作る（無料）' });
    await expect(createCta).toBeVisible();
    await expect(createCta).toHaveAttribute('href', '/ja/create');
    expect(await page.getByRole('link', { name: /支払う \(スキャン\)/ }).count()).toBe(0);
    // お店以外の方の入口 (ガイドの目次と同じ名前)。Store の flag で販売の節が無いときは販売のガイドへ。
    const audience = page.getByRole('navigation', { name: 'お店以外の方は' });
    await expect(audience.getByRole('link', { name: /クリエイター向け/ })).toHaveAttribute('href', /^(#lp-sell|\/ja\/guide\/store)$/);
    await expect(audience.getByRole('link', { name: /AI・開発者向け/ })).toHaveAttribute('href', '#lp-ai');
    await expect(audience.getByRole('link', { name: /お客様向け/ })).toHaveAttribute('href', '/ja/guide/pay');
  });

  // 2026-09-26: 1 行固定のビッグナンバー (en "No sign-up" 等) が狭いカードからはみ出し、
  // /en の 390px 幅で文書幅が 411px になっていた。文字サイズをカード幅に合わせる修正の回帰防止。
  test('ビッグナンバーはカードに収まり、トップに横はみ出しが無い (ja/en)', async ({ page }) => {
    for (const locale of ['ja', 'en']) {
      await page.goto(`/${locale}`);
      const result = await page.evaluate(() => {
        const focals = [...document.querySelectorAll('[data-focal]')];
        const overflowing = focals.flatMap((p) => {
          // 数字が入る枠 (文字サイズの基準 = container-type を持つ要素) を基準に測る。導入メリットはカード (li) そのもの。
          const card = p.closest('[class*="container-type"]') ?? p.closest('li');
          if (!card) return [p.textContent];
          const contentRight = card.getBoundingClientRect().right - Number.parseFloat(getComputedStyle(card).paddingRight);
          const range = document.createRange();
          range.selectNodeContents(p);
          return range.getBoundingClientRect().right > contentRight + 0.5 ? [p.textContent] : [];
        });
        const root = document.documentElement;
        return { count: focals.length, overflowing, pageOverflow: root.scrollWidth - root.clientWidth };
      });
      expect(result.count, locale).toBeGreaterThan(0);
      expect(result.overflowing, locale).toEqual([]);
      expect(result.pageOverflow, locale).toBe(0);
    }
  });

  // 接続後の表示 (plans/lp-polish-2026-09.md P4a): 前回つないだまま離れた端末には、描画前 script がヒーローより前に
  // 「あなたの OpenPay」の場所を取る。wagmi は起動時に wagmi.store を初期状態へ書き戻すので、hydration 後も
  // script の結果を保つこと (再接続できない CI でも消えない = 下の節を押し上げない) を実ブラウザで確かめる。
  test('再訪の接続者にはヒーローより前に「あなたの OpenPay」を出し、hydration 後も消さない・初めての訪問者には出さない', async ({
    page,
  }) => {
    const frame = page.locator('[data-returning]');
    // hydration の完了 = 描画前 script が外れた (script は server の HTML と hydration のときだけ描く)。
    const hydrated = () => expect(page.locator('[data-returning] > script')).toHaveCount(0);

    await page.goto('/ja');
    await hydrated();
    await expect(frame).toHaveCount(1);
    await expect(frame).toHaveAttribute('data-returning', 'no');
    await expect(page.getByRole('region', { name: 'あなたの OpenPay' })).toBeHidden();

    await page.addInitScript(() => {
      window.localStorage.setItem(
        'wagmi.store',
        JSON.stringify({ state: { connections: { __type: 'Map', value: [] }, chainId: 137, current: 'e2e-uid' }, version: 2 }),
      );
      // 表示のずれ (layout shift) を読み込みの最初から数える。
      const w = window as unknown as { __cls: number };
      w.__cls = 0;
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries() as (PerformanceEntry & { value: number; hadRecentInput: boolean })[]) {
          if (!entry.hadRecentInput) w.__cls += entry.value;
        }
      }).observe({ type: 'layout-shift', buffered: true });
    });
    await page.goto('/ja');
    const strip = page.getByRole('region', { name: 'あなたの OpenPay' });
    await expect(strip).toBeVisible();
    await expect(strip.getByRole('link', { name: '履歴' })).toHaveAttribute('href', '/ja/history');
    // hydration と再接続の試行が済んでも枠は残る (wagmi の書き戻しで消えない)。
    await hydrated();
    await page.waitForLoadState('networkidle');
    await expect(frame).toHaveAttribute('data-returning', 'yes');
    await expect(strip).toBeVisible();
    // ヒーローより前にある (1 画面目で自分の道具へ行ける)。
    const stripBox = await strip.boundingBox();
    const heroBox = await page.getByRole('heading', { name: 'お店のJPYC決済を、利用料0円から。' }).boundingBox();
    expect(stripBox && heroBox && stripBox.y < heroBox.y).toBe(true);
    // 枠が後から出入りすると、ヒーロー以下が丸ごと動いて 0.1 前後になる。最初の描画から場所を取っていれば 0。
    const cls = await page.evaluate(() => (window as unknown as { __cls: number }).__cls);
    expect(cls).toBeLessThan(0.01);
  });

  test('en: Hero と主な節の見出し・主ボタンが英語で描画される', async ({ page }) => {
    await page.goto('/en');
    await expect(
      page.getByRole('heading', { name: 'Never wait for your sales.' }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Not just people. AI uses JPYC now, too.' }),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: 'Try OpenPay Agent', exact: true })).toHaveAttribute('href', '/en/agent');
    await expect(
      page.getByRole('heading', {
        name: 'Open payments — for people and AI.',
      }),
    ).toBeVisible();
    await expect(page.getByRole('heading', { name: 'JPYC payments for your shop, from ¥0 in fees.' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Not a shop?' }).getByRole('link', { name: /For customers/ })).toHaveAttribute('href', '/en/guide/pay');
    // 締めの節にも同じ名前のボタンがあるので、ヒーローの節の中で探す。
    await expect(
      page
        .locator('section')
        .filter({ has: page.getByRole('heading', { name: 'JPYC payments for your shop, from ¥0 in fees.' }) })
        .getByRole('link', { name: 'Create a payment QR (free)' }),
    ).toHaveAttribute('href', '/en/create');
  });

  test('mobile: BottomNav に 決済/販売/マイページ が出る (P4・Store は flag 連動)', async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== 'mobile-safari',
      'BottomNav は md 未満専用',
    );
    await page.goto('/ja');
    const bottomNav = page.getByRole('navigation', { name: '画面下のメニュー' });
    await expect(bottomNav).toBeVisible();
    // ホームへの戻りは AppHeader 左上のロゴクリックに集約。Nav 1 slot 目は「決済」。
    // Store 項目は NEXT_PUBLIC_ENABLE_CREATOR_STORE 連動のため CI (flag OFF・掟 2) では
    // 出ない — 常時 3 項目だけを検証し、Store の出し分けは unit (navItems.test) が担う。
    await expect(bottomNav.getByRole('link', { name: /決済/ })).toBeVisible();
    await expect(bottomNav.getByRole('link', { name: /販売/ })).toBeVisible();
    await expect(
      bottomNav.getByRole('link', { name: /マイページ/ }),
    ).toBeVisible();
  });

  test('ja: Features セクションに 3 カード (ガスレス/マルチチェーン/ノンカストディ) が出る', async ({
    page,
  }) => {
    await page.goto('/ja');
    await expect(page.getByRole('heading', { name: 'OpenPay の特長' })).toBeVisible();
    // ガスレス特長カードの見出しは「ガス代なしでも払える」(featuresGaslessTitle)。
    await expect(page.getByRole('heading', { name: 'ガス代なしでも払える' })).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'マルチチェーン対応' }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'ノンカストディ設計' }),
    ).toBeVisible();
  });

  test('ja: HowItWorks セクションに お店の 3-step と操作の動画が出る (お客様の 3-step は外した)', async ({
    page,
  }) => {
    await page.goto('/ja');
    const howItWorks = page
      .locator('section')
      .filter({ has: page.getByRole('heading', { name: '使い方' }) });
    await expect(howItWorks).toBeVisible();
    // merchant 3 step
    await expect(howItWorks.getByText('受取ウォレットアドレスを入力')).toBeVisible();
    // step3: 画面で見せる・印刷して置く の両パターン (決済QR ガイドの受け取りの流れと同じ文・2026-10-19 user)
    await expect(howItWorks.getByText('できた QR をお客様に見せる (印刷して置いてもOK)')).toBeVisible();
    // customer 3 step はトップの読者 (お店) 向けでないので外した (2026-10-25)。支払う流れは動画の ③ と支払い方のガイド。
    expect(await howItWorks.getByText('右上の「接続」でウォレット接続').count()).toBe(0);

    // 操作の短い動画 3 本 (決済QR → レジ → お客様の支払い)。再生できるかはブラウザの動画形式の対応に左右される
    // (Playwright の Chromium は H.264 を再生しない) ので、ここでは並びと止めるボタンの有無だけを見る。
    await expect(howItWorks.getByRole('region', { name: '実際の画面で見る（スマホ）' })).toBeVisible();
    expect(
      await howItWorks.locator('video source').evaluateAll((els) => els.map((e) => e.getAttribute('src'))),
    ).toEqual(['/demo/lp-qr.mp4', '/demo/lp-register.mp4', '/demo/lp-pay.mp4']);
    await expect(howItWorks.getByText('① 決済QR で受け取る')).toBeVisible();
    await expect(howItWorks.getByText('② レジで会計する')).toBeVisible();
    await expect(howItWorks.getByText('③ お客様が支払う')).toBeVisible();
    await expect(howItWorks.getByRole('button', { name: /^動画を(止める|再生)$/ })).toBeVisible();
  });

  test('ja: FAQ-A4 は JPYC EX (jpyc.co.jp) と 受け取る (/create) のテキストリンクを含む', async ({
    page,
  }) => {
    await page.goto('/ja');
    // FAQ-Q4 を展開し、対象 <details> 要素内で link を解決する (TopNav の同名 link
    // との strict mode 衝突回避)。details は親 <li> 経由で locator を組む。
    const q4Summary = page.getByText(
      '受け取った JPYC / USDC を日本円に換金するには?',
    );
    const faqDetails = page
      .locator('details')
      .filter({ has: q4Summary });
    await q4Summary.click();
    await expect(faqDetails).toHaveAttribute('open', '');

    const jpycEx = faqDetails.getByRole('link', { name: 'JPYC EX' });
    await expect(jpycEx).toBeVisible();
    await expect(jpycEx).toHaveAttribute('href', 'https://jpyc.co.jp/');
    await expect(jpycEx).toHaveAttribute('target', '_blank');
    await expect(jpycEx).toHaveAttribute('rel', 'noopener noreferrer');

    const createLink = faqDetails.getByRole('link', {
      name: '受け取る',
      exact: true,
    });
    await expect(createLink).toHaveAttribute('href', '/ja/create');
  });

  test('ja: FAQ は <details> で default closed、click で展開される', async ({
    page,
  }) => {
    await page.goto('/ja');
    await expect(page.getByRole('heading', { name: 'よくある質問' })).toBeVisible();
    // FAQ 質問は <summary> 要素。質問文はほかの節の文と重なり得るので (getByText だと二重一致する)、
    // <summary> に限定して FAQ アコーディオンの質問を一意に取る。
    const q1 = page.locator('summary', { hasText: '本当にガス代は不要ですか?' });
    await expect(q1).toBeVisible();
    // closed 状態では answer は hidden。faqA1 の本文 (回答) に固有の一節で照合する
    // (質問文ではなく回答 body であることを担保)。
    const a1Body = page.getByText(/JPYC または USDC の残高だけで支払いを完結/);
    await expect(a1Body).toBeHidden();
    // 展開
    await q1.click();
    await expect(a1Body).toBeVisible();
  });

  test('ja: Benefits セクション — Fee「0円〜」(通常決済の条件つき) + 4 focal・宛名は章ラベル', async ({
    page,
  }) => {
    await page.goto('/ja');
    // 2026-10-25: 強みの 0 円を先頭に出す。条件 (お客様がガス代を払う通常決済) とガスレスの料率・最低額は同じカードの本文。
    // 2 枚目は 0 が並ばないよう「スマホ1つ」。店舗 / 顧客のピルは外し、章ラベル「お店向け」が宛名を持つ。
    const benefits = page
      .locator('section')
      .filter({ has: page.getByRole('heading', { name: '売上を待たない。' }) });
    await expect(benefits).toBeVisible();
    await expect(benefits.getByText('お店向け', { exact: true })).toBeVisible();
    // 4 focal text (ビッグナンバー) — Benefits section 内に scope
    await expect(benefits.getByText('0円〜', { exact: true })).toBeVisible();
    await expect(benefits.getByText('スマホ1つ', { exact: true })).toBeVisible();
    await expect(benefits.getByText('数秒', { exact: true })).toBeVisible();
    expect(await benefits.getByText('登録不要').count()).toBeGreaterThanOrEqual(1);
    // 旧 % 訴求「0.5%」と旧「0%」永続コミット文脈は撤去済 (regression fence)。「0円〜」は条件つきの開始値で、永続の約束ではない。
    expect(await benefits.getByText('0.5%', { exact: true }).count()).toBe(0);
    expect(await benefits.getByText('0%', { exact: true }).count()).toBe(0);
    // Fee カードの本文に条件とガスレスの料率・最低額 (店舗負担)
    const feeCard = benefits.locator('li').filter({ has: page.getByRole('heading', { name: '決済の利用料' }) });
    await expect(feeCard).toContainText('お客様がガス代を払う通常決済は、レジ・決済QRとも0円。');
    await expect(feeCard).toContainText('ガスレスは決済額の 1%・最低 2 JPYC（店舗負担）。モバイル注文は別料金。');
    // 4 title
    await expect(
      benefits.getByRole('heading', { name: '端末も契約も不要' }),
    ).toBeVisible();
    await expect(
      benefits.getByRole('heading', { name: '即時着金' }),
    ).toBeVisible();
    await expect(
      benefits.getByRole('heading', { name: 'お客様は会員登録なし' }),
    ).toBeVisible();
    expect(
      await benefits.getByRole('heading', { name: '手数料が安い' }).count(),
    ).toBe(0);
    expect(
      await benefits.getByRole('heading', { name: '決済手数料ゼロ' }).count(),
    ).toBe(0);
    // 店舗 / 顧客のピルは無い
    expect(await benefits.getByText('店舗', { exact: true }).count()).toBe(0);
    expect(await benefits.getByText('顧客', { exact: true }).count()).toBe(0);
  });

  test('ja: Trust セクションに GitHub link (target=_blank + rel=noopener)', async ({
    page,
  }) => {
    await page.goto('/ja');
    // SiteFooter にも同名 GitHub link があるため、Trust兼Closing section に scope する。
    // LandingTrust の link は icon + label + ↗ で SVG inline を含む。
    const trust = page
      .locator('section')
      .filter({
        has: page.getByRole('heading', {
          name: '人にも、AIにも。オープンな決済を。',
        }),
      });
    await expect(trust).toBeVisible();
    await expect(trust.getByText('オープン技術と透明性')).toBeVisible();
    const github = trust.getByRole('link', {
      name: /ソースコード \(GitHub\)/,
    });
    await expect(github).toBeVisible();
    await expect(github).toHaveAttribute(
      'href',
      'https://github.com/cipherwebllc/openpay',
    );
    await expect(github).toHaveAttribute('target', '_blank');
    await expect(github).toHaveAttribute('rel', 'noopener noreferrer');
  });

  test('ja: 料金の節 — 料金がかかる 4 つの場合 + 料金ページへの入口・応援カードは締め (@openpay_jp へ 1 link)', async ({
    page,
  }) => {
    await page.goto('/ja');
    // 料金ページ (/pricing) の冒頭と同じ 4 つの場合のカード (2026-10-12 user 裁定: 長い説明は料金ページへ)。
    const pricingSection = page
      .locator('section')
      .filter({ has: page.getByRole('heading', { level: 2, name: '料金がかかるのは、この 4 つです' }) });
    await expect(pricingSection).toBeVisible();
    await expect(pricingSection.getByRole('listitem')).toHaveCount(4);
    await expect(pricingSection.getByText(/売上は預かりません/)).toBeVisible();
    // 機能ごとの料金と計算例 (/ja/pricing) への入口 (名前 = 可視テキスト)。
    const pricing = pricingSection.getByRole('link', { name: '機能ごとの料金と計算例を見る' });
    await expect(pricing).toBeVisible();
    await expect(pricing).toHaveAttribute('href', '/ja/pricing');
    // 料金の節に応援の導線は置かない (締めへ移した)。
    await expect(pricingSection.getByRole('link', { name: /応援/ })).toHaveCount(0);

    // 応援は締めの節 (オープン技術と透明性の下) の単一の「応援プロフカード」。カード全体が @openpay_jp プロフ
    // (link-in-bio) への 1 link。a11y 名は内側の可視テキストから導出される (aria-label は付けない — 掟 8)。
    const closing = page
      .locator('section')
      .filter({ has: page.getByRole('heading', { level: 2, name: '人にも、AIにも。オープンな決済を。' }) });
    await expect(closing.getByText(/応援いただけると励みになります/)).toBeVisible();
    const card = closing.getByRole('link', { name: /@openpay_jp/ });
    await expect(card).toHaveCount(1);
    await expect(card).toHaveAttribute('href', 'https://open-pay.jp/@openpay_jp');
    await expect(card).toHaveAttribute('target', '_blank');
    await expect(card).toHaveAttribute('rel', 'noopener noreferrer');
    // カード内に @handle と CTA が見える (プロフ訴求 + 応援動線)
    await expect(card).toContainText('@openpay_jp');
    await expect(card).toContainText('応援する');
  });

  test('ja: ガイドへの入口は「使い方」の中の 4 枚 + すべてのガイド・料金の節は FAQ より前', async ({ page }) => {
    await page.goto('/ja');
    const howItWorks = page
      .locator('section')
      .filter({ has: page.getByRole('heading', { level: 2, name: '使い方' }) });
    await expect(howItWorks.getByRole('heading', { level: 3, name: 'ガイドを選ぶ' })).toBeVisible();
    // 入口はトップでここ 1 か所 (plans/lp-polish-2026-10.md P1-2)。導入前チェックリストが先頭。
    const tiles = howItWorks.getByRole('list').filter({ has: page.locator('a[href="/ja/guide/start"]') }).getByRole('link');
    await expect(tiles).toHaveCount(4);
    expect(await tiles.evaluateAll((links) => links.map((a) => a.getAttribute('href')))).toEqual([
      '/ja/guide/start',
      '/ja/guide/qr',
      '/ja/guide/shop',
      '/ja/guide/store',
    ]);
    await expect(howItWorks.getByRole('link', { name: 'すべてのガイドを見る' })).toHaveAttribute('href', '/ja/guide');

    // 料金の節は「使い方」の後・FAQ の前 (2026-10-12 user 裁定)。
    const pricingTop = (await page.getByRole('heading', { level: 2, name: '料金がかかるのは、この 4 つです' }).boundingBox())?.y;
    const faqTop = (await page.getByRole('heading', { level: 2, name: 'よくある質問' }).boundingBox())?.y;
    const howTop = (await howItWorks.getByRole('heading', { level: 2, name: '使い方' }).boundingBox())?.y;
    expect(howTop).toBeDefined();
    expect(pricingTop).toBeGreaterThan(howTop!);
    expect(faqTop).toBeGreaterThan(pricingTop!);
  });

  test('ja: モバイルオーダー訴求バナー — 画像 + 主CTA(/create?tab=mobileOrder) + お店向けガイド (/guide/shop)', async ({
    page,
  }) => {
    await page.goto('/ja');
    // バナーは mobileorder 画像で一意に特定 (見出し名でのスコープは他節と競合し得るため)。
    const banner = page
      .locator('section')
      .filter({ has: page.locator('img[src*="mobileorder"]') });
    await expect(banner).toBeVisible();
    await expect(banner.locator('img[src*="mobileorder"]')).toBeVisible();
    // 主CTA → /create?tab=mobileOrder (flag に依らず href は固定)。
    const cta = banner.getByRole('link', { name: 'モバイルオーダーを作る' });
    await expect(cta).toHaveAttribute('href', '/ja/create?tab=mobileOrder');
    // 副リンクはお店向けのガイド (サイト内)。お客様向けのガイドは /guide/shop とハブから辿る。
    const guide = banner.getByRole('link', { name: '詳しい使い方を見る' });
    await expect(guide).toHaveAttribute('href', '/ja/guide/shop');
    await expect(guide).not.toHaveAttribute('target', '_blank');
  });
});
