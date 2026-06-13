// JPYC EIP-3009 relay endpoint (Phase 1: Polygon / Amoy)。
//
// 顧客が transferWithAuthorization に EIP-712 署名 (eth_signTypedData_v4・任意ウォレットで可) →
// ここで検証 (署名 recover==from / 残高 / rate-limit / authorizationState) → relayer が submit →
// poll → {txHash}。委任不要なので現行 7702 経路より到達が広い。詳細・段階計画は memory:jpyc-eip3009。
//
// 送信 provider は "起動時に1回" 確定する (within-request の failover はしない — broadcast 後の
// 曖昧な状態で別経路に流すと二重送金しうるため・Codex #5):
//   RELAYER_PRIVATE_KEY あり → self-host (運営 EOA が直接 submit・POL 負担。既定)
//   なければ GELATO_SPONSOR_API_KEY あり → gelato (sponsoredCall。deploy 単位の rollback 用)
//   どちらも無し → relay_not_configured (client は 7702/standard へ fallback)
//
// 実依存 (viem / Gelato fetch / KV rate-limit) を inject して lib/relay/jpycRelay の純コアに委譲
// (分岐は unit test で担保)。

import { NextResponse } from 'next/server';
import {
  createPublicClient,
  parseAbi,
  isAddress,
  isHex,
  getAddress,
  type Address,
  type Hex,
} from 'viem';
import { isKvConfigured } from '@/lib/kv';
import { logger } from '@/lib/logger';
import { recordRelayedVolume } from '@/lib/billingMeter';
import { isGaslessRelayBlocked } from '@/lib/feeGate';
import type { RelayResult } from '@/lib/relay/jpycRelay';
import {
  PROVIDER,
  MAX_VALUE,
  MAINNET_CHAINS,
  RELAY_MAX_GAS_COST_WEI,
  RELAY_LOW_BALANCE_ALERT_WEI,
  SUPPORTED_CHAINS,
  transportFor,
  jpycAddressFor,
  getBalance,
  readAuthorizationUsed,
  selfHostIoFor,
  relayFreeAuthorization,
} from '@/lib/relay/relayProvider';
import { submitSelfHost, pollSelfHost } from '@/lib/relay/selfHostRelayer';
import {
  recoverViaForwarder,
  type ForwarderRecoverDeps,
} from '@/lib/relay/forwarderRecover';
import {
  buildForwarderNonce,
  type ForwarderSettleParams,
} from '@/lib/relay/forwarderIntent';
import {
  jpycForwarderFor,
  configuredJpycForwarderFor,
} from '@/lib/relay/forwarderConfig';
import { recoverFeeValue } from '@/lib/relay/recoverFee';
import {
  checkRateLimit,
  checkGasBudget,
  refundGasBudget,
  makeIdempotency,
} from '@/lib/relay/relayGuards';
import { feeDisclosureDivergence } from '@/lib/legal';
import { env } from '@/lib/env';

export const runtime = 'nodejs';

const MAX_BODY_BYTES = 4 * 1024;

// CDX-1: forwarder の immutable getter (Eip3009Forwarder.token / feeReceiver)。健全性チェックで読む。
const FORWARDER_GETTERS_ABI = parseAbi([
  'function token() view returns (address)',
  'function feeReceiver() view returns (address)',
]);

