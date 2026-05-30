// =============================================================================
// CROSS-SWITCH SMOKE (manual・throwaway): 同一 EOA で Pimlico ↔ Circle paymaster
// =============================================================================
//
// 目的 (計画 C5 / docs/runbooks/circle-paymaster-release-gate.md):
//   同一の委任済 EOA が **Pimlico paymaster** と **Circle paymaster** の両経路で
//   連続して決済成功することを receipt 付きで実証し、Circle 本番有効化のゲートにする。
//
// ⚠️ 重要な事実 (調査で確定):
//   permissionless / viem の 7702 SimpleAccount は **EntryPoint v0.8 専用**。よって
//   本番 Pimlico 経路 (lib/smartAccount/simpleAccount.ts) も Circle 経路も **同一の
//   EntryPoint v0.8 + 同一 impl 0xe6Cae83**。両者の差は paymaster だけ:
//     - Pimlico: ERC20 paymaster (Pimlico が USDC quote/徴収を仲介)
//     - Circle:  Circle Paymaster v0.8 (EIP-2612 permit で USDC を直接徴収)
//   nonce 空間は単一 (同 EntryPoint) なので、本スモークは「同 EOA・同 nonce 空間で
//   paymaster を切替えても連続送信が壊れない」ことを確認する。
//
// このスクリプトは UI / MetaMask を使わず、ローカル鍵で完結する (pristine でも
// 初回 UserOp 内 7702 authorization で自動委任)。本番コードからは参照しない。
//
// 使い方:
//   1) 使い捨て testnet EOA に Arbitrum Sepolia USDC を ~1 入れる (faucet.circle.com)。
//      鍵が無ければ SMOKE_PRIVATE_KEY 未設定で 1 度実行 → 鍵とアドレスが出る。
//   2) 環境変数:
//      SMOKE_PRIVATE_KEY=0x...        (or 既存の SPIKE_PRIVATE_KEY を流用)
//      PIMLICO_API_KEY=...            (or NEXT_PUBLIC_PIMLICO_API_KEY)
//      [SMOKE_RPC_URL=...]            (既定: 公開 Arbitrum Sepolia RPC)
//      [SMOKE_ORIGIN=https://...]     (Origin 制限付き Pimlico キーのとき)
//      [SMOKE_PERMIT_USDC=2]          (Circle permit 上限・既定 2 USDC)
//   3) node scripts/smoke-circle-crossswitch.mjs
//
// 合否: 3 leg (Pimlico → Circle → Pimlico) すべて receipt success かつ同一 sender・
//   委任先 0xe6Cae83 維持なら PASS。1 つでも失敗 / 委任ずれは FAIL (詳細を dump)。
// -----------------------------------------------------------------------------

import {
  createPublicClient,
  http,
  encodePacked,
  encodeFunctionData,
  erc20Abi,
  formatUnits,
  parseAbi,
  getAddress,
  parseErc6492Signature,
  parseEventLogs,
  BaseError,
  HttpRequestError,
  TimeoutError,
} from 'viem';
import { arbitrumSepolia } from 'viem/chains';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import {
  createBundlerClient,
  toSimple7702SmartAccount,
  entryPoint08Address,
} from 'viem/account-abstraction';
import { createSmartAccountClient } from 'permissionless';
import { to7702SimpleSmartAccount } from 'permissionless/accounts';
import { createPimlicoClient } from 'permissionless/clients/pimlico';
import { prepareUserOperationForErc20Paymaster } from 'permissionless/experimental/pimlico';
import { entryPoint07Address } from 'viem/account-abstraction';

const CHAIN = arbitrumSepolia;
// Arbitrum Sepolia の値 (lib/tokens.ts / lib/circlePaymaster.ts と一致)。
const USDC = getAddress('0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d');
const CIRCLE_PAYMASTER_V08 = getAddress(
  '0x3BA9A96eE3eFf3A69E2B18886AcF52027EFF8966',
);
const IMPL_7702 = getAddress('0xe6Cae83BdE06E4c305530e199D7217f42808555B');
const MAX_UINT256 = 2n ** 256n - 1n;
const CIRCLE_MIN_POSTOP_GAS = 15_000n;

