// 事業者情報の単一 source of truth。利用規約・プライバシーポリシー・免責事項・
// 特商法表記で共通参照する。env 注入に切替える場合もここの export だけ
// 差替で済むよう、page 側からは LEGAL_ENTITY のみ参照する。
//
// 値の出所: 国税庁法人番号公表サイト (1110003003789) で住所・商号・代表者を
// 突合済 (2026-05-14)。文面そのものは alpha 段階で弁護士 review 未実施の
// draft 扱い (本番昇格時に文言精査が必要)。

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
  // 2026-05-29 改定: OpenPay 利用手数料を 0% 化 (取引額連動の % 手数料を撤廃)、
  //   ガスレスのネットワーク手数料相当額を上限価格基準の固定額で徴収する旨に
  //   Terms 第5条 / 特商法 役務の対価 を改定 (利用者の一般の利益に適合)。
  //   同改定で Disclaimer も、当社指定ウォレットへ送金されるのは「利用手数料」では
  //   なく「ネットワーク手数料相当額」である旨に冒頭・第7条を修正し、Terms 第9条(2)
  //   の賠償上限を固定額 (10,000 円) ベースに改めたため施行日を 2026-05-29 に更新。
  //   Privacy は料金モデルに直接言及しないため 2026-05-16 のまま据置。
  termsEffectiveDate: '2026-05-29',
  privacyEffectiveDate: '2026-05-16',
  disclaimerEffectiveDate: '2026-05-29',
  tokuteiEffectiveDate: '2026-05-29',

  // copyright 起点年。表記は <year>-<currentYear> で動的描画。
  copyrightStartYear: 2026,

  // Terms 第9条(2) の損害賠償責任上限額 (円)。手数料 0% 化で消費者契約の軽過失
  // 上限が実質 ¥0 化するのを避けるための固定下限。変更時は本定数のみ修正すれば
  // よく、規約本文 (messages/{ja,en}.json art9) は {amount} 補間で追従するため
  // ja/en が乖離しない (page 側で固定ロケール整形して同一文字列を両言語へ注入)。
  liabilityCapJpy: 10000,
} as const;
