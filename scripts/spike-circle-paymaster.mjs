// =============================================================================
// FEASIBILITY SPIKE (throwaway): Circle Paymaster v0.8 + EntryPoint v0.8 + 7702
// =============================================================================
//
// 目的: 本実装前に「USDC で gas を払う Circle Paymaster」が当社の 7702 スタックで
// 動くかを 1 チェーン (Arbitrum Sepolia) の実機で検証し、計画の GO/NO-GO を出す。
// これは使い捨ての調査スクリプト。コミットはするが本番コードからは参照しない。
//
// 検証する問い (計画 §4 Phase 0):
//   Q-A: Pimlico bundler が EntryPoint v0.8 を当該 chain で提供するか
//   Q-B: viem toSimple7702SmartAccount(v0.8) の委任先 impl は何か / pristine EOA が
//        自動委任されるか (現行 Pimlico Simple7702 impl 0xe6Cae83… との差を測る)
//   Q-C: EIP-2612 permit → paymasterData → UserOp 送信で gas が USDC で引かれるか
//   Q-D: 事前 gas quote の算出方式 (Circle に paymaster RPC 無し → 自前計算)
//
// 使い方 (テストネット EOA + Arbitrum Sepolia USDC + 少量の native gas は委任 tx 用に不要、
//   ただし pristine EOA の初回 7702 authorization は UserOp に内包される):
//   1) Circle faucet/bridge で Arbitrum Sepolia USDC をテスト EOA に入れる
//      (https://faucet.circle.com)。最低 ~1 USDC。
//   2) 環境変数:
//      SPIKE_PRIVATE_KEY=0x...            (テスト用 EOA 秘密鍵・本番鍵は絶対に使わない)
//      PIMLICO_API_KEY=...                (or NEXT_PUBLIC_PIMLICO_API_KEY)
//      [SPIKE_RPC_URL=...]                (任意・既定は公開 Arbitrum Sepolia RPC)
//      [SPIKE_PERMIT_USDC=5]              (任意・permit する USDC 上限、既定 5)
//   3) node scripts/spike-circle-paymaster.mjs
//
// ⚠️ mainnet アドレスは docs が client-render で自動取得不可。本スパイクは検証済の
//    Arbitrum Sepolia v0.8 アドレスのみハードコード。本実装では docs から per-chain 取得。
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
  parseSignature,
  parseEventLogs,
  BaseError,
  ContractFunctionRevertedError,
  HttpRequestError,
  TimeoutError,
} from 'viem';
import { arbitrumSepolia } from 'viem/chains';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import {
  createBundlerClient,
  toSimple7702SmartAccount,
  entryPoint08Address,
  entryPoint07Address,
} from 'viem/account-abstraction';
import { writeGeneratedKey } from './lib/write-generated-key.mjs';

// ---- 設定 (Arbitrum Sepolia / Circle Paymaster v0.8) ------------------------
const CHAIN = arbitrumSepolia; // chainId 421614
// Circle Paymaster v0.8 — Arbitrum Sepolia (research で検証済)
const CIRCLE_PAYMASTER_V08 = getAddress(
  '0x3BA9A96eE3eFf3A69E2B18886AcF52027EFF8966',
);
// USDC (Circle native) — Arbitrum Sepolia (lib/tokens.ts USDC_ARBITRUM_SEPOLIA と一致)
const USDC = getAddress('0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d');
// 現行 Pimlico Simple7702 impl (lib/accountDetection.ts) — 委任先比較用
const PIMLICO_SIMPLE7702_IMPL = getAddress(
  '0xe6Cae83BdE06E4c305530e199D7217f42808555B',
);

const MAX_UINT256 = 2n ** 256n - 1n;

// Circle Paymaster は paymasterPostOpGasLimit に固定下限 (15000) を要求する。bundler の
// 推定 (例 11360) が下回ると validatePaymasterUserOp が AA33 revert (0x5ff4afc1) する。
// Circle 公式 quickstart も 15000n を明示指定。bundler 推定に委ねず明示が正しい。
const CIRCLE_MIN_POSTOP_GAS = 15_000n;

const log = (...a) => console.log(...a);
const section = (t) => log(`\n${'─'.repeat(70)}\n▶ ${t}\n${'─'.repeat(70)}`);

