// 事業者情報の単一 source of truth。利用規約・プライバシーポリシー・免責事項・
// 特商法表記で共通参照する。env 注入に切替える場合もここの export だけ
// 差替で済むよう、page 側からは LEGAL_ENTITY のみ参照する。
//
// 値の出所: 国税庁法人番号公表サイト (1110003003789) で住所・商号・代表者を
// 突合済 (2026-05-14)。文面そのものは alpha 段階で弁護士 review 未実施の
// draft 扱い (本番昇格時に文言精査が必要)。
//
// import 方針: 本モジュールは法務開示の SOT (定数 + 開示数値) であり、live env から
// 開示数値を読む下流ヘルパ (feeDisclosureDivergence) のためにのみ relay の floor reader
// (relayGasFeeValue・forwarderConfig) と env を import する。bps は env.recoverFeeBps を直接読む
// (recoverFee.ts ではなく env から読むことで、recoverFee を mock する下流テストに影響しない)。
// forwarderConfig / env は legal を import し返さないため循環は生じない (legal → {forwarderConfig, env})。

import { relayGasFeeValue } from '@/lib/relay/forwarderConfig';
import { env } from '@/lib/env';

export const LEGAL_ENTITY = {
  serviceName: 'OpenPay',
  companyName: 'サイファーウェブ合同会社',
  corporateNumber: '1110003003789',
  headOffice: '〒950-1147 新潟県新潟市中央区高美町4-14',
  representative: '代表社員 高野勝通',
  contactEmail: 'info@cipher-web.com',
  siteUrl: 'https://open-pay.jp',

  // 施行日 (各文書共通でサービス開始日に揃える)
  // 2026-05-16 改定: 通常決済（ガスあり）モード追加に伴う料金体系・用語の整理。
  // 2026-06-05 改定 (JPYC ガス無料化): JPYC ガスレス決済のネットワーク手数料相当額の
  //   徴収を全廃し、当社がガスを全額負担し利用者から相当額を一切徴収しない旨に
  //   Terms 第3条/第5条・Disclaimer 冒頭/第7条・特商法 (役務の対価/対価以外の費用/
  //   支払時期/返品) を改定 (決済フローへの介在を除去・利用者の一般の利益に適合)。
  //   負担者選択 (顧客/店主) の記述も JPYC 無料化に伴い撤去。Privacy は料金モデルに
  //   直接言及しないため 2026-05-16 のまま据置。
  // (2026-05-29 改定: OpenPay 利用手数料を 0% 化 (取引額連動の % 手数料を撤廃) し、
  //   当時はガスレスのネットワーク手数料相当額を固定額で徴収する旨に改定していた。
  //   本 2026-06-05 改定でその徴収自体を廃止。)
  // 2026-06-07 改定: 「取引額連動の % 手数料は将来も取らない」という将来を縛る断定を撤回し、
  //   「現在は 0%・将来の料金体系は検討中・変更時は事前周知し変更後の取引に適用」へ改める
  //   (Terms 第3条/第5条・Disclaimer §7・特商法 役務の対価/支払時期・Landing 文言)。現在の無徴収は不変。
  // 2026-06-08 改定 (外部レビュー精査に基づく開示拡充・4文書): Terms (行為能力/未成年者
  //   同意・違反時のサービス利用制限/提供停止【非カストディ前提】)、Privacy (Cookie/
  //   localStorage の実態正確化・要配慮個人情報 非取得・プロファイリング非実施・安全管理
  //   措置の節を新設し以降を繰下げ)、Disclaimer (脱ペッグ明記・スマートコントラクト脆弱性
  //   免責の明示強化)、特商法 (支払方法 wallet-only 明確化・事業者種を役務提供事業者へ
  //   精緻化・現状有姿/無保証の明記)。いずれも開示の明確化で利用者の一般の利益に適合。
  // 2026-06-09 改定 (OpenPay 利用料の有料化開始の事前開示・3文書 Terms/Disclaimer/特商法):
  //   「OpenPay 利用料」を 2026 年 7 月のご利用分から申し受ける旨を開示。これは決済ごとに
  //   売上から差し引く決済手数料 (中抜き) ではなく、ガスレス決済モード (当社が gas を肩代わり
  //   する JPYC 決済等) を利用する店主にご負担いただく月額の利用料で、当月のガスレス受領額の
  //   1% を基準に算出し翌月以降にまとめて後払い請求する (実際の gas 額とは非連動・gas 回収では
  //   なく本サービス利用の対価)。商品代金等は引き続き全額が店主へ直接着金し (当社は売上を
  //   受領/保管/精算しない)、利用料は別途店主から当社指定ウォレットへ送金される。決済の受け取り
  //   そのもの・通常決済（ガスあり）・顧客が gas を負担する USDC 経路は無料。未払い時はガスレス
  //   中継のみ停止 (受け取り自体・通常決済は継続)。2026 年 6 月のご利用分までは無料 (0%)。
  //   旧「現在 0%・将来検討中」文言を是正し、用語を「OpenPay 利用手数料」→「OpenPay 利用料」へ
  //   統一。Terms 第3条/第5条・Disclaimer 冒頭/§7・特商法 (役務の対価/支払時期/返品)・Landing
  //   /FAQ を改定。民法 548 条の 4 (定型約款の変更) に基づき、施行日 (2026-06-09) 以降の利用に
  //   適用し、有料化は 2026 年 7 月利用分から (約 3 週間の事前周知・利用料はガスレスを使わなければ
  //   発生せず通常決済は無料のため、変更の相当性・必要性を充足)。Privacy は料金モデルに直接
  //   言及しないため据置だが、用語統一 (利用手数料→利用料) のみ反映。
  // 2026-06-12 改定 (無料化ピボット撤回・JPYC ガスレスを per-tx 利用料へ・3文書 Terms/Disclaimer/
  //   特商法): 2026-06-05 の「JPYC ガスを当社が全額負担し相当額を一切徴収しない (無徴収・100%着金)」
  //   という絶対的開示と、2026-06-09 の「月次後払いの a1 月額利用料 (前月ガスレス受領額の 1%)」の
  //   いずれをも JPYC ガスレス決済について撤回し、決済 1 件ごとに決済時 (オンチェーン精算時) に
  //   差し引く per-tx の「OpenPay 利用料」へ改める。利用料額は 1 決済あたり「当面 約 2 JPYC、
  //   2026 年 7 月のご利用分から 決済額の 1%・最低 2 JPYC」とし、当該額を決済と同一の tx 内で
  //   atomic に OpenPay 指定ウォレット (fee-receiver) へ分割する (当社は商品代金本体を受領・保管・
  //   精算しないノンカストディを維持し、分割されるのは利用料部分のみ)。負担者 (お客様が上乗せ /
  //   店舗が受取から吸収) は店舗が gasMode トグルで選択する。これに伴い、JPYC ガスレスについて
  //   「無徴収」「全額負担」「徴収しません」「全額が直接送金」「100%着金」「月次後払い」「翌月以降」
  //   等の旧文言を、per-tx 利用料が決済時に差し引かれ純着金額は負担者により決まる旨の正確な記述へ
  //   置換 (gas の「回収/立替」目的の語は再導入しない・本利用料は gas 回収ではなく本サービス利用の
  //   対価)。**ただし通常決済（ガスあり）モード、および顧客が自ら gas を負担する USDC 経路 (Circle /
  //   ERC20 Paymaster) は従前どおり OpenPay 利用料の対象外 (無料) であり、当該 carve-out は撤回しない。**
  //   また forwarder 未設定の JPYC 無料 (free) 経路が残る限り当該決済に利用料は発生しない (本改定は
  //   forwarder を設定した recover 経路を前提とする開示)。民法 548 条の 4 (定型約款の変更) に基づき
  //   施行日 (2026-06-12) 以降の利用に適用 (利用料はガスレスを使わなければ発生せず通常決済・USDC 経路は
  //   無料のため、変更の相当性・必要性を充足)。Privacy は料金モデルに直接言及しないため据置。
  //   ⚠️ 本文面は弁護士 review 前の draft。per-tx 利用料 vs gas-recovery framing 等は要法務確認。
  // 2026-06-13 改定 (負担者の固定化・3文書 Terms/Disclaimer/特商法): 2026-06-12 の per-tx 利用料の
  //   負担者を「店主が gasMode トグルで選択 (お客様上乗せ/店舗吸収)」としていた点を撤回し、決済
  //   (/pay・/checkout・レジ) は **店舗 (店主) が手数料を常に負担する固定** に改める (お客様は表示
  //   された決済額のみをお支払いになり、利用料は店主の受取額から差し引かれる・per-QR の負担者トグルは
  //   撤去)。利用料率は不変 (1 決済あたり当面 約 2 JPYC、2026 年 7 月のご利用分から 決済額の 1%・最低
  //   2 JPYC)。他方、クリエイターへのチップ (/tip・@handle) については、チップをお送りになるお客様
  //   (チッパー) が **ガス相当額 (1 件あたり 約 2 JPYC・決済額の 1% は適用しない)** をチップ額に上乗せ
  //   して負担する (チップは固定額のガス相当のみで、bps の 1% は乗せない)。通常決済（ガスあり）および
  //   顧客が自ら gas を負担する USDC 経路 (Circle / ERC20 Paymaster) の carve-out (無料) は不変。
  //   民法 548 条の 4 に基づき施行日 (2026-06-13) 以降の利用に適用。Privacy は据置。⚠️ 弁護士 review 前 draft。
  termsEffectiveDate: '2026-06-13',
  privacyEffectiveDate: '2026-06-08',
  disclaimerEffectiveDate: '2026-06-13',
  tokuteiEffectiveDate: '2026-06-13',

  // copyright 起点年。表記は <year>-<currentYear> で動的描画。
  copyrightStartYear: 2026,

  // Terms 第9条(2) の損害賠償責任上限額 (円)。OpenPay 利用料 (per-tx・1 決済あたり 約 2 JPYC
  // または決済額の 1%・最低 2 JPYC) は 1 件あたり少額となりうるため、消費者契約の軽過失上限が
  // 実質的に過小化するのを避けるための固定下限 (上限は「取引金額 / 本定数 / 直近6か月の支払額」の最大値)。
  // 変更時は本定数のみ修正すればよく、規約本文 (messages/{ja,en}.json art9) は {amount}
  // 補間で追従するため ja/en が乖離しない (page 側で固定ロケール整形して同一文字列を
  // 両言語へ注入)。
  liabilityCapJpy: 10000,
} as const;

