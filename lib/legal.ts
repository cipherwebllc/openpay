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

import { polygon, kaia, avalanche } from 'viem/chains';
import { relayGasFeeValue } from '@/lib/relay/forwarderConfig';
import { STOREFRONT_FEE_BPS, PREORDER_FEE_BPS } from '@/lib/mobileOrderFee';
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
  // 2026-06-17 改定 (モバイル注文システム利用料の新設・flag 裏 staged): モバイル注文 (店頭/券売機・
  //   事前モバイルオーダー) 機能をご利用の場合に申し受ける「モバイル注文システム利用料」を新設。これは
  //   OpenPay 利用料のうちモバイル注文ご利用時の料率で、gas-recovery の per-tx 利用料とは **重複せず・
  //   決済ごとにいずれか一方のみ** を適用する (上乗せではない・モバイル料率に肩代わり gas も含む)。
  //   店舗ページ・メニュー・注文管理・受注リレー等を含むモバイル注文システム提供の対価であり、
  //   決済経路 (ガスレス relay / 通常決済) に **依存せず一律** に申し受ける (gas を肩代わりしない通常決済でも対象)。料率は 店頭/券売機=決済額の 1%、事前モバイル
  //   オーダー=決済額の 3% とし、事前モバイルオーダーは店舗の選択で【店舗負担】(店舗の受取から差引) /
  //   【顧客上乗せ】(お客様が商品代金に加えてお支払い) のいずれか。商品代金本体は引き続き店舗のウォレット
  //   へ直接着金し (当社は売上を受領/保管/精算しない)、当該利用料部分のみ決済と同一取引内で当社指定ウォレット
  //   へ分割される (ノンカストディ不変)。/pay QR・チップ (/tip)・通常の決済リンクは本利用料の **対象外**
  //   (従来どおり)。本機能は現在 flag 裏で未提供 (NEXT_PUBLIC_ENABLE_MOBILE_ORDER_FEE 既定 OFF) で、提供開始
  //   (点灯) は本開示と同一リリース + 別途明示の承認後。新規・任意の付加機能ゆえ既存取引には遡及しない
  //   (相当性・必要性を充足)。⚠️ 弁護士 review 前 draft。
  // 2026-06-28 改定 (x402 ファシリテーター利用料の新設・3 文書 Terms/特商法/お知らせ追記): AI エージェント
  //   向け managed x402 都度課金ファシリテーターの運用対価を新設。決済額の 1%・最低 2 JPYC・**買い手上乗せ**
  //   (売り手=リソース登録者は表示額をそのまま受領)・ノンカストディ (当社は売上を預からず、利用料部分のみ
  //   決済と同一 tx 内で当社指定ウォレットへ分割)。当社が肩代わりする gas は本利用料に含む。OpenPay 利用料
  //   (relay) / モバイル注文システム利用料とは独立の別対価で、x402 経由の決済には重複適用しない。SOT は
  //   DISCLOSED_X402_FEE (= 100bps / 1 JPYC。2026-07-05 改定で下限 2→1 JPYC) と一致。施行日は x402FacilitatorFeeEffectiveDate (2026-06-28)
  //   で別管理し、機能提供開始 (NEXT_PUBLIC_ENABLE_X402_FACILITATOR 点灯) まで実際の徴収は発生しない (新規・
  //   任意の付加機能ゆえ既存取引に遡及しない)。
  // 2026-07-14 改定案 (Shops API・merge 前 user 承認対象): Privacy に店舗の明示同意に基づく
  //   AI/API 利用者への掲載情報提供・目的・項目・電話番号除外・解除/保持を追加。Terms に検索/注文支援
  //   目的の利用許諾、データ自体の再販/一括再配布制限、店舗提供情報の正確性に関する条項を追加。
  termsEffectiveDate: '2026-07-14',
  privacyEffectiveDate: '2026-07-14',
  disclaimerEffectiveDate: '2026-06-13',
  tokuteiEffectiveDate: '2026-06-13',
  // モバイル注文システム利用料の施行日 (本利用料を新設した開示の公表日)。doc 全体の施行日 (上記
  // 2026-06-13) とは別管理 — 本利用料は新規・任意の付加機能 (モバイル注文) に対する個別条項で、機能の
  // 提供開始 (flag 点灯) まで実際の徴収は発生しない。本文は本定数の日付を補間して表示する。
  mobileOrderFeeEffectiveDate: '2026-06-17',
  // x402 ファシリテーター利用料の施行日 (本利用料を新設した開示の公表日)。mobileOrderFeeEffectiveDate と
  // 同様に doc 全体の施行日 (2026-06-13) とは別管理 — 新規・任意の付加機能 (AI エージェント向け x402
  // 都度課金ファシリテーター) に対する個別条項で、機能の提供開始 (NEXT_PUBLIC_ENABLE_X402_FACILITATOR
  // 点灯) まで実際の徴収は発生しない。Terms 第5条(9)/特商法 役務の対価/お知らせ本文は本日付を記載する。
  x402FacilitatorFeeEffectiveDate: '2026-06-28',

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