// transient (再試行で解消しうる) RPC/bundler エラーか。これらは「Circle が動かない」
// 証拠ではないので NO-GO ではなく UNKNOWN/retry に分類する (finding 4巡目)。
function isTransient(e) {
  if (e instanceof BaseError && e.walk((x) => x instanceof HttpRequestError || x instanceof TimeoutError)) {
    return true;
  }
  const m = `${e?.shortMessage || ''} ${e?.message || ''}`.toLowerCase();
  return /\b429\b|timeout|timed out|rate.?limit|econnreset|socket hang up|fetch failed|service unavailable|503|502|gateway|block.*not found|nonce too low|already known|replacement/i.test(m);
}

// viem エラーの詳細 (revert 理由・AA コード・cause 連鎖) を全部吐く。paymaster revert の
// 具体的原因を掴むための診断用。
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
    if (cause?.details) log(`    details: ${cause.details}`);
    if (Array.isArray(cause?.metaMessages) && cause.metaMessages.length) {
      log(`    metaMessages: ${cause.metaMessages.join(' | ')}`);
    }
    if (cause?.data) log(`    data: ${typeof cause.data === 'string' ? cause.data : JSON.stringify(cause.data)}`);
    cause = cause.cause;
    depth += 1;
  }
}

function requireEnv(name, alt) {
  const v = process.env[name] ?? (alt ? process.env[alt] : undefined);
  if (!v) {
    throw new Error(`env ${name}${alt ? ` (or ${alt})` : ''} が未設定です`);
  }
  return v;
}

const findings = {
  chain: `${CHAIN.name} (${CHAIN.id})`,
  qA_bundler_v08: 'untested',
  qB_delegation: 'untested',
  qC_usdc_gas: 'untested',
  qD_gas_quote: 'untested',
  // finding (4巡目 #1): 既定は NO-GO ではなく UNKNOWN。NO-GO は決定的 terminal 分岐
  // でのみ設定する (未完/transient 中断を誤って NO-GO にしない)。
  verdict: 'UNKNOWN/incomplete (未完)',
  notes: [],
};

// SPIKE_PRIVATE_KEY 未設定時の使い捨て鍵生成のみで終了したか (findings dump を抑止)。
let keygenOnly = false;

