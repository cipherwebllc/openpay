#!/usr/bin/env node
// dual-rail 402 (JPYC + USDC/Base 並記) の USDC 面を購入するリファレンス買い手。
//
// なぜ専用スクリプトか: 標準クライアント x402-fetch (1.2.0 現在) は 402 の accepts **全件**を
// v1 ネットワーク名 enum で厳格 parse するため、JPYC 面の CAIP-2 表記 ('eip155:137') を含む
// dual-rail 402 では支払い先を選ぶ前に throw する。本スクリプトは network==='base' の accept
// だけを選び、EIP-3009 (TransferWithAuthorization) に署名して X-PAYMENT で支払う。
//
// 使い方 (署名する鍵はどちらか 1 つ・RESOURCE_URL は https だけ):
//   1. 鍵を env で渡す (このファイル単体で動く・鍵はファイルに書かない):
//        BUYER_PRIVATE_KEY=0x... RESOURCE_URL=https://seller.example/api/paid/x \
//          [MAX_USDC=0.01] [EXPECTED_PAY_TO=0x...] node x402-dual-buyer-example.mjs
//   2. OpenPay Agent のウォレットで署名する (鍵を入力しない・画面にも出さない):
//        USE_AGENT_WALLET=1 RESOURCE_URL=https://seller.example/api/paid/x \
//          [MAX_USDC=0.01] [EXPECTED_PAY_TO=0x...] node scripts/x402-dual-buyer-example.mjs
//      openpay-x402-mcp (SIGNER_MODE=keystore) がこの端末に作ったウォレット (~/.openpay-x402/wallet.json・
//      OPENPAY_X402_HOME で変更可) を、MCP と同じ読み込み処理 (packages/x402-mcp/src/keystore.mjs・権限と
//      ファイルの差し替えを検査) で読む。**信頼できる、手を加えていない OpenPay の checkout からだけ実行する**
//      (隣の packages/ を import するので、置き場所ごと差し替えられた tree で実行するとウォレットを渡すことになる)。
//      同じアドレスを Base でも使うので、Base の USDC をそのアドレスへ入れておく。MCP と共有するのは鍵のファイル
//      だけで、MCP の JPYC の上限 (1 回・セッション・1 日)・host/カタログの制限・購入履歴 (wallet_history) は
//      効かない。上限は MAX_USDC (1 回の実行ごと・実行をまたいで合算しない) だけ。
//
// 金銭ガード:
//   - RESOURCE_URL は https だけ (平文 HTTP の 402 は経路の途中で payTo や額を書き換えられる)
//   - 402 の取得も支払いの再送も転送 (3xx) を追わない。最初の URL と別の origin の応答には署名しない
//   - 支払条件に resource があれば、その origin が最初の URL の origin と同じでなければ支払わない
//   - asset が Base mainnet の native USDC (0x8335…2913) でなければ支払わない
//   - 要求額が MAX_USDC (既定 0.01 = 1 セント) を超えたら支払わない
//   - EXPECTED_PAY_TO (受け取り先のアドレス) を渡せば、payTo がそれと違うときは支払わない。
//     渡さなければ payTo は照合せず、402 が示した宛先と「確かめていない」旨を表示してから署名する
// ガス代は不要 (署名のみ・broadcast は facilitator 側)。ウォレットには USDC だけあれば良い。

import { privateKeyToAccount } from 'viem/accounts';

const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