// 開示済みフロア (DISCLOSED_RECOVER_FEE.floorJpyc) を「約 2 JPYC / 最低 2 JPYC」として約束した mainnet
// relay チェーン。Polygon/Kaia/Avalanche が同一フロア (2 JPYC) で開示済み。Avalanche は 2026-06-15 に
// 本点灯したが、実 gas が極小 (≈¥0.006/件) のため Polygon/Kaia と同一の 2 JPYC フロアを採用 → 既存の
// 汎用開示文「約 2 JPYC / 最低 2 JPYC」がそのまま正確に適用され、per-chain 開示本文の改定は不要。
// ⚠️ いずれかの chain を floor≠2 で運用する場合は (1) DISCLOSED_RECOVER_FEE を per-chain 化し
// (2) 同一リリースで開示本文 (Terms/Disclaimer/特商法/お知らせ ja+en) も改定すること。本ガードが per-chain
// で乖離を検出するため、片側だけの変更 (env だけ floor=7 等 / 定数だけ) は warn する。
const DISCLOSED_FLOOR_CHAINS: number[] = [polygon.id, kaia.id, avalanche.id];

// L4: live env (実際に徴収する数値) が法務文書で開示済みの数値 (DISCLOSED_RECOVER_FEE) と
// 乖離していないかを判定する純関数。乖離していれば人間可読な理由文字列を、一致していれば null を返す。
//   - floor (per-chain): 開示済み各 mainnet relay チェーン (DISCLOSED_FLOOR_CHAINS) で
//     relayGasFeeValue(chainId) が「約 2 JPYC / 最低 2 JPYC」として開示した floorJpyc (×10^18) と一致するか。
//     per-chain env (NEXT_PUBLIC_RELAY_GAS_FEE_JPYC_<SLUG>) かグローバル env のどちらで乖離させても検出する。
//   - bps (CDX-4b: 日付対応): 開示スケジュールは「当面フロアのみ (bps=0)、2026 年 7 月のご利用分から
//     1% (= percentFromJulyBps = 100)」。よって *現在日付* で期待 bps が決まる:
//       2026-07-01 UTC より前 → 期待 bps は 0。100 を早期に設定すると開示前に 1% を徴収する乖離 (warn)。
//       2026-07-01 UTC 以降   → 期待 bps は percentFromJulyBps (100)。0 のままだと 7 月の料率反映漏れ (warn)。
//     これにより「6 月に bps=100 を入れてしまった (早期徴収)」「7 月に bps=0 のまま (反映漏れ)」の両方を検知。
// テスト容易化のため現在日付を注入できる (now 既定 = new Date())。relay route module load の
// 起動時診断がこれを呼び、非 null なら logger.warn で Sentry に上げる (throw はしない — 決済は止めず、
// 運営に「文書を改定せず env だけ変えた」乖離を可視化するだけ)。
export function feeDisclosureDivergence(now: Date = new Date()): string | null {
  const floorExpected = BigInt(DISCLOSED_RECOVER_FEE.floorJpyc) * 10n ** 18n;
  const bps = env.recoverFeeBps;
  // 現在が 7 月以降か否かで開示済みの期待 bps が一意に決まる (単一の許容値・日付対応)。
  const expectedBps =
    now.getTime() >= PERCENT_EFFECTIVE_FROM
      ? DISCLOSED_RECOVER_FEE.percentFromJulyBps
      : 0;
  const issues: string[] = [];
  for (const chainId of DISCLOSED_FLOOR_CHAINS) {
    const floorActual = relayGasFeeValue(chainId);
    if (floorActual !== floorExpected) {
      issues.push(
        `relayGasFeeValue(${chainId})=${floorActual} != disclosed floor ${floorExpected} ` +
          `(NEXT_PUBLIC_RELAY_GAS_FEE_JPYC[_<chain>] vs DISCLOSED_RECOVER_FEE.floorJpyc=${DISCLOSED_RECOVER_FEE.floorJpyc})`,
      );
    }
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

// 開示済みの「モバイル注文システム利用料」料率 (SOT)。Terms/Disclaimer/特商法/お知らせ の本文に書かれた
// 数値そのもので、これらの文書はこの定数と矛盾してはならない。店頭/券売機=1% (100bps)・事前モバイル
// オーダー=3% (300bps)。実装の率は lib/mobileOrderFee.ts (STOREFRONT_FEE_BPS / PREORDER_FEE_BPS) で、
// 本定数と一致しなければならない。gas-recovery 料金 (DISCLOSED_RECOVER_FEE) とは独立 (別の対価)。
// ⚠️ 重要: これらは法務文書で利用者に約束した数値。変更する = 開示の変更ゆえ、必ず本文改定 (新「改定」
//   エントリ + フェンステスト更新) を伴わなければならない。下の guard が実装の率と本定数の乖離を検出する。
export const DISCLOSED_MOBILE_ORDER_FEE = {
  storefrontBps: 100, // 店頭/券売機 1%
  preorderBps: 300, // 事前モバイルオーダー 3%
} as const;

// 実装の料率 (lib/mobileOrderFee.ts) が開示済みの数値 (DISCLOSED_MOBILE_ORDER_FEE) と乖離していないかを
// 判定する純関数。乖離していれば人間可読な理由文字列、一致していれば null。率は静的定数 (env 非依存) の
// ため、フェンステスト (tests/lib/mobileOrderFeeDisclosure.test.ts) が CI で乖離を検出すれば十分で、
// runtime 診断は持たない (env を読む gas-recovery の feeDisclosureDivergence は deploy 時 env ドリフトを
// 捕捉する必要があるため runtime でも呼ぶが、本関数は静的なので CI フェンスで足りる)。
export function mobileOrderFeeDisclosureDivergence(): string | null {
  const issues: string[] = [];
  if (STOREFRONT_FEE_BPS !== DISCLOSED_MOBILE_ORDER_FEE.storefrontBps) {
    issues.push(
      `STOREFRONT_FEE_BPS=${STOREFRONT_FEE_BPS} != disclosed storefrontBps ` +
        `${DISCLOSED_MOBILE_ORDER_FEE.storefrontBps} ` +
        `(lib/mobileOrderFee.ts vs lib/legal.ts DISCLOSED_MOBILE_ORDER_FEE)`,
    );
  }
  if (PREORDER_FEE_BPS !== DISCLOSED_MOBILE_ORDER_FEE.preorderBps) {
    issues.push(
      `PREORDER_FEE_BPS=${PREORDER_FEE_BPS} != disclosed preorderBps ` +
        `${DISCLOSED_MOBILE_ORDER_FEE.preorderBps} ` +
        `(lib/mobileOrderFee.ts vs lib/legal.ts DISCLOSED_MOBILE_ORDER_FEE)`,
    );
  }
  return issues.length > 0 ? issues.join('; ') : null;
}

// 開示済みの「x402 ファシリテーター利用料」料率 (SOT)。Terms/Disclaimer/特商法/お知らせ/README の本文に
// 書かれた数値そのもので、これらの文書はこの定数と矛盾してはならない。決済額の 1% (100bps)・下限 2 JPYC・
// **買い手上乗せ** (seller は表示額をそのまま受領)。実装は lib/x402/facilitatorConfig.ts
// (X402_FEE_BPS / X402_FEE_FLOOR_JPYC) で、既定は本定数と一致する。gas-recovery (DISCLOSED_RECOVER_FEE) /
// モバイル注文 (DISCLOSED_MOBILE_ORDER_FEE) とは独立の別対価 (managed x402 facilitator の運用対価)。
// ⚠️ 変更する = 開示の変更ゆえ、必ず本文改定 (新「改定」エントリ) + フェンス更新を伴わなければならない。
export const DISCLOSED_X402_FEE = {
  bps: 100, // 1%
  floorJpyc: 1, // 下限 1 JPYC (2026-07-05 改定で 2→1。実測 settle ガス ~0.5 円の 2 倍を確保しつつマイクロ決済の割高感を低減)
} as const;

// 実 x402 料率 (env 由来・lib/x402/facilitatorConfig.ts) が開示済みの数値 (DISCLOSED_X402_FEE) と乖離して
// いないかを判定する純関数。legal.ts を x402 runtime config へ結合させないため live 値を引数で受け取る
// (呼出側 = facilitator route が x402FacilitatorConfig.feeBps / feeFloorWei を渡す)。乖離なら人間可読な
// 理由文字列、一致していれば null。
// ⚠️ これは **release gate ではなく best-effort な runtime 監視** (呼出側は throw せず warn/Sentry する
// のみ・呼ばれた route が最初にヒットするまで評価されない = P2-L)。開示の**静的**な数値
// (DISCLOSED_X402_FEE.bps=100 / floorJpyc=1) 自体の不意の改変は tests/lib/x402/disclosure.test.ts が
// CI で assert して止める。env 由来の**動的**な乖離 (X402_FEE_BPS を開示と別値でデプロイ) は静的検査
// 不能ゆえ本関数の runtime warn で拾う (人間のフォロー前提)。
export function x402FeeDisclosureDivergence(
  feeBps: number,
  feeFloorWei: bigint,
): string | null {
  const issues: string[] = [];
  if (feeBps !== DISCLOSED_X402_FEE.bps) {
    issues.push(
      `X402_FEE_BPS=${feeBps} != disclosed bps ${DISCLOSED_X402_FEE.bps} ` +
        `(lib/x402/facilitatorConfig.ts vs lib/legal.ts DISCLOSED_X402_FEE)`,
    );
  }
  const floorExpected = BigInt(DISCLOSED_X402_FEE.floorJpyc) * 10n ** 18n;
  if (feeFloorWei !== floorExpected) {
    issues.push(
      `X402_FEE_FLOOR_JPYC(wei)=${feeFloorWei} != disclosed floor ${floorExpected} ` +
        `(DISCLOSED_X402_FEE.floorJpyc=${DISCLOSED_X402_FEE.floorJpyc})`,
    );
  }
  return issues.length > 0 ? issues.join('; ') : null;
}
