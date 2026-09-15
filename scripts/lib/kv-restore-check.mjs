// Offline graph checks against the stored schemas. Never import app/server modules or emit values.
import { isDeepStrictEqual } from 'node:util';
import { encodeAbiParameters, getAddress, isAddress, keccak256, stringToHex } from 'viem';
import { sha256 } from './kv-backup-core.mjs';

const PRODUCT = 'h_[0-9a-f]{32}';
const HEX = '0x[0-9a-f]{64}';
const ADDRESS = '0x[0-9a-f]{40}';
const OB_INDEX = 'store:license:ob:index';
const REG_INDEX = 'store:license:registration:index';
const ACTIVE = 'store:license:worker:active';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const integer = (v) => Number.isSafeInteger(v) && v >= 0;
const hex = (v) => typeof v === 'string' && /^0x[0-9a-f]{64}$/i.test(v);
const lower = (v) => typeof v === 'string' ? v.toLowerCase() : '';
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const decimal = (v) => typeof v === 'string' && /^(0|[1-9][0-9]*)$/.test(v);
const contentKey = (id, revision) => `x402:hosted:${id}:content:${revision}`;
const ownKey = (payer, id) => `store:own:${lower(payer)}:${id}`;
const libKey = (payer) => `store:lib:${lower(payer)}`;

// definition.ts's immutable tuple validation, independent of runtime flags/deployment.
function licenseDefinition(v) {
  if (!object(v) || v.schema !== 1 || v.rail !== 'jpyc' || ![137, 80002].includes(v.tokenChainId)
    || !isAddress(v.contract ?? '') || /^0x0{40}$/i.test(v.contract) || typeof v.deploymentId !== 'string' || !v.deploymentId || v.deploymentId.length > 200
    || !integer(v.supply) || v.supply < 1 || v.supply > 10_000 || typeof v.transferable !== 'boolean'
    || typeof v.termsUrl !== 'string' || v.termsUrl.length > 512 || typeof v.termsVersion !== 'string' || !v.termsVersion.trim() || v.termsVersion.length > 128
    || ![v.tokenId, v.termsHash, v.definitionHash].every((x) => typeof x === 'string' && /^0x[0-9a-f]{64}$/.test(x))
    || typeof v.contentRef !== 'string' || !/^x402:hosted:h_[0-9a-f]{32}:content:1$/.test(v.contentRef)) return null;
  try {
    const url = new URL(v.termsUrl);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    const id = v.contentRef.slice('x402:hosted:'.length, -':content:1'.length);
    const termsHash = keccak256(encodeAbiParameters([{ type: 'string' }, { type: 'string' }], [v.termsUrl, v.termsVersion]));
    const hash = keccak256(encodeAbiParameters(
      ['bytes32', 'uint8', 'string', 'uint256', 'address', 'string', 'uint256', 'bool', 'string', 'string', 'bytes32', 'string', 'uint64'].map((type) => ({ type })),
      [keccak256(stringToHex('openpay.license.definition.v1')), v.schema, v.rail, BigInt(v.tokenChainId), v.contract, v.deploymentId,
        BigInt(v.tokenId), v.transferable, v.termsUrl, v.termsVersion, v.termsHash, v.contentRef, BigInt(v.supply)],
    ));
    if (v.tokenId !== keccak256(stringToHex(`openpay:license:${id}`)) || v.termsHash !== termsHash || v.definitionHash !== hash) return null;
    return { schema: 1, rail: 'jpyc', tokenChainId: v.tokenChainId, contract: getAddress(v.contract), deploymentId: v.deploymentId,
      tokenId: v.tokenId, transferable: v.transferable, termsUrl: v.termsUrl, termsVersion: v.termsVersion, termsHash: v.termsHash,
      contentRef: v.contentRef, supply: v.supply, definitionHash: v.definitionHash };
  } catch { return null; } // A corrupt tuple is quarantined, never treated as a different license.
}