async function main() {
  section('0. セットアップ');

  // SPIKE_PRIVATE_KEY 未設定 → 使い捨て鍵を生成し、入金先アドレスを案内して終了。
  // 既存ウォレットの秘密鍵をターミナルに貼る必要をなくす ("使い捨て鍵へ送金" 方式)。
  if (!process.env.SPIKE_PRIVATE_KEY) {
    const freshPk = generatePrivateKey();
    const freshAddr = privateKeyToAccount(freshPk).address;
    keygenOnly = true;
    // 鍵は stdout に出さず 0600 のファイルへ (ターミナル履歴・CI ログ・スクショへの波及を断つ)。
    const { path: keyPath } = writeGeneratedKey(freshPk, 'spike', {
      ADDRESS: freshAddr,
    });
    log('SPIKE_PRIVATE_KEY が未設定 → 使い捨てのテスト専用鍵を生成しました。\n');
    log('  ┌─────────────────────────────────────────────────────────────');
    log(`  │ ADDRESS           =${freshAddr}`);
    log(`  │ 秘密鍵の書き出し先 =${keyPath} (mode 0600・stdout には出しません)`);
    log('  └─────────────────────────────────────────────────────────────');
    log('\n次の手順:');
    log(`  1) 既存ウォレットから上記 ADDRESS へ Arbitrum Sepolia USDC を ~1 送金`);
    log('     (testnet・無価値。faucet: https://faucet.circle.com)');
    log(`     USDC コントラクト: ${USDC}`);
    log('  2) 書き出しファイルの PRIVATE_KEY を SPIKE_PRIVATE_KEY に設定して再実行:');
    log('     SPIKE_PRIVATE_KEY=$(...) \\');
    log('       PIMLICO_API_KEY=<your-key> node scripts/spike-circle-paymaster.mjs');
    log('\n⚠️ これは使い捨て鍵です。mainnet 資産は絶対に入れないこと (漏れても価値ゼロ)。');
    return;
  }

  const pk = requireEnv('SPIKE_PRIVATE_KEY');
  const pimlicoApiKey = requireEnv('PIMLICO_API_KEY', 'NEXT_PUBLIC_PIMLICO_API_KEY');
  const rpcUrl =
    process.env.SPIKE_RPC_URL || 'https://sepolia-rollup.arbitrum.io/rpc';
  const permitUsdc = BigInt(process.env.SPIKE_PERMIT_USDC || '5');
  const permitAmount = permitUsdc * 1_000_000n; // USDC 6 decimals

  const owner = privateKeyToAccount(pk.startsWith('0x') ? pk : `0x${pk}`);
  log(`EOA (owner):        ${owner.address}`);
  log(`RPC:                ${rpcUrl}`);
  log(`USDC:               ${USDC}`);
  log(`Circle Paymaster:   ${CIRCLE_PAYMASTER_V08} (v0.8)`);
  log(`EntryPoint v0.8:    ${entryPoint08Address}`);
  log(`permit 上限:        ${permitUsdc} USDC`);

  const publicClient = createPublicClient({ chain: CHAIN, transport: http(rpcUrl) });
  const bundlerUrl = `https://api.pimlico.io/v2/${CHAIN.id}/rpc?apikey=${pimlicoApiKey}`;
  // Origin 制限付き Pimlico キーを使う場合、許可済み origin を Node から明示送出する
  // (制限なしの専用キーなら未設定で可)。例: SPIKE_ORIGIN=https://open-pay.jp
  const spikeOrigin = process.env.SPIKE_ORIGIN;
  const bundlerTransport = spikeOrigin
    ? http(bundlerUrl, { fetchOptions: { headers: { Origin: spikeOrigin } } })
    : http(bundlerUrl);
  log(`bundler Origin header: ${spikeOrigin || '(なし — 制限なしキー前提)'}`);

  // ---- Q-B: 委任状態の事前確認 --------------------------------------------
  section('1. [Q-B] EOA の委任状態 (7702 delegation)');
  const codeBefore = await publicClient.getCode({ address: owner.address });
  log(`getCode(EOA) before: ${codeBefore ?? '0x (空 = 未委任 pristine)'}`);
  if (codeBefore && codeBefore.startsWith('0xef0100')) {
    const delegate = getAddress('0x' + codeBefore.slice(8, 48));
    log(`既に委任済 → delegate: ${delegate}`);
    log(
      delegate.toLowerCase() === PIMLICO_SIMPLE7702_IMPL.toLowerCase()
        ? '  = 現行 Pimlico Simple7702 impl (v0.7 系)'
        : '  ≠ Pimlico impl (別実装)',
    );
    findings.notes.push(`pre-existing delegate: ${delegate}`);
  }

  // ---- USDC 残高確認 -------------------------------------------------------
  section('2. USDC 残高 / メタデータ');
  const [bal, dec, name] = await Promise.all([
    publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [owner.address] }),
    publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: 'decimals' }),
    publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: 'name' }),
  ]);
  log(`USDC name:    ${name}`);
  log(`USDC balance: ${formatUnits(bal, dec)} USDC`);
  if (bal === 0n) {
    findings.notes.push('USDC 残高 0 — faucet.circle.com で入金して再実行');
    throw new Error('USDC 残高が 0 です。Arbitrum Sepolia USDC を入金してください。');
  }

  // ---- EIP-712 domain (permit 用) -----------------------------------------
  // EIP-5267 eip712Domain() があれば優先、無ければ name + version フォールバック。
  let domain;
  try {
    const d = await publicClient.readContract({
      address: USDC,
      abi: parseAbi([
        'function eip712Domain() view returns (bytes1 fields, string name, string version, uint256 chainId, address verifyingContract, bytes32 salt, uint256[] extensions)',
      ]),
      functionName: 'eip712Domain',
    });
    domain = { name: d[1], version: d[2], chainId: Number(d[3]), verifyingContract: d[4] };
    log(`eip712Domain(): name="${d[1]}" version="${d[2]}"`);
  } catch {
    let version = '2';
    try {
      version = await publicClient.readContract({
        address: USDC,
        abi: parseAbi(['function version() view returns (string)']),
        functionName: 'version',
      });
    } catch {
      findings.notes.push('version() 取得不可 → "2" を仮定 (要確認)');
    }
    domain = { name, version, chainId: CHAIN.id, verifyingContract: USDC };
    log(`fallback domain: name="${name}" version="${version}"`);
  }

  // ---- Q-A: smart account (v0.8) + bundler -------------------------------
  section('3. [Q-A] v0.8 smart account + Pimlico bundler 構築');
  const account = await toSimple7702SmartAccount({
    client: publicClient,
    owner,
  });
  log(`smart account address: ${account.address} (== EOA: ${account.address.toLowerCase() === owner.address.toLowerCase()})`);
  log(`account entryPoint:    ${account.entryPoint?.address} v${account.entryPoint?.version}`);
  // finding (8巡目 #2): spike の目的は v0.8 feasibility。account が v0.8 でなければ送信前に
  // hard-return し、間違ったスタックで GO を出さない (GO は v0.8 実使用が前提)。
  const accountEpV08 =
    account.entryPoint?.address?.toLowerCase() === entryPoint08Address.toLowerCase() &&
    String(account.entryPoint?.version) === '0.8';
  log(`account entryPoint v0.8: ${accountEpV08}`);
  if (!accountEpV08) {
    findings.notes.push(
      `account の entryPoint が v0.8 でない: ${account.entryPoint?.address} v${account.entryPoint?.version} (viem 版/既定を確認)`,
    );
    findings.qA_bundler_v08 = `account が v0.8 でない (${account.entryPoint?.address})`;
    findings.verdict =
      'UNKNOWN/setup-failed (account が EntryPoint v0.8 でない — v0.8 feasibility を検証できない。viem 版/設定を確認)';
    return;
  }

  const bundlerClient = createBundlerClient({
    account,
    client: publicClient,
    transport: bundlerTransport,
  });

  // Q-A: bundler が v0.8 をサポートするか
  try {
    const eps = await bundlerClient.request({ method: 'eth_supportedEntryPoints' });
    log(`bundler supportedEntryPoints: ${JSON.stringify(eps)}`);
    const supports08 = eps?.some?.((e) => e.toLowerCase() === entryPoint08Address.toLowerCase());
    const supports07 = eps?.some?.((e) => e.toLowerCase() === entryPoint07Address.toLowerCase());
    findings.qA_bundler_v08 = supports08 ? 'YES (v0.8 supported)' : `NO (v0.7=${supports07})`;
    log(`→ Q-A: Pimlico bundler v0.8 サポート = ${findings.qA_bundler_v08}`);
  } catch (e) {
    findings.qA_bundler_v08 = `unknown (${e.shortMessage || e.message})`;
    findings.notes.push(`eth_supportedEntryPoints 失敗: ${e.shortMessage || e.message}`);
  }

  // ---- permit 準備: domain 検証 → 署名 → 実 paymasterData → preflight --------
  section('4. permit 準備 (domain 検証 → 署名 → preflight)');
  // finding #3: domain drift を「permit 失敗」として早期に切り分ける。
  if (domain.chainId !== CHAIN.id) {
    findings.notes.push(`⚠️ permit domain.chainId=${domain.chainId} ≠ chain ${CHAIN.id}`);
    throw new Error(`permit domain chainId 不一致: ${domain.chainId} ≠ ${CHAIN.id}`);
  }
  if (getAddress(domain.verifyingContract) !== USDC) {
    findings.notes.push(`⚠️ permit domain.verifyingContract=${domain.verifyingContract} ≠ USDC`);
    throw new Error('permit domain verifyingContract が USDC と不一致');
  }
  log(`domain 検証 OK (chainId=${domain.chainId}, verifyingContract=${domain.verifyingContract})`);

  const nonce = await publicClient.readContract({
    address: USDC,
    abi: parseAbi(['function nonces(address) view returns (uint256)']),
    functionName: 'nonces',
    args: [owner.address],
  });
  log(`permit nonce: ${nonce}`);

  // permit は USDC owner = EOA が署名 (spender = Circle paymaster)。deadline=MAX (ERC-4337
  // validation 制約で paymaster は block.timestamp を読めないため non-expiring が必須)。
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
  log(`permit signature: ${permitSignature.slice(0, 20)}… (len ${(permitSignature.length - 2) / 2} bytes)`);
  log('→ 注: 実 UX では permit=popup 1 回目、UserOp 署名=2 回目');

  // finding #3: permit を eth_call で preflight し、permit 自体の有効性 (domain/version/
  // sig) を UserOp 送信より前に切り分ける。simulate は state を変えないので nonce は温存。
  // permitState: 'ok' | 'revert' (決定的 permit 失敗=terminal NO-GO) | 'transient'
  // (RPC timeout/429 等=UNKNOWN/retry)。finding (3巡目 #1): transient を deterministic
  // revert と誤分類して誤 NO-GO を出さないよう error 種別で分岐。
  let permitState = 'ok';
  {
    const sig = parseSignature(permitSignature);
    const vNum = sig.v !== undefined ? Number(sig.v) : sig.yParity + 27;
    try {
      await publicClient.simulateContract({
        address: USDC,
        abi: parseAbi([
          'function permit(address owner,address spender,uint256 value,uint256 deadline,uint8 v,bytes32 r,bytes32 s)',
        ]),
        functionName: 'permit',
        args: [owner.address, CIRCLE_PAYMASTER_V08, permitAmount, MAX_UINT256, vNum, sig.r, sig.s],
        account: owner.address,
      });
      log('permit preflight (eth_call): OK — permit 署名/ドメインは有効');
      findings.notes.push('permit preflight OK (domain/sig 有効)');
    } catch (e) {
      const isRevert =
        e instanceof BaseError &&
        !!e.walk((x) => x instanceof ContractFunctionRevertedError);
      permitState = isRevert ? 'revert' : 'transient';
      log(`⚠️ permit preflight 失敗 (${permitState}): ${e.shortMessage || e.message}`);
      if (isRevert) log(`→ permit が決定的に revert (version="${domain.version}" 推定や domain を疑う)。`);
      else log('→ transient RPC エラー (timeout/429 等)。permit の有効性は未確定。');
      findings.notes.push(`⚠️ permit preflight 失敗 [${permitState}]: ${e.shortMessage || e.message}`);
    }
  }

  // finding (2巡目 #1 + 3巡目 #1): permit が無効/未確定なら estimate/send は失敗し
  // Circle/bundler の失敗と誤認される。skip して切り分けを保つ。ただし transient は
  // NO-GO ではなく UNKNOWN/retry に分類 (誤 NO-GO 回避)。
  if (permitState !== 'ok') {
    findings.qD_gas_quote = `skip (permit preflight ${permitState})`;
    findings.qC_usdc_gas = `skip (permit preflight ${permitState})`;
    // finding (5巡目 #3): permit revert は USDC 側の setup 問題 (domain/version/署名) で
    // あり、Circle paymaster の validation には未到達。NO-GO ではなく UNKNOWN に分類。
    findings.verdict =
      permitState === 'revert'
        ? 'UNKNOWN/permit-setup-failed (permit が eth_call で revert — domain/version/署名の setup 問題。Circle paymaster validation には未到達)'
        : 'UNKNOWN/retry (permit preflight が transient RPC エラー — 再実行を)';
    return;
  }

  // finding #1: estimate / send の両方で「実署名入り」paymasterData を使う (無効 stub による誤 NO-GO 回避)。
  const paymasterData = encodePacked(
    ['uint8', 'address', 'uint256', 'bytes'],
    [0, USDC, permitAmount, permitSignature],
  );
  const selfTransfer = {
    to: USDC,
    data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [owner.address, 0n] }),
  };

  // ---- 7702 authorization を明示本署名 ------------------------------------
  // viem の prepareUserOperation は authorization を「準備」するだけで stub 署名のまま
  // 送るため、bundler が "recovered signer != sender" で弾く。owner で本署名し、明示的に
  // sendUserOperation/estimate に渡す (prepareUserOperation は渡された authorization を優先)。
  // 既に同 impl へ委任済の EOA は authorization 不要。
  const IMPL_7702 = PIMLICO_SIMPLE7702_IMPL; // viem toSimple7702SmartAccount の既定 impl と一致
  let authorization;
  const alreadyDelegated =
    codeBefore?.toLowerCase() === `0xef0100${IMPL_7702.slice(2)}`.toLowerCase();
  if (alreadyDelegated) {
    log('既に同 impl へ委任済 → authorization 不要');
  } else {
    const authNonce = await publicClient.getTransactionCount({ address: owner.address });
    authorization = await owner.signAuthorization({
      address: IMPL_7702,
      chainId: CHAIN.id,
      nonce: authNonce,
    });
    log(`7702 authorization 署名: impl=${IMPL_7702} nonce=${authNonce}`);
  }
  const authOpt = authorization ? { authorization } : {};

  // ---- Q-D: 実 paymasterData で gas estimate (gas limit は bundler 推定に委ねる) -----
  section('5. [Q-D] gas quote 試算 (実 permit 入り・postOp は Circle 下限を明示)');
  try {
    // 実 paymasterData を渡す。paymasterPostOpGasLimit のみ Circle 固定下限を明示
    // (bundler 推定だと 11360 で AA33 revert するため・上記 const 参照)。
    const gasEst = await bundlerClient.estimateUserOperationGas({
      account,
      calls: [selfTransfer],
      paymaster: CIRCLE_PAYMASTER_V08,
      paymasterData,
      paymasterPostOpGasLimit: CIRCLE_MIN_POSTOP_GAS,
      ...authOpt,
    });
    log(`estimateUserOperationGas: ${JSON.stringify(gasEst, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2)}`);
    findings.qD_gas_quote =
      'estimate 成功 — units×maxFeePerGas×(USDC/native rate)×1.10 で UI quote 算出可 (Circle に paymaster RPC は無いが bundler estimate で代替)';
  } catch (e) {
    findings.qD_gas_quote = `estimate 失敗: ${e.shortMessage || e.message}`;
    findings.notes.push(`gas estimate 失敗: ${e.shortMessage || e.message}`);
  }

  // ---- Q-C: UserOp 送信 (send / wait を分離・finding #4) --------------------
  section('6. [Q-C] UserOp 送信 → 受領 (NO-GO は inclusion 後の positive evidence のみ)');
  // 設計原則 (5巡目 codex 収束): findings.verdict の NO-GO は「UserOp が included され、
  // かつ (a) revert した、または (b) success だが USDC が徴収されなかった」場合だけに限定。
  // setup/permit/送信/RPC のあらゆる失敗は UNKNOWN/* に分類し、誤 NO-GO を構造的に排除する。

  let hash;
  try {
    // Pimlico は maxPriorityFeePerGas に下限を要求する (Arbitrum Sepolia は ≥120000)。
    // viem 既定の fee 推定だと priority=0 で弾かれるため、pimlico_getUserOperationGasPrice
    // の standard tier を使う (本番アプリの simpleAccount.ts も同じ standard tier)。
    const gp = await bundlerClient.request({ method: 'pimlico_getUserOperationGasPrice' });
    const maxFeePerGas = BigInt(gp.standard.maxFeePerGas);
    const maxPriorityFeePerGas = BigInt(gp.standard.maxPriorityFeePerGas);
    log(`Pimlico gas price (standard): maxFee=${maxFeePerGas} maxPriority=${maxPriorityFeePerGas}`);

    // 2 段階方式: まず estimate で全 gas フィールドを取得し、postOp を Circle 下限以上に
    // 補正して **完全な gas セット**で送信する。postOp だけ部分指定すると viem が
    // "Invalid fields set on User Operation" で弾くため (gas フィールドの整合性要求)。
    const est = await bundlerClient.estimateUserOperationGas({
      account,
      calls: [selfTransfer],
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
    log(
      `send 用 gas: callGasLimit=${est.callGasLimit} verificationGasLimit=${est.verificationGasLimit} ` +
        `preVerificationGas=${est.preVerificationGas} pmVerification=${est.paymasterVerificationGasLimit} pmPostOp=${postOp}`,
    );
    hash = await bundlerClient.sendUserOperation({
      account,
      calls: [selfTransfer],
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
    log(`✅ UserOp broadcast 成功。hash: ${hash}`);
  } catch (e) {
    // finding (5巡目 #1): 送信段階の失敗は inclusion されておらず、Circle paymaster の
    // validation 可否を決定づけない。種別を問わず NO-GO にせず UNKNOWN/retry とする
    // (transient か否かは raw error として記録し、人間が判断)。
    const transient = isTransient(e);
    dumpError(e); // paymaster revert 等の具体理由を全部出す
    findings.qC_usdc_gas = `broadcast 失敗 [${transient ? 'transient' : 'unclassified'}]: ${e.shortMessage || e.message}`;
    findings.notes.push(`sendUserOperation 失敗 [${transient ? 'transient' : 'unclassified'}]: ${e.shortMessage || e.message}`);
    findings.verdict =
      'UNKNOWN/retry (broadcast 失敗 — inclusion されず paymaster validation 可否は未確定。上記 error 詳細を確認)';
    return;
  }

  // wait は別 try。inclusion が確定するまで NO-GO は出さない。
  try {
    const receipt = await bundlerClient.waitForUserOperationReceipt({ hash });
    log(`success: ${receipt.success}  txHash: ${receipt.receipt.transactionHash}  actualGasCost(native wei): ${receipt.actualGasCost}`);

    // 徴収判定: Circle の USDC 引き落としは **postOp フェーズ**で起きるため、userOp-scoped
    // の receipt.logs には含まれないことがある (ERC-4337 log スコープ)。そこで **full tx
    // receipt の logs** から Transfer(from=owner) を集計し、併せて pinned 残高差分も取る。
    // 専用テスト EOA・単一 userOp 前提なので、同 owner 別 userOp の誤帰属懸念はない。
    let usdcChargedLog = null; // full-tx logs 由来の owner 発 USDC 合計
    let netDelta = null; // pinned 残高差分 (block-1 → block)
    let codeAfter;
    let inclusionBlock;
    try {
      const pubReceipt = await publicClient.waitForTransactionReceipt({ hash: receipt.receipt.transactionHash });
      inclusionBlock = pubReceipt.blockNumber;
      const ownerOut = parseEventLogs({ abi: erc20Abi, logs: pubReceipt.logs, eventName: 'Transfer' }).filter(
        (l) =>
          getAddress(l.address) === USDC &&
          l.args.from?.toLowerCase() === owner.address.toLowerCase(),
      );
      usdcChargedLog = ownerOut.reduce((sum, l) => sum + l.args.value, 0n);
      const toCircle = ownerOut.some((l) => l.args.to?.toLowerCase() === CIRCLE_PAYMASTER_V08.toLowerCase());
      const [bb, ba] = await Promise.all([
        publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [owner.address], blockNumber: inclusionBlock - 1n }),
        publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [owner.address], blockNumber: inclusionBlock }),
      ]);
      netDelta = bb - ba;
      log(`USDC 徴収判定: tx-log(from=owner)合計=${formatUnits(usdcChargedLog, 6)} (Circle宛=${toCircle}, 件数 ${ownerOut.length}) | net balance Δ @block ${inclusionBlock}=${formatUnits(netDelta, 6)}`);
      codeAfter = await publicClient.getCode({ address: owner.address, blockNumber: inclusionBlock });
    } catch (be) {
      log(`⚠️ post-receipt 読取不可 @block ${inclusionBlock}: ${be.shortMessage || be.message}`);
      findings.notes.push(`post-receipt 読取不可: ${be.shortMessage || be.message}`);
    }

    // GO は receipt が「この userOp が v0.8 EntryPoint + Circle paymaster で実行」を証明することを要求。
    const hashOk = receipt.userOpHash?.toLowerCase() === hash.toLowerCase();
    const epOk = receipt.entryPoint?.toLowerCase() === entryPoint08Address.toLowerCase();
    const pmOk = receipt.paymaster?.toLowerCase() === CIRCLE_PAYMASTER_V08.toLowerCase();
    log(`receipt 検証: userOpHash一致=${hashOk}, entryPoint=v0.8(${epOk}, ${receipt.entryPoint}), paymaster=Circle(${pmOk}, ${receipt.paymaster})`);
    const receiptProvesV08Circle = hashOk && epOk && pmOk;

    // Q-B 委任先
    if (codeAfter?.startsWith('0xef0100')) {
      const delegate = getAddress('0x' + codeAfter.slice(8, 48));
      const isPimlico = delegate.toLowerCase() === PIMLICO_SIMPLE7702_IMPL.toLowerCase();
      log(`委任先 (after): ${delegate} ${isPimlico ? '(=Pimlico impl)' : '(≠Pimlico impl)'}`);
      findings.qB_delegation =
        `委任先 impl=${delegate}` +
        `${codeBefore ? '' : ' (pristine→UserOp内 7702 auth で自動委任 初回成功)'}` +
        `${isPimlico ? ' (現行 Pimlico impl と一致)' : ' (≠Pimlico impl → 本実装で再委任 or 別 detect 要)'}`;
    } else if (codeAfter !== undefined) {
      findings.qB_delegation = `委任コード未検出 (codeAfter=${codeAfter})`;
    } else {
      findings.qB_delegation = 'public RPC 遅延で確認不可 (hash で手動確認)';
    }

    // 徴収有無: net balance Δ を ground truth (postOp 含む全 debit を捕捉)、tx-log を corroboration。
    const charged =
      netDelta !== null ? netDelta > 0n : usdcChargedLog !== null ? usdcChargedLog > 0n : null;

    // verdict: NO-GO は inclusion 後の positive evidence のみ。revert を最優先。
    if (!receipt.success) {
      findings.qC_usdc_gas = `included だが success=false (revert)${receipt.reason ? `: ${receipt.reason}` : ''}`;
      findings.verdict =
        'NO-GO (preflight OK の permit が paymaster/AA validation 通過後に UserOp revert — positive evidence)';
    } else if (!receiptProvesV08Circle) {
      findings.qC_usdc_gas = `included・success だが receipt が v0.8+Circle を証明せず (hashOk=${hashOk}, epOk=${epOk}, pmOk=${pmOk})`;
      findings.verdict =
        'UNKNOWN/manual-inspection (receipt の userOpHash/entryPoint/paymaster が期待と不一致 — txHash で手動確認を)';
    } else if (charged === null) {
      findings.qC_usdc_gas = 'included・success・v0.8+Circle 確認済だが残高/logs を読めず徴収有無を確認できず';
      findings.verdict =
        'UNKNOWN/manual-inspection (post-receipt 読取不可 — txHash で USDC 徴収を手動確認を)';
    } else if (charged) {
      findings.qC_usdc_gas = `YES — gas を USDC で徴収 (tx-log=${usdcChargedLog === null ? 'n/a' : formatUnits(usdcChargedLog, 6)}, net Δ=${netDelta === null ? 'n/a' : formatUnits(netDelta, 6)} USDC・当社徴収 0)`;
      findings.verdict = 'GO 候補 (実機で USDC gas 成立・v0.8+Circle+7702 委任 実証)';
    } else {
      findings.qC_usdc_gas = `success・v0.8+Circle 実証だが USDC 徴収 0 (tx-log=${formatUnits(usdcChargedLog ?? 0n, 6)}, net Δ=${formatUnits(netDelta ?? 0n, 6)})`;
      findings.verdict =
        'NO-GO/要調査 (included・success だが USDC 未徴収 — testnet で Circle が無償 sponsor している可能性。mainnet 挙動を別途確認)';
    }
  } catch (e) {
    // wait 失敗 = inclusion 不明。NO-GO にはせず UNKNOWN (broadcast 済なので hash で手動確認)。
    log(`⚠️ wait 失敗 (inclusion 不明): ${e.shortMessage || e.message}`);
    log(`   hash 取得済: ${hash} — included の可能性あり (USDC 消費・委任が起きうる)`);
    findings.notes.push(`wait 失敗 (broadcast は成功): ${e.shortMessage || e.message}. hash=${hash}`);
    findings.qC_usdc_gas = `wait timeout/失敗。hash=${hash} で手動確認`;
    findings.verdict = 'UNKNOWN/retry (broadcast 済・inclusion 未確認。hash で手動確認を)';
  }
}