// CDX-1: chain 別 forwarder 健全性チェックの判定キャッシュ (process lifetime)。'valid' (肯定的に検証済み)
// と DETERMINISTIC 無効 (no-code / token mismatch / feeReceiver mismatch・恒久) のみキャッシュする。
// 検証不能 (RPC throw 等) はキャッシュせず毎リクエストで再試行する (自己回復)。値: 'valid' = 健全,
// 文字列(理由) = 恒久的に無効。
const forwarderVerdictCache = new Map<number, 'valid' | string>();
// 設計 (Codex 4 round の最終形): 「**肯定的に検証できた時だけ submit**」。
// getBytecode/getter の throw (RPC flake でも別コントラクトの revert でも) は理由を問わず
// 「今回は検証不能」とし submit しない (= 非 null を返す) が **キャッシュしない** → 次リクエストで再試行し
// 自己回復する。これにより:
//   (a) false-success (EOA / 別コントラクトの settle no-op) を完全に塞ぐ (検証成功時のみ先へ進むため)。
//   (b) 一時的 RPC flake で chain を恒久 503 キャッシュしない (throw は非キャッシュ)。
//   (c) エラー文字列を transport/contract に分類する fragile なロジックが不要になる。
// 代償は「RPC flake 中の初回 recover が standard へ落ちる」だけ (安全・自己回復・利用者は支払える)。
// 返り値: null = 肯定的に検証済み (submit 可) / 非 null = 503 relay_not_configured に倒す理由。
async function verifyRecoverForwarder(
  chainId: number,
  forwarder: Address,
  jpyc: Address,
  feeReceiver: Address,
): Promise<string | null> {
  const cached = forwarderVerdictCache.get(chainId);
  if (cached !== undefined) return cached === 'valid' ? null : cached;

  const client = createPublicClient({
    chain: SUPPORTED_CHAINS[chainId].chain,
    transport: transportFor(chainId),
  });

  // STEP 1: bytecode。no-code (EOA/未デプロイ) は DETERMINISTIC 無効 → キャッシュ + 503。
  //         throw は検証不能 → 非キャッシュで 503 (次回再試行)。
  let code: Hex | undefined;
  try {
    code = await client.getBytecode({ address: forwarder });
  } catch (e) {
    logger.warn('relay.jpyc.forwarder_unverified', {
      chainId,
      error: e instanceof Error ? e.message : String(e),
    });
    return 'forwarder_unverified'; // 非キャッシュ: 次リクエストで再試行
  }
  if (!code || code === '0x') {
    forwarderVerdictCache.set(chainId, 'no_bytecode');
    logger.error('relay.jpyc.forwarder_invalid', { chainId, forwarder, reason: 'no_bytecode' });
    return 'no_bytecode';
  }

  // STEP 2: immutable getter を **肯定的に** 読む。throw は理由を問わず検証不能 → 非キャッシュ 503。
  //         token()/feeReceiver() を持たない別コントラクトも、RPC flake も、ここで一律に submit しない
  //         (= false-success を構造的に排除)。値が取れた時だけ不一致判定へ進む。
  let token: Address;
  let onChainFeeReceiver: Address;
  try {
    token = await client.readContract({
      address: forwarder,
      abi: FORWARDER_GETTERS_ABI,
      functionName: 'token',
    });
    onChainFeeReceiver = await client.readContract({
      address: forwarder,
      abi: FORWARDER_GETTERS_ABI,
      functionName: 'feeReceiver',
    });
  } catch (e) {
    logger.warn('relay.jpyc.forwarder_unverified', {
      chainId,
      error: e instanceof Error ? e.message : String(e),
    });
    return 'forwarder_unverified'; // 非キャッシュ: getter が取れない限り submit しない
  }

  // 値が取れた → DETERMINISTIC 不一致判定 (恒久・キャッシュする)。
  let reason: string | null = null;
  if (getAddress(token) !== getAddress(jpyc)) {
    reason = `token_mismatch(${token} != ${jpyc})`;
  } else if (getAddress(onChainFeeReceiver) !== getAddress(feeReceiver)) {
    reason = `fee_receiver_mismatch(${onChainFeeReceiver} != ${feeReceiver})`;
  }

  if (reason) {
    forwarderVerdictCache.set(chainId, reason);
    logger.error('relay.jpyc.forwarder_invalid', { chainId, forwarder, reason });
    return reason;
  }

  forwarderVerdictCache.set(chainId, 'valid');
  return null;
}

// recover モード config は client/server 共有 (lib/relay/forwarderConfig)。forwarder アドレスが
// chain に設定されていれば recover モード (= 立替+回収)、無ければ free (Phase A 直接 transfer)。
const forwarderFor = jpycForwarderFor;
// forwarder の immutable feeReceiver と一致させる回収先 (= OpenPay fee receiver)。
function feeReceiverFor(_chainId: number): Address | null {
  return isAddress(env.feeReceiver) ? getAddress(env.feeReceiver) : null;
}
const MAX_VALIDITY_WINDOW_SEC = 20 * 60;

