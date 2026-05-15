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
  termsEffectiveDate: '2026-05-16',
  privacyEffectiveDate: '2026-05-12',
  disclaimerEffectiveDate: '2026-05-16',
  tokuteiEffectiveDate: '2026-05-16',

  // copyright 起点年。表記は <year>-<currentYear> で動的描画。
  copyrightStartYear: 2026,
} as const;

export type LegalEntity = typeof LEGAL_ENTITY;
