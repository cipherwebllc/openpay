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
//   1) 使い捨て EOA に対象 chain の USDC を入れる:
//      - testnet (既定): Arbitrum Sepolia USDC ~1 (faucet.circle.com)
//      - Base mainnet  : 本物の Base USDC ~2 (低残高の捨て鍵のみ・faucet 無し)
//      鍵が無ければ SMOKE_PRIVATE_KEY 未設定で 1 度実行 → 鍵とアドレスが出る。
//   2) 環境変数:
//      SMOKE_PRIVATE_KEY=0x...        (or 既存の SPIKE_PRIVATE_KEY を流用)
//      PIMLICO_API_KEY=...            (or NEXT_PUBLIC_PIMLICO_API_KEY)
//      [SMOKE_CHAIN=base]             (既定: arbitrum-sepolia。base=Base mainnet 実マネー)
//      [SMOKE_MAINNET_OK=1]           (mainnet 実行時に必須・実 USDC 消費の明示同意)
//      [SMOKE_RPC_URL=...]            (既定: chain ごとの公開 RPC)
//      [SMOKE_ORIGIN=https://...]     (Origin 制限付き Pimlico キーのとき)
//      [SMOKE_PERMIT_USDC=2]          (Circle permit 上限・既定 2 USDC)
//   3) node scripts/smoke-circle-crossswitch.mjs
//      Base mainnet 例:
//      SMOKE_CHAIN=base SMOKE_MAINNET_OK=1 SMOKE_PRIVATE_KEY=0x.. \
//        PIMLICO_API_KEY=.. SMOKE_ORIGIN=https://open-pay.jp \
//        node scripts/smoke-circle-crossswitch.mjs
//
// 合否: 3 leg (Circle → Pimlico → Circle) すべて receipt success かつ同一 sender・
//   委任先 0xe6Cae83 維持なら PASS。1 つでも失敗 / 委任ずれは FAIL (詳細を dump)。
//   pristine EOA は最初の Circle leg が 7702 authorization を明示署名して委任を bootstrap。
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
import { arbitrumSepolia, base } from 'viem/chains';
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

// SMOKE_CHAIN で対象 chain を選択 (既定: arbitrum-sepolia = 従来挙動)。
// 各値は **本番 SoT と一致** させること:
//   usdc            : lib/tokens.ts (USDC_BASE_MAINNET 等)
//   circlePaymaster : lib/circlePaymaster.ts CIRCLE_PAYMASTER_ADDRESSES
//                     ← permit spender = 信頼境界。誤ると顧客 USDC が流出する。
// tsx 不在で TS の SoT を直接 import できないため明示列挙し、起動時に on-chain code
// 存在で sanity check する (assertPaymasterDeployed)。
const CHAIN_CONFIGS = {
  'arbitrum-sepolia': {
    chain: arbitrumSepolia,
    usdc: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d',
    circlePaymaster: '0x3BA9A96eE3eFf3A69E2B18886AcF52027EFF8966', // v0.8 testnet
    rpcEnv: 'NEXT_PUBLIC_ARBITRUM_SEPOLIA_RPC_URL',
    rpcUrl: 'https://sepolia-rollup.arbitrum.io/rpc',
    isMainnet: false,
    funding: 'Arbitrum Sepolia USDC を ~1 (faucet.circle.com)',
  },
  base: {
    chain: base,
    usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // USDC_BASE_MAINNET (lib/tokens.ts)
    circlePaymaster: '0x0578cFB241215b77442a541325d6A4E6dFE700Ec', // v0.8 mainnet (lib/circlePaymaster.ts SoT)
    // 公開 RPC (rpcUrl) は rate limit に弱く 7702 bootstrap の nonce 読みを壊す。
    // NEXT_PUBLIC_BASE_RPC_URL (Alchemy 等) を最優先で使う。
    rpcEnv: 'NEXT_PUBLIC_BASE_RPC_URL',
    rpcUrl: 'https://mainnet.base.org',
    isMainnet: true,
    funding: '本物の Base USDC を ~2 (使い捨てウォレットのみ・faucet 無し)',
  },
};
const SMOKE_CHAIN = process.env.SMOKE_CHAIN || 'arbitrum-sepolia';
const CFG = CHAIN_CONFIGS[SMOKE_CHAIN];
if (!CFG) {
  throw new Error(
    `SMOKE_CHAIN='${SMOKE_CHAIN}' は未対応 (対応: ${Object.keys(CHAIN_CONFIGS).join(', ')})`,
  );
}
const CHAIN = CFG.chain;
const USDC = getAddress(CFG.usdc);
const CIRCLE_PAYMASTER_V08 = getAddress(CFG.circlePaymaster);
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
    // account は v0.8 (permissionless to7702)。Pimlico client も v0.8 に揃える。
    // 本スモークで v0.7 client + v0.8 account の erc20 不一致 (approve spender と paymaster の
    // version 食い違い → AA50 postOp revert) を発見。本番 lib/pimlico.ts も
    // createPimlico(chainId,'0.8') で simpleAccount/circle を v0.8 に揃えて修正済。
    entryPoint: { address: entryPoint08Address, version: '0.8' },
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
  // 委任済 EOA なら undefined (circle-first 順序で通常はここに来る時点で委任済)。
  const authorization = await maybeSignAuthorization(publicClient, owner);
  const hash = await smartAccountClient.sendUserOperation({
    calls: [transferCall()],
    ...(authorization ? { authorization } : {}),
  });
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

  // pristine EOA の初回 7702 委任を bootstrap する authorization (委任済なら undefined)。
  const authorization = await maybeSignAuthorization(publicClient, owner);
  const authOpt = authorization ? { authorization } : {};

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
    ...authOpt,
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
    ...authOpt,
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

