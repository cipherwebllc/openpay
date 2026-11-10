import { LEGAL_ENTITY } from '@/lib/legal';

// OpenPay 自身の origin (flag に依らない定数)。firstParty.ts から分けてあるのは、client の bundle に入る file
// (AI ストアのカードの lib/x402/usdcCatalog.ts など) がこの定数だけを取るときに、firstParty.ts が module の読み込み時に
// 作る FIRST_PARTY_RESOURCES (server 専用の flag を読む) を一緒に持ち込まないため。firstParty.ts も再 export する。
export const OPENPAY_CANONICAL_ORIGIN = new URL(LEGAL_ENTITY.siteUrl).origin;
