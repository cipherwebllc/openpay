// ランディング用デモ収録の共有シード。受取先を「一度設定済み」の状態で始めるため
// localStorage (openpay:qr-settings:v2) を addInitScript で先に書く。源は useQrSettings.ts。
export const QR_SETTINGS_KEY = 'openpay:qr-settings:v2';
export const DEMO_RECEIVER = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';

// 収録時だけスクロールバーを隠す (overflow-y-auto のモーダルで右に 15px の
// スクロールバー溝が出て中央寄せが左にズレ、右側に灰色が残るのを防ぐ)。
// 製品 CSS は変えず addInitScript で注入する録画専用の見た目調整。
export function hideScrollbars() {
  const css =
    '::-webkit-scrollbar{display:none!important;width:0!important;height:0!important}' +
    'html{scrollbar-width:none!important}';
  const apply = () => {
    const s = document.createElement('style');
    s.textContent = css;
    (document.head || document.documentElement).appendChild(s);
  };
  if (document.head || document.documentElement) apply();
  else document.addEventListener('DOMContentLoaded', apply);
}

// useQrSettings の永続形に合わせた完全な設定 (検証で drop されないよう全 field を埋める)。
// receiverSource:'manual' なのでウォレット未接続でも useReceiverAutofill に上書きされない。
export const SEED_QR_SETTINGS = {
  receiver: DEMO_RECEIVER,
  receiverSource: 'manual',
  token: 'jpyc',
  chain: 'polygon',
  gasMode: 'customer',
  payMode: 'gasless',
  splits: [],
  storeName: 'OpenPay Store',
  posterNote: '',
  quickAmounts: { jpyc: ['500', '1000', '1500', '3000'], usdc: ['5', '10', '20', '50'] },
  crossChain: true,
  productName: '',
  memo: '',
  taxRate: null,
  taxCategory: null,
};