// Match the projections in purchaseIntent.parseGrant/parseMetadata and storePaymentSnapshot.
function metadata(v) {
  if (!object(v) || !isAddress(v.owner ?? '') || !isAddress(v.payTo ?? '') || typeof v.title !== 'string' || !v.title
    || !decimal(v.priceJpyc) || !['url', 'text'].includes(v.contentKind)
    || !['download', 'pdf', 'zip', 'prompt', 'api', 'external'].includes(v.label)
    || (v.desc !== undefined && typeof v.desc !== 'string') || (v.emoji !== undefined && typeof v.emoji !== 'string')
    || (v.productKind !== undefined && v.productKind !== 'license') || (v.productKind === undefined && v.license !== undefined)) return null;
  const license = v.productKind === 'license' ? licenseDefinition(v.license) : null;
  if (v.productKind === 'license' && (!license || v.contentKind !== 'text' || BigInt(v.priceJpyc) < 1000n)) return null;
  return { ...(license ? { productKind: 'license', license } : {}),
    owner: getAddress(v.owner), payTo: getAddress(v.payTo), title: v.title,
    ...(v.desc === undefined ? {} : { desc: v.desc }), ...(v.emoji === undefined ? {} : { emoji: v.emoji }),
    priceJpyc: v.priceJpyc, contentKind: v.contentKind, label: v.label };
}
function payment(v) {
  const q = v?.quote;
  if (!object(v) || v.version !== 1 || v.rail !== 'usdc' || lower(v.asset) !== lower(USDC) || v.assetSymbol !== 'USDC'
    || v.chainId !== 8453 || !decimal(v.paidAtomic) || BigInt(v.paidAtomic) <= 0n || !decimal(v.priceJpyc) || BigInt(v.priceJpyc) <= 0n
    || !object(q) || typeof q.rateScaled !== 'string' || !/^[1-9][0-9]*$/.test(q.rateScaled) || !integer(q.rateFetchedAt)
    || !integer(q.fxQuoteExpiresAt) || q.fxQuoteExpiresAt <= q.rateFetchedAt || q.fxQuoteExpiresAt > q.rateFetchedAt + 180_000 || q.rounding !== 'ceil') return null;
  return { version: 1, rail: 'usdc', asset: USDC, assetSymbol: 'USDC', chainId: 8453,
    paidAtomic: v.paidAtomic, priceJpyc: v.priceJpyc, quote: { rateScaled: q.rateScaled, rateFetchedAt: q.rateFetchedAt,
      fxQuoteExpiresAt: q.fxQuoteExpiresAt, rounding: 'ceil' } };
}
function grant(v) {
  const meta = metadata(v?.metadata);
  if (!object(v) || !hex(v.intentSalt) || !hex(v.txHash) || !hex(v.nonce) || !meta || !integer(v.contentRevision) || v.contentRevision < 1
    || typeof v.contentRef !== 'string' || !v.contentRef || !integer(v.chainId) || v.chainId < 1 || !integer(v.purchasedAt)) return null;
  if (meta.license && (meta.license.contentRef !== v.contentRef || v.contentRevision !== 1 || meta.license.tokenChainId !== v.chainId)) return null;
  const pay = v.payment === undefined ? undefined : payment(v.payment);
  if (v.payment !== undefined && (!pay || meta.productKind === 'license')) return null;
  return { intentSalt: lower(v.intentSalt), contentRevision: v.contentRevision, contentRef: v.contentRef, metadata: meta,
    chainId: v.chainId, txHash: lower(v.txHash), nonce: lower(v.nonce), purchasedAt: v.purchasedAt,
    ...(pay ? { payment: pay } : {}) };
}
function ownership(v) {
  if (!object(v) || v.version !== 1 || v.policy !== 'all-purchased-revisions' || !isAddress(v.payer ?? '')
    || typeof v.resourceId !== 'string' || !v.resourceId || !integer(v.firstPurchasedAt) || !integer(v.updatedAt)
    || !Array.isArray(v.grants) || !v.grants.length) return null;
  const grants = v.grants.map(grant), latest = grant(v.latestGrant);
  if (!latest || grants.some((g) => !g || g.contentRef !== contentKey(v.resourceId, g.contentRevision))
    || new Set(grants.map((g) => g.intentSalt)).size !== grants.length) return null;
  const expected = grants.reduce((a, g) => g.contentRevision > a.contentRevision
    || (g.contentRevision === a.contentRevision && g.purchasedAt > a.purchasedAt) ? g : a);
  if (!isDeepStrictEqual(latest, expected) || v.firstPurchasedAt !== grants.reduce((first, g) => Math.min(first, g.purchasedAt), grants[0].purchasedAt)) return null;
  return { ...v, payer: getAddress(v.payer), grants, latestGrant: expected };
}
// Reproduce readIntent's settled-USDC parser before applying readSettledStoreUsdcAccess's graph tests.
function settledUsdcIntent(v) {
  const meta = metadata(v.metadata), c = v.claim;
  const times = ['rateFetchedAt', 'createdAt', 'intentExpiresAt', 'fxQuoteExpiresAt', 'signedAt', 'settledAt'];
  if (v.version !== 1 || v.deploymentVersion !== 'creator-store-usdc-vanilla-v1' || !hex(v.intentSalt) || !hex(v.txHash)
    || typeof v.parentIntentId !== 'string' || !/^[0-9a-f]{64}$/.test(v.parentIntentId) || !meta || meta.productKind !== undefined
    || !isAddress(v.payerHint ?? '') || !isAddress(v.merchant ?? '') || lower(v.token) !== lower(USDC) || v.chainId !== 8453
    || !integer(v.contentRevision) || v.contentRevision < 1 || v.contentRef !== contentKey(v.resourceId, v.contentRevision)
    || times.some((field) => !integer(v[field])) || !decimal(v.usdcQuoteAtomic) || BigInt(v.usdcQuoteAtomic) <= 0n
    || !decimal(v.rateScaled) || BigInt(v.rateScaled) <= 0n || !decimal(v.anchorBlock) || !decimal(v.authorizationValidBeforeMax)
    || v.rounding !== 'ceil' || lower(meta.payTo) !== lower(v.merchant)
    || lower(v.nonce) !== keccak256(stringToHex(`openpay:creator-store-usdc-vanilla-v1:${lower(v.intentSalt)}`))
    || v.createdAt >= v.fxQuoteExpiresAt || v.fxQuoteExpiresAt > v.intentExpiresAt || v.fxQuoteExpiresAt > v.rateFetchedAt + 180_000
    || v.authorizationValidBeforeMax !== String(Math.floor(v.fxQuoteExpiresAt / 1000))
    || (v.nextReconcileAt !== undefined && !integer(v.nextReconcileAt))
    || !object(c) || !isAddress(c.payer ?? '') || !isAddress(c.to ?? '') || !hex(c.nonce)
    || ![c.value, c.validAfter, c.validBefore].every(decimal) || typeof c.signatureFingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(c.signatureFingerprint)
    || lower(c.payer) !== lower(v.payerHint) || lower(c.to) !== lower(v.merchant) || c.value !== v.usdcQuoteAtomic
    || c.validAfter !== '0' || BigInt(c.validBefore) > BigInt(v.authorizationValidBeforeMax) || lower(c.nonce) !== lower(v.nonce)) return null;
  const base = { version: 1, deploymentVersion: v.deploymentVersion, intentSalt: lower(v.intentSalt), parentIntentId: v.parentIntentId,
    resourceId: v.resourceId, contentRevision: v.contentRevision, contentRef: v.contentRef, metadata: meta,
    payerHint: getAddress(v.payerHint), token: getAddress(v.token), chainId: 8453, merchant: getAddress(v.merchant),
    usdcQuoteAtomic: v.usdcQuoteAtomic, rateScaled: v.rateScaled, rateFetchedAt: v.rateFetchedAt, rounding: 'ceil', anchorBlock: v.anchorBlock,
    nonce: lower(v.nonce), createdAt: v.createdAt, intentExpiresAt: v.intentExpiresAt, fxQuoteExpiresAt: v.fxQuoteExpiresAt,
    authorizationValidBeforeMax: v.authorizationValidBeforeMax };
  const claim = { payer: getAddress(c.payer), to: getAddress(c.to), value: c.value, validAfter: c.validAfter, validBefore: c.validBefore,
    nonce: lower(c.nonce), signatureFingerprint: c.signatureFingerprint };
  if (sha256(JSON.stringify(base)) !== v.bindingHash || sha256(JSON.stringify(claim)) !== v.authorizationHash) return null;
  return { ...v, ...base, claim, txHash: lower(v.txHash) };
}
function validSubmission(s) {
  return object(s) && hex(s.hash) && typeof s.serializedTransaction === 'string' && /^0x(?:[0-9a-f]{2})+$/.test(s.serializedTransaction)
    && keccak256(s.serializedTransaction) === s.hash && integer(s.nonce) && isAddress(s.signer ?? '') && decimal(s.fromBlock);
}

