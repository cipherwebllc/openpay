import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import { getAddress } from 'viem';
import { renderWithIntl } from '../_helpers/i18n';
import { CreatorStoreLicenseDetails } from '@/components/CreatorStoreLicenseDetails';
import { CreatorStoreLicenseNftState } from '@/components/CreatorStoreLicenseNftState';
import { CreatorStorePurchaseConfirmation } from '@/components/CreatorStorePurchaseConfirmation';
import { CreatorStorePurchaseState } from '@/components/CreatorStorePurchaseState';
import { licenseMintTxUrl, type StoreLicenseProof } from '@/lib/licenseUi';
import type { JpycRecoverSignPreview } from '@/lib/signPreview';
import ja from '@/messages/ja.json';
import en from '@/messages/en.json';

const flags = vi.hoisted(() => ({ enabled: true }));
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return { ...actual, env: { ...actual.env, get enableLicenseNftUi() { return flags.enabled; } } };
});
const license = { supply: 10, remaining: 7, transferable: false, termsUrl: 'https://example.com/terms', termsVersion: '2', tokenChainId: 137 };
const product = { productKind: 'license' as const, title: 'License', sellerName: 'Example Seller', license };
const txHash = `0x${'ab'.repeat(32)}`;
const preview: JpycRecoverSignPreview & { gasMode: 'customer' } = {
  kind: 'jpyc-recover', amountHuman: '1000', feeHuman: '10', totalHuman: '1010', totalAtomic: '1010000000000000000000',
  merchant: getAddress('0x1234567890123456789012345678901234567890'), forwarder: getAddress('0x0f4560a777415580f0680f8b56a79b0022c6b848'),
  storeName: 'License', gasMode: 'customer', expiresInMin: 10, decimals: 18, symbol: 'JPYC',
};
function confirmation(provider: 'operator' | 'third_party' = 'operator', transferable = false) {
  return <CreatorStorePurchaseConfirmation product={{ ...product, sellerRole: provider, license: { ...license, transferable } }} priceJpyc="1000" feeJpyc="10" totalJpyc="1010" sellerDisclosureHref="/ja/store/seller/0x1234" supportHref="/ja/store/seller/0x1234" signPreview={preview} isSubmitting={false} onBack={vi.fn()} onConfirm={vi.fn()} />;
}
beforeEach(() => { flags.enabled = true; });

describe('license public details and confirmation', () => {
  it('card variant はバッジと残数だけを出し、full の開示項目を出さない', () => {
    renderWithIntl(<CreatorStoreLicenseDetails product={{ ...product, sellerRole: 'third_party' }} variant="card" />);
    expect(screen.getByText(ja.CreatorStoreLicense.badge)).toBeInTheDocument();
    expect(screen.getByText(ja.CreatorStoreLicense.remaining.replace('{remaining}', '7').replace('{supply}', '10'))).toBeInTheDocument();
    expect(screen.queryByText(ja.CreatorStoreLicense.nonTransferable)).not.toBeInTheDocument();
    expect(screen.queryByText(ja.CreatorStoreLicense.sellerThirdParty.replace('{name}', 'Example Seller'))).not.toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.queryByText(ja.CreatorStoreLicense.deliveryNotice)).not.toBeInTheDocument();
  });
  it('card variant も在庫不明を在庫ありに見せない', () => {
    renderWithIntl(<CreatorStoreLicenseDetails product={{ ...product, license: { ...license, remaining: null } }} variant="card" />);
    expect(screen.getByText(ja.CreatorStoreLicense.remainingUnknown)).toBeInTheDocument();
  });
  it('在庫ゼロと取得失敗を区別する', () => {
    const { rerender } = renderWithIntl(<CreatorStoreLicenseDetails product={{ ...product, license: { ...license, remaining: 0 } }} />);
    expect(screen.getByText('残り 0 / 10 · 譲渡不可')).toBeInTheDocument();
    rerender(<CreatorStoreLicenseDetails product={{ ...product, license: { ...license, remaining: null } }} />);
    expect(screen.getByText('残数を確認できません · 譲渡不可')).toBeInTheDocument();
    expect(screen.queryByText(/残り 0/)).not.toBeInTheDocument();
  });
  it('公開カードはサーバー由来の残数・譲渡・外部の利用条件と発行案内を示す', () => {
    const { container } = renderWithIntl(<CreatorStoreLicenseDetails product={product} />);
    expect(screen.getByText('利用ライセンス NFT')).toBeInTheDocument();
    expect(screen.getByText('残り 7 / 10 · 譲渡不可')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '利用条件（バージョン 2）' })).toHaveAttribute('href', license.termsUrl);
    expect(screen.getByRole('link')).toHaveAttribute('target', '_blank');
    expect(screen.getByText(ja.CreatorStoreLicense.deliveryNotice)).toBeInTheDocument();
    expect(container).not.toHaveTextContent(/tokenId|definitionHash|contract/);
  });
  it('flag OFF では追加の公開表示も NFT 状態もない', () => {
    flags.enabled = false;
    const { container } = renderWithIntl(<><CreatorStoreLicenseDetails product={product} /><CreatorStoreLicenseNftState nft={{ status: 'pending' }} /></>);
    expect(container).toBeEmptyDOMElement();
  });
  it('最終確認で第13条のライセンス開示と合計を示す', () => {
    renderWithIntl(confirmation());
    for (const key of ['sellerOperator', 'scopeLabel', 'scopeBody', 'meteredBody', 'issueBody', 'refundBody', 'nonTransferBody', 'publicBody'] as const) expect(screen.getByText(ja.CreatorStoreLicense[key])).toBeInTheDocument();
    expect(within(screen.getByText('支払総額（価格 + 手数料）').parentElement!).getByText('1010 JPYC')).toBeInTheDocument();
    expect(screen.getByText('商品価格').parentElement).toHaveTextContent('1000 JPYC');
    expect(screen.getByText('買い手負担 x402 手数料').parentElement).toHaveTextContent('10 JPYC');
    expect(screen.getByRole('link', { name: '利用条件（バージョン 2）' })).toHaveAttribute('href', license.termsUrl);
    expect(screen.queryByText(/購入者本人の私的利用に限り/)).not.toBeInTheDocument();
  });
  it('第三者と譲渡可の条件を取り違えない', () => {
    renderWithIntl(confirmation('third_party', true));
    expect(screen.getByText(ja.CreatorStoreLicense.sellerThirdParty.replace('{name}', 'Example Seller'))).toBeInTheDocument();
    expect(screen.getByText(ja.CreatorStoreLicense.providerThirdPartyNote)).toBeInTheDocument();
    expect(screen.getByText(ja.CreatorStoreLicense.transferBody)).toBeInTheDocument();
    expect(screen.queryByText(ja.CreatorStoreLicense.nonTransferBody)).not.toBeInTheDocument();
  });
  it('OFF の確認画面には既存のデジタル開示が残る', () => {
    flags.enabled = false; renderWithIntl(confirmation());
    expect(screen.queryByText(ja.CreatorStoreLicense.publicLabel)).not.toBeInTheDocument();
    expect(screen.getByText(/購入者本人の私的利用に限り/)).toBeInTheDocument();
  });
  it('英語 namespace から同じライセンス開示を表示する', () => {
    renderWithIntl(confirmation('third_party'), { locale: 'en' });
    expect(screen.getByText(en.CreatorStoreLicense.publicBody)).toBeInTheDocument();
    expect(screen.getByText(en.CreatorStoreLicense.issueBody)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Terms (version 2)' })).toHaveAttribute('href', license.termsUrl);
  });

  it('English details use the version wording', () => {
    renderWithIntl(<CreatorStoreLicenseDetails product={product} />, { locale: 'en' });
    expect(screen.getByRole('link', { name: 'Terms (version 2)' })).toHaveAttribute('href', license.termsUrl);
  });

});

