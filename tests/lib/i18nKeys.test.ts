// onramp / offramp 関連 i18n キーの存在と ja/en parity を fence するテスト。
// 片方のロケールだけにキーを足して silent regression するのを防ぐ。
import { describe, it, expect } from 'vitest';
import ja from '@/messages/ja.json';
import en from '@/messages/en.json';
import { FEE_BPS_GASLESS, FEE_BPS_STANDARD } from '@/lib/fee';

const ONRAMP_KEYS = [
  'onrampCta',
  'onrampJaResidentsOnlyNote',
  'onrampJapaneseUserHint',
] as const;

const FORM_NAMESPACES = ['PaymentForm', 'TipForm', 'CheckoutForm'] as const;

const OFFRAMP_KEYS = [
  'heading',
  'subheading',
  'row',
  'hint',
  'jaResidentsOnlyNote',
  'japaneseUserHint',
] as const;

describe('i18n: smart account 互換性エラー (3 form 名前空間 × ja/en)', () => {
  // useSmartAccount の router が IncompatibleSmartAccountError を投げる時の
  // i18n key 2 種。HashPort などの MAv2 委任 EOA 対策で導入。
  const SA_KEYS = [
    'errorIncompatibleSmartAccount',
    'errorMav2Disabled',
    // Kaia + MAv2 (HashPort 等) 専用、Polygon フォールバック案内
    // (memory:project_kaia_evaluation、mav2.ts の Kaia chainId 早期 throw 経路)
    'errorMav2KaiaPolygon',
    // pristine EOA (未委任) は injected wallet で初回ガスレス委任不可
    // (useSmartAccount が standard mode 案内に倒す)
    'errorPristineNoBootstrap',
    // canonical EIP-7702 非対応 chain (Avalanche = ACP-209「7702 style」AA) で
    // 委任済み EOA を standard mode に倒す (chainSupportsCanonical7702 ガード)
    'errorChainNo7702',
    // MetaMask Smart Account ガスレスが viem 2.50 ERC-7739 非互換で一時無効
    // (standard mode 案内に倒す・useSmartAccount の metamask-7702 ガード)
    'errorMetaMaskGaslessUnavailable',
  ] as const;
  for (const ns of FORM_NAMESPACES) {
    for (const key of SA_KEYS) {
      it(`ja.${ns}.${key} は非空文字列`, () => {
        const v = (ja[ns] as Record<string, unknown>)[key];
        expect(typeof v).toBe('string');
        expect(v).not.toBe('');
      });
      it(`en.${ns}.${key} は非空文字列`, () => {
        const v = (en[ns] as Record<string, unknown>)[key];
        expect(typeof v).toBe('string');
        expect(v).not.toBe('');
      });
    }
  }
});

describe('i18n: onramp keys (3 form 名前空間 × ja/en)', () => {
  for (const ns of FORM_NAMESPACES) {
    for (const key of ONRAMP_KEYS) {
      it(`ja.${ns}.${key} は非空文字列`, () => {
        const v = (ja[ns] as Record<string, unknown>)[key];
        expect(typeof v).toBe('string');
        expect(v).not.toBe('');
      });

      it(`en.${ns}.${key} は非空文字列`, () => {
        const v = (en[ns] as Record<string, unknown>)[key];
        expect(typeof v).toBe('string');
        expect(v).not.toBe('');
      });
    }

    it(`${ns}.onrampCta は {label} と {token} の placeholder を両方持つ`, () => {
      // i18n 引数 (label, token) を受ける形式が変わると runtime エラー。fence する。
      const jaText = (ja[ns] as Record<string, string>).onrampCta;
      const enText = (en[ns] as Record<string, string>).onrampCta;
      expect(jaText).toContain('{label}');
      expect(jaText).toContain('{token}');
      expect(enText).toContain('{label}');
      expect(enText).toContain('{token}');
    });
  }
});

describe('i18n: Create.offramp キー (ja/en parity)', () => {
  for (const key of OFFRAMP_KEYS) {
    it(`ja.Create.offramp.${key} は非空文字列`, () => {
      const v = (ja.Create.offramp as Record<string, unknown>)[key];
      expect(typeof v).toBe('string');
      expect(v).not.toBe('');
    });

    it(`en.Create.offramp.${key} は非空文字列`, () => {
      const v = (en.Create.offramp as Record<string, unknown>)[key];
      expect(typeof v).toBe('string');
      expect(v).not.toBe('');
    });
  }

  it('Home.offramp.row は {token} placeholder を持つ', () => {
    expect(ja.Create.offramp.row).toContain('{token}');
    expect(en.Create.offramp.row).toContain('{token}');
  });
});