const log = (...a) => console.log(...a);
const section = (t) => log(`\n${'─'.repeat(70)}\n▶ ${t}\n${'─'.repeat(70)}`);

function isTransient(e) {
  if (
    e instanceof BaseError &&
    e.walk((x) => x instanceof HttpRequestError || x instanceof TimeoutError)
  ) {
    return true;
  }
  const m = `${e?.shortMessage || ''} ${e?.message || ''}`.toLowerCase();
  return /\b429\b|timeout|timed out|rate.?limit|econnreset|socket hang up|fetch failed|service unavailable|503|502|gateway|block.*not found/i.test(
    m,
  );
}

function dumpError(e) {
  log('  --- error 詳細 ---');
  if (e?.shortMessage) log(`  shortMessage: ${e.shortMessage}`);
  if (e?.details) log(`  details     : ${e.details}`);
  if (Array.isArray(e?.metaMessages) && e.metaMessages.length) {
    log(`  metaMessages:\n    ${e.metaMessages.join('\n    ')}`);
  }
  let cause = e?.cause;
  let depth = 0;
  while (cause && depth < 6) {
    const tag = cause.name || cause.constructor?.name || 'cause';
    log(`  cause[${depth}] (${tag}): ${cause.shortMessage || cause.message || cause}`);
    if (cause?.data)
      log(`    data: ${typeof cause.data === 'string' ? cause.data : JSON.stringify(cause.data)}`);
    cause = cause.cause;
    depth += 1;
  }
}

function requireEnv(name, alt) {
  const v = process.env[name] ?? (alt ? process.env[alt] : undefined);
  if (!v) throw new Error(`env ${name}${alt ? ` (or ${alt})` : ''} が未設定です`);
  return v;
}

// 受取人 (任意の別アドレス)。merchant 送金を模す微小転送。
const RECIPIENT = getAddress('0xAcCA802054535F9742E6a05B3c7DEb757b01e543');
const TRANSFER_AMOUNT = 1_000n; // 0.001 USDC

function transferCall() {
  return {
    to: USDC,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: 'transfer',
      args: [RECIPIENT, TRANSFER_AMOUNT],
    }),
  };
}

// full-tx receipt の logs から owner 発 USDC 転送を集計 (Circle の postOp 徴収は
// userOp-scoped logs に出ないため full-tx logs を使う。単一 EOA 前提)。
async function summarizeUsdcOut(publicClient, txHash, owner) {
  const r = await publicClient.waitForTransactionReceipt({ hash: txHash });
  const outs = parseEventLogs({ abi: erc20Abi, logs: r.logs, eventName: 'Transfer' }).filter(
    (l) =>
      getAddress(l.address) === USDC &&
      l.args.from?.toLowerCase() === owner.toLowerCase(),
  );
  const total = outs.reduce((s, l) => s + l.args.value, 0n);
  const toCircle = outs
    .filter((l) => l.args.to?.toLowerCase() === CIRCLE_PAYMASTER_V08.toLowerCase())
    .reduce((s, l) => s + l.args.value, 0n);
  return { total, toCircle, count: outs.length };
}

