// 事業者情報の単一 source of truth。利用規約・プライバシーポリシー・免責事項、
// 将来追加する特商法表記で共通参照する。env 注入に切替える場合もここの
// export だけ差替で済むよう、page 側からは LEGAL_ENTITY のみ参照する。
//
// TODO(user-provided): 商号・法人番号・本店所在地・代表者氏名・連絡先メールは
// 弁護士 review 前に user から実値の提供を受けて差替えること。現状の値は
// placeholder で、本番運用前に必ず置換すること。

export const LEGAL_ENTITY = {
  serviceName: 'OpenPay',

  // ===== USER PROVIDED 待ち =====
  companyName: 'サイファーウェブ合同会社',
  corporateNumber: '1110003003789', // 13 桁 (国税庁法人番号)
  headOffice: '〒950-1147 新潟県新潟市中央区高美町4-14',
  representative: '代表社員 高野勝通',
  contactEmail: 'info@cipher-web.com',
  siteUrl: 'https://open-pay.jp',
  // ===============================

  // 施行日 (各文書共通でサービス開始日に揃える)
  termsEffectiveDate: '2026-05-12',
  privacyEffectiveDate: '2026-05-12',
  disclaimerEffectiveDate: '2026-05-12',
  tokuteiEffectiveDate: '2026-05-14',

  // copyright 起点年。表記は <year>-<currentYear> で動的描画。
  copyrightStartYear: 2026,
} as const;

export type LegalEntity = typeof LEGAL_ENTITY;
