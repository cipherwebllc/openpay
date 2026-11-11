// onramp / offramp 関連 i18n キーの存在と ja/en parity を fence するテスト。
// 片方のロケールだけにキーを足して silent regression するのを防ぐ。
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ja from '@/messages/ja.json';
import en from '@/messages/en.json';
import { FEE_BPS_GASLESS, FEE_BPS_STANDARD } from '@/lib/fee';

const ONRAMP_KEYS = [
  'onrampCta',
  'onrampJaResidentsOnlyNote',
  'onrampJapaneseUserHint',
] as const;

const FORM_NAMESPACES = ['PaymentForm', 'TipForm', 'CheckoutForm'] as const;

describe('retired checkout generator messages', () => {
  it.each(['ja', 'en'] as const)('%s keeps the live checkout namespace without retired generator copy', (locale) => {
    const messages = { ja, en }[locale];
    expect(messages).toHaveProperty('CheckoutForm');
    expect(messages).not.toHaveProperty('CheckoutLinkGenerator');
  });
});

describe('Privacy: x402 retention disclosure', () => {
  it('Privacy.section4 declares 400 days in both locales (not Terms.section4)', () => {
    expect(ja.Privacy.section4.body).toContain('x402 決済の記録 (買い手・受取先のウォレットアドレス、商品 URL、金額と利用料、チェーン、取引ハッシュ、日時) は最後の記録から 400 日間保管');
    expect(en.Privacy.section4.body).toContain('Records of x402 payments (buyer and payee wallet addresses, product URL, amount and fee, chain, transaction hash, and date/time) are retained for 400 days from the last record');
    expect(deepKeys(ja.Privacy).sort()).toEqual(deepKeys(en.Privacy).sort());
  });
});

const OFFRAMP_KEYS = [
  'heading',
  'subheading',
  'row',
  'hint',
  'jaResidentsOnlyNote',
  'japaneseUserHint',
] as const;

function deepKeys(value: unknown, prefix = ''): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return [prefix];
  }
  return Object.entries(value as Record<string, unknown>).flatMap(
    ([key, nested]) =>
      deepKeys(nested, prefix ? `${prefix}.${key}` : key),
  );
}

describe('i18n: Creator Store namespace の完全 parity', () => {
  it.each(
    [
      'CreatorStoreSeller',
      'CreatorStoreLicense',
      'CreatorStorefront',
      'CreatorStorePurchase',
      'CreatorStoreLibrary',
      'CreatorStoreSellerDisclosure',
    ] as const,
  )(
    'ja/en の %s deep key 集合が一致する',
    (namespace) => {
      expect(deepKeys(ja[namespace]).sort()).toEqual(
        deepKeys(en[namespace]).sort(),
      );
    },
  );
});

describe('i18n: Landing namespace の全キー parity', () => {
  it('ja.Landing と en.Landing のキー集合が完全一致', () => {
    expect(Object.keys(ja.Landing).sort()).toEqual(
      Object.keys(en.Landing).sort(),
    );
  });
});

// ガイドのハブ (/guide) への入口 (フッター・/create の用途別ガイド)。Footer は全ページ共通の
// SHARED namespace で、Create は namespace 全体の parity を持たないので、ここで個別に縛る。
describe('i18n: Footer と Create.guideLinks の ja/en parity', () => {
  it('ja.Footer と en.Footer の deep key 集合が一致', () => {
    expect(deepKeys(ja.Footer).sort()).toEqual(deepKeys(en.Footer).sort());
  });

  it('ja.Create.guideLinks と en.Create.guideLinks のキー集合が一致し、値はすべて非空', () => {
    expect(Object.keys(ja.Create.guideLinks).sort()).toEqual(
      Object.keys(en.Create.guideLinks).sort(),
    );
    for (const m of [ja, en]) {
      for (const value of Object.values(m.Create.guideLinks)) {
        expect(typeof value).toBe('string');
        expect(value).not.toBe('');
      }
    }
  });
});

// 特商法表記 (Tokutei) は rows の各 {label, value} に加え、役務の対価の下に料金ページ (/pricing) への
// 1 行 (priceSeeAlso・t.rich の <link>) を持つ。片方のロケールだけに足す/消すのを防ぐ。
describe('i18n: Tokutei の ja/en parity', () => {
  it('ja.Tokutei と en.Tokutei の deep key 集合が一致', () => {
    expect(deepKeys(ja.Tokutei).sort()).toEqual(deepKeys(en.Tokutei).sort());
  });

  it('priceSeeAlso は ja/en とも <link>…</link> をちょうど 1 つ持つ', () => {
    for (const m of [ja, en]) {
      expect(m.Tokutei.priceSeeAlso.match(/<link>[^<]+<\/link>/g)).toHaveLength(1);
    }
  });
});

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

// 確認中の支払いを送り直す前に端末へ保存できないときの本文 (user 承認済みの文・2026-11-11)。3 フォームの
// namespace だけに ja/en 同じ文で入る (同名の key が複数の namespace にあるので、入った先を namespace ごとに確かめる)。
// /pay・/checkout は確認中のあいだ通常送信も閉じている (/tip は経路ごとの止めで、通常送信は閉じない)。どの画面でも、
// この文は通常送信を案内しない。
describe('i18n: pendingStoreUnavailableResendBody (3 form 名前空間 × ja/en)', () => {
  const KEY = 'pendingStoreUnavailableResendBody';
  const TEXT = {
    ja: 'この端末では支払い記録を保存できないため、確認中の支払いを送り直せません。着金通知・受注画面でご確認ください。',
    en: "This device can't save payment records, so the pending payment can't be re-sent. Please check the payment notification or order screen.",
  } as const;
  it.each(['ja', 'en'] as const)('%s: 3 フォームの namespace だけにあり、承認済みの文と一致する', (locale) => {
    const messages = { ja, en }[locale] as Record<string, unknown>;
    const holders = Object.entries(messages)
      .filter(([, value]) => typeof value === 'object' && value !== null && KEY in value)
      .map(([ns]) => ns);
    expect(holders.sort()).toEqual([...FORM_NAMESPACES].sort());
    for (const ns of FORM_NAMESPACES) {
      expect((messages[ns] as Record<string, unknown>)[KEY]).toBe(TEXT[locale]);
    }
  });
  it.each(['ja', 'en'] as const)('%s: 通常送信を案内しない (保存できないだけのときの本文とは別の文)', (locale) => {
    const messages = { ja, en }[locale];
    for (const ns of FORM_NAMESPACES) {
      const form = messages[ns] as Record<string, string>;
      expect(form[KEY]).not.toMatch(/通常送信|standard payment/);
      expect(form.pendingStoreUnavailableBody).toMatch(/通常送信をご利用ください|use standard payment instead/);
    }
  });
});

