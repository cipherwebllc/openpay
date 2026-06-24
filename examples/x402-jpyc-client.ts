// OpenPay x402 JPYC ファシリテーターのローカル/testnet 実機確認用クライアント (dev ツール)。
// resource-server + buyer を兼ね、forwarder 分割の receiveWithAuthorization を **実署名** して
// /api/facilitator/{verify,settle} を叩き、/verify-receipt で受領証明を検証する。
// viem のみ依存の自己完結スクリプト (nonce/型は lib/relay/forwarderIntent と一致させてある)。
//
// 実行例:
//   X402_BASE_URL=http://localhost:3000 \
//   BUYER_PRIVATE_KEY=0x<Amoy JPYC 保有の買い手鍵> \
//   SELLER_ADDRESS=0x<出品者(受取)アドレス> \
//   AMOUNT_JPYC=1000 \
//   npx tsx examples/x402-jpyc-client.ts
//
// 前提: dev サーバが flag ON (NEXT_PUBLIC_ENABLE_X402_FACILITATOR=1) + Amoy forwarder/relayer 構成済で起動中。
//   buyer に Amoy testnet JPYC が無いと settle は insufficient_balance になる (= 署名/手数料検証は通過した証)。

import { privateKeyToAccount } from 'viem/accounts';
import {
  keccak256,
  encodeAbiParameters,
  toHex,
  getAddress,
  type Address,
  type Hex,
} from 'viem';

const BASE = process.env.X402_BASE_URL ?? 'http://localhost:3000';
const BUYER_PK = process.env.BUYER_PRIVATE_KEY as Hex | undefined;
const SELLER = process.env.SELLER_ADDRESS;
const AMOUNT_JPYC = BigInt(process.env.AMOUNT_JPYC ?? '1000');

if (!BUYER_PK || !SELLER) {
  console.error('BUYER_PRIVATE_KEY と SELLER_ADDRESS を設定してください。');
  process.exit(1);
}

// lib/relay/forwarderIntent.ts と一致必須 (契約 COMMIT_VERSION)。
const COMMIT_VERSION = keccak256(toHex('openpay.eip3009.forwarder.v1'));

function randomSalt(): Hex {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return toHex(b);
}

// 契約 settle の nonce 計算と完全一致 (型・順序・値)。
function buildForwarderNonce(
  p: {
    from: Address;
    merchant: Address;
    merchantValue: bigint;
    feeReceiver: Address;
    feeValue: bigint;
    validAfter: bigint;
    validBefore: bigint;
    intentSalt: Hex;
  },
  chainId: number,
  forwarder: Address,
): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'address' },
        { type: 'address' },
        { type: 'uint256' },
        { type: 'address' },
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'bytes32' },
        { type: 'uint256' },
        { type: 'address' },
      ],
      [
        COMMIT_VERSION,
        p.from,
        p.merchant,
        p.merchantValue,
        p.feeReceiver,
        p.feeValue,
        p.validAfter,
        p.validBefore,
        p.intentSalt,
        BigInt(chainId),
        forwarder,
      ],
    ),
  );
}