// recover (forwarder 設定) は self-host relayer 前提 (recover 経路は forwarder.settle を自前 EOA で
// submit する)。client は PROVIDER を見えないため forwarder 設定だけで recover payload を送る。
// forwarder を設定したのに self-host でない構成は誤設定 (client の recover payload を handleFree が
// 弾き 400 になる) → 起動時に警告。invariant: forwarder 設定 ⟹ RELAYER_PRIVATE_KEY 設定。
if (
  PROVIDER !== 'self-host' &&
  Object.keys(SUPPORTED_CHAINS).some(
    (id) => configuredJpycForwarderFor(Number(id)) !== null,
  )
) {
  logger.warn('relay.jpyc.misconfig', {
    reason:
      'forwarder configured but PROVIDER is not self-host; recover requires self-host',
  });
}

// recover (forwarder 立替+回収) と a1 利用料 (NEXT_PUBLIC_ENABLE_USAGE_FEE) は併用不可。
// recover 経路 (handleRecover) は isGaslessRelayBlocked の延滞遮断も recordRelayedVolume の
// 出来高メーターも通らないため、両立すると延滞ゲート/出来高メーターを迂回する。排他は resolver
// (jpycForwarderFor) で解決済み: a1 が ON のとき jpycForwarderFor は全 chain で null を返すため
// client は free payload を組み、server も recoverMode=false で handleFree に倒れる (ゲート/メーター付き)。
// 致命的な 503 は不要。ただし両方を *設定* した運営の構成ミスは可視化する必要があるため、ここでは
// 生の forwarder 値 (configuredJpycForwarderFor) で起動時に警告する (a1 が ON でも検出できる)。
if (env.enableUsageFee) {
  if ([...MAINNET_CHAINS].some((id) => configuredJpycForwarderFor(id) !== null)) {
    logger.error('relay.jpyc.misconfig', {
      reason:
        'mainnet forwarder (recover) configured while usage fee (a1) is enabled; ' +
        'recover bypasses the fee gate/meter — a1 takes precedence so recover is disabled ' +
        '(effective forwarder=null, relay runs free mode); remove the forwarder env to clear this',
    });
  } else if (
    Object.keys(SUPPORTED_CHAINS).some(
      (id) => configuredJpycForwarderFor(Number(id)) !== null,
    )
  ) {
    logger.warn('relay.jpyc.misconfig', {
      reason:
        'testnet forwarder (recover) configured while usage fee (a1) is enabled; ' +
        'a1 takes precedence so recover is disabled (effective forwarder=null, relay runs free mode)',
    });
  }
}

// L4: 法務開示と実 env の乖離検知。live の徴収数値 (NEXT_PUBLIC_RELAY_GAS_FEE_JPYC /
// NEXT_PUBLIC_RECOVER_FEE_BPS) が、Terms/Disclaimer/特商法/お知らせ で利用者に約束した数値
// (lib/legal.ts DISCLOSED_RECOVER_FEE) と食い違っていれば起動時に warn を出す。運営が文書を改定
// せず env だけ変えると文書が黙って嘘になるため、Sentry でその乖離を可視化する (throw はしない —
// 決済は止めない)。一致していれば何もしない。
{
  const divergence = feeDisclosureDivergence();
  if (divergence) {
    logger.warn('relay.jpyc.fee_disclosure_divergence', {
      reason:
        'live relay fee env diverges from the disclosed numbers in Terms/Disclaimer/Tokutei/news ' +
        '(lib/legal.ts DISCLOSED_RECOVER_FEE); changing fees requires revising the legal text ' +
        '(new 改定 entry). Either revert the env or revise the disclosure.',
      detail: divergence,
    });
  }
}

// 冪等性ヘルパは共有 relayGuards から prefix 指定で生成する。決済 relay は従来の prefix
// (relay:idem:) を維持し挙動を不変に保つ (rate-limit / 日次予算は共有キーで両 route 共通)。
// recover 経路 (handleRecover) でこの helper を inject する (free 経路は relayFreeAuthorization が
// 同 prefix で内製する)。
const { claimIdempotency, recordRelayHash, releaseIdempotency } =
  makeIdempotency('relay:idem:');

function anonymizeIp(ip: string): string {
  const first = ip.split(',')[0].trim();
  if (first.includes(':')) return first.split(':').slice(0, 4).join(':') + '::/64';
  const p = first.split('.');
  return p.length === 4 ? `${p[0]}.${p[1]}.${p[2]}.0/24` : 'unknown';
}

