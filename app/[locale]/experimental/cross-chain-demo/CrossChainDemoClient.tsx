'use client';

// Cross-chain demo client UI — Circle Gateway の deposit + transfer フローを
// 1 page で実行できる operator 向け検証 UI。
//
// 構成:
//   1. ConnectButton — wallet 接続
//   2. BalancesPanel — wallet 別 USDC + Gateway unified balance を 1 click 更新
//   3. DepositPanel — approve + GatewayWallet.deposit (source chain で)
//   4. TransferPanel — burn intent sign + attestation 取得 + GatewayMinter.gatewayMint (dest chain で)
//
// state machine:
//   transfer は 4 step (sign → attest → switch → mint)。各 step の status を
//   表示し、失敗時は error を表示して再実行を許可する。
//
// 実機検証想定:
//   - HashPort wallet (Alchemy MAv2 + EIP-7702) で burnIntent EOA sign が通るか
//   - 普通 EOA (MetaMask) と HashPort で挙動差分を比較
//   - testnet で 1 周 (Polygon Amoy → Base Sepolia) 動作確認

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  erc20Abi,
  formatUnits,
  parseUnits,
  type Address,
  type Hex,
} from 'viem';
import {
  useAccount,
  usePublicClient,
  useSwitchChain,
  useWalletClient,
} from 'wagmi';
import { ConnectButton } from '@/components/ConnectButton';
import {
  CROSS_CHAIN_TARGETS,
  GATEWAY_MINTER_ADDRESS,
  GATEWAY_WALLET_ADDRESS,
  chainIdForDomain,
  domainForChainId,
} from '@/lib/crossChain/config';
import {
  readAllCrossChainBalances,
  type MultiChainBalances,
} from '@/lib/crossChain/balance';
import {
  buildBurnIntent,
  encodeGatewayMintCalldata,
  getBurnIntentTypedData,
  requestAttestation,
} from '@/lib/crossChain/gateway';
import type {
  AttestationResponse,
  CircleDomain,
  SignedBurnIntentRequest,
} from '@/lib/crossChain/types';
import { resolveDeployment } from '@/lib/tokens';
import { shortAddress } from '@/lib/format';
import { blockExplorerUrl } from '@/lib/chains';

export function CrossChainDemoClient() {
  const { address, isConnected } = useAccount();

  if (!isConnected || !address) {
    return (
      <section className="rounded-2xl border border-slate-200 bg-white p-6">
        <p className="mb-3 text-sm text-slate-600">
          Wallet を接続してください。
        </p>
        <ConnectButton />
      </section>
    );
  }

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-slate-200 bg-white p-4 text-sm">
        <ConnectButton />
      </section>
      <BalancesPanel account={address} />
      <DepositPanel account={address} />
      <TransferPanel account={address} />
    </div>
  );
}

// ----- BalancesPanel -----

function BalancesPanel({ account }: { account: Address }) {
  // React Query で 30 秒 cache + manual refetch ボタンも提供
  const balancesQuery = useQuery({
    queryKey: ['crossChain.balances', account],
    queryFn: () => readAllCrossChainBalances(account),
    staleTime: 30_000,
  });

  return (
    <section className="space-y-3 rounded-2xl border border-slate-200 bg-white p-5">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-slate-900">Balances</h2>
        <button
          type="button"
          onClick={() => balancesQuery.refetch()}
          disabled={balancesQuery.isFetching}
          className="rounded-md border border-slate-300 bg-white px-3 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
        >
          {balancesQuery.isFetching ? 'refreshing…' : 'refresh'}
        </button>
      </div>

      {balancesQuery.isLoading && (
        <p className="text-xs text-slate-500">loading…</p>
      )}
      {balancesQuery.error && (
        <p className="text-xs text-red-600">
          query error: {String(balancesQuery.error)}
        </p>
      )}
      {balancesQuery.data && (
        <BalancesTable balances={balancesQuery.data} />
      )}
    </section>
  );
}