describe('license NFT states', () => {
  it.each([
    ['awaiting_finality', '発行待ち'], ['pending', '発行待ち'], ['submitted', '発行待ち'], ['minted', '発行済み'], ['retryable', '修復中'], ['needs_repair', '修復中'], ['unknown', '確認できませんでした'],
  ] as const)('%s を表示する', (status, label) => {
    renderWithIntl(<CreatorStoreLicenseNftState nft={{ status }} entitled basis="purchase" chainId={137} />);
    expect(screen.getByText(`NFT 状態: ${label}`)).toBeInTheDocument();
    expect(screen.getByText(ja.CreatorStoreLicense.purchaseRights)).toBeInTheDocument();
  });
  it.each([137, 80002])('発行済みはチェーン %s の tx を開く', (chainId) => {
    renderWithIntl(<CreatorStoreLicenseNftState nft={{ status: 'minted', mintTxHash: txHash }} chainId={chainId} />);
    expect(screen.getByRole('link', { name: '発行トランザクションを見る' })).toHaveAttribute('href', `https://${chainId === 80002 ? 'amoy.' : ''}polygonscan.com/tx/${txHash}`);
  });
  it('移転済みと RPC 不明を区別し、submitted hash を発行完了と誤表示しない', () => {
    const { rerender } = renderWithIntl(<CreatorStoreLicenseNftState nft={{ status: 'minted' }} entitled={false} basis="holder" />);
    expect(screen.getByText('NFT 状態: 譲渡済み')).toBeInTheDocument();
    expect(screen.getByText(ja.CreatorStoreLicense.transferredRights)).toBeInTheDocument();
    rerender(<CreatorStoreLicenseNftState nft={{ status: 'unknown' }} entitled={null} basis={null} />);
    expect(screen.queryByText('NFT 状態: 譲渡済み')).not.toBeInTheDocument();
    rerender(<CreatorStoreLicenseNftState nft={{ status: 'submitted', mintTxHash: txHash } as StoreLicenseProof} />);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(licenseMintTxUrl('javascript:alert(1)', 137)).toBeNull();
    expect(licenseMintTxUrl(txHash, 1)).toBeNull();
    expect(licenseMintTxUrl(txHash)).toBeNull();
  });
  it('支払い未確定なら権利発生の表示を出さず、確定後に発行案内を表示する', () => {
    const props = { productKind: 'license' as const, accessStatus: 'provisioning' as const, ownershipReadBack: false, libraryHref: '/ja/store/library', supportHref: '/ja/store/seller/a' };
    const { rerender } = renderWithIntl(<CreatorStorePurchaseState {...props} paymentStatus="unknown" />);
    expect(screen.queryByText(ja.CreatorStoreLicense.deliveryNotice)).not.toBeInTheDocument();
    rerender(<CreatorStorePurchaseState {...props} paymentStatus="confirmed" />);
    expect(screen.getByText(ja.CreatorStoreLicense.deliveryNotice)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '購入済みライブラリを開く' })).not.toBeInTheDocument();
  });
});


it('公開カードは server の販売者区分と名前を表示する', () => {
  const { rerender } = renderWithIntl(<CreatorStoreLicenseDetails product={{ ...product, sellerRole: 'operator' }} />);
  expect(screen.getByText('販売者: OpenPay (運営)')).toBeInTheDocument();
  rerender(<CreatorStoreLicenseDetails product={{ ...product, sellerRole: 'third_party' }} />);
  expect(screen.getByText('販売者: 第三者出品者 (Example Seller)')).toBeInTheDocument();
  expect(screen.queryByText('販売者: OpenPay (運営)')).not.toBeInTheDocument();
});