function isDec(v: unknown): v is string {
  return typeof v === 'string' && /^[0-9]+$/.test(v);
}

export async function POST(req: Request): Promise<NextResponse> {
  // relay 未構成なら早期に signal (client が fallback 判定できるよう専用コード)。
  if (PROVIDER === null) {
    return NextResponse.json(
      { ok: false, error: 'relay_not_configured' },
      { status: 503 },
    );
  }

  let bodyText: string;
  try {
    bodyText = await req.text();
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid_json' }, { status: 400 });
  }
  if (Buffer.byteLength(bodyText, 'utf8') > MAX_BODY_BYTES) {
    return NextResponse.json({ ok: false, error: 'payload_too_large' }, { status: 413 });
  }
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(bodyText);
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid_json' }, { status: 400 });
  }

  if (typeof raw.chainId !== 'number' || !Number.isInteger(raw.chainId)) {
    return NextResponse.json({ ok: false, error: 'invalid_payload' }, { status: 400 });
  }
  const chainId = raw.chainId;

  // recover (forwarder)×a1 の排他は resolver (jpycForwarderFor) で解決済み: a1 が ON のとき
  // forwarderFor(chainId) は null を返す → 下の recoverMode が false → handleFree に倒れ、a1 の
  // 関所ゲート + 出来高メーターが効く。よって顧客決済を壊す致命的な 503 は不要 (config guard が
  // 顧客の支払いを止めるのは誤り)。両方を *設定* した運営の構成ミスは起動時 logger
  // (configuredJpycForwarderFor 基準) で可視化済み。

  // mainnet (Polygon/Kaia) を self-host で relay する前提条件 (testnet は緩く運用可)。silent な
  // 無効化を避け mainnet のみ 503 で拒否する。
  if (PROVIDER === 'self-host' && MAINNET_CHAINS.has(chainId)) {
    // B5: gas-cost ceiling 未設定は赤字リスク (Codex P1)。
    if (RELAY_MAX_GAS_COST_WEI === 0n) {
      logger.error('RELAY_MAX_GAS_COST_WEI unset on mainnet self-host (B5 必須)', {
        chainId,
      });
      return NextResponse.json(
        { ok: false, error: 'gas_ceiling_required' },
        { status: 503 },
      );
    }
    // KV 必須: 未設定だと idempotency が fail-open になり、TTL 失効や重複 POST で同一 authorization の
    // 二重 submit が起こりうる (fatal+unused→relay_error→standard fallback の安全性が崩れる・Codex)。
    // mainnet では KV を必須にして fail-open 経路を塞ぐ (最終防壁の on-chain に加えた多層防御)。
    if (!isKvConfigured()) {
      logger.error('KV unconfigured on mainnet self-host (idempotency/budget 必須)', {
        chainId,
      });
      return NextResponse.json(
        { ok: false, error: 'kv_required' },
        { status: 503 },
      );
    }
  }

  const ipPrefix = anonymizeIp(
    req.headers.get('x-forwarded-for') ?? req.headers.get('x-real-ip') ?? '',
  );

  // L5: forwarder を設定した chain なのに self-host relayer 鍵が無い (PROVIDER!=='self-host') 構成は、
  // client が recover payload (merchant/merchantValue/feeValue/intentSalt) を送ってくるのに handleFree が
  // それを invalid_payload (400) として弾く → 全 JPYC 決済が汎用エラーで死ぬ。これを明示の
  // 503 relay_not_configured に倒し、client が standard モードへ綺麗に fallback できるようにする
  // (client は relay_not_configured → errorRelayNotConfigured + standard 案内にマップ済み)。
  // 生の forwarder lookup (configuredJpycForwarderFor) で判定する: ただし a1 (env.enableUsageFee) が
  // ON のときは resolver (jpycForwarderFor) が意図的に forwarder=null に倒し client も free payload を
  // 組むため、recover payload は来ない → この場合は 503 を出さず free 経路へ通す (顧客決済を壊さない)。
  // Gelato (PROVIDER==='gelato') も recover (forwarder.settle を自前 EOA で submit) はできないため
  // 同じ 503 に倒す (PROVIDER!=='self-host' で一括カバー)。
  if (
    PROVIDER !== 'self-host' &&
    !env.enableUsageFee &&
    configuredJpycForwarderFor(chainId) !== null
  ) {
    logger.warn('relay.jpyc.relay_not_configured', {
      chainId,
      reason:
        'forwarder configured for this chain but relayer key missing (PROVIDER is not self-host); ' +
        'recover requires self-host RELAYER_PRIVATE_KEY — returning 503 so client falls back to standard',
    });
    return NextResponse.json(
      { ok: false, error: 'relay_not_configured' },
      { status: 503 },
    );
  }

  // forwarder が設定された chain は recover モード (gas 相当額を JPYC 回収・self-host 限定)。
  // 無ければ free モード (Phase A・直接 transferWithAuthorization)。
  // ⚠️ recover (per-tx ガス回収) と a1 月額 OpenPay 利用料 (NEXT_PUBLIC_ENABLE_USAGE_FEE) は **排他**:
  // 両方有効にすると recover 経路が利用料ゲート/メーターを迂回する。排他は forwarderFor (= a1-aware な
  // jpycForwarderFor) で解決済み: a1 が ON なら forwarderFor は null を返すため recoverMode=false に
  // 倒れ handleFree (ゲート+メーター付き) で処理される。client も同じ resolver で free payload を組む
  // ため payload 形が食い違わない。詳細は docs/plans/merchant-gasless-fee-a1.md (S5/P3)。
  const recoverMode =
    PROVIDER === 'self-host' &&
    chainId in SUPPORTED_CHAINS &&
    forwarderFor(chainId) !== null;

  return recoverMode
    ? handleRecover(raw, chainId, ipPrefix)
    : handleFree(raw, chainId, ipPrefix);
}