async function main() {
  const buyer = privateKeyToAccount(BUYER_PK as Hex);

  // 1. /supported から chain / forwarder / feeReceiver / asset / feeModel を取得。
  const supRes = await fetch(`${BASE}/api/facilitator/supported`);
  if (!supRes.ok) {
    throw new Error(`/supported -> ${supRes.status} (flag OFF か未起動?)`);
  }
  const sup = (await supRes.json()) as {
    kinds: Array<{
      network: string;
      asset: string;
      extra: {
        name: string;
        version: string;
        decimals: number;
        feeModel: { bps: number; floor: string };
        openpay: { forwarder: string; feeReceiver: string };
      };
    }>;
  };
  const kind = sup.kinds?.[0];
  if (!kind) throw new Error('supported kind なし (forwarder/JPYC 未設定?)');

  const network = kind.network; // eip155:80002
  const chainId = Number(network.split(':')[1]);
  const asset = getAddress(kind.asset);
  const forwarder = getAddress(kind.extra.openpay.forwarder);
  const feeReceiver = getAddress(kind.extra.openpay.feeReceiver);
  const bps = kind.extra.feeModel.bps;
  const floorWei = BigInt(kind.extra.feeModel.floor);

  // 2. server と同式で fee を計算: max(floor, amount * bps / 10000)。
  const merchantValue = AMOUNT_JPYC * 10n ** 18n;
  const pct = (merchantValue * BigInt(bps)) / 10000n;
  const feeValue = pct > floorWei ? pct : floorWei;

  const params = {
    from: getAddress(buyer.address),
    merchant: getAddress(SELLER as string),
    merchantValue,
    feeReceiver,
    feeValue,
    validAfter: 0n,
    validBefore: BigInt(Math.floor(Date.now() / 1000) + 600),
    intentSalt: randomSalt(),
  };

  // 3. receiveWithAuthorization(to=forwarder, value=mv+fv, nonce=commit) を実署名。
  const nonce = buildForwarderNonce(params, chainId, forwarder);
  const signature = await buyer.signTypedData({
    domain: {
      name: kind.extra.name,
      version: kind.extra.version,
      chainId,
      verifyingContract: asset,
    },
    types: {
      ReceiveWithAuthorization: [
        { name: 'from', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' },
        { name: 'validBefore', type: 'uint256' },
        { name: 'nonce', type: 'bytes32' },
      ],
    },
    primaryType: 'ReceiveWithAuthorization',
    message: {
      from: params.from,
      to: forwarder,
      value: merchantValue + feeValue,
      validAfter: params.validAfter,
      validBefore: params.validBefore,
      nonce,
    },
  });

  // 4. x402 ボディ (paymentPayload + paymentRequirements) を構築。
  const body = {
    x402Version: 1,
    paymentPayload: {
      x402Version: 1,
      scheme: 'exact',
      network,
      payload: {
        signature,
        authorization: {
          from: params.from,
          validAfter: params.validAfter.toString(),
          validBefore: params.validBefore.toString(),
          intentSalt: params.intentSalt,
        },
      },
    },
    paymentRequirements: {
      scheme: 'exact',
      network,
      maxAmountRequired: (merchantValue + feeValue).toString(),
      resource: 'http://localhost/paid/demo',
      description: 'x402 local e2e',
      mimeType: '',
      payTo: forwarder,
      maxTimeoutSeconds: 600,
      asset,
      extra: {
        name: kind.extra.name,
        version: kind.extra.version,
        decimals: kind.extra.decimals,
        assetTransferMethod: 'eip3009',
        openpay: {
          mode: 'forwarder-split',
          forwarder,
          merchant: params.merchant,
          merchantValue: merchantValue.toString(),
          feeReceiver,
          feeValue: feeValue.toString(),
          commitVersion: COMMIT_VERSION,
        },
      },
    },
  };

  const post = (path: string) =>
    fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  console.log(
    `\n[x402 client] chain=${chainId} forwarder=${forwarder}\n` +
      `  buyer=${params.from} seller=${params.merchant}\n` +
      `  merchantValue=${AMOUNT_JPYC} JPYC  fee=${feeValue / 10n ** 18n} JPYC (feeReceiver=${feeReceiver})\n`,
  );

  // 5. /verify (broadcast なし)。
  const vr = await post('/api/facilitator/verify');
  console.log('verify  ->', vr.status, await vr.json());

  // 6. /settle (broadcast)。
  const sr = await post('/api/facilitator/settle');
  const settle = (await sr.json()) as { receipt?: { signature: string } };
  console.log('settle  ->', sr.status, settle);

  // 7. receipt 検証。
  if (settle?.receipt?.signature) {
    const rr = await fetch(`${BASE}/api/facilitator/verify-receipt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        receipt: settle.receipt,
        signature: settle.receipt.signature,
      }),
    });
    console.log('receipt ->', rr.status, await rr.json());
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