export function checkRecords(records, { incompleteReservationProducts = [] } = {}) {
  const violations = [], unverifiable = [], byKey = new Map(), json = new Map(), parsedOwn = new Map();
  const add = (rule, key, detail) => violations.push({ rule, key, detail });
  const unknown = (rule, key, detail) => unverifiable.push({ rule, key, detail });
  const products = [], owns = [], intents = [], stocks = [], reservations = new Map(), jobs = [];
  const incomplete = new Set(incompleteReservationProducts);
  const match = (key, re) => key.match(new RegExp(`^${re}$`));
  for (const record of records) {
    if (typeof record.k !== 'string') { unknown('record', record.k, 'binary_key'); continue; }
    const key = record.k;
    if (byKey.has(key)) add('identity', key, 'duplicate_key');
    byKey.set(key, record);
    if (record.error || record.uncertain) unknown('record', key, record.error ? 'capture_error' : 'uncertain_capture');
    const reservationMatch = match(key, `x402:hosted:(${PRODUCT}):license:reservation:(${HEX})`);
    if (reservationMatch) {
      const group = reservations.get(reservationMatch[1]) ?? [];
      group.push(record); reservations.set(reservationMatch[1], group);
      if (record.error || record.uncertain) incomplete.add(reservationMatch[1]);
    }
    const p = match(key, `x402:hosted:(${PRODUCT})`);
    const own = match(key, `store:own:(${ADDRESS}):(${PRODUCT})`);
    const intent = match(key, `store:(?:usdc:)?intent:(${HEX})`);
    const stock = match(key, `x402:hosted:(${PRODUCT}):license:stock`);
    const ob = match(key, `store:license:ob:(${HEX})`);
    const reg = match(key, `store:license:registration:(${PRODUCT})`);
    const purchase = match(key, `store:purchase:([0-9]+):(${HEX})`);
    const content = match(key, `x402:hosted:(${PRODUCT}):content:([0-9]+)`);
    const rail = match(key, 'store:rail:parent:((?:0x)?[0-9a-f]{64})');
    const railActive = match(key, `store:rail:active:(${ADDRESS}):(${PRODUCT}):([0-9]+)`);
    if (!(p || own || intent || stock || ob || reg || purchase || content || reservationMatch || rail || railActive)) continue;
    let value;
    try { value = record.t === 'string' && typeof record.s === 'string' ? JSON.parse(record.s) : null; } catch { value = null; }
    if (!object(value)) {
      if (!record.error) add('schema', key, 'expected_json_object');
      if (reservationMatch) incomplete.add(reservationMatch[1]);
      continue;
    }
    json.set(key, value);
    if (reservationMatch && !['held', 'sold', 'released'].includes(value.state)) incomplete.add(reservationMatch[1]);
    if (p) {
      products.push([key, p[1], value]);
      if (value.id !== p[1]) add('identity', key, 'product_id');
      if (value.productKind === 'license' && !licenseDefinition(value.license)) add('schema', key, 'license_definition');
    }
    if (content && (!['url', 'text'].includes(value.kind) || typeof value.value !== 'string')) add('schema', key, 'content');
    if (own) {
      owns.push([key, value]);
      if (lower(value.payer) !== own[1] || value.resourceId !== own[2]) add('identity', key, 'ownership_payer_resource');
      const parsed = ownership(value);
      parsedOwn.set(key, parsed);
      if (!parsed) add('schema', key, 'ownership');
    }
    if (intent) {
      intents.push([key, value]);
      if (lower(value.intentSalt) !== intent[1] || !isAddress(value.payerHint ?? '') || !new RegExp(`^${PRODUCT}$`).test(value.resourceId)
        || value.contentRef !== contentKey(value.resourceId, value.contentRevision)
        || (value.claim && lower(value.claim.payer) !== lower(value.payerHint))
        || (value.claim?.resourceId !== undefined && value.claim.resourceId !== value.resourceId)) add('identity', key, 'intent_salt_payer_resource');
    }
    if (stock) stocks.push([key, stock[1], value]);
    if (purchase && (String(value.chainId) !== purchase[1] || lower(value.txHash) !== purchase[2])) add('identity', key, 'purchase_chain_transaction');
    if (rail && value.parentIntentId !== rail[1]) add('identity', key, 'rail_parent_id');
    if (railActive && (lower(value.payer) !== railActive[1] || value.resourceId !== railActive[2] || String(value.contentRevision) !== railActive[3])) add('identity', key, 'rail_payer_resource_revision');
    if (ob || reg) {
      const member = ob ? ob[1] : `registration:${reg[1]}`;
      jobs.push([key, member, value, ob ? OB_INDEX : REG_INDEX, ob ? ob[1] : reg[1]]);
      if (ob ? value.kind !== 'mint' || value.paymentKey !== ob[1]
        : !['register', 'registration'].includes(value.kind) || value.productId !== reg[1]) add('identity', key, 'job_member');
      if (!licenseDefinition(value.license) || value.version !== 1 || !integer(value.attempts) || !integer(value.nextAttemptAt)
        || !['awaiting_finality', 'pending', 'submitted', 'minted', 'registered', 'retryable', 'needs_repair'].includes(value.status)) add('schema', key, 'license_job');
      if (value.license?.contentRef !== contentKey(value.productId, 1)
        || (ob && (lower(value.payer) !== lower(value.payment?.payer) || value.productId !== value.payment?.resourceId))) add('identity', key, 'job_product_payer');
    }
  }
  const zset = (key) => byKey.get(key)?.t === 'zset' ? byKey.get(key).z : undefined;
  const scores = new Map();
  const members = (key) => {
    if (!scores.has(key)) scores.set(key, new Map(zset(key) ?? []));
    return scores.get(key);
  };
  const requireContent = (key, id, revision, ref = contentKey(id, revision)) => {
    if (!integer(revision) || revision < 1 || ref !== contentKey(id, revision) || !json.has(ref)) add('content_revision', key, 'missing_or_invalid_content_revision');
  };
  for (const [key, id, p] of products) {
    requireContent(key, id, p.contentRevision);
    if (p.productKind === 'license') {
      const stock = json.get(`x402:hosted:${id}:license:stock`);
      if (!stock || stock.gen !== p.license?.definitionHash || stock.supply !== p.license?.supply) add('license_stock', key, 'product_stock_definition');
    }
  }
  for (const [key, own] of owns) {
    if (!json.has(`x402:hosted:${own.resourceId}`)) add('content_revision', key, 'missing_product');
    for (const g of Array.isArray(own.grants) ? own.grants : []) requireContent(key, own.resourceId, g?.contentRevision, g?.contentRef);
    if (!members(libKey(own.payer)).has(own.resourceId)) add('lib_own', key, 'missing_library_member');
  }
  for (const [key, record] of byKey) {
    const library = match(key, `store:lib:(${ADDRESS})`);
    if (library) {
      if (record.t !== 'zset') { add('lib_own', key, 'library_type'); continue; }
      for (const [member] of record.z) {
        const own = json.get(ownKey(library[1], member));
        if (!own || lower(own.payer) !== library[1] || own.resourceId !== member) add('lib_own', key, 'missing_or_conflicting_ownership');
      }
    }
  }
  for (const [key, id, stock] of stocks) {
    const group = reservations.get(id) ?? [];
    const valid = integer(stock.supply) && stock.supply >= 1 && stock.supply <= 10_000 && integer(stock.reserved) && integer(stock.sold)
      && stock.reserved + stock.sold <= stock.supply && hex(stock.gen);
    if (!valid) add('license_stock', key, 'invalid_stock');
    if (byKey.get(key).uncertain || incomplete.has(id)) unknown('license_stock', key, 'incomplete_reservation_set');
    else {
      const held = group.filter((r) => json.get(r.k)?.state === 'held').length;
      const sold = group.filter((r) => json.get(r.k)?.state === 'sold').length;
      if (held !== stock.reserved || sold !== stock.sold) add('license_stock', key, 'reservation_totals');
    }
  }
  for (const [id, group] of reservations) for (const r of group) {
    const v = json.get(r.k);
    if (!v) continue;
    const salt = r.k.split(':').at(-1), stock = json.get(`x402:hosted:${id}:license:stock`), intent = json.get(`store:intent:${salt}`);
    if (v.productId !== id || v.intentSalt !== salt || !isAddress(v.payer ?? '') || !['held', 'sold', 'released'].includes(v.state)
      || !stock || v.gen !== stock.gen || !intent || intent.resourceId !== id || intent.intentSalt !== salt
      || v.payer !== lower(intent.payerHint) || (intent.claim && v.payer !== lower(intent.claim.payer))
      || v.gen !== intent.metadata?.license?.definitionHash) add('reservation_identity', r.k, 'reservation_stock_intent');
  }
  const indexMembers = new Map([OB_INDEX, REG_INDEX].map((key) => [key, new Set((zset(key) ?? []).map(([m]) => m))]));
  const jobsByKey = new Map(jobs.map((job) => [job[0], job]));
  const jobsByMember = new Map(jobs.map((job) => [job[1], job]));
  for (const [key, , job, index, member] of jobs) {
    if (!indexMembers.get(index).has(member)) add('job_index', key, 'missing_permanent_index_member');
    if ((job.status === 'submitted' || job.submission) && !validSubmission(job.submission)) add('active_job', key, 'invalid_submission');
  }
  for (const index of [OB_INDEX, REG_INDEX]) {
    const record = byKey.get(index);
    if (record && record.t !== 'zset') add('job_index', index, 'index_type');
    for (const [member] of zset(index) ?? []) {
      const key = index === OB_INDEX ? `store:license:ob:${member}` : `store:license:registration:${member}`;
      if (!jobsByKey.has(key)) add('job_index', index, 'missing_job');
    }
  }
  const active = byKey.get(ACTIVE);
  if (active) {
    const job = active.t === 'string' ? jobsByMember.get(active.s) : undefined;
    if (!job || !validSubmission(job[2].submission)) add('active_job', ACTIVE, 'missing_job_identity_or_submission');
  }
  for (const [key, member, job] of jobs) {
    if (job.submission && !['minted', 'registered'].includes(job.status) && (active?.t !== 'string' || active.s !== member)) add('active_job', key, 'missing_active_member');
  }
  for (const [key, storedIntent] of intents) {
    if (!key.startsWith('store:usdc:intent:') || storedIntent.state !== 'settled') continue;
    const parsed = settledUsdcIntent(storedIntent);
    if (!parsed) add('schema', key, 'settled_usdc_intent');
    const intent = parsed ?? storedIntent;
    const payer = intent.claim?.payer;
    const claimKey = `payment:claimed:${intent.chainId}:${lower(intent.txHash)}`;
    if (byKey.get(claimKey)?.t !== 'string' || byKey.get(claimKey).s !== `r:store:${intent.intentSalt}`) add('usdc_claim', key, 'missing_or_conflicting_claim');
    const expectedGrant = grant({ intentSalt: intent.intentSalt, contentRevision: intent.contentRevision, contentRef: intent.contentRef,
      metadata: intent.metadata, chainId: intent.chainId, txHash: intent.txHash, nonce: intent.nonce, purchasedAt: intent.settledAt,
      payment: { version: 1, rail: 'usdc', asset: intent.token, assetSymbol: 'USDC', chainId: 8453,
        paidAtomic: intent.usdcQuoteAtomic, priceJpyc: intent.metadata?.priceJpyc,
        quote: { rateScaled: intent.rateScaled, rateFetchedAt: intent.rateFetchedAt, fxQuoteExpiresAt: intent.fxQuoteExpiresAt, rounding: 'ceil' } } });
    const own = parsedOwn.get(ownKey(payer, intent.resourceId));
    const exactGrant = own?.grants.find((g) => g.intentSalt === intent.intentSalt);
    if (!expectedGrant || !exactGrant || !isDeepStrictEqual(exactGrant, expectedGrant)) add('usdc_grant', key, 'missing_or_conflicting_grant');
    const score = members(libKey(payer)).get(intent.resourceId);
    if (!own || score === undefined || Number(score) !== own.firstPurchasedAt) add('usdc_library', key, 'missing_or_conflicting_library_score');
    const purchase = json.get(`store:purchase:${intent.chainId}:${lower(intent.txHash)}`);
    const expectedPurchase = { version: 1, deploymentVersion: 'creator-store-usdc-vanilla-v1', payer: isAddress(payer ?? '') ? getAddress(payer) : payer,
      resourceId: intent.resourceId, merchant: isAddress(intent.merchant ?? '') ? getAddress(intent.merchant) : intent.merchant,
      token: isAddress(intent.token ?? '') ? getAddress(intent.token) : intent.token, paidAtomic: intent.usdcQuoteAtomic, ...expectedGrant };
    if (!expectedGrant || !purchase || JSON.stringify(purchase) !== JSON.stringify(expectedPurchase)) add('usdc_purchase', key, 'missing_or_conflicting_purchase');
  }
  return { violations, unverifiable, summary: { records: records.length, violations: violations.length, unverifiable: unverifiable.length,
    quarantine_candidates: [...new Set(violations.map((v) => v.key))], onchainReconciled: false } };
}