// errorMetaMaskKaia は Kaia で MetaMask Smart Account を断るときの文。MetaMask Smart Account のガスレスは
// 止めている (NEXT_PUBLIC_ENABLE_METAMASK_SMART_ACCOUNT は既定 OFF・同じ namespace の
// errorMetaMaskGaslessUnavailable が「現在ご利用いただけません」と書く) ので、ほかのチェーンで使えるとは書かない。
// 同名の key が 3 フォームの namespace にあるので、namespace ごとに確かめる。
describe('i18n: errorMetaMaskKaia (3 form 名前空間 × ja/en)', () => {
  const KEY = 'errorMetaMaskKaia';
  it.each(['ja', 'en'] as const)('%s: 3 フォームの namespace だけにあり、Kaia のほかのチェーンの名前を出さない', (locale) => {
    const messages = { ja, en }[locale] as Record<string, unknown>;
    const holders = Object.entries(messages)
      .filter(([, value]) => typeof value === 'object' && value !== null && KEY in value)
      .map(([ns]) => ns);
    expect(holders.sort()).toEqual([...FORM_NAMESPACES].sort());
    for (const ns of FORM_NAMESPACES) {
      const text = (messages[ns] as Record<string, unknown>)[KEY];
      expect(typeof text).toBe('string');
      expect(text).toContain('Kaia');
      expect(text).not.toMatch(/\b(Polygon|Base|Arbitrum|Optimism|Ethereum|Avalanche|Arc)\b/);
      expect(text).not.toMatch(/gasless|ガスレス/i);
    }
  });
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

describe('i18n: 受取先「接続ウォレットで初期化」キー (3 namespace × ja/en parity)', () => {
  // QR / レジ / Tip の各 namespace に同じ 2 キー (useConnectedWallet / receiverMatchesWallet)。
  const NS = ['QrGenerator', 'RegisterMode', 'TipEmbedGenerator'] as const;
  const KEYS = ['useConnectedWallet', 'receiverMatchesWallet'] as const;
  for (const ns of NS) {
    for (const key of KEYS) {
      it(`ja/en の ${ns}.${key} は非空文字列`, () => {
        for (const m of [ja, en]) {
          const v = (m[ns] as Record<string, unknown>)[key];
          expect(typeof v).toBe('string');
          expect(v).not.toBe('');
        }
      });
    }
  }
});

describe('i18n: 取引履歴の受取/支払い統合キー (ja/en parity)', () => {
  // 種別フィルタ/バッジ (History) + /scan→/history 導線 (PayerReceipt)。
  const HISTORY_KEYS = [
    'filterDirectionLabel',
    'filterDirectionAll',
    'filterDirectionIn',
    'filterDirectionOut',
    'directionInBadge',
    'directionOutBadge',
    'summaryReceivedOnlyNote',
  ] as const;
  for (const key of HISTORY_KEYS) {
    it(`ja/en の History.${key} は非空文字列`, () => {
      for (const m of [ja, en]) {
        const v = (m.History as Record<string, unknown>)[key];
        expect(typeof v).toBe('string');
        expect(v).not.toBe('');
      }
    });
  }
  it('ja/en の PayerReceipt.historyLink は非空文字列', () => {
    for (const m of [ja, en]) {
      const v = (m.PayerReceipt as Record<string, unknown>).historyLink;
      expect(typeof v).toBe('string');
      expect(v).not.toBe('');
    }
  });
  // count 付きラベルは {count} placeholder を持つ。
  it('filterDirection* は {count} placeholder を持つ', () => {
    for (const m of [ja, en]) {
      const h = m.History as Record<string, string>;
      expect(h.filterDirectionAll).toContain('{count}');
      expect(h.filterDirectionIn).toContain('{count}');
      expect(h.filterDirectionOut).toContain('{count}');
    }
  });
});

describe('i18n: Create.tabs キー (ja/en parity)', () => {
  // タブラベルは短縮済 (決済QR/レジ/チップ) で 3 タブ分必要。
  const TAB_KEYS = ['qr', 'register', 'tip'] as const;
  for (const key of TAB_KEYS) {
    it(`ja/en の Create.tabs.${key} は非空文字列`, () => {
      for (const m of [ja, en]) {
        const tabs = m.Create.tabs as Record<string, unknown>;
        expect(typeof tabs[key]).toBe('string');
        expect(tabs[key]).not.toBe('');
      }
    });
  }

  // タブ下の説明 (tabDesc) は撤去済み (タブ名で用途が分かる・2026-10 決済QR/レジ磨き上げ P1)。
  it('ja/en とも Create.tabDesc を持たない (撤去した説明の行を戻さない)', () => {
    for (const m of [ja, en]) {
      expect((m.Create as Record<string, unknown>).tabDesc).toBeUndefined();
    }
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

describe('i18n: 非公開 tip message の namespace / privacy disclosure', () => {
  const SEND_KEYS = [
    'privateTipMessageLabel',
    'privateTipMessagePlaceholder',
    'privateTipMessagePrivacy',
    'privateTipMessageMinimum',
  ] as const;
  const RECEIVE_KEYS = [
    'tipInboxTitle',
    'tipInboxDescription',
    'tipInboxSignInCta',
    'tipInboxLoading',
    'tipInboxError',
    'tipInboxRetry',
    'tipInboxEmpty',
    'tipInboxAmount',
    'tipInboxFrom',
    'tipInboxDeleteAll',
    'tipInboxDeleting',
    'tipInboxDeleteError',
  ] as const;

  it('送信文言は TipForm、受信文言は TipEmbedGenerator に ja/en 同じキーで入る', () => {
    for (const messages of [ja, en]) {
      for (const key of SEND_KEYS) {
        expect(typeof messages.TipForm[key]).toBe('string');
        expect(messages.TipForm[key]).not.toBe('');
        expect(
          (messages.TipEmbedGenerator as Record<string, unknown>)[key],
        ).toBeUndefined();
      }
      for (const key of RECEIVE_KEYS) {
        expect(typeof messages.TipEmbedGenerator[key]).toBe('string');
        expect(messages.TipEmbedGenerator[key]).not.toBe('');
        expect(
          (messages.TipForm as Record<string, unknown>)[key],
        ).toBeUndefined();
      }
    }
    expect(ja.TipEmbedGenerator.tipInboxAmount).toContain('{amount}');
    expect(en.TipEmbedGenerator.tipInboxAmount).toContain('{amount}');
    expect(ja.TipEmbedGenerator.tipInboxFrom).toContain('{address}');
    expect(en.TipEmbedGenerator.tipInboxFrom).toContain('{address}');
  });

  it('Privacy draft は取得項目・受取人表示目的・非公開・最長180日・全削除を ja/en で開示する', () => {
    const jaBody = [
      ja.Privacy.section1.body,
      ja.Privacy.section2.body,
      ja.Privacy.section4.body,
    ].join(' ');
    expect(jaBody).toMatch(/メッセージ本文/);
    expect(jaBody).toMatch(/送信元・受取先ウォレットアドレス/);
    expect(jaBody).toMatch(/金額.*チェーン ID.*トランザクションハッシュ.*送信日時/);
    expect(jaBody).toMatch(/受取人本人.*表示/);
    expect(jaBody).toMatch(/公開しません/);
    expect(jaBody).toMatch(/最長 180 日/);
    expect(jaBody).toMatch(/すべて削除/);

    const enBody = [
      en.Privacy.section1.body,
      en.Privacy.section2.body,
      en.Privacy.section4.body,
    ].join(' ');
    expect(enBody).toMatch(/message body/i);
    expect(enBody).toMatch(/sender and recipient wallet addresses/i);
    expect(enBody).toMatch(/amount.*chain ID.*transaction hash.*sent time/i);
    expect(enBody).toMatch(/display the message to the tip recipient/i);
    expect(enBody).toMatch(/not made public|do not make it public/i);
    expect(enBody).toMatch(/up to 180 days/i);
    expect(enBody).toMatch(/Delete all/i);
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
    'balancesFailedItem',
    'balancesRetry',
    'balancesRetrying',
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
    // F7: 同 origin checkout/tip でも callback が第三者ホストのときの interstitial 文言。
    'callbackWarnTitle',
    'callbackWarnBody',
    'callbackWarnContinue',
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

describe('i18n: JPYC EIP-3009 relay keys (PaymentForm × ja/en parity)', () => {
  // relay 経路 (eip3009-relay) のガス表示 + error コード→friendly 文言。flag-gate された
  // 機能なので片 locale 抜けが silent regression しやすい。非空 + parity を fence する。
  const RELAY_KEYS = [
    'gasInfoJpycRelay',
    'gasRowRelayFree',
    'gaslessBatchHintJpycRelay',
    'gasInfoJpycRecover',
    'gaslessBatchHintJpycRecover',
    'errorRelayRateLimited',
    'errorRelayNotConfigured',
    'errorRelayInsufficientBalance',
    'errorRelayGeneric',
    'pendingTitle',
    'pendingBody',
    'pendingExplorerLink',
  ] as const;
  for (const key of RELAY_KEYS) {
    it(`ja.PaymentForm.${key} は非空文字列`, () => {
      const v = (ja.PaymentForm as Record<string, unknown>)[key];
      expect(typeof v).toBe('string');
      expect(v).not.toBe('');
    });
    it(`en.PaymentForm.${key} は非空文字列`, () => {
      const v = (en.PaymentForm as Record<string, unknown>)[key];
      expect(typeof v).toBe('string');
      expect(v).not.toBe('');
    });
  }

  // CheckoutForm (/checkout・簡易レジ) も同じ relay 経路を持つ。hint キーは CheckoutForm の
  // 命名規則 (gaslessHintJpyc*) に合わせる (PaymentForm は gaslessBatchHintJpyc*)。
  const CHECKOUT_RELAY_KEYS = [
    'gasInfoJpycRelay',
    'gasRowRelayFree',
    'gaslessHintJpycRelay',
    'gasInfoJpycRecover',
    'gaslessHintJpycRecover',
    'errorRelayRateLimited',
    'errorRelayNotConfigured',
    'errorRelayInsufficientBalance',
    'errorRelayGeneric',
    'pendingTitle',
    'pendingBody',
    'pendingExplorerLink',
  ] as const;
  for (const key of CHECKOUT_RELAY_KEYS) {
    it(`ja.CheckoutForm.${key} は非空文字列`, () => {
      const v = (ja.CheckoutForm as Record<string, unknown>)[key];
      expect(typeof v).toBe('string');
      expect(v).not.toBe('');
    });
    it(`en.CheckoutForm.${key} は非空文字列`, () => {
      const v = (en.CheckoutForm as Record<string, unknown>)[key];
      expect(typeof v).toBe('string');
      expect(v).not.toBe('');
    });
  }

  // relay の未確定 (pending) を履歴で示す status バッジ (HistoryRow / MiniHistoryRecent)。
  for (const loc of [
    { name: 'ja', m: ja },
    { name: 'en', m: en },
  ] as const) {
    it(`${loc.name}.History.statusPending は非空文字列`, () => {
      const v = (loc.m.History as Record<string, unknown>).statusPending;
      expect(typeof v).toBe('string');
      expect(v).not.toBe('');
    });
  }

  // B1 Layer B: relayer 健全性プローブ (useRelayHealth) が degraded を返したとき、署名 *前* に出す
  // 事前 (preflight) banner の文言。PaymentForm + CheckoutForm が RelayFallbackBanner の message prop
  // に渡す (Layer A の errorRelay* と同じく form 名前空間)。/tip (TipForm) は対象外なので持たない。
  for (const ns of ['PaymentForm', 'CheckoutForm'] as const) {
    it(`ja.${ns}.relayDegradedPreflight は非空文字列`, () => {
      const v = (ja[ns] as Record<string, unknown>).relayDegradedPreflight;
      expect(typeof v).toBe('string');
      expect(v).not.toBe('');
    });
    it(`en.${ns}.relayDegradedPreflight は非空文字列`, () => {
      const v = (en[ns] as Record<string, unknown>).relayDegradedPreflight;
      expect(typeof v).toBe('string');
      expect(v).not.toBe('');
    });
  }
});

describe('i18n: RecoverFee 名前空間 (recover 手数料開示・共有 RecoverFeeNotice・ja/en parity)', () => {
  // QrGenerator / PaymentForm に重複していた recover 手数料ラベルを 1 つの共有名前空間へ
  // 集約 (RecoverFeeNotice が消費)。F2 で tooSmall (金額 <= 手数料の受付不可) を追加。
  const RECOVER_FEE_KEYS = [
    'disclosureGasOnly',
    'disclosurePercent',
    'splitCustomer',
    'splitMerchant',
    'tooSmall',
  ] as const;

  for (const loc of [
    { name: 'ja', m: ja },
    { name: 'en', m: en },
  ] as const) {
    for (const key of RECOVER_FEE_KEYS) {
      it(`${loc.name}.RecoverFee.${key} は非空文字列`, () => {
        const v = (loc.m.RecoverFee as Record<string, unknown>)[key];
        expect(typeof v).toBe('string');
        expect(v).not.toBe('');
      });
    }
  }

  it('キー集合が ja と en で完全一致 (構造 parity)', () => {
    expect(Object.keys(ja.RecoverFee).sort()).toEqual(
      Object.keys(en.RecoverFee).sort(),
    );
  });

  it('parameterized キーが必要な placeholder を持つ (ja/en)', () => {
    for (const m of [ja, en]) {
      const r = m.RecoverFee as Record<string, string>;
      expect(r.disclosureGasOnly).toContain('{feeHuman}');
      for (const ph of ['{feeHuman}', '{pct}', '{floorHuman}']) {
        expect(r.disclosurePercent).toContain(ph);
      }
      for (const ph of ['{customerPays}', '{merchantReceives}']) {
        expect(r.splitCustomer).toContain(ph);
        expect(r.splitMerchant).toContain(ph);
      }
      expect(r.tooSmall).toContain('{fee}');
    }
  });

  it('旧 per-namespace の recoverFee* キーは QrGenerator / PaymentForm から削除済 (移設 fence)', () => {
    // 重複の出戻りを防ぐ: 旧キーが片方の namespace に復活したら CI を赤くする。
    const OLD_KEYS = [
      'recoverFeeDisclosureGasOnly',
      'recoverFeeDisclosurePercent',
      'recoverFeeCustomer',
      'recoverFeeMerchant',
    ] as const;
    for (const m of [ja, en]) {
      for (const ns of ['QrGenerator', 'PaymentForm'] as const) {
        for (const key of OLD_KEYS) {
          expect((m[ns] as Record<string, unknown>)[key]).toBeUndefined();
        }
      }
    }
  });
});

describe('i18n: SignReassurance 名前空間 (署名安心 UX・ja/en parity)', () => {
  // 署名安心パネル + 署名待ちオーバーレイ + 照合表の i18n キー集合。片 locale 抜けで
  // t() が key を表示する regression を fence する。
  const SIGN_KEYS = [
    'headline',
    'badgeApprove',
    'badgeAmount',
    'badgeExpiry',
    'blockaidNote',
    'detailsSummary',
    'rowToField',
    'rowToMeaning',
    'rowValueField',
    'rowValueMeaning',
    'rowValidBeforeField',
    'rowValidBeforeMeaning',
    'rowNonceField',
    'rowNonceMeaning',
    'detailsWalletVariesNote',
    'awaitingTitle',
    'awaitingAmountLabel',
    'awaitingToLabel',
    'awaitingNote',
    // P4: recover (forwarder) パネルのバッジ/照合表/待機補足キー。
    'recoverBadgeAmountCustomer',
    'recoverBadgeAmountMerchant',
    'recoverBadgeRecipient',
    'recoverRowToMeaning',
    'recoverRowValueMeaningCustomer',
    'recoverAwaitingToVia',
  ] as const;

  for (const loc of [
    { name: 'ja', m: ja },
    { name: 'en', m: en },
  ] as const) {
    for (const key of SIGN_KEYS) {
      it(`${loc.name}.SignReassurance.${key} は非空文字列`, () => {
        const v = (loc.m.SignReassurance as Record<string, unknown>)[key];
        expect(typeof v).toBe('string');
        expect(v).not.toBe('');
      });
    }
  }

  it('キー集合が ja と en で完全一致 (構造 parity)', () => {
    expect(Object.keys(ja.SignReassurance).sort()).toEqual(
      Object.keys(en.SignReassurance).sort(),
    );
  });

  it('parameterized キーが必要な placeholder を持つ (ja/en)', () => {
    for (const m of [ja, en]) {
      const s = m.SignReassurance as Record<string, string>;
      // 金額バッジ + 照合表 value 欄は amount/symbol を差し込む。
      for (const ph of ['{amount}', '{symbol}']) {
        expect(s.badgeAmount).toContain(ph);
        expect(s.rowValueMeaning).toContain(ph);
      }
      // value 欄の意味説明は decimals を差し込む。
      expect(s.rowValueMeaning).toContain('{decimals}');
      // 失効バッジ + validBefore 欄は minutes を差し込む。
      expect(s.badgeExpiry).toContain('{minutes}');
      expect(s.rowValidBeforeMeaning).toContain('{minutes}');
      // P4: recover customer バッジ + value 欄は total/amount/fee/symbol を差し込む
      // (ウォレットに出る合計 = 表示額 + 手数料 の内訳説明が本質)。
      for (const ph of ['{total}', '{amount}', '{fee}', '{symbol}']) {
        expect(s.recoverBadgeAmountCustomer).toContain(ph);
        expect(s.recoverRowValueMeaningCustomer).toContain(ph);
      }
      // recover merchant バッジは amount/symbol のみ (手数料は受取から内枠吸収)。
      expect(s.recoverBadgeAmountMerchant).toContain('{amount}');
      expect(s.recoverBadgeAmountMerchant).toContain('{symbol}');
    }
  });
});

describe('i18n: RelayFallback 名前空間 (relay API 失敗→通常決済へ切替・ja/en parity)', () => {
  // B1 graceful degradation: relay が API レベルで失敗したとき Pay ボタン直上に出す
  // 「通常決済へ切替」banner の固定文言 (title / switchButton / gasHint)。per-error の
  // friendly 文言は PaymentForm/CheckoutForm の errorRelay* を流用する (banner には prop で渡す)。
  const RELAY_FALLBACK_KEYS = ['title', 'switchButton', 'gasHint'] as const;

  for (const loc of [
    { name: 'ja', m: ja },
    { name: 'en', m: en },
  ] as const) {
    for (const key of RELAY_FALLBACK_KEYS) {
      it(`${loc.name}.RelayFallback.${key} は非空文字列`, () => {
        const v = (loc.m.RelayFallback as Record<string, unknown>)[key];
        expect(typeof v).toBe('string');
        expect(v).not.toBe('');
      });
    }
  }

  it('キー集合が ja と en で完全一致 (構造 parity)', () => {
    expect(Object.keys(ja.RelayFallback).sort()).toEqual(
      Object.keys(en.RelayFallback).sort(),
    );
  });

  it('gasHint は {nativeToken} placeholder を持つ (chain-aware・ja/en)', () => {
    for (const m of [ja, en]) {
      expect((m.RelayFallback as Record<string, string>).gasHint).toContain(
        '{nativeToken}',
      );
    }
  });
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
    // affiliate entry (GMOコイン等) の景表法「広告」開示ラベル。
    'affiliateAd',
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

describe('i18n: News 名前空間 (お知らせ・ja/en parity)', () => {
  // /news page + NewsBell の UI シャーシ用 key 集合。お知らせ本文 (title/body) は
  // lib/news.ts に ja/en 同梱なのでここには含めない (explore.ts と同方針)。
  const NEWS_KEYS = [
    'pageTitle',
    'pageDescription',
    'categoryFeature',
    'categoryPricing',
    'categoryNotice',
    'bellAria',
    'unreadAria',
    'empty',
  ] as const;

  for (const loc of [
    { name: 'ja', m: ja },
    { name: 'en', m: en },
  ] as const) {
    for (const key of NEWS_KEYS) {
      it(`${loc.name}.News.${key} は非空文字列`, () => {
        const v = (loc.m.News as Record<string, unknown>)[key];
        expect(typeof v).toBe('string');
        expect(v).not.toBe('');
      });
    }
  }

  it('unreadAria は {count} placeholder を持つ (件数読み上げ)', () => {
    for (const m of [ja, en]) {
      expect((m.News as Record<string, string>).unreadAria).toContain('{count}');
    }
  });

  it('News キー集合が ja と en で一致 (構造 parity)', () => {
    expect(Object.keys(ja.News).sort()).toEqual(Object.keys(en.News).sort());
  });
});

describe('i18n: Nav / Landing 名前空間 (AppShell + LP, ja/en parity)', () => {
  // AppShell の BottomNav / TopNav (4 link) と LP 2 大 CTA で使う i18n key 集合。
  // 片方の locale だけ抜けて regression するのを fence する。
  const NAV_KEYS = [
    // P4 (2026-08-02): 4 区分ナビ 決済/販売/Store/マイページ
    'pay',
    'sell',
    'store',
    'me',
    'connect',
    'disconnect',
  ] as const;
  const LANDING_KEYS = [
    'tagline',
    'heroLeadline',
    'heroBody',
    'heroCta',
    'heroAudienceLead',
    'heroVisualAlt',
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
    'mobileOrderBannerTitle',
    'mobileOrderBannerLead',
    'mobileOrderBannerAlt',
    'mobileOrderBannerCta',
    'mobileOrderBannerLearnMore',
    'howItWorksMerchantTitle',
    'howItWorksMerchantStep1',
    'howItWorksMerchantStep2',
    'howItWorksMerchantStep3',
    // FAQ (Q6/A6「OpenPay の手数料はいくらか」は「利用料について」の節へ移したあと表示されなくなったので廃止・2026-09-28)
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
    // faqQ7/A7 = 「JPYC・USDC とは何ですか?」(LandingFaq で faqQ2 の前に表示)
    'faqQ7',
    'faqA7',
    // faqQ9/A9 = 「JPYC で払うお客様だけ割引できますか?」(ガイドの jpyc-discount へ送る)
    'faqQ9',
    'faqA9',
    // Trust section
    'trustTitle',
    'trustBody',
    'trustGithubLabel',
    // Support / 利用料 section: トップは料金ページと同じ 5 つの場合 (lib/pricing.ts)・supportFee* はガイドの利用料の欄が使う
    'supportFeePayFocal',
    'supportFeePayTitle',
    'supportFeePayBody',
    'supportFeeRegisterFocal',
    'supportFeeRegisterTitle',
    'supportFeeRegisterBody',
    'supportFeeMobileFocal',
    'supportFeeMobileTitle',
    'supportFeeMobileBody',
    'supportFeeTipFocal',
    'supportFeeTipTitle',
    'supportFeeTipBody',
    'supportFeeStoreFocal',
    'supportFeeStoreTitle',
    'supportFeeStoreBody',
    'supportFeeNote',
    'supportTipRequest',
    'supportProfileTagline',
    'supportProfileCta',
    // Benefits section (4 cards × {focal, title, body} + section meta)。Fee カードの focal は「0円〜」で、条件
    // (お客様がガス代を払う通常決済) とガスレスの料率・最低額を本文に持つ (2026-10-25)。永続の約束 (旧「0%」) ではない。
    'benefitsTitle',
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
    'useCase5Title',
    'useCase5Body',
    'useCase5ImageAlt',
    // 活用例のモバイルオーダー (2026-10-19 user・店舗・イベント出店の次に並べる)。
    'useCase8Title',
    'useCase8Body',
    'useCase8ImageAlt',
    // 技術詳細は Trust「オープン技術と透明性」の技術スタックに一本化
    // (旧 featuresGaslessTech は撤去)。
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

describe('i18n: 動的 QR / FX 換算 keys (ja/en parity)', () => {
  // QrGenerator の convert (他トークン建てで受け取る) keys。
  const QR_CONVERT_KEYS = [
    'convertButton',
    'convertActiveSummary',
    'convertRate',
    'convertRemaining',
    'convertExpired',
    'convertRecalc',
    'convertRevert',
    'convertCrossChainNote',
    // F8: レート急変 (LKG から ±20% 超) 警告の文言。
    'fxWarnTitle',
    'fxWarnDetail',
    'fxWarnAck',
  ] as const;
  // PaymentForm の FX 文脈 + 有効期限 keys。
  const PAY_FX_KEYS = [
    'fxAnchorLine',
    'fxRateLine',
    'fxRemaining',
    'fxExpiredShort',
    'expiredTitle',
    'expiredBody',
    'btnExpired',
  ] as const;

  for (const loc of [
    { name: 'ja', m: ja },
    { name: 'en', m: en },
  ] as const) {
    for (const key of QR_CONVERT_KEYS) {
      it(`${loc.name}.QrGenerator.${key} は非空文字列`, () => {
        const v = (loc.m.QrGenerator as Record<string, unknown>)[key];
        expect(typeof v).toBe('string');
        expect(v).not.toBe('');
      });
    }
    for (const key of PAY_FX_KEYS) {
      it(`${loc.name}.PaymentForm.${key} は非空文字列`, () => {
        const v = (loc.m.PaymentForm as Record<string, unknown>)[key];
        expect(typeof v).toBe('string');
        expect(v).not.toBe('');
      });
    }
  }

  it('parameterized keys が ja/en 両方で必要な placeholder を含む', () => {
    const placeholderChecks = [
      ['QrGenerator', 'convertButton', ['{symbol}']],
      ['QrGenerator', 'convertActiveSummary', ['{anchorAmount}', '{anchorSymbol}', '{amount}', '{symbol}']],
      ['QrGenerator', 'convertRate', ['{rate}']],
      ['QrGenerator', 'convertRemaining', ['{time}']],
      ['QrGenerator', 'convertRevert', ['{symbol}']],
      ['QrGenerator', 'fxWarnDetail', ['{lkg}', '{current}']],
      ['PaymentForm', 'fxAnchorLine', ['{refAmt}', '{anchorSymbol}', '{amount}', '{symbol}']],
      ['PaymentForm', 'fxRateLine', ['{rate}']],
      ['PaymentForm', 'fxRemaining', ['{time}']],
    ] as const;
    for (const [ns, key, phs] of placeholderChecks) {
      for (const m of [ja, en]) {
        const v = (m[ns] as Record<string, unknown>)[key] as string;
        for (const ph of phs) expect(v).toContain(ph);
      }
    }
  });
});

describe('i18n: F7 off-origin callback 開示 keys (ja/en parity)', () => {
  // CheckoutForm / TipForm の payer 向け開示 (redirect / サンクスリンクが第三者ホストのとき)。
  // Scan interstitial は上の Scan describe で fence 済 (callbackWarn*)。
  for (const loc of [
    { name: 'ja', m: ja },
    { name: 'en', m: en },
  ] as const) {
    it(`${loc.name}: 第三者 webhook は退役 (R1) — 入力欄の文言キーも「通知する」開示も残さない`, () => {
      const generator = loc.m.TipEmbedGenerator as Record<string, unknown>;
      for (const key of ['webhookLabel', 'webhookPlaceholder', 'webhookHint']) {
        expect(generator, key).not.toHaveProperty(key);
      }
      for (const v of [
        (loc.m.CheckoutForm as Record<string, unknown>).offOriginCallbackNote,
        (loc.m.TipForm as Record<string, unknown>).offOriginCallbackNote,
        (loc.m.Scan as Record<string, unknown>).callbackWarnBody,
      ]) {
        expect(v as string).not.toMatch(/通知|notif/i);
      }
    });

    for (const ns of ['CheckoutForm', 'TipForm'] as const) {
      it(`${loc.name}.${ns}.offOriginCallbackNote は非空文字列 + {host} を含む`, () => {
        const v = (loc.m[ns] as Record<string, unknown>).offOriginCallbackNote;
        expect(typeof v).toBe('string');
        expect(v).not.toBe('');
        expect(v as string).toContain('{host}');
      });
    }
    it(`${loc.name}.Scan.callbackWarnBody は {host} を含む`, () => {
      const v = (loc.m.Scan as Record<string, unknown>).callbackWarnBody as string;
      expect(v).toContain('{host}');
    });
  }
});

describe('i18n: History フィルタ/集計/会計CSV keys (ja/en parity)', () => {
  const HISTORY_KEYS = [
    'filterStatusLabel',
    'filterStatusAll',
    // フィルタ各行の可視軸ラベル (種別/通貨/状態) + revert 専門用語のホバー補足。
    'axisDirection',
    'axisAsset',
    'axisStatus',
    'statusRevertedTooltip',
    'searchLabel',
    'searchPlaceholder',
    'dateRangeLabel',
    'datePresetAll',
    'datePresetThisMonth',
    'datePresetLastMonth',
    'datePresetCustom',
    'dateFrom',
    'dateTo',
    'accountingFormatLabel',
    'accountingFormatFreee',
    'accountingFormatYayoi',
    'accountingFormatMf',
    'accountingFormatYayoiNative',
    'exportAccountingCsv',
    'accountingIncomeOnlyNote',
    'accountingRateUnavailable',
    'accountingNoRows',
    'accountingTooManyRows',
    'summaryTitle',
    'summaryGmv',
    'gmvApproxChip',
    'gmvRateUnavailable',
    'gmvReferenceNote',
    'filterEmpty',
    'columnAnchor',
    'affiliateHeading',
    'affiliateAd',
    'affiliateNote',
  ] as const;

  for (const loc of [
    { name: 'ja', m: ja },
    { name: 'en', m: en },
  ] as const) {
    for (const key of HISTORY_KEYS) {
      it(`${loc.name}.History.${key} は非空文字列`, () => {
        const v = (loc.m.History as Record<string, unknown>)[key];
        expect(typeof v).toBe('string');
        expect(v).not.toBe('');
      });
    }
  }

  it('parameterized History keys が placeholder を含む (ja/en)', () => {
    for (const m of [ja, en]) {
      const h = m.History as Record<string, string>;
      expect(h.summaryGmv).toContain('{amount}');
      expect(h.accountingTooManyRows).toContain('{max}');
    }
  });
});

describe('i18n: FreeeSync keys (ja/en parity)', () => {
  const FREEE_KEYS = [
    'title',
    'signInRequired',
    'connectCta',
    'connected',
    'companyLabel',
    'mappingRequired',
    'accountItemLabel',
    'taxCodeLabel',
    'saveMapping',
    'editMapping',
    'syncCta',
    'syncing',
    'noIncome',
    'syncDone',
    'syncRateNote',
    'draftNote',
    'connectError',
    'syncError',
    'loadError',
    'entitlementRequired',
  ] as const;

  for (const loc of [
    { name: 'ja', m: ja },
    { name: 'en', m: en },
  ] as const) {
    for (const key of FREEE_KEYS) {
      it(`${loc.name}.FreeeSync.${key} は非空文字列`, () => {
        const v = (loc.m.FreeeSync as Record<string, unknown>)[key];
        expect(typeof v).toBe('string');
        expect(v).not.toBe('');
      });
    }
  }

  it('parameterized FreeeSync keys が placeholder を含む (ja/en)', () => {
    for (const m of [ja, en]) {
      const f = m.FreeeSync as Record<string, string>;
      expect(f.companyLabel).toContain('{name}');
      expect(f.syncCta).toContain('{count}');
      expect(f.syncRateNote).toContain('{count}');
      for (const ph of ['{synced}', '{skipped}', '{errored}']) {
        expect(f.syncDone).toContain(ph);
      }
    }
  });
});

describe('i18n: PayerReceipt keys (顧客向け電子レシート, ja/en parity)', () => {
  // /scan の PayerReceiptList + PayerReceiptDetail + 完了画面で使う key 集合。
  // 片 locale 抜けで t() が key を表示する regression を fence する。
  const PAYER_RECEIPT_KEYS = [
    'sectionTitle',
    'sectionDescription',
    'empty',
    'emptyHint',
    'merchantFallback',
    'storageNotice',
    'detailTitle',
    'completionTitle',
    'statusConfirmed',
    'statusPending',
    'statusFailed',
    'statusUnknown',
    'receiptNoLabel',
    'paidAtLabel',
    'merchantLabel',
    'merchantWalletLabel',
    'payerWalletLabel',
    'currencyLabel',
    'lineItemsLabel',
    'anchorLabel',
    'subtotalLabel',
    'taxLabel',
    'totalLabel',
    'txHashLabel',
    'memoLabel',
    'explorerLink',
    'copyButton',
    'copiedButton',
    'printButton',
    'saveJsonButton',
    'saveCsvButton',
    'removeButton',
    'removeConfirm',
    'clearAllButton',
    'clearAllConfirm',
    'scanLink',
    'disclaimer',
  ] as const;

  for (const loc of [
    { name: 'ja', m: ja },
    { name: 'en', m: en },
  ] as const) {
    for (const key of PAYER_RECEIPT_KEYS) {
      it(`${loc.name}.PayerReceipt.${key} は非空文字列`, () => {
        const v = (loc.m.PayerReceipt as Record<string, unknown>)[key];
        expect(typeof v).toBe('string');
        expect(v).not.toBe('');
      });
    }
  }

  it('PayerReceipt キー集合が ja と en で一致 (構造 parity)', () => {
    const jaKeys = Object.keys(ja.PayerReceipt).sort();
    const enKeys = Object.keys(en.PayerReceipt).sort();
    expect(jaKeys).toEqual(enKeys);
  });

  it('禁止表現を含まない (正式領収書/税務証憑/インボイス対応/必ず使える)', () => {
    // spec の禁止表現。免責 (disclaimer) は「正式な領収書…ではありません」と否定文で使うため
    // disclaimer は除外し、訴求系の文言にこれらが紛れていないことを fence する。
    const banned = [
      '正式な領収書として',
      '税務証憑として有効',
      'インボイス対応',
      '経費精算に必ず使えます',
      '会計・税務上有効であることを保証',
    ];
    const jaText = JSON.stringify(ja.PayerReceipt);
    for (const phrase of banned) {
      expect(jaText).not.toContain(phrase);
    }
  });

  it('SuccessOverlay.viewReceiptsLink が ja/en に存在 (完了画面 → /scan 導線)', () => {
    for (const m of [ja, en]) {
      const v = (m.SuccessOverlay as Record<string, unknown>).viewReceiptsLink;
      expect(typeof v).toBe('string');
      expect(v).not.toBe('');
    }
  });

  it('SuccessOverlay 完了音トグルの名前 (soundToggle・状態は aria-pressed で伝える) が ja/en に存在', () => {
    for (const m of [ja, en]) {
      const overlay = m.SuccessOverlay as Record<string, unknown>;
      expect(typeof overlay.soundToggle).toBe('string');
      expect(overlay.soundToggle).not.toBe('');
      // 名前を状態で切り替えていた旧キー (二重否定の読み上げ) は残さない (D5)。
      expect(overlay).not.toHaveProperty('muteSound');
      expect(overlay).not.toHaveProperty('unmuteSound');
    }
  });
});

describe('i18n: UsageFee owed 一覧 keys (古い未収の期間別清算・ja/en parity)', () => {
  // REM-3 で追加。owed 複数月の一覧見出し ({count}) と各月の支払い金額 ({fee})。
  const OWED_KEYS = ['owedListTitle', 'owedPeriodAmount'] as const;
  for (const loc of [
    { name: 'ja', m: ja },
    { name: 'en', m: en },
  ] as const) {
    for (const key of OWED_KEYS) {
      it(`${loc.name}.UsageFee.${key} は非空文字列`, () => {
        const v = (loc.m.UsageFee as Record<string, unknown>)[key];
        expect(typeof v).toBe('string');
        expect(v).not.toBe('');
      });
    }
  }
  it('owedListTitle は {count}・owedPeriodAmount は {fee} placeholder を持つ', () => {
    for (const m of [ja, en]) {
      const u = m.UsageFee as Record<string, string>;
      expect(u.owedListTitle).toContain('{count}');
      expect(u.owedPeriodAmount).toContain('{fee}');
    }
  });
  it('UsageFee キー集合が ja と en で一致 (構造 parity)', () => {
    expect(Object.keys(ja.UsageFee).sort()).toEqual(
      Object.keys(en.UsageFee).sort(),
    );
  });
});

describe('i18n: 加入の厳密額確認 (過不足は付与不可)', () => {
  it.each([
    ['ja.Pro', ja.Pro.confirmOverpay, '{price} JPYC ちょうどを送金してください。異なる金額では Pro を付与できません。'],
    ['ja.CsvPass', ja.CsvPass.confirmOverpay, '{price} JPYC ちょうどを送金してください。異なる金額では CSV パスを付与できません。'],
    ['en.Pro', en.Pro.confirmOverpay, 'Send exactly {price} JPYC. Pro access cannot be granted for any other amount.'],
    ['en.CsvPass', en.CsvPass.confirmOverpay, 'Send exactly {price} JPYC. A CSV pass cannot be granted for any other amount.'],
  ])('%s は厳密額と異なる額の付与不可を開示する', (_key, actual, expected) => {
    expect(actual).toBe(expected);
  });
});

describe('i18n: Pro 名前空間 (OpenPay Pro paywall・ja/en parity)', () => {
  // Pro 加入パネル (ProPaywall) で使う key 集合。flag-gate された機能なので片 locale 抜けが
  // silent regression しやすい。非空 + 構造 parity + placeholder を fence する。
  const PRO_KEYS = [
    'title',
    'intro',
    'price',
    'misconfigured',
    'connectRequired',
    'mismatch',
    'signIn',
    'signingIn',
    'signInStatement',
    'signInError',
    'switchChain',
    'reviewCta',
    'confirmPrice',
    'confirmNoAutoRenew',
    'confirmNoRefund',
    'confirmOverpay',
    'confirmGas',
    'payCta',
    'paying',
    'verifying',
    'retryVerify',
    'verifyError',
    'payError',
    'granted',
    'grantedNoDate',
    'note',
  ] as const;

  for (const loc of [
    { name: 'ja', m: ja },
    { name: 'en', m: en },
  ] as const) {
    for (const key of PRO_KEYS) {
      it(`${loc.name}.Pro.${key} は非空文字列`, () => {
        const v = (loc.m.Pro as Record<string, unknown>)[key];
        expect(typeof v).toBe('string');
        expect(v).not.toBe('');
      });
    }
  }

  it('Pro キー集合が ja と en で完全一致 (構造 parity)', () => {
    expect(Object.keys(ja.Pro).sort()).toEqual(Object.keys(en.Pro).sort());
  });

  it('parameterized Pro キーが必要な placeholder を持つ (ja/en)', () => {
    for (const m of [ja, en]) {
      const p = m.Pro as Record<string, string>;
      expect(p.price).toContain('{price}');
      expect(p.price).toContain('{days}');
      expect(p.confirmPrice).toContain('{price}');
      expect(p.confirmPrice).toContain('{days}');
      expect(p.confirmOverpay).toContain('{price}');
      expect(p.payCta).toContain('{price}');
      expect(p.reviewCta).toContain('{price}');
      expect(p.switchChain).toContain('{chain}');
      expect(p.granted).toContain('{date}');
      expect(p.verifyError).toContain('{reason}');
      expect(p.payError).toContain('{reason}');
    }
  });
});

describe('i18n: CsvPass 名前空間 (CSV 24時間パス paywall・ja/en parity)', () => {
  // CSV パス購入パネル (CsvPassPaywall) で使う key 集合。flag-gate された機能なので片 locale 抜けが
  // silent regression しやすい。非空 + 構造 parity + placeholder を fence する。Pro と同型だが期間が
  // 「日」でなく「時間」(hours)・再購入合算なし (confirmNoStacking) が追加。
  const CSV_PASS_KEYS = [
    'title',
    'intro',
    'price',
    'misconfigured',
    'connectRequired',
    'mismatch',
    'signIn',
    'signingIn',
    'signInStatement',
    'signInError',
    'switchChain',
    'reviewCta',
    'confirmPrice',
    'confirmNoAutoRenew',
    'confirmNoRefund',
    'confirmNoStacking',
    'confirmOverpay',
    'confirmGas',
    'payCta',
    'paying',
    'verifying',
    'retryVerify',
    'verifyError',
    'payError',
    'granted',
    'grantedNoDate',
    'note',
    'noteGasless',
    'noteGasPaid',
  ] as const;

  for (const loc of [
    { name: 'ja', m: ja },
    { name: 'en', m: en },
  ] as const) {
    for (const key of CSV_PASS_KEYS) {
      it(`${loc.name}.CsvPass.${key} は非空文字列`, () => {
        const v = (loc.m.CsvPass as Record<string, unknown>)[key];
        expect(typeof v).toBe('string');
        expect(v).not.toBe('');
      });
    }
  }

  it('CsvPass キー集合が ja と en で完全一致 (構造 parity)', () => {
    expect(Object.keys(ja.CsvPass).sort()).toEqual(
      Object.keys(en.CsvPass).sort(),
    );
  });

  it('parameterized CsvPass キーが必要な placeholder を持つ (ja/en)', () => {
    for (const m of [ja, en]) {
      const p = m.CsvPass as Record<string, string>;
      expect(p.price).toContain('{price}');
      expect(p.price).toContain('{hours}');
      expect(p.confirmPrice).toContain('{price}');
      expect(p.confirmPrice).toContain('{hours}');
      expect(p.confirmNoStacking).toContain('{hours}');
      expect(p.confirmOverpay).toContain('{price}');
      expect(p.confirmOverpay).not.toContain('{hours}');
      expect(p.payCta).toContain('{price}');
      expect(p.reviewCta).toContain('{price}');
      expect(p.switchChain).toContain('{chain}');
      expect(p.granted).toContain('{date}');
      expect(p.verifyError).toContain('{reason}');
      expect(p.payError).toContain('{reason}');
    }
  });
});

describe('i18n: @handle 名前空間 (ja/en parity)', () => {
  function deepKeys(o: Record<string, unknown>, prefix = ''): string[] {
    return Object.entries(o)
      .flatMap(([k, v]) =>
        v && typeof v === 'object'
          ? deepKeys(v as Record<string, unknown>, `${prefix}${k}.`)
          : [`${prefix}${k}`],
      )
      .sort();
  }

  for (const ns of [
    'HandleClaim',
    'HandleProfile',
    'HandleProfileBuilder',
    'MobileOrder',
  ] as const) {
    it(`${ns}: ja と en でキー集合が完全一致`, () => {
      expect(deepKeys(ja[ns] as Record<string, unknown>)).toEqual(
        deepKeys(en[ns] as Record<string, unknown>),
      );
    });
    it(`${ns}: 全 leaf が非空文字列`, () => {
      for (const m of [ja, en]) {
        for (const leaf of Object.values(m[ns] as Record<string, unknown>)) {
          if (typeof leaf === 'string') {
            expect(leaf.trim().length).toBeGreaterThan(0);
          }
        }
      }
    });
  }

  it('Create.tabs.profile が ja/en 双方に存在', () => {
    expect(typeof (ja.Create as { tabs: Record<string, string> }).tabs.profile).toBe('string');
    expect(typeof (en.Create as { tabs: Record<string, string> }).tabs.profile).toBe('string');
  });

  it('Create.tabs.mobileOrder が ja/en 双方に存在 (flag裏タブのラベル)', () => {
    expect(typeof (ja.Create as { tabs: Record<string, string> }).tabs.mobileOrder).toBe('string');
    expect(typeof (en.Create as { tabs: Record<string, string> }).tabs.mobileOrder).toBe('string');
  });
});


describe('i18n: license UI の正確な namespace と key path', () => {
  // 両言語で同じ誤配置をしても通らないよう、利用箇所が要求する完全パスを固定する。
  const requiredPaths = [
    'CreatorStoreSeller.productTypeLabel',
    'CreatorStoreSeller.digitalProduct',
    'CreatorStoreSeller.licenseProduct',
    'CreatorStoreSeller.licenseTitleLabel',
    'CreatorStoreSeller.licenseSupplyLabel',
    'CreatorStoreSeller.licensePriceLabel',
    'CreatorStoreSeller.licenseTransferLabel',
    'CreatorStoreSeller.licenseTransferYes',
    'CreatorStoreSeller.licenseTransferNo',
    'CreatorStoreSeller.licenseTermsLabel',
    'CreatorStoreSeller.licenseTermsStandard',
    'CreatorStoreSeller.licenseTermsStandardLink',
    'CreatorStoreSeller.licenseTermsCustom',
    'CreatorStoreSeller.licenseTermsVersionHint',
    'CreatorStoreSeller.licenseTermsUrlLabel',
    'CreatorStoreSeller.licenseTermsVersionLabel',
    'CreatorStoreSeller.licenseInstructionsLabel',
    'CreatorStoreSeller.licenseInstructionsHint',
    'CreatorStoreSeller.licenseUsdcNotice',
    'CreatorStoreSeller.licenseImmutableNotice',
    'CreatorStoreSeller.licenseValidationError',
    'CreatorStoreSeller.licenseRegistrationLabel',
    'CreatorStoreSeller.licenseRegistrationPending',
    'CreatorStoreSeller.licenseRegistrationRegistered',
    'CreatorStoreSeller.licenseRegistrationFailed',
    'CreatorStoreSeller.licenseRefresh',
    'CreatorStoreSeller.licensePublish',
    'CreatorStoreSeller.licensePause',
    'CreatorStoreSeller.licenseRegistrationHint',
    'CreatorStoreSeller.licensePayToLabel',
    'CreatorStoreSeller.licensePayToHint',
    'CreatorStorePurchase.licenseErrors.sold_out',
    'CreatorStorePurchase.licenseErrors.reservation_quota',
    'CreatorStorePurchase.licenseErrors.recipient_unsupported',
    'CreatorStorePurchase.licenseErrors.license_registration_pending',
    'CreatorStorePurchase.licenseErrors.license_simulation_unavailable',
    'CreatorStoreLibrary.receivedHeading',
    'CreatorStoreLibrary.receivedEmpty',
    'CreatorStoreLibrary.receivedIntro',
    'CreatorStoreLibrary.receivedLoadError',
    'CreatorStoreLibrary.openLicense',
    'CreatorStoreLibrary.holderProvenance',
    'CreatorStoreLibrary.receivedLink',
    'CreatorStoreLicense.badge',
    'CreatorStoreLicense.transferable',
    'CreatorStoreLicense.nonTransferable',
    'CreatorStoreLicense.termsLink',
    'CreatorStoreLicense.deliveryNotice',
    'CreatorStoreLicense.nftState',
    'CreatorStoreLicense.mintTransaction',
    'CreatorStoreLicense.purchaseRights',
    'CreatorStoreLicense.holderRights',
    'CreatorStoreLicense.transferredRights',
    'CreatorStoreLicense.providerLabel',
    'CreatorStoreLicense.providerUnverified',
    'CreatorStoreLicense.scopeLabel',
    'CreatorStoreLicense.scopeBody',
    'CreatorStoreLicense.meteredLabel',
    'CreatorStoreLicense.meteredBody',
    'CreatorStoreLicense.issueLabel',
    'CreatorStoreLicense.issueBody',
    'CreatorStoreLicense.refundLabel',
    'CreatorStoreLicense.refundBody',
    'CreatorStoreLicense.transferLabel',
    'CreatorStoreLicense.transferBody',
    'CreatorStoreLicense.nonTransferBody',
    'CreatorStoreLicense.publicLabel',
    'CreatorStoreLicense.publicBody',
    'CreatorStoreLicense.quantity',
    'CreatorStoreLicense.providerThirdPartyNote',
    'CreatorStoreLicense.providerOperatorNote',
    'CreatorStoreLicense.states.pending',
    'CreatorStoreLicense.states.minted',
    'CreatorStoreLicense.states.repair',
    'CreatorStoreLicense.states.transferred',
    'CreatorStoreLicense.states.unknown',
    'CreatorStoreLicense.remaining',
    'CreatorStoreLicense.remainingUnknown',
    'CreatorStoreLicense.sellerOperator',
    'CreatorStoreLicense.sellerThirdParty',
    'CreatorStoreLicense.providerThirdParty',
  ] as const;

  it.each([ja, en])('全ライセンス UI key が指定の namespace に存在する', (messages) => {
    for (const key of requiredPaths) {
      expect(messages, key).toHaveProperty(key, expect.any(String));
    }
    expect(messages.CreatorStoreLicense.remaining).toContain('{remaining}');
    expect(messages.CreatorStoreLicense.remaining).toContain('{supply}');
    expect(messages.CreatorStoreLicense.sellerThirdParty).toContain('{name}');
    expect(messages.CreatorStoreSeller.licenseRegistrationLabel).toContain('{state}');
  });
});

// ---------------------------------------------------------------------------
// 使われていないキーのフェンス (第 9 回レビュー F-06)。
//
// next-intl はキーを実行時に引くので、使われているキーを消しても typecheck と vitest は緑のまま、本番の画面に
// キー名が出る。だから「未使用」の判定は保守的にする (未使用を見逃すのは可・使っているキーを未使用と言うのは不可):
//   - 本番のソースのどこかに leaf 名 (パスの最後の段) が文字列の一部として 1 回でも出てくれば使用中とみなす。
//     namespace + leaf の完全一致は求めない。t(key) の変数経由・別ファイルへ渡した t・Record で名前を引くキー
//     (STATUS_I18N_KEY 等) も、leaf 名がどこかに書かれていれば使用中になる。
//   - 本番のソース = repo 直下から歩いた .ts/.tsx/.js/.jsx/.mjs/.cjs。messages/ は判定の対象そのもの、
//     tests/・e2e/・demo-e2e/ はテストだけが名前を書くキー (このファイルのキー一覧など) を本番で使っているとは
//     言えないので除く。node_modules・ビルド出力・ドットで始まるディレクトリ (.next・.git・.claude の worktree 等) も除く。
//   - leaf 名がソースに文字列として現れない動的なキーは DYNAMIC_KEY_PATTERNS に明示する。
//
// 落ちたとき:
//   - 本当に使っていない → ja.json と en.json の同じ namespace から両方消す (掟 5・同名キーが別 namespace にある)。
//     消す前に leaf 名と旧文言を components/ lib/ app/ messages/ tests/ e2e/ で grep する (掟 4)。
//   - テンプレートリテラル等で組み立てて使っている → 消さずに DYNAMIC_KEY_PATTERNS に使う場所つきで足す。
//   - LP (Landing.*)・法務・llms.txt に関わる公開文言 → 消すかは user が決める。決まるまで
//     UNUSED_PUBLIC_COPY_PENDING に置く。

/** messages の leaf のパス (配列は 1 つの leaf として扱う・既存の deepKeys と同じ)。 */
function messageLeafPaths(value: unknown, prefix: readonly string[] = []): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return [prefix.join('.')];
  }
  return Object.entries(value as Record<string, unknown>).flatMap(([key, nested]) =>
    messageLeafPaths(nested, [...prefix, key]),
  );
}

/**
 * leaf 名がソースに文字列として現れないので、名前の検索では「使用中」にならない動的なキー。
 * パターンは使う場所のテンプレートの形 (固定の部分) に合わせて広めに書く — 形に当たる leaf はすべて使用中とみなす
 * (見逃しは可・誤って消させるのは不可)。
 */
const DYNAMIC_KEY_PATTERNS: readonly { pattern: RegExp; site: string }[] = [
  // --- leaf 名そのものを「接頭辞 + 値 + 接尾辞」で組み立てる。leaf 名はソースのどこにも書かれない。
  { pattern: /^Landing\.benefits[^.]+(?:Focal|Title|Body)$/, site: 'components/LandingBenefits.tsx `benefits${id}Title`' },
  { pattern: /^Landing\.cashCell[^.]+(?:Cash|Card|OpenPay)$/, site: 'components/LandingCashComparison.tsx `cashCell${id}Cash`' },
  { pattern: /^Landing\.useCase[^.]+(?:Title|Body)$/, site: 'components/LandingUseCases.tsx `useCase${useCase.id}Title`' },
  { pattern: /^Landing\.whyItem[^.]+(?:Title|Body)$/, site: 'components/LandingWhyStablecoin.tsx `whyItem${key}Title`' },
  { pattern: /^Landing\.supportFee[^.]+(?:Focal|Title|Body)$/, site: 'app/[locale]/guide/start/page.tsx `supportFee${k}Title`' },
  { pattern: /^ArcPayout\.step_[^.]+$/, site: 'components/arcPayout/ArcPayoutPanel.tsx `step_${flow.phase}`' },
  { pattern: /^TipEmbedGenerator\.[^.]+(?:Label|Placeholder)$/, site: 'components/handle-profile-builder/AdvancedGroup.tsx `${field}Label`' },
  // --- leaf が実行時の値で決まる (`prefix.${value}`)。今は値がソースに文字列で書かれているので名前の検索でも
  //     使用中になるが、値の出どころ (union 型・API の応答・計算) が変わると書かれなくなりうるので、その部分木ごと除く。
  { pattern: /^Create\.guideLinks\./, site: 'app/[locale]/create/page.tsx `guideLinks.${key}`' },
  { pattern: /^StoreCatalog\.(?:categories|types)\./, site: 'components/StoreBrowser.tsx ほか `categories.${value}`・`types.${...}`' },
  { pattern: /^MePage\.cards\./, site: 'app/[locale]/me/page.tsx `cards.${key}.title`' },
  { pattern: /^Terms\.[^.]+\.(?:title|body)$/, site: 'app/[locale]/terms/page.tsx `${k}.title`' },
  { pattern: /^Tokutei\.rows\./, site: 'app/[locale]/tokutei/page.tsx `rows.${key}.label`' },
  { pattern: /^AgentConfigGenerator\.modeOptions\./, site: 'components/agent/AgentConfigGenerator.tsx `modeOptions.${value}`' },
  { pattern: /^CreatorStoreSeller\.(?:contentKinds|labels|deliveryFormats)\./, site: 'components/creator-store-seller/ProductEditorSection.tsx・ProductListSection.tsx' },
  { pattern: /^CreatorStorefront\.labels\./, site: 'components/CreatorStorefrontSection.tsx `labels.${...}`' },
  { pattern: /^CreatorStoreLibrary\.labels\./, site: 'components/CreatorStoreLibrary.tsx `labels.${item.label}`' },
  { pattern: /^CreatorStoreLicense\.states\./, site: 'components/CreatorStoreLicenseNftState.tsx `states.${state}`' },
  { pattern: /^CreatorStorePurchase\.(?:licenseErrors|paymentStates|accessStates)\./, site: 'components/CreatorStorePurchaseFlow.tsx・CreatorStorePurchaseState.tsx' },
  { pattern: /^Discount\.mode\./, site: 'components/DiscountField.tsx `mode.${mode}`' },
  { pattern: /^Explore\.badge\./, site: 'components/ExploreEntry.tsx `badge.${b}`' },
  { pattern: /^HandleProfile\.(?:linkLayouts|fonts)\./, site: 'components/handle-profile-builder/LinksGroup.tsx・LookGroup.tsx' },
  { pattern: /^MobileOrder\.discountKind\./, site: 'components/MobileOrderBuilder.tsx `discountKind.${kind}`' },
  // modes.${mode}Desc・kinds.${settings.linkKind}Desc (leaf 名を組み立てる形) もこの部分木に入る。
  { pattern: /^OrderLinkBuilder\.(?:verify|contactKinds|errors|errorsShort|kinds|modes)\./, site: 'components/OrderLinkBuilder.tsx・order-link/OrderLinkVerify.tsx' },
  { pattern: /^QrGenerator\.(?:notReady|notReadyShort|splitError)\./, site: 'components/QrGenerator.tsx・qr/QrPreviewSection.tsx・qr/SplitEditor.tsx' },
  { pattern: /^QrGenerator\.storeDevice\.blocked\./, site: 'components/QrGenerator.tsx `storeDevice.blocked.${storeBlocked}`' },
  { pattern: /^RegisterMode\.(?:notReady|notReadyShort)\./, site: 'components/RegisterMode.tsx `notReady.${notReadyKey}`' },
  { pattern: /^RegisterMode\.storeDevice\.(?:saleBlocked|createFailed|notSent)\./, site: 'components/RegisterMode.tsx・StoreDeviceRegisterStatus.tsx' },
  { pattern: /^RegisterMode\.storeGasWallet\.(?:withdrawError|topUpError|topUpResult)\./, site: 'components/StoreGasWalletPanel.tsx・StoreGasWalletTopUp.tsx' },
  { pattern: /^CheckoutForm\.storeDevice\.(?:error|previous)\./, site: 'components/StoreDeviceCheckoutForm.tsx `storeDevice.error.${status.reason}`' },
];

/**
 * 未使用だが公開文言 (LP) なので、消すかを user が決めるまで残すキー。
 * 使うようになったら、または消したら、ここからも外す (下の検査が残りを知らせる)。
 * 第 9 回レビュー F-06 で見つけた Landing.wipNote・Landing.howItWorksVisualAlt は user 判断で消した (2026-11-06)。
 */
const UNUSED_PUBLIC_COPY_PENDING: readonly string[] = [];

const MESSAGE_SOURCE_FILE = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/;
/** repo 直下でだけ除くディレクトリ (判定の対象そのもの・テストだけのコード)。 */
const MESSAGE_SOURCE_ROOT_EXCLUDED = new Set(['messages', 'tests', 'e2e', 'demo-e2e']);
/** どの深さでも除くディレクトリ (依存・ビルド出力・レポート)。ドットで始まるものも除く。 */
const MESSAGE_SOURCE_EXCLUDED = new Set([
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  'playwright-report',
  'playwright-prodflags-report',
  'test-results',
  'demo-artifacts',
]);

function readProductionSource(dir: string, isRoot: boolean): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name.startsWith('.') || MESSAGE_SOURCE_EXCLUDED.has(entry.name)) return [];
    if (isRoot && MESSAGE_SOURCE_ROOT_EXCLUDED.has(entry.name)) return [];
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return readProductionSource(full, false);
    return entry.isFile() && MESSAGE_SOURCE_FILE.test(entry.name) ? [readFileSync(full, 'utf8')] : [];
  });
}

describe('i18n: 使われていないキーが無い (第 9 回レビュー F-06)', () => {
  const jaLeaves = messageLeafPaths(ja);
  const enLeaves = messageLeafPaths(en);
  const allLeaves = [...new Set([...jaLeaves, ...enLeaves])].sort();
  const corpus = readProductionSource(process.cwd(), true).join('\n');
  // 語の集合で先に引き、無ければ部分文字列で探す (部分一致も使用中とみなす = 保守側)。
  const tokens = new Set(corpus.match(/[\w$]+/g) ?? []);
  const appearsInSource = (leafName: string) => tokens.has(leafName) || corpus.includes(leafName);
  const leafNameOf = (leafPath: string) => leafPath.slice(leafPath.lastIndexOf('.') + 1);
  const isDynamic = (leafPath: string) => DYNAMIC_KEY_PATTERNS.some(({ pattern }) => pattern.test(leafPath));

  it('ja と en の leaf の集合が完全に一致する (消すときは両方から・掟 5)', () => {
    expect(jaLeaves.slice().sort()).toEqual(enLeaves.slice().sort());
  });

  it('本番のソースを読めている (歩き方が壊れて空になると全キーが未使用に見える)', () => {
    expect(corpus).toContain('useTranslations');
    expect(corpus).toContain('getTranslations');
  });

  it('messages の全 leaf が、本番のソースに leaf 名として出るか、動的なキーか、user 判断待ちの公開文言', () => {
    const unused = allLeaves.filter(
      (leafPath) =>
        !appearsInSource(leafNameOf(leafPath)) &&
        !isDynamic(leafPath) &&
        !UNUSED_PUBLIC_COPY_PENDING.includes(leafPath),
    );
    expect(
      unused,
      '使われていないキー: 本当に未使用なら ja/en の同じ namespace から両方消す。' +
        'テンプレートリテラルで組み立てて使っているなら DYNAMIC_KEY_PATTERNS に足す。',
    ).toEqual([]);
  });

  it.each(DYNAMIC_KEY_PATTERNS)('DYNAMIC_KEY_PATTERNS の $pattern は今ある leaf に当たる ($site)', ({ pattern }) => {
    expect(allLeaves.some((leafPath) => pattern.test(leafPath))).toBe(true);
  });

  // 一覧が空でも走るように it.each ではなく 1 つの it で回す。
  it('UNUSED_PUBLIC_COPY_PENDING の各キーは ja/en にあり、まだ本番のソースに名前が出ない (使う・消すなら一覧から外す)', () => {
    for (const leafPath of UNUSED_PUBLIC_COPY_PENDING) {
      expect(jaLeaves, leafPath).toContain(leafPath);
      expect(enLeaves, leafPath).toContain(leafPath);
      expect(appearsInSource(leafNameOf(leafPath)), leafPath).toBe(false);
    }
  });

  // leaf 名の判定は保守的なので、title・intro のようなよくある名前だけの namespace は、丸ごと未使用でも見逃す
  // (年額の利用権の Billing 名前空間の 22 文言がこれで残っていた・2026-11-06 に削除)。namespace の名前そのものが
  // 本番のソースに出るか (useTranslations('X')・getTranslations・'X.key' の一部) を別に確かめる。
  it('messages の最上位の namespace の名前が、本番のソースに出る', () => {
    const namespaces = [...new Set([...Object.keys(ja), ...Object.keys(en)])].sort();
    expect(
      namespaces.filter((ns) => !appearsInSource(ns)),
      '使われていない namespace: 本当に未使用なら ja/en の両方から丸ごと消す。',
    ).toEqual([]);
  });
});
