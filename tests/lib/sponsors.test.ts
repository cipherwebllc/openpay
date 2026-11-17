// スポンサー・広告掲載のご案内 (/sponsors) の正本のフェンス (2026-11-18 user 裁定の第 1 段)。
//   - 料金・日数・社数・入稿の数字は lib/sponsorPlans.ts の 1 か所 (値を固定する)
//   - ja の文は承認済みの文 (つなぐと承認の文に戻る・中身を足さない)
//   - ja / en の形がそろう (同じ項目・同じ数)
//   - 書かないもの: 「税込」・計測やレポートの案内・メールアドレス
//   - Discord と X の URL は lib/officialLinks.ts だけが持つ (フッターと募集ページで二重に持たない)

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OPENPAY_DISCORD_URL, OPENPAY_X_URL } from '@/lib/officialLinks';
import {
  SPONSOR_BANNER_SPEC,
  SPONSOR_BLURB_MAX_CHARS,
  SPONSOR_LOGO_MIN_WIDTH,
  SPONSOR_PLANS,
  formatSponsorYen,
  sponsorBannerRatio,
} from '@/lib/sponsorPlans';
import { SPONSORS, sponsorsContentFor, sponsorsMetadata, type SponsorsContent } from '@/lib/sponsors';

const ROOT = resolve(__dirname, '../..');

describe('料金と入稿の決まり (lib/sponsorPlans.ts) の値', () => {
  it('法人スポンサー 33,000 円／30 日・最大 3 社・バナー広告 11,000 円／30 日・最大 3 社で共有', () => {
    expect(SPONSOR_PLANS).toEqual({
      sponsor: { priceYen: 33_000, termDays: 30, maxCompanies: 3 },
      banner: { priceYen: 11_000, termDays: 30, maxCompanies: 3 },
    });
  });

  it('バナー 1200×300 px (横 4：縦 1)・300 KB 以内・ロゴは横 400 px 以上・紹介文は日本語 80 字・英語 160 字以内', () => {
    expect(SPONSOR_BANNER_SPEC).toEqual({ width: 1200, height: 300, maxKb: 300 });
    expect(sponsorBannerRatio()).toEqual({ w: 4, h: 1 });
    expect(SPONSOR_LOGO_MIN_WIDTH).toBe(400);
    expect(SPONSOR_BLURB_MAX_CHARS).toEqual({ ja: 80, en: 160 });
  });

  it('金額は 3 桁で区切る', () => {
    expect(formatSponsorYen(33_000)).toBe('33,000');
    expect(formatSponsorYen(11_000)).toBe('11,000');
  });

  it('ページの文 (lib/sponsors.ts) と描く部品は、料金の数字を直書きしない (定数から差し込む)', () => {
    for (const file of [
      'lib/sponsors.ts',
      'components/sponsors/SponsorsPieces.tsx',
      'app/[locale]/sponsors/page.tsx',
      'components/LandingSponsorsNote.tsx',
    ]) {
      const source = readFileSync(join(ROOT, file), 'utf8');
      expect({ file, hits: source.match(/33,?000|11,?000|1200|300 ?(?:KB|px)/g) ?? [] }).toEqual({ file, hits: [] });
    }
  });
});