// 結果 → HTTP 応答 (free / recover 共通)。pending は 202 で client に fallback 禁止を伝える。
function respond(result: RelayResult, chainId: number): NextResponse {
  switch (result.kind) {
    case 'success':
      return NextResponse.json({ ok: true, txHash: result.txHash });
    case 'reverted':
      logger.warn('relay.jpyc.reverted', { txHash: result.txHash, chainId });
      return NextResponse.json({ ok: false, reverted: true, txHash: result.txHash });
    case 'pending':
      // broadcast 済だが未確定。client は standard へ fallback してはならない (二重支払い防止)。
      logger.warn('relay.jpyc.pending', { txHash: result.txHash, chainId });
      return NextResponse.json(
        { ok: false, pending: true, txHash: result.txHash ?? null },
        { status: 202 },
      );
    case 'rejected':
      return NextResponse.json(
        { ok: false, error: result.reason },
        { status: result.httpStatus },
      );
    case 'relay_error':
      logger.warn('relay.jpyc.relay_error', { detail: result.detail, chainId });
      return NextResponse.json({ ok: false, error: 'relay_error' }, { status: 502 });
  }
}

// free モード: 直接 transferWithAuthorization (Phase A)。relayer が token に直接 submit。
async function handleFree(
  raw: Record<string, unknown>,
  chainId: number,
  ipPrefix: string,
): Promise<NextResponse> {
  if (
    !isAddress(raw.from as string) ||
    !isAddress(raw.to as string) ||
    !isDec(raw.value) ||
    !isDec(raw.validAfter) ||
    !isDec(raw.validBefore) ||
    typeof raw.nonce !== 'string' ||
    !/^0x[0-9a-fA-F]{64}$/.test(raw.nonce) ||
    typeof raw.signature !== 'string' ||
    !isHex(raw.signature)
  ) {
    return NextResponse.json({ ok: false, error: 'invalid_payload' }, { status: 400 });
  }
  const auth = {
    from: getAddress(raw.from as string),
    to: getAddress(raw.to as string),
    value: BigInt(raw.value),
    validAfter: BigInt(raw.validAfter),
    validBefore: BigInt(raw.validBefore),
    nonce: raw.nonce as Hex,
  };

  // 利用料支払い (店主→FEE_RECEIVER) かどうか。関所ゲート除外 + メーター除外で共用する。
  const feeRecv = feeReceiverFor(chainId);
  const isFeePayment =
    feeRecv !== null && auth.to.toLowerCase() === feeRecv.toLowerCase();

  // OpenPay 利用料 関所ゲート (S5): billing 点灯中、利用料が未払い (前月請求あり・猶予超過) の店主は
  // ガスレス中継を停止する。顧客は standard モード (自分でガス負担) で無料のまま決済できる。
  // billing OFF / アルファ bypass / 利用料支払い自体 は遮断しない。KV 障害時は fail-open。
  if (await isGaslessRelayBlocked(auth.to, isFeePayment)) {
    return NextResponse.json({ ok: false, error: 'fee_required' }, { status: 402 });
  }

  // PROVIDER 種別ごとの deps 構築 (self-host IO / Gelato submit-poll / idempotency prefix relay:idem:)
  // は共有 relayFreeAuthorization に集約。CSV パス購入 relay と同一の self-host/poll/ガード経路を通る。
  const result = await relayFreeAuthorization(
    chainId,
    auth,
    raw.signature as Hex,
    [auth.from, ipPrefix],
    { idemPrefix: 'relay:idem:' },
  );
  // OpenPay 利用料メーター (S1): 中継成功した gasless 決済の店主別出来高をサーバ権威で記録する
  // (将来の月次利用料 a1 の課金根拠)。merchant=auth.to / value=auth.value。点灯前から貯める
  // 設計で NEXT_PUBLIC_ENABLE_USAGE_FEE に依存しない。失敗しても決済応答は壊さない (undercount=honest)。
  // 除外: 店主が利用料を FEE_RECEIVER へ支払う tx を「売上出来高」として誤計上しない (isFeePayment 共用)。
  if (result.kind === 'success') {
    if (!isFeePayment) {
      try {
        await recordRelayedVolume({
          chainId,
          merchant: auth.to,
          value: auth.value,
          nowMs: Date.now(),
          txHash: result.txHash,
        });
      } catch (e) {
        logger.warn('billing.meter.record_failed', {
          chainId,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }
  return respond(result, chainId);
}

// recover モード: forwarder.settle 経由で amount→店舗 + gas相当→feeReceiver を 1 署名分割。
// feeReceiver/feeValue は server 権威 (client 値は信用せず一致を強制)。
async function handleRecover(
  raw: Record<string, unknown>,
  chainId: number,
  ipPrefix: string,
): Promise<NextResponse> {
  if (
    !isAddress(raw.from as string) ||
    !isAddress(raw.merchant as string) ||
    !isDec(raw.merchantValue) ||
    !isDec(raw.feeValue) ||
    !isDec(raw.validAfter) ||
    !isDec(raw.validBefore) ||
    typeof raw.intentSalt !== 'string' ||
    !/^0x[0-9a-fA-F]{64}$/.test(raw.intentSalt) ||
    typeof raw.signature !== 'string' ||
    !isHex(raw.signature)
  ) {
    return NextResponse.json({ ok: false, error: 'invalid_payload' }, { status: 400 });
  }
  const feeReceiver = feeReceiverFor(chainId);
  if (!feeReceiver) {
    return NextResponse.json(
      { ok: false, error: 'relay_not_configured' },
      { status: 503 },
    );
  }
  const params: ForwarderSettleParams = {
    from: getAddress(raw.from as string),
    merchant: getAddress(raw.merchant as string),
    merchantValue: BigInt(raw.merchantValue),
    feeReceiver, // server 権威 (client 値は使わない・nonce で client と一致を強制)
    feeValue: BigInt(raw.feeValue),
    validAfter: BigInt(raw.validAfter),
    validBefore: BigInt(raw.validBefore),
    intentSalt: raw.intentSalt as Hex,
  };
  // gasMode は手数料計算の検証ヒント (署名対象ではない)。billAmount を (merchantValue, feeValue)
  // から再構成するために使う:
  //   customer: merchantValue == billAmount (顧客が手数料を上乗せ・店舗は満額受領)
  //   merchant: merchantValue == billAmount − feeValue (店舗が手数料を吸収・顧客は表示額ちょうど)
  // 旧 client は gasMode を送らない → 'customer' に既定 (後方互換・bps=0 なら gasMode は無関係)。
  // 不正値も 'customer' に倒す。誤った gasMode は expectedFee が署名済 feeValue と食い違い
  // fee_value_mismatch で安全に弾かれる (悪用不可・client 値を信用しているわけではない)。
  const gasMode = raw.gasMode === 'merchant' ? 'merchant' : 'customer';
  const billAmount =
    gasMode === 'merchant'
      ? params.merchantValue + params.feeValue
      : params.merchantValue;
  // server 権威の per-tx 手数料。料金スケジュールは gasMode で選択される (確定モデル):
  //   merchant (決済): max(ガスフロア, billAmount × bps/10000)。
  //   customer (チップ): フロアのみ (bps 無視)。
  // client と **同じ payload gasMode** で同式 (recoverFeeValue) 算出し、forwarderRecover が
  // feeValue === expectedFeeValue を強制する。gasMode の偽造は有界 (customer 主張でも最低
  // フロアを払い、署名済の分割は nonce で固定される)。
  const expectedFee = recoverFeeValue(billAmount, gasMode);
  const io = selfHostIoFor(chainId);
  // collision/fatal 時の authState 再確認用 (P0/P1)。recover の nonce は commitment nonce。
  const jpyc = jpycAddressFor(chainId);
  const forwarder = forwarderFor(chainId);

  // CDX-1: submit 前に forwarder を on-chain で **肯定的に** 検証する。env の forwarder が EOA や
  // 別コントラクト/別 token/別 feeReceiver だと settle() が no-op SUCCESS して「API 成功・着金ゼロ・
  // authorization 未消費」になる。検証成功 (null) のときだけ submit へ進み、無効 or 検証不能 (非 null) は
  // 503 relay_not_configured に倒す (client が standard へ綺麗にフォールバック)。RPC flake 中の検証不能は
  // キャッシュされないので RPC 回復後に自動で recover へ戻る (verifyRecoverForwarder の説明参照)。
  if (jpyc && forwarder) {
    const invalid = await verifyRecoverForwarder(chainId, forwarder, jpyc, feeReceiver);
    if (invalid) {
      return NextResponse.json(
        { ok: false, error: 'relay_not_configured' },
        { status: 503 },
      );
    }
  }

  const isAuthorizationUsed =
    jpyc && forwarder
      ? () =>
          readAuthorizationUsed(
            chainId,
            jpyc,
            params.from,
            buildForwarderNonce(params, chainId, forwarder),
          )
      : undefined;
  const deps: ForwarderRecoverDeps = {
    nowSec: () => Math.floor(Date.now() / 1000),
    expectedFeeValue: expectedFee,
    maxValue: MAX_VALUE,
    maxValidityWindowSec: MAX_VALIDITY_WINDOW_SEC,
    jpycAddressFor,
    forwarderFor,
    feeReceiverFor,
    getBalance,
    checkRateLimit,
    // refund (未 broadcast 失敗の予算返却) を recover 経路にも配線。recover は本番標準経路に昇格した
    // ため、free 経路 (jpycRelay) と同一セマンティクスで日次予算を回収する: checkGasBudget で INCR 消費
    // した枠を、tx が 1 件も broadcast されなかったことが確実な失敗 (submit throw / poll 'error') でのみ
    // DECR で 1 戻す (RPC 不安定日に正当決済が daily_budget_exceeded で 503 になるのを防ぐ)。fail-quiet。
    checkGasBudget,
    refundGasBudget,
    checkAuthorizationUsed: readAuthorizationUsed,
    claimIdempotency,
    recordRelayHash,
    releaseIdempotency,
    submit: (_c, target, data) =>
      submitSelfHost(io, target, data, {
        maxGasCostWei: RELAY_MAX_GAS_COST_WEI,
        isAuthorizationUsed,
        lowBalanceWei: RELAY_LOW_BALANCE_ALERT_WEI,
        onLowBalance: (b) =>
          logger.warn('relay.relayer.balance_low', {
            chainId,
            balanceWei: b.toString(),
          }),
      }),
    pollTask: (taskId) => pollSelfHost(io, taskId),
  };
  const result = await recoverViaForwarder(
    { chainId, params, signature: raw.signature as Hex, rateLimitKeys: [params.from, ipPrefix] },
    deps,
  );
  return respond(result, chainId);
}