const TARGET = process.env.RESOURCE_URL;
if (!TARGET) {
  console.error('RESOURCE_URL env が必要です (購入する dual-rail 402 の URL)');
  process.exit(1);
}
// 平文 HTTP の 402 は経路の途中で書き換えられ、改竄された支払条件 (payTo・額) に署名させられる。
// 購入先は https だけにする (OpenPay の SDK の executor と同じ扱い・localhost の http も通さない)。
const targetUrl = URL.canParse(TARGET) ? new URL(TARGET) : null;
if (!targetUrl || targetUrl.protocol !== 'https:') {
  console.error(`RESOURCE_URL は https の URL にしてください: ${TARGET}`);
  process.exit(1);
}
const ORIGIN = targetUrl.origin;
const EXPECTED_PAY_TO = process.env.EXPECTED_PAY_TO;
if (EXPECTED_PAY_TO !== undefined && !/^0x[0-9a-fA-F]{40}$/.test(EXPECTED_PAY_TO)) {
  console.error(`EXPECTED_PAY_TO はアドレス (0x と 16 進 40 桁) で渡してください: ${EXPECTED_PAY_TO}`);
  process.exit(1);
}
const MAX_USDC = process.env.MAX_USDC ?? '0.01';
const m = /^([0-9]+)(?:\.([0-9]{1,6}))?$/.exec(MAX_USDC);
if (!m) {
  console.error(`MAX_USDC の形式が不正です (例: 0.01): ${MAX_USDC}`);
  process.exit(1);
}
const MAX_ATOMIC = BigInt(m[1]) * 1_000_000n + BigInt((m[2] ?? '').padEnd(6, '0'));

const pk = process.env.BUYER_PRIVATE_KEY;
const useAgentWallet = process.env.USE_AGENT_WALLET === '1';
if (useAgentWallet && pk) {
  console.error('BUYER_PRIVATE_KEY と USE_AGENT_WALLET=1 はどちらか 1 つにしてください (どちらの鍵で払うかを曖昧にしない)');
  process.exit(1);
}
let account;
if (useAgentWallet) {
  let loadWallet;
  try {
    ({ loadWallet } = await import(new URL('../packages/x402-mcp/src/keystore.mjs', import.meta.url).href));
  } catch (error) {
    // このファイルだけを取得して実行した場合 (売り手ガイドのリンク) に、何が足りないかを示す。
    console.error(`USE_AGENT_WALLET=1 は OpenPay のリポジトリの中で実行してください (packages/x402-mcp/src/keystore.mjs を読めません: ${error.code ?? error.message})`);
    process.exit(1);
  }
  let wallet;
  try {
    wallet = await loadWallet();
  } catch (error) {
    console.error('OpenPay Agent のウォレットを読めません:', error.message);
    process.exit(1);
  }
  if (!wallet) {
    console.error('OpenPay Agent のウォレットがありません (MCP の wallet_init で作る・OPENPAY_X402_HOME を確かめる)');
    process.exit(1);
  }
  account = privateKeyToAccount(wallet.secret.privateKey);
} else {
  if (!pk || !pk.startsWith('0x')) {
    console.error('BUYER_PRIVATE_KEY env (0x...) か USE_AGENT_WALLET=1 が必要です');
    process.exit(1);
  }
  account = privateKeyToAccount(pk);
}
console.log('buyer :', account.address);
console.log('buying:', TARGET);

// 転送 (3xx) を追うと、別の origin が返した支払条件に署名したり、署名した支払い (x-payment) を
// 別の origin へ運んだりする。fetch は redirect: 'manual' で呼び、応答が最初の URL の origin の
// ものであることをここで確かめる (問題があればその説明を返す)。
function originProblem(response, label) {
  if (
    response.type === 'opaqueredirect' ||
    response.redirected ||
    (response.status >= 300 && response.status < 400)
  ) {
    return `${label}の応答が転送 (HTTP ${response.status}) でした — 転送先は追わずに中止します`;
  }
  if (response.url && new URL(response.url).origin !== ORIGIN) {
    return `${label}の応答が ${ORIGIN} 以外から届きました — 中止します`;
  }
  return null;
}

