// ランディング用デモ収録の共有シード。受取先を「一度設定済み」の状態で始めるため
// localStorage (openpay:qr-settings:v2) を addInitScript で先に書く。源は useQrSettings.ts。
export const QR_SETTINGS_KEY = 'openpay:qr-settings:v2';
export const DEMO_RECEIVER = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';

// 収録時だけの見た目調整 (製品 CSS は不変・addInitScript で注入する録画専用):
//   1. スクロールバーを隠す (overflow-y-auto のモーダルで右に溝が出て中央寄せが
//      左へズレ、右に灰色が残るのを防ぐ)。
//   2. QR モーダルの暗い背景 (bg-slate-900/70) を白に上書き。背景がグレーだと
//      クロップで縁に灰色が残るため、白にして「灰色余白ゼロ」を保証する。
//      カードは shadow-xl + border で分離が出る。
export function demoChrome() {
  const css =
    '::-webkit-scrollbar{display:none!important;width:0!important;height:0!important}' +
    'html{scrollbar-width:none!important}' +
    '[role="dialog"][aria-modal="true"]{background-color:#ffffff!important}';
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