function BalancesTable({ balances }: { balances: MultiChainBalances }) {
  return (
    <div className="space-y-4">
      <div>
        <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
          Wallet USDC (on-chain)
        </p>
        <ul className="space-y-1 text-sm">
          {balances.wallet.map((w) => (
            <li
              key={w.target.chainId}
              className="flex items-center justify-between gap-3"
            >
              <span className="font-mono text-xs text-slate-600">
                chainId {w.target.chainId} · domain {w.target.domain}
              </span>
              <span className="font-mono text-sm text-slate-900">
                {w.status === 'ok'
                  ? `${formatUnits(w.balance, 6)} USDC`
                  : `error: ${w.error.slice(0, 80)}`}
              </span>
            </li>
          ))}
        </ul>
      </div>

      <div>
        <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
          Gateway unified balance (per source domain)
        </p>
        {balances.gateway.status === 'ok' ? (
          <ul className="space-y-1 text-sm">
            {CROSS_CHAIN_TARGETS.map((t) => {
              const b = balances.gateway.status === 'ok'
                ? balances.gateway.perDomain.get(t.domain) ?? 0n
                : 0n;
              return (
                <li
                  key={t.domain}
                  className="flex items-center justify-between gap-3"
                >
                  <span className="font-mono text-xs text-slate-600">
                    domain {t.domain} (chainId {t.chainId})
                  </span>
                  <span className="font-mono text-sm text-slate-900">
                    {formatUnits(b, 6)} USDC
                  </span>
                </li>
              );
            })}
            <li className="flex items-center justify-between gap-3 border-t border-slate-200 pt-1">
              <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                total (unified)
              </span>
              <span className="font-mono text-sm font-semibold text-slate-900">
                {formatUnits(balances.gateway.total, 6)} USDC
              </span>
            </li>
          </ul>
        ) : (
          <p className="text-xs text-red-600">
            Gateway API error: {balances.gateway.error.slice(0, 200)}
          </p>
        )}
      </div>
    </div>
  );
}

// ----- DepositPanel -----

function DepositPanel({ account }: { account: Address }) {
  const [sourceChainId, setSourceChainId] = useState<number>(
    CROSS_CHAIN_TARGETS[0].chainId,
  );
  const [amount, setAmount] = useState('1');
  const [status, setStatus] = useState<
    | { kind: 'idle' }
    | { kind: 'pending'; step: string }
    | { kind: 'success'; approveHash: Hex; depositHash: Hex }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' });

  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient({ chainId: sourceChainId });
  const { switchChainAsync } = useSwitchChain();

  async function onDeposit() {
    if (!walletClient || !publicClient) {
      setStatus({ kind: 'error', message: 'wallet not ready' });
      return;
    }
    const dep = resolveDeployment('usdc', sourceChainId);
    if (!dep) {
      setStatus({
        kind: 'error',
        message: `USDC deployment missing for chainId ${sourceChainId}`,
      });
      return;
    }
    const valueAtomic = parseUnits(amount, dep.decimals);

    setStatus({ kind: 'pending', step: 'switch to source chain' });
    await switchChainAsync({ chainId: sourceChainId });

    setStatus({ kind: 'pending', step: 'approve USDC to Gateway' });
    const approveHash = await walletClient.writeContract({
      address: dep.address,
      abi: erc20Abi,
      functionName: 'approve',
      args: [GATEWAY_WALLET_ADDRESS, valueAtomic],
      chain: walletClient.chain,
      account,
    });
    await publicClient.waitForTransactionReceipt({ hash: approveHash });

    setStatus({ kind: 'pending', step: 'GatewayWallet.deposit()' });
    const depositHash = await walletClient.writeContract({
      address: GATEWAY_WALLET_ADDRESS,
      abi: [
        {
          inputs: [
            { name: 'token', type: 'address' },
            { name: 'value', type: 'uint256' },
          ],
          name: 'deposit',
          outputs: [],
          stateMutability: 'nonpayable',
          type: 'function',
        },
      ] as const,
      functionName: 'deposit',
      args: [dep.address, valueAtomic],
      chain: walletClient.chain,
      account,
    });
    await publicClient.waitForTransactionReceipt({ hash: depositHash });

    setStatus({ kind: 'success', approveHash, depositHash });
  }

  return (
    <section className="space-y-3 rounded-2xl border border-slate-200 bg-white p-5">
      <h2 className="text-base font-semibold text-slate-900">
        Deposit to Gateway
      </h2>
      <p className="text-xs text-slate-600">
        source chain で USDC を Gateway に pre-deposit する。L2 deposit finality 13-19 分後に Gateway transfer が使えるようになる。
      </p>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-xs text-slate-700">
          source chain
          <select
            value={sourceChainId}
            onChange={(e) => setSourceChainId(Number(e.target.value))}
            className="rounded border border-slate-300 bg-white px-2 py-1 text-sm"
          >
            {CROSS_CHAIN_TARGETS.map((t) => (
              <option key={t.chainId} value={t.chainId}>
                chainId {t.chainId} · domain {t.domain}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-slate-700">
          amount (USDC)
          <input
            type="text"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))}
            className="rounded border border-slate-300 bg-white px-2 py-1 text-sm"
            placeholder="1"
          />
        </label>
      </div>

      <button
        type="button"
        onClick={onDeposit}
        disabled={status.kind === 'pending'}
        className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand-dark disabled:opacity-50"
      >
        {status.kind === 'pending' ? `…${status.step}` : 'Approve + Deposit'}
      </button>

      <TxStatusView
        kind={status.kind}
        pendingStep={status.kind === 'pending' ? status.step : undefined}
        errorMessage={status.kind === 'error' ? status.message : undefined}
        successText={
          status.kind === 'success'
            ? `deposit ${shortAddress(status.depositHash)} (approve ${shortAddress(status.approveHash)})`
            : undefined
        }
        successTxHash={
          status.kind === 'success' ? status.depositHash : undefined
        }
        chainId={sourceChainId}
      />
    </section>
  );
}

