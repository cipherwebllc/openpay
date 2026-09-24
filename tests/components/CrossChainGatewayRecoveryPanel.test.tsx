import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { env } from '@/lib/env';
import * as config from '@/lib/crossChain/config';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CrossChainGatewayRecoveryPanel } from '@/components/CrossChainGatewayRecoveryPanel';
import type { GatewayAttempt } from '@/lib/crossChain/gatewayRecovery';
import { gatewayAttestation, gatewaySpec, encodedSpec } from '../fixtures/gateway';
import { keccak256, pad } from 'viem';
import { renderWithIntl } from '../_helpers/i18n';

beforeEach(() => vi.spyOn(env, 'enableGatewayCrossChain', 'get').mockReturnValue(true));
afterEach(() => vi.restoreAllMocks());

function attempt(status: GatewayAttempt['status']): GatewayAttempt {
  return { status, transferSpecHash: keccak256(encodedSpec()), spec: { ...gatewaySpec, value: String(gatewaySpec.value) },
    attestation: gatewayAttestation(), maxBlockHeight: '100', txHashes: [], observations: [] };
}
describe('Gateway recovery consent', () => {
  it.each(['ja', 'en'] as const)('keeps recheck and replacement separate in %s', async (locale) => {
    const user = userEvent.setup(); const onRecheck = vi.fn();
    const merchant = attempt('replaceable');
    renderWithIntl(<CrossChainGatewayRecoveryPanel enabled={true} recovery={{ kind: 'pending', state: { merchant: { attempts: [merchant] } } }} busy={false} onRecheck={onRecheck} />, { locale });
    await user.click(screen.getByRole('button', { name: locale === 'ja' ? '送金状態を再確認' : 'Recheck transfer' }));
    expect(onRecheck).toHaveBeenLastCalledWith();
    await user.click(screen.getByRole('button', { name: locale === 'ja' ? '新しい送金に同意して署名' : 'Authorize and sign replacement' }));
    expect(onRecheck).toHaveBeenLastCalledWith({ merchant: merchant.transferSpecHash });
  });
  it('does not offer fee-only replacement after merchant settlement', () => {
    const fee = { ...attempt('replaceable'), transferSpecHash: pad('0x02') };
    renderWithIntl(<CrossChainGatewayRecoveryPanel enabled={true} recovery={{ kind: 'pending', state: { merchant: { attempts: [attempt('paid')] }, fee: { attempts: [fee] } } }} busy={false} onRecheck={vi.fn()} />);
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.getByText('送金は確定しています。取引の詳細を再取得できます。追加の支払いは不要です。')).toBeInTheDocument();
  });
  it.each(['unknown', 'awaiting-finality', 'expired-unused', 'awaiting-balance'] as const)('never offers replacement for %s', (status) => {
    renderWithIntl(<CrossChainGatewayRecoveryPanel enabled={true} recovery={{ kind: 'pending', state: { merchant: { attempts: [attempt(status)] } } }} busy={false} onRecheck={vi.fn()} />);
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });
});

it('exposes each persisted source and rechecks only the selected record', async () => {
  const user = userEvent.setup(); const onRecheck = vi.fn();
  const key = { account: '0x1111111111111111111111111111111111111111' as const, kind: 'gateway' as const,
    recipient: '0x2222222222222222222222222222222222222222' as const, destChainId: 80002, valueAtomic: 1_000_000n, feeAtomic: 0n };
  renderWithIntl(<CrossChainGatewayRecoveryPanel enabled={true} recovery={{ kind: 'pending', entries: [84532, 11155420].map((sourceChainId) => ({ kind: 'pending',
    key: { ...key, sourceChainId }, state: { merchant: { attempts: [attempt('replaceable')] } }, replacementAllowed: false })) }} busy={false} onRecheck={onRecheck} />);
  const buttons = screen.getAllByRole('button', { name: '送金状態を再確認' });
  expect(buttons).toHaveLength(2);
  expect(screen.queryByRole('button', { name: '新しい送金に同意して署名' })).not.toBeInTheDocument();
  await user.click(buttons[1]);
  expect(onRecheck).toHaveBeenCalledWith(undefined, 11155420);
});