// ---- Pimlico leg (本番 simpleAccount.ts と同一スタック・EntryPoint v0.8 + ERC20 PM) ----
async function pimlicoLeg({ owner, publicClient, bundlerTransport, label }) {
  section(`[${label}] Pimlico ERC20 Paymaster 経由 (v0.8 account)`);
  const pimlicoClient = createPimlicoClient({
    transport: bundlerTransport,
    // 本番 lib/pimlico.ts createPimlico と同じ設定。account は v0.8 だが paymaster
    // action は account.entryPoint を使うため送信は v0.8 で行われる。
    entryPoint: { address: entryPoint07Address, version: '0.7' },
  });
  const account = await to7702SimpleSmartAccount({ client: publicClient, owner });
  log(`account: ${account.address} entryPoint=${account.entryPoint?.address} v${account.entryPoint?.version}`);
  const smartAccountClient = createSmartAccountClient({
    account,
    chain: CHAIN,
    bundlerTransport,
    paymaster: pimlicoClient,
    paymasterContext: { token: USDC }, // ERC20 mode
    userOperation: {
      estimateFeesPerGas: async () =>
        (await pimlicoClient.getUserOperationGasPrice()).standard,
      prepareUserOperation: prepareUserOperationForErc20Paymaster(pimlicoClient),
    },
  });
  const hash = await smartAccountClient.sendUserOperation({ calls: [transferCall()] });
  log(`UserOp broadcast: ${hash}`);
  const receipt = await smartAccountClient.waitForUserOperationReceipt({ hash });
  const usdc = await summarizeUsdcOut(publicClient, receipt.receipt.transactionHash, owner.address);
  return {
    leg: label,
    provider: 'pimlico',
    ok: receipt.success,
    userOpHash: hash,
    txHash: receipt.receipt.transactionHash,
    entryPoint: receipt.entryPoint,
    paymaster: receipt.paymaster,
    usdcOut: usdc,
  };
}

// ---- Circle leg (spike の実証済みレシピ・viem v0.8 + Circle Paymaster) -----------
async function circleLeg({ owner, publicClient, bundlerTransport, permitAmount, label }) {
  section(`[${label}] Circle Paymaster v0.8 経由`);
  const account = await toSimple7702SmartAccount({ client: publicClient, owner });
  log(`account: ${account.address} entryPoint=${account.entryPoint?.address} v${account.entryPoint?.version}`);
  const bundlerClient = createBundlerClient({
    account,
    client: publicClient,
    transport: bundlerTransport,
  });

  // permit domain (EIP-5267 優先・fallback name+version)
  let domain;
  const usdcName = await publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: 'name' });
  try {
    const d = await publicClient.readContract({
      address: USDC,
      abi: parseAbi([
        'function eip712Domain() view returns (bytes1 fields, string name, string version, uint256 chainId, address verifyingContract, bytes32 salt, uint256[] extensions)',
      ]),
      functionName: 'eip712Domain',
    });
    domain = { name: d[1], version: d[2], chainId: Number(d[3]), verifyingContract: d[4] };
  } catch {
    domain = { name: usdcName, version: '2', chainId: CHAIN.id, verifyingContract: USDC };
  }
  if (domain.chainId !== CHAIN.id || getAddress(domain.verifyingContract) !== USDC) {
    throw new Error(`permit domain 不一致 (chainId=${domain.chainId}, vc=${domain.verifyingContract})`);
  }
  const nonce = await publicClient.readContract({
    address: USDC,
    abi: parseAbi(['function nonces(address) view returns (uint256)']),
    functionName: 'nonces',
    args: [owner.address],
  });
  const permitSigRaw = await owner.signTypedData({
    domain,
    types: {
      Permit: [
        { name: 'owner', type: 'address' },
        { name: 'spender', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
      ],
    },
    primaryType: 'Permit',
    message: {
      owner: owner.address,
      spender: CIRCLE_PAYMASTER_V08,
      value: permitAmount,
      nonce,
      deadline: MAX_UINT256,
    },
  });
  const { signature: permitSignature } = parseErc6492Signature(permitSigRaw);
  const paymasterData = encodePacked(
    ['uint8', 'address', 'uint256', 'bytes'],
    [0, USDC, permitAmount, permitSignature],
  );

  const gp = await bundlerClient.request({ method: 'pimlico_getUserOperationGasPrice' });
  const maxFeePerGas = BigInt(gp.standard.maxFeePerGas);
  const maxPriorityFeePerGas = BigInt(gp.standard.maxPriorityFeePerGas);

  const est = await bundlerClient.estimateUserOperationGas({
    account,
    calls: [transferCall()],
    paymaster: CIRCLE_PAYMASTER_V08,
    paymasterData,
    paymasterPostOpGasLimit: CIRCLE_MIN_POSTOP_GAS,
    maxFeePerGas,
    maxPriorityFeePerGas,
  });
  const postOp =
    est.paymasterPostOpGasLimit > CIRCLE_MIN_POSTOP_GAS
      ? est.paymasterPostOpGasLimit
      : CIRCLE_MIN_POSTOP_GAS;
  const hash = await bundlerClient.sendUserOperation({
    account,
    calls: [transferCall()],
    paymaster: CIRCLE_PAYMASTER_V08,
    paymasterData,
    maxFeePerGas,
    maxPriorityFeePerGas,
    callGasLimit: est.callGasLimit,
    verificationGasLimit: est.verificationGasLimit,
    preVerificationGas: est.preVerificationGas,
    paymasterVerificationGasLimit: est.paymasterVerificationGasLimit,
    paymasterPostOpGasLimit: postOp,
  });
  log(`UserOp broadcast: ${hash}`);
  const receipt = await bundlerClient.waitForUserOperationReceipt({ hash });
  const usdc = await summarizeUsdcOut(publicClient, receipt.receipt.transactionHash, owner.address);
  return {
    leg: label,
    provider: 'circle',
    ok: receipt.success,
    userOpHash: hash,
    txHash: receipt.receipt.transactionHash,
    entryPoint: receipt.entryPoint,
    paymaster: receipt.paymaster,
    usdcOut: usdc,
  };
}