// ----- TransferPanel -----

function TransferPanel({ account }: { account: Address }) {
  const [sourceDomain, setSourceDomain] = useState<CircleDomain>(
    CROSS_CHAIN_TARGETS[0].domain,
  );
  const [destinationDomain, setDestinationDomain] = useState<CircleDomain>(
    CROSS_CHAIN_TARGETS[1].domain,
  );
  const [amount, setAmount] = useState('0.5');
  const [recipient, setRecipient] = useState<string>(account);
  const [status, setStatus] = useState<
    | { kind: 'idle' }
    | { kind: 'pending'; step: string }
    | { kind: 'success'; mintHash: Hex; destinationChainId: number }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' });

  const { data: walletClient } = useWalletClient();
  const sourceChainId = chainIdForDomain(sourceDomain);
  const destinationChainId = chainIdForDomain(destinationDomain);
  const sourcePublicClient = usePublicClient({ chainId: sourceChainId });
  const destPublicClient = usePublicClient({ chainId: destinationChainId });
  const { switchChainAsync } = useSwitchChain();

  async function onTransfer() {
    if (!walletClient || !sourcePublicClient || !destPublicClient) {
      setStatus({ kind: 'error', message: 'wallet not ready' });
      return;
    }
    const sourceDep = resolveDeployment('usdc', sourceChainId);
    const destDep = resolveDeployment('usdc', destinationChainId);
    if (!sourceDep || !destDep) {
      setStatus({
        kind: 'error',
        message: 'USDC deployment missing on source or destination',
      });
      return;
    }
    if (!/^0x[a-fA-F0-9]{40}$/.test(recipient)) {
      setStatus({ kind: 'error', message: 'invalid recipient address' });
      return;
    }
    const valueAtomic = parseUnits(amount, sourceDep.decimals);

    setStatus({ kind: 'pending', step: 'fetch current block height (source)' });
    const currentBlockHeight = await sourcePublicClient.getBlockNumber();

    const intent = buildBurnIntent({
      sourceDomain,
      destinationDomain,
      sourceToken: sourceDep.address,
      destinationToken: destDep.address,
      depositor: account,
      recipient: recipient as Address,
      value: valueAtomic,
      currentBlockHeight,
    });

    setStatus({ kind: 'pending', step: 'sign burn intent (EIP-712)' });
    const typedData = getBurnIntentTypedData(intent);
    const signature = (await walletClient.signTypedData({
      account,
      domain: typedData.domain,
      types: typedData.types,
      primaryType: typedData.primaryType,
      message: typedData.message,
    })) as Hex;

    setStatus({ kind: 'pending', step: 'request attestation (Circle API)' });
    const signedReq: SignedBurnIntentRequest = {
      burnIntent: intent,
      signature,
    };
    const attestation: AttestationResponse = await requestAttestation(signedReq);

    setStatus({
      kind: 'pending',
      step: `switch to destination chain (${destinationChainId})`,
    });
    await switchChainAsync({ chainId: destinationChainId });

    setStatus({ kind: 'pending', step: 'send GatewayMinter.gatewayMint tx' });
    const data = encodeGatewayMintCalldata(
      attestation.attestation,
      attestation.signature,
    );
    const mintHash = await walletClient.sendTransaction({
      account,
      chain: walletClient.chain,
      to: GATEWAY_MINTER_ADDRESS,
      data,
    });

    await destPublicClient.waitForTransactionReceipt({ hash: mintHash });
    setStatus({ kind: 'success', mintHash, destinationChainId });
  }

  return (
    <section className="space-y-3 rounded-2xl border border-slate-200 bg-white p-5">
      <h2 className="text-base font-semibold text-slate-900">
        Transfer via Gateway (sign + attest + mint)
      </h2>
      <p className="text-xs text-slate-600">
        Buyer wallet で burn intent を sign し、Circle attestation API から
        attestation を取得して destination chain で gatewayMint を呼ぶ。
        merchant address (recipient) は普通の EOA で着金する。
      </p>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-xs text-slate-700">
          source domain
          <select
            value={sourceDomain}
            onChange={(e) =>
              setSourceDomain(Number(e.target.value) as CircleDomain)
            }
            className="rounded border border-slate-300 bg-white px-2 py-1 text-sm"
          >
            {CROSS_CHAIN_TARGETS.map((t) => (
              <option key={t.domain} value={t.domain}>
                domain {t.domain} (chainId {t.chainId})
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-slate-700">
          destination domain
          <select
            value={destinationDomain}
            onChange={(e) =>
              setDestinationDomain(Number(e.target.value) as CircleDomain)
            }
            className="rounded border border-slate-300 bg-white px-2 py-1 text-sm"
          >
            {CROSS_CHAIN_TARGETS.map((t) => (
              <option key={t.domain} value={t.domain}>
                domain {t.domain} (chainId {t.chainId})
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-slate-700">
          amount (USDC)
          <input
            type="text"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))}
            className="rounded border border-slate-300 bg-white px-2 py-1 text-sm"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-slate-700">
          recipient (destination chain)
          <input
            type="text"
            value={recipient}
            onChange={(e) => setRecipient(e.target.value.trim())}
            className="rounded border border-slate-300 bg-white px-2 py-1 font-mono text-xs"
            spellCheck={false}
          />
        </label>
      </div>

      {sourceDomain === destinationDomain && (
        <p className="text-xs text-amber-700">
          same source/destination — Gateway は same-chain mint も対応するが
          UX 確認では別 chain 推奨。
        </p>
      )}

      <button
        type="button"
        onClick={onTransfer}
        disabled={status.kind === 'pending'}
        className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand-dark disabled:opacity-50"
      >
        {status.kind === 'pending'
          ? `…${status.step}`
          : 'Sign + Attest + Mint'}
      </button>

      <TxStatusView
        kind={status.kind}
        pendingStep={status.kind === 'pending' ? status.step : undefined}
        errorMessage={status.kind === 'error' ? status.message : undefined}
        successText={
          status.kind === 'success'
            ? `mint tx ${shortAddress(status.mintHash)} on chainId ${status.destinationChainId}`
            : undefined
        }
        successTxHash={
          status.kind === 'success' ? status.mintHash : undefined
        }
        chainId={destinationChainId}
      />
    </section>
  );
}

// ----- TxStatusView (共通) -----
//
// 各 panel の status 構造が異なる (deposit は approveHash + depositHash、
// transfer は mintHash + destinationChainId) ため、status object を直接受けず、
// caller 側で discriminated union を narrow した結果を flat に渡す設計にした。
// (status object をそのまま受けると generic / discriminated union narrowing
// が deeply nested で TS infer が崩れるのを回避)

function TxStatusView({
  kind,
  pendingStep,
  errorMessage,
  successText,
  successTxHash,
  chainId,
}: {
  kind: 'idle' | 'pending' | 'success' | 'error';
  pendingStep?: string;
  errorMessage?: string;
  successText?: string;
  successTxHash?: Hex;
  chainId: number;
}) {
  if (kind === 'idle') return null;
  if (kind === 'pending') {
    return <p className="text-xs text-slate-500">{pendingStep}…</p>;
  }
  if (kind === 'error') {
    return <p className="text-xs text-red-600">error: {errorMessage}</p>;
  }
  const explorer = blockExplorerUrl(chainId);
  return (
    <div className="space-y-1 text-xs">
      <p className="text-emerald-700">✓ {successText}</p>
      {explorer && successTxHash && (
        <a
          href={`${explorer}/tx/${successTxHash}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-brand underline"
        >
          view on explorer
        </a>
      )}
    </div>
  );
}

// Re-export for completeness (caller can read domain→chainId mapping)
export { chainIdForDomain, domainForChainId };