it('renders no recovery warning during the storage scan', () => {
  const { container } = renderWithIntl(<CrossChainGatewayRecoveryPanel enabled={true} recovery={{ kind: 'scanning' }} busy={false} onRecheck={vi.fn()} />);
  expect(container).toBeEmptyDOMElement();
});


it.each(['rollout', 'kill-switch'])('hides replacement when %s blocks new transfers while retaining recheck', (flag) => {
  if (flag === 'rollout') vi.spyOn(env, 'enableGatewayCrossChain', 'get').mockReturnValue(false);
  else vi.spyOn(config, 'CROSS_CHAIN_DISABLED', 'get').mockReturnValue(true);
  renderWithIntl(<CrossChainGatewayRecoveryPanel enabled={true} recovery={{ kind: 'pending', state: { merchant: { attempts: [attempt('replaceable')] } } }} busy={false} onRecheck={vi.fn()} />);
  expect(screen.getAllByRole('button')).toHaveLength(1);
  expect(screen.getByRole('button', { name: '送金状態を再確認' })).toBeEnabled();
});

it('hides replacement when the invoice is not payable, while recheck remains available', () => {
  renderWithIntl(<CrossChainGatewayRecoveryPanel enabled={false} recovery={{ kind: 'pending', state: { merchant: { attempts: [attempt('replaceable')] } } }} busy={false} onRecheck={vi.fn()} />);
  expect(screen.getAllByRole('button')).toHaveLength(1);
  expect(screen.getByRole('button', { name: '送金状態を再確認' })).toBeEnabled();
});

it.each(['ja', 'en'] as const)('explains a mintable authorization in %s', (locale) => {
  renderWithIntl(<CrossChainGatewayRecoveryPanel enabled={true} recovery={{ kind: 'pending', state: { merchant: { attempts: [attempt('mintable')] } } }} busy={false} onRecheck={vi.fn()} />, { locale });
  expect(screen.getByText(locale === 'ja' ? '送金を完了する準備ができています。再確認すると、保存済みの承認で送金を実行します。' : 'This transfer is ready to complete. Recheck to submit the saved authorization.')).toBeInTheDocument();
});
it('surfaces lost confirmation without offering another authorization', () => {
  renderWithIntl(<CrossChainGatewayRecoveryPanel enabled={true} recovery={{ kind: 'pending', state: { completion: 'confirming', merchant: { attempts: [attempt('expired-unused')] } } }} busy={false} onRecheck={vi.fn()} />);
  expect(screen.getByText('成功と表示した送金が、確定したブロックでは未実行のまま期限切れになっています。再支払いせず、サポートに連絡してください。')).toBeInTheDocument();
  expect(screen.getAllByRole('button')).toHaveLength(1);
});
it.each([true, false])('offers explicit unsigned-fee consent only on a payable invoice (%s)', async (enabled) => {
  const onRecheck = vi.fn(); const merchant = attempt('mintable');
  const key = { kind: 'gateway' as const, sourceChainId: 84532, destChainId: 80002, account: '0x1111111111111111111111111111111111111111' as const,
    recipient: '0x2222222222222222222222222222222222222222' as const, valueAtomic: 1000000n, feeAtomic: 100n };
  renderWithIntl(<CrossChainGatewayRecoveryPanel enabled={enabled} recovery={{ kind: 'pending', key, state: { merchant: { attempts: [merchant] }, fee: { attempts: [attempt('abandoned-unsigned')] } } }} busy={false} onRecheck={onRecheck} />);
  const button = screen.queryByRole('button', { name: '手数料の送金に同意して署名' });
  if (enabled) {
    await userEvent.setup().click(button!);
    expect(onRecheck).toHaveBeenCalledWith({ authorizeFee: merchant.transferSpecHash });
  } else expect(button).not.toBeInTheDocument();
});