async function delegateOf(publicClient, addr) {
  const code = await publicClient.getCode({ address: addr });
  if (code && code.startsWith('0xef0100')) return getAddress('0x' + code.slice(8, 48));
  return null;
}

async function main() {
  section('0. セットアップ');
  const pkEnv = process.env.SMOKE_PRIVATE_KEY ?? process.env.SPIKE_PRIVATE_KEY;
  if (!pkEnv) {
    const freshPk = generatePrivateKey();
    const freshAddr = privateKeyToAccount(freshPk).address;
    log('SMOKE_PRIVATE_KEY が未設定 → 使い捨て鍵を生成しました。\n');
    log(`  SMOKE_PRIVATE_KEY=${freshPk}`);
    log(`  ADDRESS          =${freshAddr}`);
    log(`\n  1) 上記 ADDRESS へ Arbitrum Sepolia USDC を ~1 送金 (faucet.circle.com)`);
    log(`     USDC: ${USDC}`);
    log('  2) 同じ鍵 + PIMLICO_API_KEY で再実行');
    log('\n⚠️ 使い捨て鍵。mainnet 資産は絶対に入れない。');
    return;
  }
  const pimlicoApiKey = requireEnv('PIMLICO_API_KEY', 'NEXT_PUBLIC_PIMLICO_API_KEY');
  const rpcUrl = process.env.SMOKE_RPC_URL || 'https://sepolia-rollup.arbitrum.io/rpc';
  const permitAmount = BigInt(process.env.SMOKE_PERMIT_USDC || '2') * 1_000_000n;
  const owner = privateKeyToAccount(pkEnv.startsWith('0x') ? pkEnv : `0x${pkEnv}`);

  const publicClient = createPublicClient({ chain: CHAIN, transport: http(rpcUrl) });
  const bundlerUrl = `https://api.pimlico.io/v2/${CHAIN.id}/rpc?apikey=${pimlicoApiKey}`;
  const origin = process.env.SMOKE_ORIGIN ?? process.env.SPIKE_ORIGIN;
  const bundlerTransport = origin
    ? http(bundlerUrl, { fetchOptions: { headers: { Origin: origin } } })
    : http(bundlerUrl);

  log(`EOA:              ${owner.address}`);
  log(`chain:            ${CHAIN.name} (${CHAIN.id})`);
  log(`Circle Paymaster: ${CIRCLE_PAYMASTER_V08}`);
  log(`EntryPoint v0.8:  ${entryPoint08Address}`);
  log(`bundler Origin:   ${origin || '(なし)'}`);

  const bal = await publicClient.readContract({
    address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [owner.address],
  });
  log(`USDC balance:     ${formatUnits(bal, 6)} USDC`);
  if (bal === 0n) throw new Error('USDC 残高 0 — faucet.circle.com で入金して再実行');

  const delBefore = await delegateOf(publicClient, owner.address);
  log(`委任 (before):    ${delBefore ?? '0x (pristine — 初回 UserOp で自動委任)'}`);

  // 3 leg: Pimlico → Circle → Pimlico (同 EOA・同 v0.8 EntryPoint で paymaster 往復)。
  const results = [];
  const legs = [
    () => pimlicoLeg({ owner, publicClient, bundlerTransport, label: 'leg1/pimlico' }),
    () => circleLeg({ owner, publicClient, bundlerTransport, permitAmount, label: 'leg2/circle' }),
    () => pimlicoLeg({ owner, publicClient, bundlerTransport, label: 'leg3/pimlico-again' }),
  ];
  for (const run of legs) {
    try {
      const r = await run();
      log(
        `  → success=${r.ok} entryPoint=${r.entryPoint} paymaster=${r.paymaster} ` +
          `USDC out=${formatUnits(r.usdcOut.total, 6)} (→Circle=${formatUnits(r.usdcOut.toCircle, 6)})`,
      );
      results.push(r);
    } catch (e) {
      log(`  ✖ leg 失敗 [${isTransient(e) ? 'transient' : 'deterministic'}]: ${e.shortMessage || e.message}`);
      dumpError(e);
      results.push({ leg: 'failed', ok: false, error: e.shortMessage || e.message });
    }
  }

  const delAfter = await delegateOf(publicClient, owner.address);

  // ---- 判定 ----------------------------------------------------------------
  section('SMOKE 結果 (PASS / FAIL)');
  const allOk = results.length === 3 && results.every((r) => r.ok);
  const senders = new Set(results.filter((r) => r.txHash).map(() => owner.address.toLowerCase()));
  const epAllV08 = results
    .filter((r) => r.entryPoint)
    .every((r) => r.entryPoint.toLowerCase() === entryPoint08Address.toLowerCase());
  const circleLegOk = results.some(
    (r) => r.provider === 'circle' && r.ok &&
      r.paymaster?.toLowerCase() === CIRCLE_PAYMASTER_V08.toLowerCase() &&
      r.usdcOut?.toCircle > 0n,
  );
  const delegationStable = delAfter?.toLowerCase() === IMPL_7702.toLowerCase();

  log(JSON.stringify(
    {
      allLegsSuccess: allOk,
      sameSender: senders.size <= 1,
      allEntryPointV08: epAllV08,
      circleChargedUsdc: circleLegOk,
      delegationStable_0xe6Cae83: delegationStable,
      delegateBefore: delBefore,
      delegateAfter: delAfter,
      legs: results.map((r) => ({
        leg: r.leg, provider: r.provider, ok: r.ok,
        entryPoint: r.entryPoint, paymaster: r.paymaster,
        usdcOut: r.usdcOut ? formatUnits(r.usdcOut.total, 6) : null,
        txHash: r.txHash, error: r.error,
      })),
    },
    null, 2,
  ));

  const PASS = allOk && epAllV08 && circleLegOk && delegationStable;
  log(`\n${PASS ? '✅ PASS' : '❌ FAIL'} — ${PASS
    ? '同一 EOA・同一 v0.8 EntryPoint で Pimlico↔Circle paymaster 往復成功。Circle 投入ゲート (送信面) クリア。'
    : '上記 legs の error / フラグを確認。FAIL の間は Circle 有効化しない。'}`);
}

main().catch((e) => {
  log(`\n❌ 中断 [${isTransient(e) ? 'transient' : 'deterministic'}]: ${e.shortMessage || e.message}`);
  dumpError(e);
  process.exitCode = 1;
});
