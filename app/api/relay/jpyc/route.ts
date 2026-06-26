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
import { isAddress, isHex, getAddress, type Hex } from 'viem';
import { isKvConfigured } from '@/lib/kv';
import { logger } from '@/lib/logger';
import { recordRelayedVolume } from '@/lib/billingMeter';
import { isGaslessRelayBlocked } from '@/lib/feeGate';
import {
  PROVIDER,
  MAINNET_CHAINS,
  relayMaxGasCostWei,
  SUPPORTED_CHAINS,
  relayFreeAuthorization,
} from '@/lib/relay/relayProvider';
import { type ForwarderSettleParams } from '@/lib/relay/forwarderIntent';
import {
  jpycForwarderFor,
  configuredJpycForwarderFor,
  isRecoverRequiredChain,
} from '@/lib/relay/forwarderConfig';
import { recoverFeeValue } from '@/lib/relay/recoverFee';
import {
  settleViaForwarder,
  feeReceiverFor,
} from '@/lib/relay/forwarderSettleService';
import {
  isMobileOrderFeeKind,
  mobileOrderFeeValue,
} from '@/lib/mobileOrderFee';
import {
  MAX_BODY_BYTES,
  isDec,
  anonymizeIp,
  makeRespond,
} from '@/lib/relay/relayRoute';
import { feeDisclosureDivergence } from '@/lib/legal';
import { env } from '@/lib/env';

export const runtime = 'nodejs';

// MAX_BODY_BYTES / isDec / anonymizeIp / respond は共有 relayRoute へ集約 (CSV パス relay と同形)。
// respond は logger イベント prefix を 'relay.jpyc' で束ね、現行のイベント名を完全再現する。

// forwarder 健全性チェック (verifyForwarderHealth) は lib/relay/forwarderHealth へ、settle
// オーケストレーション (検証 + broadcast) と feeReceiverFor / MAX_VALIDITY_WINDOW_SEC は
// lib/relay/forwarderSettleService へ抽出した (x402 facilitator と共有・挙動不変)。

// recover モード config は client/server 共有 (lib/relay/forwarderConfig)。forwarder アドレスが
// chain に設定されていれば recover モード (= 立替+回収)、無ければ free (Phase A 直接 transfer)。
const forwarderFor = jpycForwarderFor;

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

// 冪等性ヘルパ (prefix 'relay:idem:') は settleViaForwarder が recover 経路で内製する。free 経路は
// relayFreeAuthorization が同 prefix で内製。rate-limit / 日次予算は relayGuards 内で両 route 共有キー。

// 結果 → HTTP 応答 (free / recover 共通)。共有 makeRespond に prefix 'relay.jpyc' を束ねて、
// 従来のイベント名 (relay.jpyc.reverted / .pending / .relay_error) と応答 body/status を完全再現する。
const respond = makeRespond('relay.jpyc');

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
    // B5: gas-cost ceiling 未設定は赤字リスク (Codex P1)。per-chain 解決
    // (Avalanche は RELAY_MAX_GAS_COST_WEI_AVALANCHE 必須・グローバルは POL/KAIA 用)。
    if (relayMaxGasCostWei(chainId) === 0n) {
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

  // recover-required chain (Avalanche) は free モード禁止 (OpenPay relayer の AVAX 持ち出し防止)。
  // recover でない (forwarder 未設定 or a1 ON で実効 null) なら handleFree に倒さず 503 で拒否し、
  // client を standard へ誘導する。⚠️ server 権威の安全策: client ゲート (paymasterMode→standard) を
  // 迂回する直接署名 POST でもここで止まる (Codex P1)。
  if (!recoverMode && isRecoverRequiredChain(chainId)) {
    logger.warn('relay.jpyc.recover_required_no_forwarder', { chainId });
    return NextResponse.json(
      { ok: false, error: 'relay_not_configured' },
      { status: 503 },
    );
  }

  return recoverMode
    ? handleRecover(raw, chainId, ipPrefix)
    : handleFree(raw, chainId, ipPrefix);
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
  // server 権威の per-tx 手数料。
  //   モバイル注文 (feeKind present + flag ON): 経路非依存のシステム利用料 = 一律 % を **定数表から
  //     再計算** する (mobileOrderFeeValue)。client 申告の率は信用せず server が定数から導くため率を
  //     下げられない (残余は「安い feeKind を申告」=過少徴収のみ・資金毀損なし)。flag OFF では
  //     feeKind を無視 (= 従来の gas-recovery に倒す)。
  //   それ以外 (/pay・/checkout・チップ): 従来の gas-recovery (recoverFeeValue・gasMode 選択):
  //     merchant=max(ガスフロア, billAmount × bps/10000)・customer=フロアのみ。
  // いずれも client と **同式** で算出し、forwarderRecover が feeValue === expectedFeeValue を強制
  // する (feeValue は nonce にコミットされるため client/server がずれると署名検証が落ちる → KV/handle
  // 非依存の純関数で算出する)。
  const feeKind =
    env.enableMobileOrderFee && isMobileOrderFeeKind(raw.feeKind)
      ? raw.feeKind
      : undefined;
  const expectedFee = feeKind
    ? mobileOrderFeeValue(billAmount, feeKind)
    : recoverFeeValue(billAmount, gasMode, chainId);
  // 検証 (server 権威 feeValue 照合 / 署名 recover / 残高 / nonce 未使用 / 冪等 / 日次予算) +
  // forwarder 健全性 + submit/poll は共有 settleViaForwarder に集約 (x402 facilitator と同一コア)。
  // recover 固有値だけ渡す: expectedFeeValue = 上で算出した recover 料率 / forwarderFor = a1-aware /
  // idemPrefix = 'relay:idem:' (従来の冪等名前空間を維持)。
  const result = await settleViaForwarder({
    chainId,
    params,
    signature: raw.signature as Hex,
    rateLimitKeys: [params.from, ipPrefix],
    expectedFeeValue: expectedFee,
    forwarderFor,
    idemPrefix: 'relay:idem:',
  });
  return respond(result, chainId);
}