// 運営者が承認した ja の文 (2026-11-18)。ページの文をつなぐと、この文に戻る。
const APPROVED_JA = {
  title: 'スポンサー・広告掲載のご案内',
  lead: 'JPYC の利用と、AI が支払う体験を、一緒に広げませんか。OpenPay の開発・運営を支える法人スポンサーと、広告掲載企業を募集しています。',
  audience: 'ウォレット・決済・API・開発基盤など、OpenPay を使うお店・お客様・AI エージェントの開発者に関わる企業の方へ。',
  purpose:
    'いただいた協賛・掲載料は、OpenPay の開発と運営にあてます。協賛は、OpenPay の開発・運営の支援と、協賛企業としての掲載を内容とします。',
  sponsor:
    '33,000 円／30 日・最大 3 社。トップページ上部の「協賛企業」欄・OpenPay の案内ページ（ガイド等）の下部・このページに、ロゴ・企業名・リンク（このページでは短い紹介文も）を掲載します。掲載中の全社のロゴを、同じ大きさで並べます。',
  banner:
    '11,000 円／30 日・最大 3 社で共有する枠。トップページ（主な機能の紹介の後）・Store（商品一覧の手前）・AI ストア（カタログの手前）に掲載します。',
  priceNote:
    '表示の金額のほかに、消費税等をいただくことはありません。請求書を発行します（適格請求書ではありません）。お支払いは、日本円の銀行振込か JPYC で承ります。',
  specs:
    'バナー: 1200×300 px（横 4：縦 1）・PNG / JPG / WebP・300 KB 以内・代替テキスト（画像の説明の文）。ロゴ: SVG か PNG（背景が透明のもの）・横 400 px 以上。リンク先の URL（https）。紹介文: 日本語 80 字以内・英語 160 字以内',
  flow: '① Discord か X でお問い合わせ → ② 掲載の可否・空き枠・開始日のご連絡 → ③ 素材のご入稿 → ④ 請求書の発行とお支払い → ⑤ 掲載開始（30 日）',
  terms:
    '掲載料金は、所定の掲載場所・期間に対する料金です。バナー・ロゴ等の素材は広告主様にご用意いただきます。定期レポートの提供は含まれません。表示回数・クリック数・お問い合わせ・購入等の成果は保証いたしません。',
  bannerTerms:
    '（バナー広告）複数の広告主様で共有する広告枠です。ページ表示時に、掲載中の広告から 1 件をランダムに表示します。閲覧中の自動切り替えは行いません。表示回数・表示割合の保証はありません。',
  standards:
    '次のものは掲載しません: 法令に反するもの・必要な登録の無い暗号資産の交換や電子決済手段の取引のサービス・利回りや値上がりをうたう投資の勧誘・ギャンブル・誤解を招く表示・OpenPay の決済の操作と見間違える表示。OpenPay の判断で、掲載をお断りしたり、掲載中でも止めたりすることがあります。',
  refund:
    '掲載基準に反するため掲載を止めた場合、掲載料はお返ししません。OpenPay の都合で掲載を止めた場合は、残りの日数分を日割りでお返しします。',
  welcome: '企業の公式 SNS やブログでの OpenPay の紹介や、活用事例の相互紹介を歓迎します（必須ではありません）。',
  buttons: ['Discord で問い合わせる', 'X で問い合わせる'],
} as const;

describe('ja の文は承認済みの文のまま (中身を足さない・変えない)', () => {
  const c = SPONSORS.ja;
  const plan = (id: 'sponsor' | 'banner') => c.plans.find((p) => p.id === id)!;

  it('題・冒頭・対象・目的・料金の注記・掲載条件・返金・歓迎事項・ボタン', () => {
    expect(c.title).toBe(APPROVED_JA.title);
    expect(c.lead).toBe(APPROVED_JA.lead);
    expect(c.audience).toBe(APPROVED_JA.audience);
    expect(c.plansLead).toBe(APPROVED_JA.purpose);
    expect(c.priceNote).toBe(APPROVED_JA.priceNote);
    expect(c.terms).toBe(APPROVED_JA.terms);
    expect(`${c.bannerTermsLabel}${c.bannerTerms}`).toBe(APPROVED_JA.bannerTerms);
    expect(c.refund).toBe(APPROVED_JA.refund);
    expect(c.welcome).toBe(APPROVED_JA.welcome);
    expect([c.contactDiscord, c.contactX]).toEqual(APPROVED_JA.buttons);
  });

  it('料金のカード: 大きい数字 + 期間と社数 + 本文をつなぐと、承認の文に戻る', () => {
    for (const id of ['sponsor', 'banner'] as const) {
      const p = plan(id);
      expect(`${p.focal}${p.focalSub}。${p.body}`).toBe(APPROVED_JA[id]);
    }
    expect(c.plans.map((p) => p.id)).toEqual(['sponsor', 'banner']);
  });

  it('入稿仕様: 名前と決まりを「: 」でつなぎ、行を「。」でつなぐと、承認の文に戻る', () => {
    expect(c.specs.map((s) => (s.body ? `${s.label}: ${s.body}` : s.label)).join('。')).toBe(APPROVED_JA.specs);
  });

  it('流れ: 番号を付けて「 → 」でつなぐと、承認の文に戻る', () => {
    const marks = ['①', '②', '③', '④', '⑤'];
    expect(c.flow).toHaveLength(marks.length);
    expect(c.flow.map((step, i) => `${marks[i]} ${step}`).join(' → ')).toBe(APPROVED_JA.flow);
  });

  it('掲載基準: 前置き・項目 (「・」でつなぐ)・後ろの文をつなぐと、承認の文に戻る', () => {
    expect(`${c.standardsIntro} ${c.standards.join('・')}。${c.standardsNote}`).toBe(APPROVED_JA.standards);
  });
});

/** 文の全部 (数え上げ)。 */
function allStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(allStrings);
  if (value && typeof value === 'object') return Object.values(value).flatMap(allStrings);
  return [];
}