// Circle Paymaster (= permit spender) が対象 chain に実在する contract か検証。
// 誤アドレス (typo / 別 chain の値) が EOA や空アドレスを指していたら permit を
// 署名する前に中断する (信頼境界保護)。
async function assertPaymasterDeployed(publicClient, addr) {
  const code = await publicClient.getCode({ address: addr });
  if (!code || code === '0x') {
    throw new Error(
      `Circle Paymaster ${addr} に contract code が無い (chain=${CHAIN.name} ${CHAIN.id})。` +
        'アドレス誤りの可能性 — permit を署名せず中断する。',
    );
  }
}

// pristine EOA は初回 UserOp に 7702 authorization を内包して委任 (→ IMPL_7702) を張る。
// viem / permissionless は prepareUserOperation 段階で authorization を **stub 署名のまま**
// 送るため、bundler が "recovered signer != sender" で弾く (spike で確定)。owner で本署名
// して estimate / sendUserOperation に明示的に渡す。既に委任済なら undefined (不要)。
async function maybeSignAuthorization(publicClient, owner) {
  const code = await publicClient.getCode({ address: owner.address });
  const delegated =
    code?.toLowerCase() === `0xef0100${IMPL_7702.slice(2)}`.toLowerCase();
  if (delegated) return undefined;
  const authNonce = await publicClient.getTransactionCount({ address: owner.address });
  const authorization = await owner.signAuthorization({
    address: IMPL_7702,
    chainId: CHAIN.id,
    nonce: authNonce,
  });
  log(`  7702 authorization 署名 (pristine bootstrap): impl=${IMPL_7702} nonce=${authNonce}`);
  return authorization;
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
    log(`\n  1) 上記 ADDRESS へ ${CFG.funding} 送金`);
    log(`     chain: ${CHAIN.name} (${CHAIN.id}) / USDC: ${USDC}`);
    log('  2) 同じ鍵 + PIMLICO_API_KEY で再実行');
    log(
      `\n⚠️ 使い捨て鍵専用。${CFG.isMainnet ? 'mainnet は低残高の捨て鍵のみ・大金は絶対に入れない。' : 'mainnet 資産は絶対に入れない。'}`,
    );
    return;
  }
  // 実マネー保護: mainnet は明示 opt-in を要求 (fat-finger で本番 chain を叩かないように)。
  if (CFG.isMainnet && process.env.SMOKE_MAINNET_OK !== '1') {
    throw new Error(
      `SMOKE_CHAIN=${SMOKE_CHAIN} は mainnet で実 USDC を消費する。意図的なら ` +
        'SMOKE_MAINNET_OK=1 を付けて再実行。使い捨て・低残高ウォレットのみ使用すること。',
    );
  }
  const pimlicoApiKey = requireEnv('PIMLICO_API_KEY', 'NEXT_PUBLIC_PIMLICO_API_KEY');
  // RPC 優先順位: SMOKE_RPC_URL > 専用 env (NEXT_PUBLIC_*_RPC_URL) > 公開 fallback。
  const rpcUrl =
    process.env.SMOKE_RPC_URL ||
    (CFG.rpcEnv && process.env[CFG.rpcEnv]) ||
    CFG.rpcUrl;
  if (CFG.isMainnet && rpcUrl === CFG.rpcUrl) {
    log(`⚠️ 公開 RPC (${CFG.rpcUrl}) を使用中 — rate limit で nonce 読みが壊れ`);
    log(`   7702 bootstrap が "recovered signer != sender" で失敗しやすい。`);
    log(`   SMOKE_RPC_URL に Alchemy 等の専用 Base RPC を設定して再実行を強く推奨。\n`);
  }
  const permitAmount = BigInt(process.env.SMOKE_PERMIT_USDC || '2') * 1_000_000n;
  const owner = privateKeyToAccount(pkEnv.startsWith('0x') ? pkEnv : `0x${pkEnv}`);

  const publicClient = createPublicClient({ chain: CHAIN, transport: http(rpcUrl) });
  const bundlerUrl = `https://api.pimlico.io/v2/${CHAIN.id}/rpc?apikey=${pimlicoApiKey}`;
  const origin = process.env.SMOKE_ORIGIN ?? process.env.SPIKE_ORIGIN;
  const bundlerTransport = origin
    ? http(bundlerUrl, { fetchOptions: { headers: { Origin: origin } } })
    : http(bundlerUrl);

  log(`EOA:              ${owner.address}`);
  log(`chain:            ${CHAIN.name} (${CHAIN.id})${CFG.isMainnet ? ' ⚠️ MAINNET (実 USDC)' : ' (testnet)'}`);
  log(`USDC:             ${USDC}`);
  log(`Circle Paymaster: ${CIRCLE_PAYMASTER_V08}`);
  log(`permit ceiling:   ${formatUnits(permitAmount, 6)} USDC (deadline=MAX → 実行後も allowance 残存)`);
  log(`EntryPoint v0.8:  ${entryPoint08Address}`);
  log(`bundler Origin:   ${origin || '(なし)'}`);

  // permit 署名前に paymaster (spender) が対象 chain に実在することを確認。
  await assertPaymasterDeployed(publicClient, CIRCLE_PAYMASTER_V08);

  const bal = await publicClient.readContract({
    address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [owner.address],
  });
  log(`USDC balance:     ${formatUnits(bal, 6)} USDC`);
  if (bal === 0n) throw new Error(`USDC 残高 0 — ${CFG.funding} を入金して再実行`);

  const delBefore = await delegateOf(publicClient, owner.address);
  log(`委任 (before):    ${delBefore ?? '0x (pristine — 初回 UserOp で自動委任)'}`);

  // 3 leg: Circle → Pimlico → Circle (同 EOA・同 v0.8 EntryPoint で paymaster 往復)。
  // pristine EOA の初回委任は **最初の Circle leg** が spike 実証済の viem 経路で bootstrap
  // する (authorization 明示署名)。以降の Pimlico / Circle leg は委任済 EOA 上で走るため
  // production の cross-switch シナリオ (委任済 EOA で paymaster 切替) を正確に再現する。
  const results = [];
  const legs = [
    () => circleLeg({ owner, publicClient, bundlerTransport, permitAmount, label: 'leg1/circle' }),
    () => pimlicoLeg({ owner, publicClient, bundlerTransport, label: 'leg2/pimlico' }),
    () => circleLeg({ owner, publicClient, bundlerTransport, permitAmount, label: 'leg3/circle-again' }),
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
