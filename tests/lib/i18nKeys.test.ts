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

describe('i18n: Create.tabs / tabDesc キー (ja/en parity)', () => {
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

  // tabDesc は決済QR タブのみ表示 (レジ/チップは各パネル先頭の見出し+説明と重複する
  // ため非表示)。qr のみ非空 + parity を fence する。
  it('ja/en の Create.tabDesc.qr は非空文字列 (register/tip は撤去)', () => {
    for (const m of [ja, en]) {
      const desc = (m.Create as Record<string, unknown>).tabDesc as Record<
        string,
        unknown
      >;
      expect(typeof desc.qr).toBe('string');
      expect(desc.qr).not.toBe('');
      expect(desc.register).toBeUndefined();
      expect(desc.tip).toBeUndefined();
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
    'posGuideLink',
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
    // faqQ7/A7 = 「JPYC・USDC とは何ですか?」(LandingFaq で faqQ2 の前に表示)
    'faqQ7',
    'faqA7',
    // Trust section
    'trustTitle',
    'trustBody',
    'trustGithubLabel',
    // Support / 利用料 section (FAQ 下、料率カード 4 方法 + Tip widget 埋め込み)
    'supportTitle',
    'supportSubtitle',
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
    'supportFeeNote',
    'supportTipRequest',
    'supportProfileTagline',
    'supportProfileCta',
    'supportProfileAria',
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
    // Benefits 「なぜ店舗決済に OpenPay が必要か」narrative (lead + 2 points)
    'benefitsWhyTitle',
    'benefitsWhyLead',
    'benefitsWhyPoint1Title',
    'benefitsWhyPoint1Body',
    'benefitsWhyPoint2Title',
    'benefitsWhyPoint2Body',
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
    // 技術詳細は Trust「オープン技術と透明性」の技術スタックに一本化
    // (旧 featuresGaslessTech は撤去)。
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

describe('i18n: 動的 QR / FX 換算 keys (ja/en parity)', () => {
  // QrGenerator の convert (他トークン建てで受け取る) keys。
  const QR_CONVERT_KEYS = [
    'convertButton',
    'convertRateUnavailable',
    'convertActiveSummary',
    'convertRate',
    'convertRemaining',
    'convertExpired',
    'convertRecalc',
    'convertRevert',
    'convertCrossChainNote',
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
    'summaryCountsLine',
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
      for (const ph of ['{total}', '{success}', '{reverted}', '{error}', '{pending}']) {
        expect(h.summaryCountsLine).toContain(ph);
      }
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
    'mappingSaved',
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

  it('SuccessOverlay 完了音トグルの aria-label (muteSound/unmuteSound) が ja/en に存在', () => {
    for (const m of [ja, en]) {
      for (const key of ['muteSound', 'unmuteSound'] as const) {
        const v = (m.SuccessOverlay as Record<string, unknown>)[key];
        expect(typeof v).toBe('string');
        expect(v).not.toBe('');
      }
    }
  });
});

describe('i18n: Billing 名前空間 (利用料 paywall・ja/en parity)', () => {
  // 深いキー集合を再帰収集 (tier.basic.name 等のネストを含む)。
  function deepKeys(o: Record<string, unknown>, prefix = ''): string[] {
    return Object.entries(o)
      .flatMap(([k, v]) =>
        v && typeof v === 'object'
          ? deepKeys(v as Record<string, unknown>, `${prefix}${k}.`)
          : [`${prefix}${k}`],
      )
      .sort();
  }

  it('ja と en でキー集合が完全一致', () => {
    expect(deepKeys(ja.Billing as Record<string, unknown>)).toEqual(
      deepKeys(en.Billing as Record<string, unknown>),
    );
  });

  it('全 leaf が非空文字列 (空文字 silent regression 防止)', () => {
    for (const m of [ja, en]) {
      const flat = JSON.stringify(m.Billing);
      const leaves = Object.values(
        m.Billing as Record<string, unknown>,
      ).flatMap((v) =>
        v && typeof v === 'object' ? Object.values(v as object) : [v],
      );
      for (const leaf of leaves) {
        // ネスト (tier) は object なので展開済。string のみ検査。
        if (typeof leaf === 'string') {
          expect(leaf.trim().length, flat).toBeGreaterThan(0);
        }
      }
    }
  });

  it('必須キー (tier/価格/支払い/検証/付与) が存在', () => {
    for (const m of [ja, en]) {
      const b = m.Billing as Record<string, unknown>;
      for (const k of [
        'title',
        'intro',
        'priceMonthly',
        'priceAnnual',
        'payCta',
        'verifying',
        'granted',
        'verifyError',
        'softGateNote',
      ]) {
        expect(typeof b[k]).toBe('string');
      }
      const tier = b.tier as Record<string, { name?: unknown }>;
      expect(typeof tier.basic.name).toBe('string');
      expect(typeof tier.pro.name).toBe('string');
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
      expect(p.confirmOverpay).toContain('{hours}');
      expect(p.payCta).toContain('{price}');
      expect(p.reviewCta).toContain('{price}');
      expect(p.switchChain).toContain('{chain}');
      expect(p.granted).toContain('{date}');
      expect(p.verifyError).toContain('{reason}');
      expect(p.payError).toContain('{reason}');
    }
  });

  it('History.csvPassLockedNote が ja/en に存在 (パスゲートの cause-aware 文言)', () => {
    for (const m of [ja, en]) {
      const v = (m.History as Record<string, unknown>).csvPassLockedNote;
      expect(typeof v).toBe('string');
      expect(v).not.toBe('');
    }
  });
});

describe('i18n: HandleClaim / HandleProfile 名前空間 (@handle・ja/en parity)', () => {
  function deepKeys(o: Record<string, unknown>, prefix = ''): string[] {
    return Object.entries(o)
      .flatMap(([k, v]) =>
        v && typeof v === 'object'
          ? deepKeys(v as Record<string, unknown>, `${prefix}${k}.`)
          : [`${prefix}${k}`],
      )
      .sort();
  }

  for (const ns of ['HandleClaim', 'HandleProfile', 'MobileOrder'] as const) {
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
