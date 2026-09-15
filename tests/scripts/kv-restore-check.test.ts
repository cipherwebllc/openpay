// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, keccak256, stringToHex } from 'viem';
import { checkRecords } from '@/scripts/lib/kv-restore-check.mjs';
import { sha256, type BackupRecord } from '@/scripts/lib/kv-backup-core.mjs';
const id = `h_${'1'.repeat(32)}`, otherId = `h_${'2'.repeat(32)}`;
const payer = `0x${'1'.repeat(40)}`, seller = `0x${'2'.repeat(40)}`;
const salt = `0x${'3'.repeat(64)}`, txHash = `0x${'4'.repeat(64)}`, paymentKey = `0x${'5'.repeat(64)}`;
const nonce = keccak256(stringToHex(`openpay:creator-store-usdc-vanilla-v1:${salt}`));
const contentRef = `x402:hosted:${id}:content:1`;
const keys = {
  product: `x402:hosted:${id}`, content: contentRef, own: `store:own:${payer}:${id}`, library: `store:lib:${payer}`,
  intent: `store:intent:${salt}`, usdc: `store:usdc:intent:${salt}`, purchase: `store:purchase:8453:${txHash}`,
  claim: `payment:claimed:8453:${txHash}`, stock: `x402:hosted:${id}:license:stock`, reservation: `x402:hosted:${id}:license:reservation:${salt}`,
  ob: `store:license:ob:${paymentKey}`, reg: `store:license:registration:${id}`, obIndex: 'store:license:ob:index', regIndex: 'store:license:registration:index', active: 'store:license:worker:active',
};
const raw = (k: string, s: string): BackupRecord => ({ k, t: 'string', s, capturedAt: 0, expiresAt: null });
const json = (k: string, v: unknown) => raw(k, JSON.stringify(v));
const zset = (k: string, z: [string, string][]): BackupRecord => ({ k, t: 'zset', z, capturedAt: 0, expiresAt: null });
const value = (records: BackupRecord[], k: string) => JSON.parse(records.find((r) => r.k === k)!.s as string);
function change(records: BackupRecord[], k: string, changes: Record<string, unknown>) {
  const record = records.find((r) => r.k === k)!;
  record.s = JSON.stringify({ ...JSON.parse(record.s as string), ...changes });
}
const meta = { owner: seller, payTo: seller, title: 'test product', priceJpyc: '1000', contentKind: 'text', label: 'prompt' };
function usdcFixture(): BackupRecord[] {
  const token = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
  const base = { version: 1, deploymentVersion: 'creator-store-usdc-vanilla-v1', intentSalt: salt, parentIntentId: '6'.repeat(64), resourceId: id,
    contentRevision: 1, contentRef, metadata: meta, payerHint: payer, token, chainId: 8453, merchant: seller, usdcQuoteAtomic: '123456', rateScaled: '150000000',
    rateFetchedAt: 100, rounding: 'ceil', anchorBlock: '1', nonce, createdAt: 200, intentExpiresAt: 600_200,
    fxQuoteExpiresAt: 150_100, authorizationValidBeforeMax: '150' };
  const claim = { payer, to: seller, value: base.usdcQuoteAtomic, validAfter: '0', validBefore: '150', nonce, signatureFingerprint: '7'.repeat(64) };
  const intent = { ...base, bindingHash: sha256(JSON.stringify(base)), state: 'settled', claim, authorizationHash: sha256(JSON.stringify(claim)), signedAt: 500, txHash, settledAt: 1000 };
  const payment = { version: 1, rail: 'usdc', asset: token, assetSymbol: 'USDC', chainId: 8453, paidAtomic: base.usdcQuoteAtomic,
    priceJpyc: meta.priceJpyc, quote: { rateScaled: base.rateScaled, rateFetchedAt: base.rateFetchedAt, fxQuoteExpiresAt: base.fxQuoteExpiresAt, rounding: 'ceil' } };
  const grant = { intentSalt: salt, contentRevision: 1, contentRef, metadata: meta, chainId: 8453, txHash, nonce, purchasedAt: 1000, payment };
  return [json(keys.product, { id, contentRevision: 1 }), json(contentRef, { kind: 'text', value: 'SECRET_CONTENT' }), json(keys.usdc, intent),
    raw(keys.claim, `r:store:${salt}`), json(keys.own, { version: 1, policy: 'all-purchased-revisions', payer, resourceId: id, firstPurchasedAt: 1000, updatedAt: 1000, grants: [grant], latestGrant: grant }),
    zset(keys.library, [[id, '1000']]), json(keys.purchase, { version: 1, deploymentVersion: base.deploymentVersion, payer, resourceId: id, merchant: seller, token, paidAtomic: base.usdcQuoteAtomic, ...grant })];
}
function licenseFixture(): BackupRecord[] {
  const termsUrl = 'https://seller.test/terms', termsVersion = 'v1';
  const definition = { schema: 1, rail: 'jpyc', tokenChainId: 137, contract: seller, deploymentId: `openpay-license1155-v1:137:${seller}`,
    tokenId: keccak256(stringToHex(`openpay:license:${id}`)), transferable: false, termsUrl, termsVersion,
    termsHash: keccak256(encodeAbiParameters([{ type: 'string' }, { type: 'string' }], [termsUrl, termsVersion])), contentRef, supply: 100 };
  const definitionHash = keccak256(encodeAbiParameters(
    ['bytes32', 'uint8', 'string', 'uint256', 'address', 'string', 'uint256', 'bool', 'string', 'string', 'bytes32', 'string', 'uint64'].map((type) => ({ type })),
    [keccak256(stringToHex('openpay.license.definition.v1')), 1, 'jpyc', 137n, seller, definition.deploymentId, BigInt(definition.tokenId), false, termsUrl, termsVersion, definition.termsHash, contentRef, 100n],
  ));
  const license = { ...definition, definitionHash };
  const payment = { payer, nonce, resourceId: id };
  const job = { version: 1, kind: 'mint', paymentKey, productId: id, payer, intentSalt: salt, txHash, purchasedAt: 1000,
    payment, license, status: 'awaiting_finality', attempts: 0, nextAttemptAt: 1000 };
  return [json(keys.product, { id, contentRevision: 1, productKind: 'license', license }), json(contentRef, { kind: 'text', value: 'PRIVATE' }),
    json(keys.stock, { supply: 100, reserved: 1, sold: 0, gen: definitionHash }),
    json(keys.intent, { intentSalt: salt, resourceId: id, payerHint: payer, claim: payment, contentRevision: 1, contentRef, metadata: { ...meta, productKind: 'license', license } }),
    json(keys.reservation, { productId: id, intentSalt: salt, payer, gen: definitionHash, paymentKey, state: 'held' }),
    json(keys.ob, job), json(keys.reg, { version: 1, kind: 'register', productId: id, license, status: 'pending', attempts: 0, nextAttemptAt: 1000 }),
    zset(keys.obIndex, [[paymentKey, '1000']]), zset(keys.regIndex, [[id, '1000']])];
}
const submission = { hash: keccak256('0x1234'), serializedTransaction: '0x1234', nonce: 5, signer: seller, fromBlock: '10' };
const rules = (records: BackupRecord[]) => checkRecords(records).violations.map((v) => v.rule);