// 開示済みの JPYC ガスレス決済 per-tx 利用料の「約束した数値」(SOT)。Terms 第3条/第5条・
// Disclaimer §7・特商法 (役務の対価/支払時期/返品)・お知らせ (lib/news.ts) の本文に書かれている
// 数値そのもので、これらの文書はこの定数と矛盾してはならない。
//   floorJpyc          = 当面 (= 2026 年 6 月利用分まで・および 7 月以降の最低額) の固定フロア
//                        「約 2 JPYC」「最低 2 JPYC」として開示。
//                        実装の既定 = relayGasFeeValue() (NEXT_PUBLIC_RELAY_GAS_FEE_JPYC 既定 2)。
//   percentFromJulyBps = 2026 年 7 月のご利用分から適用する決済額連動率 (= 1% = 100 bps) として開示。
//                        実装 = recoverFeeBps() (NEXT_PUBLIC_RECOVER_FEE_BPS・現在 0・7 月に 100 予定)。
//
// ⚠️ 重要: これらは法務文書 (Terms/Disclaimer/特商法/お知らせ) で利用者に約束した数値である。
//   ここを変更する = 利用者への開示を変更することなので、必ず法務文書本文の改定 (新しい
//   「改定」エントリの追記 + 施行日更新 + 弁護士確認) を伴わなければならない。逆に env
//   (NEXT_PUBLIC_RELAY_GAS_FEE_JPYC / NEXT_PUBLIC_RECOVER_FEE_BPS) をこの定数と乖離させて
//   運用すると、文書が黙って嘘になる。relay route module load の起動時診断
//   (feeDisclosureDivergence) が live env とこの定数を突き合わせて Sentry に警告する。
//   フェンステスト (tests/app/legal.test.tsx / tests/lib/news.test.ts) が、描画される法務/お知らせ
//   本文がこの定数から導いた数値を含むことを assert する (定数だけ・本文だけの片側変更で fail)。
export const DISCLOSED_RECOVER_FEE = {
  floorJpyc: 2,
  percentFromJulyBps: 100,
} as const;

