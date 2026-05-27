// onramp / offramp 関連 i18n キーの存在と ja/en parity を fence するテスト。
// 片方のロケールだけにキーを足して silent regression するのを防ぐ。
import { describe, it, expect } from 'vitest';
import ja from '@/messages/ja.json';
import en from '@/messages/en.json';

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

describe('i18n: Home.offramp キー (ja/en parity)', () => {
  for (const key of OFFRAMP_KEYS) {
    it(`ja.Home.offramp.${key} は非空文字列`, () => {
      const v = (ja.Home.offramp as Record<string, unknown>)[key];
      expect(typeof v).toBe('string');
      expect(v).not.toBe('');
    });

    it(`en.Home.offramp.${key} は非空文字列`, () => {
      const v = (en.Home.offramp as Record<string, unknown>)[key];
      expect(typeof v).toBe('string');
      expect(v).not.toBe('');
    });
  }

  it('Home.offramp.row は {token} placeholder を持つ', () => {
    expect(ja.Home.offramp.row).toContain('{token}');
    expect(en.Home.offramp.row).toContain('{token}');
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

  it('Home.offramp キー集合が ja と en で一致', () => {
    const jaKeys = OFFRAMP_KEYS.filter(
      (k) => k in (ja.Home.offramp as Record<string, unknown>),
    );
    const enKeys = OFFRAMP_KEYS.filter(
      (k) => k in (en.Home.offramp as Record<string, unknown>),
    );
    expect(jaKeys.sort()).toEqual(enKeys.sort());
  });
});