describe('archive graph checks using real stored shapes', () => {
  it('accepts complete digital-USDC and license graphs, and reports no onchain verification', () => {
    for (const records of [usdcFixture(), licenseFixture()]) {
      const result = checkRecords(records);
      expect(result.violations).toEqual([]); expect(result.unverifiable).toEqual([]);
      expect(result.summary.onchainReconciled).toBe(false);
    }
  });
  it.each<[string, Record<string, unknown>]>([
    [keys.product, { id: otherId }], [keys.usdc, { intentSalt: txHash }], [keys.usdc, { payerHint: seller }],
    [keys.usdc, { resourceId: otherId }], [keys.own, { payer: seller }], [keys.own, { resourceId: otherId }],
    [keys.purchase, { txHash: salt }], [keys.purchase, { chainId: 137 }],
  ])('detects identity mismatch for %s', (key, patch) => {
    const records = usdcFixture(); change(records, key, patch); expect(rules(records)).toContain('identity');
  });
  it('checks rail parent/active identity using their JSON shape', () => {
    const records = [json(`store:rail:parent:${'a'.repeat(64)}`, { parentIntentId: 'b'.repeat(64) }),
      json(`store:rail:active:${payer}:${id}:1`, { payer: seller, resourceId: id, contentRevision: 1 })];
    expect(checkRecords(records).violations.filter((v) => v.rule === 'identity')).toHaveLength(2);
  });
  it('checks the product revision and every older grant, including a non-latest missing content', () => {
    const records = usdcFixture(), own = value(records, keys.own);
    const newer = { ...own.grants[0], intentSalt: txHash, contentRevision: 2, contentRef: `x402:hosted:${id}:content:2`, purchasedAt: 2000 };
    change(records, keys.own, { grants: [...own.grants, newer], latestGrant: newer });
    change(records, keys.product, { contentRevision: 2 });
    records.push(json(newer.contentRef, { kind: 'text', value: 'newer' }));
    const result = checkRecords(records.filter((r) => r.k !== contentRef));
    expect(result.violations).toContainEqual({ rule: 'content_revision', key: keys.own, detail: 'missing_or_invalid_content_revision' });
    expect(result.violations.some((v) => v.rule === 'content_revision' && v.key === keys.product)).toBe(false);
    expect(rules(records.filter((r) => r.k !== newer.contentRef))).toContain('content_revision');
  });
  it('counts held and sold only, including released reservations and an empty complete group', () => {
    const records = licenseFixture();
    change(records, keys.stock, { reserved: 0, sold: 1 }); change(records, keys.reservation, { state: 'sold' });
    expect(rules(records)).not.toContain('license_stock');
    change(records, keys.stock, { sold: 0 }); change(records, keys.reservation, { state: 'released' });
    expect(rules(records)).not.toContain('license_stock');
    expect(rules(records.filter((r) => r.k !== keys.reservation))).not.toContain('license_stock');
    change(records, keys.stock, { reserved: 1 });
    expect(rules(records.filter((r) => r.k !== keys.reservation))).toContain('license_stock');
  });
  it.each(['uncertain', 'error', 'malformed', 'omitted'])('marks stock totals unverifiable for %s reservations', (kind) => {
    let records = licenseFixture(); change(records, keys.stock, { reserved: 20 });
    const record = records.find((r) => r.k === keys.reservation)!;
    if (kind === 'uncertain') record.uncertain = true;
    if (kind === 'error') records = records.map((r) => r.k === record.k ? { k: r.k, error: 'read_error' } : r);
    if (kind === 'malformed') record.s = '{}';
    if (kind === 'omitted') records = records.filter((r) => r.k !== keys.reservation);
    const result = checkRecords(records, kind === 'omitted' ? { incompleteReservationProducts: [id] } : {});
    expect(result.unverifiable).toContainEqual({ rule: 'license_stock', key: keys.stock, detail: 'incomplete_reservation_set' });
    expect(result.violations.some((v) => v.detail === 'reservation_totals')).toBe(false);
  });
  it('uncertainty on a different product does not suppress complete stock totals', () => {
    const records = licenseFixture(); change(records, keys.stock, { reserved: 20 });
    records.push({ ...raw(`x402:hosted:${otherId}:license:reservation:${salt}`, '{}'), uncertain: true });
    expect(rules(records)).toContain('license_stock');
  });
  it.each([{ payer: seller }, { gen: txHash }, { productId: otherId }, { intentSalt: txHash }])('checks reservation identity %j', (patch) => {
    const records = licenseFixture(); change(records, keys.reservation, patch); expect(rules(records)).toContain('reservation_identity');
  });
  it('compares reservation gen to both stock.gen and the intent license snapshot', () => {
    const records = licenseFixture(), intent = value(records, keys.intent);
    change(records, keys.intent, { metadata: { ...intent.metadata, license: { ...intent.metadata.license, definitionHash: txHash } } });
    expect(rules(records)).toContain('reservation_identity');
  });
  it.each([keys.ob, keys.reg, keys.obIndex, keys.regIndex])('checks job/index both directions when %s is missing', (key) => {
    expect(rules(licenseFixture().filter((r) => r.k !== key))).toContain('job_index');
  });
  it('checks job key identity, license tuple and legacy registration kind', () => {
    const records = licenseFixture(); change(records, keys.reg, { kind: 'registration' });
    expect(checkRecords(records).violations).toEqual([]);
    change(records, keys.ob, { paymentKey: salt }); expect(rules(records)).toContain('identity');
    change(records, keys.reg, { productId: otherId }); expect(rules(records)).toContain('identity');
    const job = value(records, keys.reg); change(records, keys.reg, { license: { ...job.license, termsVersion: 'mutated' } });
    expect(rules(records)).toContain('schema');
  });
  it('matches active raw-string member to job with the complete submission tuple', () => {
    const records = licenseFixture(); change(records, keys.ob, { status: 'submitted', submission });
    records.push(raw(keys.active, paymentKey)); expect(rules(records)).not.toContain('active_job');
    records.at(-1)!.s = `registration:${id}`; expect(rules(records)).toContain('active_job');
    records.at(-1)!.s = JSON.stringify({ member: paymentKey }); expect(rules(records)).toContain('active_job');
  });
  it.each(['hash', 'nonce', 'signer', 'serializedTransaction', 'fromBlock'])('rejects missing submission %s and mismatched transaction hash', (field) => {
    const records = licenseFixture(), broken: Record<string, unknown> = { ...submission }; delete broken[field];
    change(records, keys.ob, { status: 'submitted', submission: broken }); records.push(raw(keys.active, paymentKey));
    expect(rules(records)).toContain('active_job');
    change(records, keys.ob, { submission: { ...submission, serializedTransaction: '0x5678' } }); expect(rules(records)).toContain('active_job');
  });
  it('requires active for unresolved submissions, but completed jobs may retain submission', () => {
    const records = licenseFixture(); change(records, keys.ob, { status: 'submitted', submission });
    expect(rules(records)).toContain('active_job');
    change(records, keys.ob, { status: 'minted' }); expect(rules(records)).not.toContain('active_job');
    change(records, keys.reg, { status: 'registered', submission }); expect(rules(records)).not.toContain('active_job');
  });
  it.each<[string, string]>([[keys.claim, 'usdc_claim'], [keys.purchase, 'usdc_purchase'], [keys.own, 'usdc_grant'], [keys.library, 'usdc_library']])('settled USDC requires %s', (key, rule) => {
    expect(rules(usdcFixture().filter((r) => r.k !== key))).toContain(rule);
  });
  it('requires exact claim value and library firstPurchasedAt score', () => {
    const records = usdcFixture(); records.find((r) => r.k === keys.claim)!.s = `r:store:${txHash}`;
    records.find((r) => r.k === keys.library)!.z = [[id, '1001']];
    expect(rules(records)).toContain('usdc_claim'); expect(rules(records)).toContain('usdc_library');
  });
  it.each(['nonce', 'txHash', 'contentRef', 'purchasedAt', 'metadata', 'payment'])('matches every grant field, including %s', (field) => {
    const records = usdcFixture(), own = value(records, keys.own);
    const patch = field === 'metadata' ? { ...meta, title: 'changed' } : field === 'payment' ? { ...own.grants[0].payment, paidAtomic: '2' }
      : field === 'purchasedAt' ? 999 : salt;
    const g = { ...own.grants[0], [field]: patch };
    change(records, keys.own, { grants: [g], latestGrant: g, ...(field === 'purchasedAt' ? { firstPurchasedAt: 999 } : {}) });
    expect(rules(records)).toContain('usdc_grant');
  });
  it.each(['payer', 'resourceId', 'merchant', 'token', 'paidAtomic', 'deploymentVersion', 'nonce', 'purchasedAt', 'payment'])('matches purchase field %s', (field) => {
    const records = usdcFixture(); change(records, keys.purchase, { [field]: field === 'purchasedAt' ? 2000 : 'different' });
    expect(rules(records)).toContain('usdc_purchase');
  });
  it('normalizes hexadecimal nonce case like the settled access reader', () => {
    const records = usdcFixture(), intent = value(records, keys.usdc);
    const upperNonce = `0x${nonce.slice(2).toUpperCase()}`;
    change(records, keys.usdc, { nonce: upperNonce, claim: { ...intent.claim, nonce: upperNonce } });
    expect(checkRecords(records).violations).toEqual([]);
  });
  it.each(['bindingHash', 'authorizationHash', 'nonce', 'token'])('rejects corrupt settled intent %s even with matching dependent records', (field) => {
    const records = usdcFixture(); change(records, keys.usdc, { [field]: txHash });
    expect(checkRecords(records).violations).toContainEqual({ rule: 'schema', key: keys.usdc, detail: 'settled_usdc_intent' });
  });
  it('validates snapshot FX quote limits and latest payment, not only the grant id', () => {
    const records = usdcFixture(), own = value(records, keys.own);
    const g = { ...own.grants[0], payment: { ...own.grants[0].payment, quote: { ...own.grants[0].payment.quote, fxQuoteExpiresAt: 999_999 } } };
    change(records, keys.own, { grants: [g], latestGrant: g });
    expect(rules(records)).toContain('usdc_grant');
    change(records, keys.own, { grants: own.grants, latestGrant: { ...own.latestGrant, payment: undefined } });
    expect(rules(records)).toContain('usdc_grant');
  });
  it('validates ownership latestGrant, duplicates and firstPurchasedAt like the access reader', () => {
    const records = usdcFixture(), own = value(records, keys.own);
    change(records, keys.own, { latestGrant: { ...own.latestGrant, nonce: txHash } }); expect(rules(records)).toContain('usdc_grant');
    change(records, keys.own, { latestGrant: own.latestGrant, grants: [...own.grants, ...own.grants] }); expect(rules(records)).toContain('schema');
    change(records, keys.own, { grants: own.grants, firstPurchasedAt: 999 }); expect(rules(records)).toContain('usdc_grant');
  });
  it('checks lib/own in both directions and ignores unrelated shared claims', () => {
    expect(rules(usdcFixture().filter((r) => r.k !== keys.own))).toContain('lib_own');
    expect(rules(usdcFixture().filter((r) => r.k !== keys.library))).toContain('lib_own');
    expect(checkRecords([raw(`payment:claimed:1:${txHash}`, 'r:tip:external'), raw(`payment:claimed:2:${txHash}`, `r:store:${salt}`)]).violations).toEqual([]);
    const records = usdcFixture(); change(records, keys.usdc, { state: 'signed' });
    expect(rules(records.filter((r) => r.k !== keys.claim))).not.toContain('usdc_claim');
  });
  it('returns stable value-free findings and quarantine candidates for malformed JSON/types', () => {
    const records = [raw(keys.product, '{PRIVATE'), { ...raw(keys.own, ''), t: 'hash', h: [] }, { k: { b: '/w==' }, error: 'read_error' }];
    const result = checkRecords(records);
    expect(result.violations.map((v) => v.rule)).toEqual(['schema', 'schema']);
    expect(result.unverifiable).toHaveLength(1); expect(result.summary.quarantine_candidates).toEqual([keys.product, keys.own]);
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });
});