describe('i18n: Privacy policy が camera 利用を開示している (法的要件)', () => {
  // /scan 機能で camera permission を要求する以上、Privacy Policy で取得情報と
  // 利用目的を明示する必要がある (APPI / GDPR 一般原則)。disclosure が脱落
  // すると regression するため fence。
  it('ja.Privacy.section1 (取得する情報) に camera / カメラ言及がある', () => {
    const body = ja.Privacy.section1.body;
    expect(body).toMatch(/カメラ|camera/i);
    expect(body).toMatch(/QR/);
  });

  it('ja.Privacy.section2 (利用目的) に「外部送信せず」「ブラウザ内のみ」の方針表明がある', () => {
    const body = ja.Privacy.section2.body;
    expect(body).toMatch(/ブラウザ内のみ|外部に送信せず/);
  });

  it('en.Privacy.section1 に camera / QR の言及がある', () => {
    const body = en.Privacy.section1.body;
    expect(body).toMatch(/camera/i);
    expect(body).toMatch(/QR/);
  });

  it('en.Privacy.section2 に "never transmitted" / "within the user\'s browser" 方針表明がある', () => {
    const body = en.Privacy.section2.body;
    expect(body).toMatch(/never transmitted|within the user's browser/i);
  });
});

describe('i18n: Scan keys (ja/en parity)', () => {
  // /scan ページ + PwaInstallHint + QrScannerSurface + ScanResultBanner で使う
  // i18n key 集合。片方の locale だけ抜けて runtime に t() が key を表示する
  // regression を fence する。
  const SCAN_KEYS = [
    'pageTitle',
    'pageSubtitle',
    'connectionTitle',
    'connectionPreHint',
    'connectionReadyHint',
    'balancesTitle',
    'balancesLoading',
    'balancesEmpty',
    'balancesPartialError',
    'scannerTitle',
    'scannerDescription',
    'cameraIdleHint',
    'startCameraButton',
    'cameraStarting',
    'permissionDeniedTitle',
    'permissionDeniedBody',
    'noCameraTitle',
    'noCameraBody',
    'genericErrorTitle',
    'manualUrlSummary',
    'manualUrlLabel',
    'manualUrlSubmit',
    'manualUrlPaste',
    'externalQrTitle',
    'externalQrBody',
    'externalQrOpen',
    'eip681Title',
    'eip681Body',
    'unknownQrTitle',
    'unknownQrBody',
    'dismissResult',
    'installHintTitle',
    'installHintIosStep1',
    'installHintIosStep2',
    'installHintIosStep3',
    'installHintAndroidPromptable',
    'installHintAndroidManual',
    'installHintAndroidButton',
    'installHintOther',
    'installHintDismiss',
  ] as const;

  for (const key of SCAN_KEYS) {
    it(`ja.Scan.${key} は非空文字列`, () => {
      const v = (ja.Scan as Record<string, unknown>)[key];
      expect(typeof v).toBe('string');
      expect(v).not.toBe('');
    });
    it(`en.Scan.${key} は非空文字列`, () => {
      const v = (en.Scan as Record<string, unknown>)[key];
      expect(typeof v).toBe('string');
      expect(v).not.toBe('');
    });
  }

  it('Scan.externalQrBody は {host} placeholder を持つ', () => {
    expect(
      (ja.Scan as unknown as Record<string, string>).externalQrBody,
    ).toContain('{host}');
    expect(
      (en.Scan as unknown as Record<string, string>).externalQrBody,
    ).toContain('{host}');
  });

  it('Scan.homeCta は title / body / button を ja/en 両方で持つ (空でない)', () => {
    for (const cta of [
      (ja.Scan as { homeCta: Record<string, string> }).homeCta,
      (en.Scan as { homeCta: Record<string, string> }).homeCta,
    ]) {
      expect(cta.title.length).toBeGreaterThan(0);
      expect(cta.body.length).toBeGreaterThan(0);
      expect(cta.button.length).toBeGreaterThan(0);
    }
  });
});

describe('i18n: gasInfoJpyc / gasInfoUsdc は {nativeToken} placeholder を持つ (chain-aware)', () => {
  // 旧: gasInfoJpyc に "POL ガス" を hardcode していて Kaia 選択時に Polygon の
  // POL を表示してしまう bug があった (2026-05-23 production smoke で発覚)。
  // 修正後は {nativeToken} placeholder + chain.nativeCurrency.symbol で
  // Polygon=POL / Kaia=KAIA / Base/Arbitrum/Optimism=ETH を動的解決する。
  // 旧 hardcode が混入したら CI が即 fail するよう fence。
  for (const ns of FORM_NAMESPACES) {
    for (const key of ['gasInfoJpyc', 'gasInfoUsdc'] as const) {
      it(`ja.${ns}.${key} は {nativeToken} placeholder を持つ`, () => {
        const v = (ja[ns] as Record<string, string>)[key];
        expect(v).toContain('{nativeToken}');
      });
      it(`en.${ns}.${key} は {nativeToken} placeholder を持つ`, () => {
        const v = (en[ns] as Record<string, string>)[key];
        expect(v).toContain('{nativeToken}');
      });
      it(`ja.${ns}.${key} は旧 'POL' / 'ETH' を hardcode していない (regression fence)`, () => {
        const v = (ja[ns] as Record<string, string>)[key];
        // "POL ガス" / "POL を保有" / "(POL)" 等の hardcode をブロック。
        // placeholder ({nativeToken}) は OK、リテラル "POL" の単独出現を弾く。
        expect(v).not.toMatch(/\bPOL\b/);
        expect(v).not.toMatch(/\bETH\b/);
      });
      it(`en.${ns}.${key} は旧 'POL' / 'ETH' を hardcode していない (regression fence)`, () => {
        const v = (en[ns] as Record<string, string>)[key];
        expect(v).not.toMatch(/\bPOL\b/);
        expect(v).not.toMatch(/\bETH\b/);
      });
    }
  }
});

describe('i18n: ja/en 構造 parity (onramp + offramp)', () => {
  it('全 form 名前空間で onramp キー集合が ja と en で一致', () => {
    for (const ns of FORM_NAMESPACES) {
      const jaKeys = ONRAMP_KEYS.filter(
        (k) => k in (ja[ns] as Record<string, unknown>),
      );
      const enKeys = ONRAMP_KEYS.filter(
        (k) => k in (en[ns] as Record<string, unknown>),
      );
      expect(jaKeys.sort()).toEqual(enKeys.sort());
    }
  });

  it('Create.offramp キー集合が ja と en で一致', () => {
    const jaKeys = OFFRAMP_KEYS.filter(
      (k) => k in (ja.Create.offramp as Record<string, unknown>),
    );
    const enKeys = OFFRAMP_KEYS.filter(
      (k) => k in (en.Create.offramp as Record<string, unknown>),
    );
    expect(jaKeys.sort()).toEqual(enKeys.sort());
  });
});

describe('FEE_BPS_* 定数の drift fence (Phase 1: 0n)', () => {
  // Phase 1 (alpha) では FEE_BPS_* = 0n。Phase 2 で課金復活時 (定数を非 0 に戻す)
  // ここが落ち、UI コピー側の「X%」追加 / fee 関連 section の復活を同期させる強制が掛かる。
  it('両モードとも 0n', () => {
    expect(FEE_BPS_STANDARD).toBe(0n);
    expect(FEE_BPS_GASLESS).toBe(0n);
  });
});

describe('i18n: Market 名前空間 (LP / Create の strip, ja/en parity)', () => {
  const MARKET_KEYS = [
    'title',
    'loading',
    'usdcRate',
    'jpycPeg',
    'referenceNote',
    'unavailable',
  ] as const;
  for (const key of MARKET_KEYS) {
    it(`ja.Market.${key} は非空文字列`, () => {
      const v = (ja.Market as Record<string, unknown>)[key];
      expect(typeof v).toBe('string');
      expect(v).not.toBe('');
    });
    it(`en.Market.${key} は非空文字列`, () => {
      const v = (en.Market as Record<string, unknown>)[key];
      expect(typeof v).toBe('string');
      expect(v).not.toBe('');
    });
  }
  it('Market.usdcRate は {rate} placeholder を持つ', () => {
    expect((ja.Market as Record<string, string>).usdcRate).toContain('{rate}');
    expect((en.Market as Record<string, string>).usdcRate).toContain('{rate}');
  });
});

describe('i18n: Explore 名前空間 (ja/en parity)', () => {
  // /explore page で使う i18n key 集合。badge は nested object なので別途検証。
  const EXPLORE_KEYS = [
    'pageTitle',
    'pageDescription',
    'categoryExchange',
    'categoryExchangeDescription',
    'categoryDex',
    'categoryDexDescription',
    'categoryDapp',
    'categoryDappDescription',
    'categoryBridge',
    'categoryBridgeDescription',
    'categoryResource',
    'categoryResourceDescription',
  ] as const;
  const EXPLORE_BADGE_KEYS = ['jp-only', 'global', 'beta'] as const;

  for (const key of EXPLORE_KEYS) {
    it(`ja.Explore.${key} は非空文字列`, () => {
      const v = (ja.Explore as Record<string, unknown>)[key];
      expect(typeof v).toBe('string');
      expect(v).not.toBe('');
    });
    it(`en.Explore.${key} は非空文字列`, () => {
      const v = (en.Explore as Record<string, unknown>)[key];
      expect(typeof v).toBe('string');
      expect(v).not.toBe('');
    });
  }

  for (const key of EXPLORE_BADGE_KEYS) {
    it(`ja.Explore.badge.${key} は非空文字列`, () => {
      const v = (ja.Explore.badge as Record<string, unknown>)[key];
      expect(typeof v).toBe('string');
      expect(v).not.toBe('');
    });
    it(`en.Explore.badge.${key} は非空文字列`, () => {
      const v = (en.Explore.badge as Record<string, unknown>)[key];
      expect(typeof v).toBe('string');
      expect(v).not.toBe('');
    });
  }
});

describe('i18n: Nav / Landing 名前空間 (AppShell + LP, ja/en parity)', () => {
  // AppShell の BottomNav / TopNav (4 link) と LP 2 大 CTA で使う i18n key 集合。
  // 片方の locale だけ抜けて regression するのを fence する。
  const NAV_KEYS = [
    'scan',
    'create',
    'history',
    'explore',
    'connect',
    'disconnect',
  ] as const;
  const LANDING_KEYS = [
    'tagline',
    'heroLeadline',
    'heroBody',
    'heroVisualAlt',
    'ctaScanTitle',
    'ctaScanBody',
    'ctaScanButton',
    'ctaCreateTitle',
    'ctaCreateBody',
    'ctaCreateButton',
    'wipNote',
    // Features section (3 cards)
    'featuresTitle',
    'featuresSubtitle',
    'featuresGaslessTitle',
    'featuresGaslessBody',
    'featuresMultichainTitle',
    'featuresMultichainBody',
    'featuresNoncustodyTitle',
    'featuresNoncustodyBody',
    // HowItWorks (merchant + customer, 3 steps each)
    'howItWorksTitle',
    'howItWorksSubtitle',
    'howItWorksVisualAlt',
    'howItWorksMerchantTitle',
    'howItWorksMerchantStep1',
    'howItWorksMerchantStep2',
    'howItWorksMerchantStep3',
    'howItWorksCustomerTitle',
    'howItWorksCustomerStep1',
    'howItWorksCustomerStep2',
    'howItWorksCustomerStep3',
    // FAQ (6 Q/A pairs — Q6/A6 は Phase 1 で「OpenPay の手数料はいくらか」を追加)
    'faqTitle',
    'faqQ1',
    'faqA1',
    'faqQ2',
    'faqA2',
    'faqQ3',
    'faqA3',
    'faqQ4',
    'faqA4',
    'faqQ5',
    'faqA5',
    'faqQ6',
    'faqA6',
    // Trust section
    'trustTitle',
    'trustBody',
    'trustGithubLabel',
    // Support / 利用料 section (FAQ 下、Tip widget 埋め込み)
    'supportTitle',
    'supportBody',
    'supportTipRequest',
    'supportTipButton',
    'supportTipJpycPolygon',
    'supportTipJpycKaia',
    'supportTipUsdc',
    // Benefits section (4 cards × {focal, title, body} + section meta)。Phase 1 で
    // Fee カードは「永久に取引額連動の手数料を取らない」永続コミットメントとして
    // focal="0%" に再構成 (旧 focal="0.5%" の規制論的に危うい % 訴求は撤去)。
    'benefitsTitle',
    'benefitsSubtitle',
    'benefitsAudienceMerchant',
    'benefitsAudienceCustomer',
    'benefitsFeeFocal',
    'benefitsFeeTitle',
    'benefitsFeeBody',
    'benefitsCostFocal',
    'benefitsCostTitle',
    'benefitsCostBody',
    'benefitsSettlementFocal',
    'benefitsSettlementTitle',
    'benefitsSettlementBody',
    'benefitsNoSignupFocal',
    'benefitsNoSignupTitle',
    'benefitsNoSignupBody',
    // Use cases section (5 用途 × {title, body} + meta)
    'useCasesTitle',
    'useCasesSubtitle',
    'useCase1Title',
    'useCase1Body',
    'useCase1ImageAlt',
    'useCase2Title',
    'useCase2Body',
    'useCase2ImageAlt',
    'useCase3Title',
    'useCase3Body',
    'useCase3ImageAlt',
    'useCase4Title',
    'useCase4Body',
    'useCase4ImageAlt',
    'useCase5Title',
    'useCase5Body',
    'useCase5ImageAlt',
    // Features の Gasless 技術詳細補足
    'featuresGaslessTech',
    // Trust の技術スタック補足
    'trustTechStack',
  ] as const;

  for (const key of NAV_KEYS) {
    it(`ja.Nav.${key} は非空文字列`, () => {
      const v = (ja.Nav as Record<string, unknown>)[key];
      expect(typeof v).toBe('string');
      expect(v).not.toBe('');
    });
    it(`en.Nav.${key} は非空文字列`, () => {
      const v = (en.Nav as Record<string, unknown>)[key];
      expect(typeof v).toBe('string');
      expect(v).not.toBe('');
    });
  }

  for (const key of LANDING_KEYS) {
    it(`ja.Landing.${key} は非空文字列`, () => {
      const v = (ja.Landing as Record<string, unknown>)[key];
      expect(typeof v).toBe('string');
      expect(v).not.toBe('');
    });
    it(`en.Landing.${key} は非空文字列`, () => {
      const v = (en.Landing as Record<string, unknown>)[key];
      expect(typeof v).toBe('string');
      expect(v).not.toBe('');
    });
  }
});

describe('i18n: Circle Paymaster の gas help text (provider 次元・C4)', () => {
  // PaymentForm / CheckoutForm は circle 経路で gasInfoUsdcCircle を表示する
  // (gasInfoUsdc は Pimlico 名を含むため流用すると prose が不正確になる)。
  const CIRCLE_FORMS = ['PaymentForm', 'CheckoutForm'] as const;

  it.each(CIRCLE_FORMS)('%s.gasInfoUsdcCircle が ja/en 両方に存在する', (ns) => {
    const j = (ja[ns] as Record<string, unknown>).gasInfoUsdcCircle;
    const e = (en[ns] as Record<string, unknown>).gasInfoUsdcCircle;
    expect(typeof j).toBe('string');
    expect(typeof e).toBe('string');
    expect((j as string).length).toBeGreaterThan(0);
    expect((e as string).length).toBeGreaterThan(0);
  });

  it.each(CIRCLE_FORMS)(
    '%s.gasInfoUsdcCircle は Circle を明示し Pimlico を含まない',
    (ns) => {
      for (const loc of [ja, en]) {
        const text = (loc[ns] as Record<string, string>).gasInfoUsdcCircle;
        expect(text).toMatch(/Circle/);
        expect(text).not.toMatch(/Pimlico/);
        // {nativeToken} placeholder を保持 (chain-aware)
        expect(text).toContain('{nativeToken}');
      }
    },
  );

  it('当社徴収0 を ja/en で明示する (paymasterMode=erc20 の真正性)', () => {
    expect(ja.PaymentForm.gasInfoUsdcCircle).toMatch(/徴収しません/);
    expect(en.PaymentForm.gasInfoUsdcCircle).toMatch(/does not collect/i);
  });
});