main()
  .catch((e) => {
    // finding (4巡目 #1): narrow handler の外で起きた transient RPC エラー (nonce/domain/
    // balance/name 読取等) を既定の値で NO-GO にしない。transient は UNKNOWN/retry、
    // deterministic な中断のみ NO-GO 扱い。
    const transient = isTransient(e);
    log(`\n❌ スパイク中断 (${transient ? 'transient' : 'deterministic'}): ${e.shortMessage || e.message}`);
    findings.notes.push(`fatal [${transient ? 'transient' : 'deterministic'}]: ${e.shortMessage || e.message}`);
    // finding (5巡目 #2): top-level の中断は env/鍵/残高/domain 等の setup 失敗であり、
    // Circle Paymaster の feasibility NO-GO ではない。常に UNKNOWN に分類 (GO/NO-GO が
    // 既に確定済ならそれを尊重し、未完のときだけ理由付きで上書き)。
    if (findings.verdict.startsWith('UNKNOWN/incomplete')) {
      findings.verdict = transient
        ? 'UNKNOWN/retry (transient RPC エラーで中断 — 再実行を)'
        : `UNKNOWN/setup-failed (env/鍵/残高/domain 等の setup 失敗で中断: ${e.shortMessage || e.message})`;
    }
  })
  .finally(() => {
    // 使い捨て鍵を生成して案内しただけの場合は findings dump を出さない (案内が主役)。
    if (keygenOnly) return;
    section('SPIKE 結果サマリ (GO/NO-GO 判定材料)');
    log(JSON.stringify(findings, null, 2));
    log(
      '\n判断指針:\n' +
        '  GO → Q-A=YES かつ Q-C=YES (USDC で gas 成立)。Q-B の委任先 impl を本実装の\n' +
        '       account 検出/委任戦略に反映 (現行 Pimlico impl と異なるなら再委任 or 別 detect)。\n' +
        '  NO-GO → notes のエラーを精査。bundler v0.8 非対応なら v0.7 Base+Arbitrum 限定案へ縮退。',
    );
  });
