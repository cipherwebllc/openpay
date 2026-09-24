import 'server-only';

// hosted creator products の KV ストア (クリエイター・ストア Phase 2)。
//
// ⚠️ **lib/x402/registry.ts (external resource) とは完全に別モジュール**。
// 理由 (計画レビュー H-3): registry の create は「global discovery index への LPUSH」を
// 常に行い、reverify cron は global index の全件を **external URL として probe** する。
// hosted を同じ index/parser に混ぜると、既存 external の discovery・cron・probeGate が
// 即座に影響を受ける。したがって index・key 空間・Lua・parser をすべて分離し、
// **registry.ts には 1 行も触れない**。
//
// key 空間 (external の `x402:resource:*` / `x402:resources:index` と衝突しない):
//   x402:hosted:<id>                        → HostedProduct (owner 限定 deliveryUrl を含む・公開時は明示 projection 必須)
//   x402:hosted:owner:<wallet>              → id の list (owner あたり cap)
//   x402:hosted:<id>:content:<revision>     → HostedContent (秘密本文・**不変**)
//
// 設計上の要点:
//   - saleActive と contentAvailable を分離 (レビュー H-5)。販売停止しても既購入者は取得可。
//     moderation の強制抹消のみ contentAvailable=false にする。
//   - content revision は不変。編集 = 新 revision を書いて公開メタを差し替える
//     (既購入者が指す revision が消えない)。
//   - payTo は feeReceiver / forwarder を**登録時に拒否** (レビュー H-2)。402 を出して
//     署名させた後に必ず失敗する構成を作らない。
//
// R15a (2026-09-24): 実装は lib/x402/hostedStore/ の 3 leaf に分割し、この file は公開名を
// 分割前と同じ path・同じ名前で再 export する facade (30 超の test が vi.mock するため)。
//   model.ts            key 空間・保存 record の型・入力検証・KV 読込時の再検証・購入 snapshot の射影
//   products.ts         product / content の KV 操作 (作成・置換・抹消は各 1 EVAL で原子化)
//   sellerDisclosure.ts 出品者の販売者情報 (特商法対応)
// leaf は facade を import しない。外 (app/components/lib の他 module/tests) は必ずこの facade から
// import する (deep import は ESLint が止める)。

export { isHostedLabel, type HostedLabel } from '@/lib/x402/storeWire';
export {
  MAX_HOSTED_PER_OWNER,
  MAX_HOSTED_TITLE_LEN,
  MAX_HOSTED_DESC_LEN,
  MAX_HOSTED_URL_LEN,
  MAX_HOSTED_GALLERY_IMAGES,
  MAX_HOSTED_DETAILS_LEN,
  MAX_HOSTED_SPECS,
  MAX_HOSTED_SPEC_LABEL_LEN,
  MAX_HOSTED_SPEC_VALUE_LEN,
  MAX_HOSTED_TEXT_CODE_POINTS,
  MIN_HOSTED_PRICE_JPYC,
  MAX_HOSTED_PRICE_JPYC,
  hostedProductKey,
  hostedOwnerIndexKey,
  hostedContentKey,
  newHostedId,
  isHostedId,
  sanitizeHostedText,
  parseHostedInput,
  parseStoredHostedProduct,
  hostedPurchaseMetadata,
  type HostedContentKind,
  type HostedProduct,
  type HostedContent,
  type HostedProductInput,
  type ParsedHostedInput,
  type HostedPurchaseMetadata,
} from '@/lib/x402/hostedStore/model';
export {
  createHostedProduct,
  getHostedProduct,
  getHostedProductUpdateSnapshot,
  getHostedContent,
  listHostedForOwner,
  listAvailableHostedForOwner,
  getHostedProductsByIds,
  selectProfileProducts,
  replaceHostedSellerProduct,
  purgeHostedContent,
  type CreateHostedResult,
  type HostedProductUpdateSnapshot,
  type ReplaceHostedSellerProductResult,
  type PurgeHostedContentResult,
} from '@/lib/x402/hostedStore/products';
export {
  MAX_SELLER_NAME_LEN,
  MAX_SELLER_CONTACT_LEN,
  MAX_SELLER_DISCLOSURE_LEN,
  sellerDisclosureKey,
  parseSellerDisclosureInput,
  putSellerDisclosure,
  getSellerDisclosure,
  sellerDisclosureComplete,
  type SellerDisclosure,
  type ParsedSellerDisclosure,
} from '@/lib/x402/hostedStore/sellerDisclosure';
