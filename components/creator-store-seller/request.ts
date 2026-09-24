// creator store の owner API 呼び出しと、エラー応答 (code / detail) の i18n key 対応。
// 親 (CreatorStoreSellerPanel) の mutation / query と各表示部品のエラー表示が共有する。

export class StoreRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail?: string,
  ) {
    super(code);
    this.name = 'StoreRequestError';
  }
}

export function errorCode(error: unknown): string {
  return error instanceof StoreRequestError ? error.code : 'request_failed';
}

// parseHostedInput / parseSellerDisclosureInput の detail (安定した英語句) を i18n key へ
// 対応付ける。未知 detail は requestError の code 表示に落とす — 本番実害 (2026-07-30):
// detail を捨てて invalid_product だけ出すと、出品者は何を直せばよいか分からない。
const DETAIL_MESSAGE_KEYS: Record<string, string> = {
  'payTo must not be the fee receiver': 'detailPayToFeeReceiver',
  'payTo must not be the forwarder': 'detailPayToForwarder',
  'invalid title': 'detailInvalidTitle',
  'invalid desc': 'detailInvalidDesc',
  'invalid details': 'detailInvalidDetails',
  'invalid specs': 'detailInvalidSpecs',
  'invalid demoUrl': 'detailInvalidDemoUrl',
  'invalid imageUrl': 'detailInvalidImageUrl',
  'invalid deliveryUrl': 'detailInvalidDeliveryUrl',
  'too many gallery images': 'detailTooManyGalleryImages',
  'invalid gallery image': 'detailInvalidGalleryImage',
  'invalid price': 'detailInvalidPrice',
  'price out of range': 'detailInvalidPrice',
  'content url must be https': 'detailInvalidUrl',
  'invalid content text': 'detailInvalidText',
  'invalid name': 'detailInvalidSellerName',
  'invalid contact': 'detailInvalidSellerContact',
  'invalid disclosure': 'detailInvalidDisclosure',
  'disclosure too long': 'detailInvalidDisclosure',
};

const ERROR_MESSAGE_KEYS: Record<string, string> = {
  usdc_pay_to_contract_wallet: 'usdcContractWalletError',
  license_registration_pending: 'licenseRegistrationHint',
  license_definition_immutable: 'licenseImmutableNotice',
};

export function errorDetailKey(error: unknown): string | null {
  if (!(error instanceof StoreRequestError) || !error.detail) return null;
  return DETAIL_MESSAGE_KEYS[error.detail] ?? null;
}

export function errorMessageKey(error: unknown): string | null {
  if (!(error instanceof StoreRequestError)) return null;
  return ERROR_MESSAGE_KEYS[error.code] ?? null;
}

export async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  // 非 JSON の障害応答で HTTP status を失う波及を断つ。ok:true を必須にするため偽成功にはしない。
  const body = (await response.json().catch(() => null)) as
    | (Record<string, unknown> & { ok?: boolean; error?: string })
    | null;
  if (!response.ok || body?.ok !== true) {
    throw new StoreRequestError(
      response.status,
      typeof body?.error === 'string' ? body.error : `http_${response.status}`,
      typeof body?.detail === 'string' ? body.detail : undefined,
    );
  }
  return body as unknown as T;
}