// 開示済みスケジュールの分岐点: 決済額連動率 (= percentFromJulyBps = 1%) を適用し始める時期。
// 「2026 年 7 月のご利用分から」= 2026-07-01 00:00 UTC 以降。これより前は bps=0 (フロアのみ) が
// 開示済みの正。日付境界の比較に使う (CDX-4b)。
const PERCENT_EFFECTIVE_FROM = Date.UTC(2026, 6, 1); // 2026-07-01T00:00:00Z (month は 0-indexed)

// L4: live env (実際に徴収する数値) が法務文書で開示済みの数値 (DISCLOSED_RECOVER_FEE) と
// 乖離していないかを判定する純関数。乖離していれば人間可読な理由文字列を、一致していれば null を返す。
//   - floor: relayGasFeeValue() (= NEXT_PUBLIC_RELAY_GAS_FEE_JPYC) が「約 2 JPYC / 最低 2 JPYC」
//     として開示した floorJpyc (×10^18) と一致するか。
//   - bps (CDX-4b: 日付対応): 開示スケジュールは「当面フロアのみ (bps=0)、2026 年 7 月のご利用分から
//     1% (= percentFromJulyBps = 100)」。よって *現在日付* で期待 bps が決まる:
//       2026-07-01 UTC より前 → 期待 bps は 0。100 を早期に設定すると開示前に 1% を徴収する乖離 (warn)。
//       2026-07-01 UTC 以降   → 期待 bps は percentFromJulyBps (100)。0 のままだと 7 月の料率反映漏れ (warn)。
//     これにより「6 月に bps=100 を入れてしまった (早期徴収)」「7 月に bps=0 のまま (反映漏れ)」の両方を検知。
// テスト容易化のため現在日付を注入できる (now 既定 = new Date())。relay route module load の
// 起動時診断がこれを呼び、非 null なら logger.warn で Sentry に上げる (throw はしない — 決済は止めず、
// 運営に「文書を改定せず env だけ変えた」乖離を可視化するだけ)。
export function feeDisclosureDivergence(now: Date = new Date()): string | null {
  const floorActual = relayGasFeeValue();
  const floorExpected = BigInt(DISCLOSED_RECOVER_FEE.floorJpyc) * 10n ** 18n;
  const bps = env.recoverFeeBps;
  // 現在が 7 月以降か否かで開示済みの期待 bps が一意に決まる (単一の許容値・日付対応)。
  const expectedBps =
    now.getTime() >= PERCENT_EFFECTIVE_FROM
      ? DISCLOSED_RECOVER_FEE.percentFromJulyBps
      : 0;
  const issues: string[] = [];
  if (floorActual !== floorExpected) {
    issues.push(
      `relayGasFeeValue=${floorActual} != disclosed floor ${floorExpected} ` +
        `(NEXT_PUBLIC_RELAY_GAS_FEE_JPYC vs DISCLOSED_RECOVER_FEE.floorJpyc=${DISCLOSED_RECOVER_FEE.floorJpyc})`,
    );
  }
  if (bps !== expectedBps) {
    issues.push(
      `recoverFeeBps=${bps} != date-aware expected ${expectedBps} ` +
        `(${now.getTime() >= PERCENT_EFFECTIVE_FROM ? '2026-07-01 以降は percentFromJulyBps を適用' : '2026-07-01 より前はフロアのみ bps=0 が開示済み'}; ` +
        `NEXT_PUBLIC_RECOVER_FEE_BPS vs DISCLOSED_RECOVER_FEE.percentFromJulyBps=${DISCLOSED_RECOVER_FEE.percentFromJulyBps})`,
    );
  }
  return issues.length > 0 ? issues.join('; ') : null;
}