/** 形 (キーと配列の長さ) だけを取り出す。 */
function shape(value: unknown): unknown {
  if (typeof value === 'string') return 'string';
  if (value === null) return 'null';
  if (Array.isArray(value)) return value.map(shape);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, k === 'id' ? v : shape(v)]));
  }
  return typeof value;
}

describe('ja / en の形と数字', () => {
  it('ja と en は同じ項目・同じ数 (料金のカードの順・入稿仕様の名前だけの行も同じ)', () => {
    expect(shape(SPONSORS.en)).toEqual(shape(SPONSORS.ja));
  });

  it('料金の大きい数字は定数から (ja は「円」・en は「¥」)', () => {
    for (const id of ['sponsor', 'banner'] as const) {
      const yen = formatSponsorYen(SPONSOR_PLANS[id].priceYen);
      expect(SPONSORS.ja.plans.find((p) => p.id === id)?.focal).toBe(`${yen} 円`);
      expect(SPONSORS.en.plans.find((p) => p.id === id)?.focal).toBe(`¥${yen}`);
      expect(SPONSORS.en.plans.find((p) => p.id === id)?.focalSub).toContain(`/ ${SPONSOR_PLANS[id].termDays} days`);
      expect(SPONSORS.en.plans.find((p) => p.id === id)?.focalSub).toContain(`up to ${SPONSOR_PLANS[id].maxCompanies} companies`);
    }
  });

  it.each(['ja', 'en'] as const)('%s: メタの説明に 2 つの料金 (定数の値) が入る', (locale) => {
    const d = SPONSORS[locale].metaDescription;
    const unit = locale === 'ja' ? (yen: string) => `${yen} 円` : (yen: string) => `¥${yen}`;
    expect(d).toContain(unit(formatSponsorYen(SPONSOR_PLANS.sponsor.priceYen)));
    expect(d).toContain(unit(formatSponsorYen(SPONSOR_PLANS.banner.priceYen)));
  });

  it.each(['ja', 'en'] as const)('%s: 書かないもの (税込・計測やレポートの案内・メールアドレス・@ の名前・URL)', (locale) => {
    const text = allStrings(SPONSORS[locale]).join('\n');
    for (const banned of [/税込/, /tax[- ]inclusive|including tax|tax included/i, /効果計測|有償オプション|別途ご相談/, /measurement|reporting option/i]) {
      expect(text).not.toMatch(banned);
    }
    expect(text).not.toMatch(/@/);
    expect(text).not.toMatch(/https?:\/\//);
  });

  it('未知のロケールは ja', () => {
    expect(sponsorsContentFor('fr')).toBe(SPONSORS.ja);
    expect(sponsorsContentFor('en')).toBe(SPONSORS.en);
  });

  it.each(['ja', 'en'] as const)('%s: metadata は /{locale}/sponsors を canonical に、ja / en の hreflang を持つ', (locale) => {
    const meta = sponsorsMetadata(locale);
    const content: SponsorsContent = SPONSORS[locale];
    expect(meta.title).toBe(content.metaTitle);
    expect(meta.description).toBe(content.metaDescription);
    expect(meta.alternates).toEqual({
      canonical: `/${locale}/sponsors`,
      languages: { ja: '/ja/sponsors', en: '/en/sponsors' },
    });
  });
});

/** components / lib / app の .ts / .tsx (テストを除く) の path。 */
function sourceFiles(): string[] {
  const out: string[] = [];
  for (const dir of ['components', 'lib', 'app']) {
    for (const entry of readdirSync(join(ROOT, dir), { recursive: true, withFileTypes: true })) {
      if (entry.isFile() && /\.tsx?$/.test(entry.name)) out.push(relative(ROOT, join(entry.parentPath, entry.name)));
    }
  }
  return out;
}

describe('Discord と X の URL は 1 か所 (lib/officialLinks.ts)', () => {
  it('値', () => {
    expect(OPENPAY_DISCORD_URL).toBe('https://discord.gg/Cfywb3aNWg');
    expect(OPENPAY_X_URL).toBe('https://x.com/openpay_jp');
  });

  it('ほかの file に URL の直書きが無い (フッター・募集ページは定数を使う)', () => {
    const holders = sourceFiles().filter((file) => {
      const source = readFileSync(join(ROOT, file), 'utf8');
      return source.includes(OPENPAY_DISCORD_URL) || source.includes(OPENPAY_X_URL);
    });
    expect(holders).toEqual(['lib/officialLinks.ts']);
  });
});