const challenge = await fetch(targetUrl.href, { redirect: 'manual' });
const challengeProblem = originProblem(challenge, '402 の取得');
if (challengeProblem) {
  console.error(challengeProblem);
  process.exit(1);
}
if (challenge.status !== 402) {
  console.error('402 ではありません:', challenge.status, (await challenge.text()).slice(0, 200));
  process.exit(1);
}
const { accepts } = await challenge.json();
const accept = (accepts || []).find(
  (a) => a && a.scheme === 'exact' && a.network === 'base',
);
if (!accept) {
  console.error(
    'USDC (base) の accept がありません。並記レール:',
    JSON.stringify((accepts || []).map((a) => a?.network)),
  );
  process.exit(1);
}
// 支払条件の resource が別の origin を指していたら、別の売り手の支払条件を中継されている疑いがある。
if (accept.resource !== undefined) {
  const resourceOrigin =
    typeof accept.resource === 'string' && URL.canParse(accept.resource)
      ? new URL(accept.resource).origin
      : null;
  if (resourceOrigin !== ORIGIN) {
    console.error(`支払条件の resource が購入先 ${ORIGIN} と別の origin のため中止:`, accept.resource);
    process.exit(1);
  }
}
if (String(accept.asset).toLowerCase() !== BASE_USDC.toLowerCase()) {
  console.error('asset が Base native USDC ではないため中止:', accept.asset);
  process.exit(1);
}
const amount = BigInt(accept.maxAmountRequired);
if (amount > MAX_ATOMIC) {
  console.error(`要求額 ${accept.maxAmountRequired} が上限 MAX_USDC=${MAX_USDC} を超過`);
  process.exit(1);
}
console.log(`price : ${accept.maxAmountRequired} atomic (= $${Number(amount) / 1e6})`);
console.log('payTo :', accept.payTo);
// payTo の期待値はこのスクリプトでは作らない (売り手のアドレスを知っているのは買い手だけ)。
// 渡されたときだけ照合し、渡されなければ照合していないことをはっきり出す。
if (EXPECTED_PAY_TO !== undefined) {
  if (typeof accept.payTo !== 'string' || accept.payTo.toLowerCase() !== EXPECTED_PAY_TO.toLowerCase()) {
    console.error(`payTo が EXPECTED_PAY_TO=${EXPECTED_PAY_TO} と違うため中止 (署名していません)`);
    process.exit(1);
  }
  console.log('payTo は EXPECTED_PAY_TO と一致');
} else {
  console.warn(
    'payTo は確かめていません (402 が示した宛先へ払う署名をします・照合するには EXPECTED_PAY_TO=0x... を付ける)',
  );
}

const validBefore = BigInt(Math.floor(Date.now() / 1000) + 300);
const nonce =
  '0x' +
  [...crypto.getRandomValues(new Uint8Array(32))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
const signature = await account.signTypedData({
  domain: {
    name: accept.extra.name,
    version: accept.extra.version,
    chainId: 8453,
    verifyingContract: accept.asset,
  },
  types: {
    TransferWithAuthorization: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' },
    ],
  },
  primaryType: 'TransferWithAuthorization',
  message: {
    from: account.address,
    to: accept.payTo,
    value: amount,
    validAfter: 0n,
    validBefore,
    nonce,
  },
});
const header = Buffer.from(
  JSON.stringify({
    scheme: 'exact',
    network: 'base',
    payload: {
      signature,
      authorization: {
        from: account.address,
        to: accept.payTo,
        value: accept.maxAmountRequired,
        validAfter: '0',
        validBefore: validBefore.toString(),
        nonce,
      },
    },
  }),
  'utf8',
).toString('base64');

// 署名した支払いは最初の URL へだけ送る (転送を追うと x-payment が転送先へも運ばれる)。
const res = await fetch(targetUrl.href, { headers: { 'x-payment': header }, redirect: 'manual' });
console.log('HTTP', res.status);
const text = await res.text();
console.log('body :', text.slice(0, 600));
const receipt = res.headers.get('x-payment-response');
if (receipt) {
  console.log('settlement:', JSON.parse(Buffer.from(receipt, 'base64').toString('utf8')));
} else {
  console.log('settlement: (x-payment-response ヘッダなし)');
}
// 受領 (x-payment-response) を表示してから、転送を追わなかったことを失敗として伝える。
const paidProblem = originProblem(res, '支払いの再送');
if (paidProblem) {
  console.error(paidProblem);
  process.exit(1);
}
