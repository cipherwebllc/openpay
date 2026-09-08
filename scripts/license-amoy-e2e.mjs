#!/usr/bin/env node
// Amoy only. Start the production server separately on the explicit E2E_BASE_URL port.
// Node >= 22; dependencies: viem and Node built-ins (including the local SDK helpers).
// Export E2E_SELLER_KEY, AMOY_TEST_BUYER_KEY, CRON_SECRET, NEXT_PUBLIC_LICENSE_NFT_AMOY,
// NEXT_PUBLIC_POLYGON_AMOY_RPC_URL. Optional: E2E_TRANSFER_TO_KEY, E2E_BASE_URL,
// E2E_PRICE_JPYC=1000, E2E_SUPPLY=2, E2E_MAX_JPYC=1100 (PER SIGNATURE), E2E_REPORT.
// E2E_MINT_TIMEOUT_SEC=720, E2E_REGISTER_TIMEOUT_SEC=720; cron polls every 60s.
// E2E_RESUME_PRODUCT=h_<id> resumes a registered/published non-transferable license;
// E2E_MAX_PURCHASES=2 bounds new resume purchases. Requires SIWE /api/license/grants
// (address, product, cursor; { ok, grants: [{ intentSalt, txHash, nft }], nextCursor }).
// This checkout has no grants route: resume fails before spending if unavailable.
// E2E_ALLOW_SKIPS=1 (default): SKIP counts as passing for exit status; 0 makes
// any SKIP fail the run, while preserving SKIP labels and dependent-step skips.
// No automatic env loading. --self-check needs neither env, server, RPC nor funds.
// Production SIWE requires SIWE_ALLOWED_DOMAINS to include the exact localhost:port.
// Public /ja/store requires an existing seller handle and STORE_DEV_FIXTURES != 1.

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  createPublicClient, createWalletClient, formatEther, formatUnits, getAddress,
  http, isAddress, keccak256, parseAbi, parseEther, stringToHex, verifyMessage,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { polygonAmoy } from 'viem/chains';
import { createSiweMessage, parseSiweMessage } from 'viem/siwe';
import { hasLicense } from '../packages/x402-sdk/src/license.mjs';
import { SUPPORTED_JPYC_ASSETS } from '../packages/x402-sdk/src/guards.mjs';
import {
  assertSupportedAssetAndForwarder, buildTypedDataFromPaymentRequirements,
  normalizePaymentRequirements, parseJpycCap,
} from './x402-buyer-example.mjs';

const DEFAULT_REPORT = '/private/tmp/claude-501/-Users-masia-Documents-GitHub-openpay/8c4d3cdc-1d35-44d2-a4ab-a74b5732bd34/scratchpad/license-amoy-e2e.json';
const CHAIN_ID = polygonAmoy.id;
const NETWORK = `eip155:${CHAIN_ID}`;
const JPYC = SUPPORTED_JPYC_ASSETS[NETWORK];
const UNIT = 10n ** 18n;
const TIMEOUT = 6 * 60_000;
const CRON_INTERVAL = 60_000;
const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const PRODUCT_ID = /^h_[0-9a-f]{32}$/;
const COMMIT_VERSION = keccak256(stringToHex('openpay.eip3009.forwarder.v1'));
const ABI = parseAbi([
  'function minter() view returns (address)',
  'function balanceOf(address account) view returns (uint256)',
  'function authorizationState(address authorizer, bytes32 nonce) view returns (bool)',
  'function safeTransferFrom(address from,address to,uint256 id,uint256 amount,bytes data)',
]);
const report = { version: 1, startedAt: new Date().toISOString(), steps: [], products: [], purchases: [], grants: [], transactions: [], polls: [] };
let config;
let rpc;
let sellerCookie;
let buyerCookie;
let spendingHalted = false;

class CheckError extends Error {}
class TransportError extends CheckError {}
class Skip extends Error {}
const requireThat = (condition, message) => { if (!condition) throw new CheckError(message); };
const sameAddress = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const feeFor = (price) => price / 100n > UNIT ? price / 100n : UNIT;

// Do not propagate viem errors/HTTP bodies: they can contain RPC credentials,
// signed transactions or cookies. Only our own assertion messages are loggable.
function safeError(error) {
  let message = error instanceof CheckError || error instanceof Skip
    ? error.message : 'Operation failed (RPC, signing, transport or local I/O; raw error withheld)';
  for (const name of ['E2E_SELLER_KEY', 'AMOY_TEST_BUYER_KEY', 'E2E_TRANSFER_TO_KEY', 'CRON_SECRET', 'LICENSE_MINTER_PRIVATE_KEY', 'NEXT_PUBLIC_POLYGON_AMOY_RPC_URL']) {
    const secret = process.env[name];
    if (secret) message = message.split(secret).join('[redacted]');
  }
  return message.replace(/[\r\n\t]/g, ' ').slice(0, 700);
}

async function step(n, name, action, options = {}) {
  const { skip } = options;
  // An explicitly undefined prerequisite is blocked, not the default true.
  // Recovered settlement evidence is for inspection, never signing permission.
  const ready = !Object.hasOwn(options, 'ready') || Boolean(options.ready);
  const started = Date.now();
  let status = 'OK';
  let detail;
  let value;
  try {
    if (skip) throw new Skip(skip);
    requireThat(Boolean(ready), 'Blocked by a failed prerequisite');
    value = await action();
    detail = typeof value === 'string' ? value : 'verified';
  } catch (error) {
    status = error instanceof Skip ? 'SKIP' : 'FAIL';
    detail = safeError(error);
  }
  const entry = { n, name, status, detail, startedAt: new Date(started).toISOString(), durationMs: Date.now() - started };
  report.steps.push(entry);
  console.log(`[${n}] ${name} ... ${status} (${detail}; ${(entry.durationMs / 1000).toFixed(2)}s)`);
  return status === 'OK' ? { status, value } : null;
}

function positiveInteger(name, fallback, env = process.env) {
  const raw = env[name] ?? String(fallback);
  requireThat(/^[1-9][0-9]*$/.test(raw) && Number.isSafeInteger(Number(raw)) && Number(raw) <= 2_147_483,
    `${name} must be a positive integer no greater than 2147483`);
  return Number(raw);
}

function driverOptions(env = process.env) {
  const resumeProduct = env.E2E_RESUME_PRODUCT || null;
  requireThat(resumeProduct === null || PRODUCT_ID.test(resumeProduct), 'E2E_RESUME_PRODUCT must be an h_id');
  requireThat(['0', '1'].includes(env.E2E_ALLOW_SKIPS ?? '1'), 'E2E_ALLOW_SKIPS must be 0 or 1');
  return { resumeProduct, allowSkips: (env.E2E_ALLOW_SKIPS ?? '1') === '1',
    mintTimeout: positiveInteger('E2E_MINT_TIMEOUT_SEC', 720, env) * 1000,
    registerTimeout: positiveInteger('E2E_REGISTER_TIMEOUT_SEC', 720, env) * 1000,
    maxPurchases: positiveInteger('E2E_MAX_PURCHASES', 2, env) };
}

function localBase(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new CheckError('E2E_BASE_URL must be a URL with an explicit local port'); }
  requireThat(['localhost', '127.0.0.1'].includes(url.hostname) && url.port &&
    ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password &&
    url.pathname === '/' && !url.search && !url.hash,
  'E2E_BASE_URL must be a localhost/127.0.0.1 origin with an explicit non-default port');
  return url;
}

function accountFromEnv(name) {
  requireThat(HEX32.test(process.env[name] ?? ''), `${name} must be a 0x-prefixed private key`);
  try { return privateKeyToAccount(process.env[name]); } catch { throw new CheckError(`${name} is not a valid private key`); }
}

function readConfig() {
  const base = localBase(process.env.E2E_BASE_URL ?? 'http://localhost:3119');
  const price = process.env.E2E_PRICE_JPYC ?? '1000';
  requireThat(/^[1-9][0-9]*$/.test(price) && BigInt(price) >= 1000n && BigInt(price) <= 1_000_000n,
    'E2E_PRICE_JPYC must be an integer from 1000 to 1000000');
  const supplyRaw = process.env.E2E_SUPPLY ?? '2';
  const supply = Number(supplyRaw);
  requireThat(/^[1-9][0-9]*$/.test(supplyRaw) && Number.isInteger(supply) && supply <= 10_000,
    'E2E_SUPPLY must be an integer from 1 to 10000');
  const cap = parseJpycCap(process.env.E2E_MAX_JPYC ?? '1100', 'E2E_MAX_JPYC');
  const priceAtomic = BigInt(price) * UNIT;
  requireThat(priceAtomic + feeFor(priceAtomic) <= cap, 'Price plus fee exceeds E2E_MAX_JPYC; no signing');
  const contract = process.env.NEXT_PUBLIC_LICENSE_NFT_AMOY;
  requireThat(isAddress(contract ?? '') && !/^0x0{40}$/i.test(contract), 'NEXT_PUBLIC_LICENSE_NFT_AMOY must be a nonzero contract address');
  requireThat(Boolean(process.env.CRON_SECRET?.trim()), 'CRON_SECRET is required');
  let rpcUrl;
  try { rpcUrl = new URL(process.env.NEXT_PUBLIC_POLYGON_AMOY_RPC_URL); } catch { throw new CheckError('NEXT_PUBLIC_POLYGON_AMOY_RPC_URL is required and must be HTTP(S)'); }
  requireThat(['http:', 'https:'].includes(rpcUrl.protocol), 'RPC URL must be HTTP(S)');
  const seller = accountFromEnv('E2E_SELLER_KEY');
  const buyer = accountFromEnv('AMOY_TEST_BUYER_KEY');
  const transferTo = process.env.E2E_TRANSFER_TO_KEY ? accountFromEnv('E2E_TRANSFER_TO_KEY') : null;
  requireThat(!sameAddress(seller.address, buyer.address), 'Seller and buyer must be distinct wallets');
  requireThat(!transferTo || (!sameAddress(transferTo.address, buyer.address) && !sameAddress(transferTo.address, seller.address)), 'Transfer recipient must be a distinct second wallet');
  return { ...driverOptions(), base, price, priceAtomic, supply, cap, contract: getAddress(contract), rpcUrl: rpcUrl.href, seller, buyer, transferTo };
}

async function request(path, { method = 'GET', body, cookie, headers = {}, html = false, deadline = Infinity } = {}) {
  const timeout = Math.min(55_000, deadline - Date.now());
  requireThat(timeout > 0, 'Request deadline exceeded');
  // Origin-bound local requests and redirect:error keep signatures/cookies/Bearer
  // from being forwarded to a redirect destination. Never follow quote.resource.
  let response;
  let raw;
  try {
    response = await fetch(new URL(path, config.base), {
      method, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(timeout),
      headers: { accept: html ? 'text/html' : 'application/json', ...headers,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(cookie ? { cookie } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    raw = await response.text();
  } catch { throw new TransportError(`HTTP transport failed: ${method} ${path.split('?')[0]} (timeout, redirect or connection)`); }
  let data = null;
  if (!html) {
    try { data = JSON.parse(raw); } catch { /* Unexpected HTML is a failed shape, never a successful API response. */ }
  }
  return { status: response.status, headers: response.headers, data, ...(html ? { html: raw } : {}) };
}

function expectStatus(response, status, label) {
  const code = response.data?.error;
  const hint = typeof code === 'string' && /^[a-z_]{1,80}$/.test(code) ? `, ${code}` : '';
  requireThat(response.status === status, `${label}: expected HTTP ${status}, got ${response.status}${hint}`);
  return response.data;
}

function siweMessage(base, address, nonce, issuedAt = new Date()) {
  return createSiweMessage({ domain: base.host, address, uri: base.origin, version: '1',
    chainId: CHAIN_ID, nonce, statement: 'Sign in for the OpenPay Amoy E2E test.', issuedAt,
    expirationTime: new Date(issuedAt.getTime() + 10 * 60_000) });
}

function sessionCookie(headers) {
  // Preserve the server's actual name: next start issues __Host-op_sess even on
  // HTTP localhost. Node sends the cookie manually; browser Secure policy differs.
  const cookies = headers.getSetCookie?.() ?? [headers.get('set-cookie') ?? ''];
  const pair = cookies.map((value) => value.split(';')[0].trim())
    .find((value) => /^(?:__Host-)?op_sess=[^;\s]+$/.test(value));
  requireThat(pair, 'SIWE verify did not issue an op_sess/__Host-op_sess cookie');
  return pair;
}

async function login(account) {
  const nonce = expectStatus(await request('/api/auth/siwe/nonce', { method: 'POST' }), 200, 'SIWE nonce');
  requireThat(nonce?.ok === true && /^[a-zA-Z0-9]{8,}$/.test(nonce.nonce), 'Invalid SIWE nonce shape');
  const message = siweMessage(config.base, account.address, nonce.nonce);
  const signature = await account.signMessage({ message });
  const response = await request('/api/auth/siwe/verify', { method: 'POST', body: { message, signature } });
  if (response.data?.error === 'domain_mismatch') throw new CheckError(`Production server needs SIWE_ALLOWED_DOMAINS=${config.base.host}`);
  const verified = expectStatus(response, 200, 'SIWE verify');
  requireThat(verified?.ok === true && sameAddress(verified.address, account.address), 'SIWE verify address mismatch');
  const cookie = sessionCookie(response.headers);
  const me = expectStatus(await request('/api/auth/siwe/me', { cookie }), 200, 'SIWE me');
  requireThat(me?.ok === true && sameAddress(me.address, account.address), 'SIWE /me address mismatch');
  return cookie;
}

async function balance() {
  return rpc.readContract({ address: JPYC.address, abi: ABI, functionName: 'balanceOf', args: [config.buyer.address] });
}

function tx(kind, hash, productId) {
  requireThat(HEX32.test(hash ?? ''), `${kind}: missing transaction hash`);
  if (!report.transactions.some((entry) => entry.kind === kind && entry.hash === hash)) {
    report.transactions.push({ kind, hash, productId, observedAt: new Date().toISOString() });
    console.log(`    ${kind}: ${hash}`);
  }
}

async function poll(name, read, { interval = 20_000, timeout = TIMEOUT } = {}) {
  const deadline = Date.now() + timeout;
  let last = 'not observed';
  while (Date.now() < deadline) {
    let observation;
    try { observation = await read(deadline); } catch (error) {
      // Retry idempotent polling after connection loss, never the payment POST/
      // signed GET itself. Assertion failures still fail the step immediately.
      if (!(error instanceof TransportError)) throw error;
      observation = { done: false, detail: safeError(error) };
    }
    last = observation.detail;
    report.polls.push({ name, at: new Date().toISOString(), detail: last });
    if (observation.done) return observation.value;
    console.log(`    ${name}: ${last}; ${Math.max(0, Math.ceil((deadline - Date.now()) / 1000))}s remaining`);
    await sleep(Math.max(0, Math.min(interval, deadline - Date.now())));
  }
  throw new CheckError(`${name}: bounded timeout (${last})`);
}

let nextCronAt = 0;
async function driveCron(deadline) {
  if (Date.now() < nextCronAt) return 'cron cadence: waiting for 60s interval';
  nextCronAt = Date.now() + CRON_INTERVAL;
  return cronDetail(await cron(deadline));
}

async function cron(deadline = Infinity, bearer = true) {
  return request('/api/cron/license-mint', { deadline,
    headers: bearer ? { authorization: `Bearer ${process.env.CRON_SECRET}` } : {} });
}

function cronDetail(response) {
  const body = response.data;
  requireThat([200, 503].includes(response.status), `Cron HTTP ${response.status}`);
  if (response.status === 503) return 'cron HTTP 503 (retrying; worker failure retained in observations)';
  if (body?.ok === true && body.skipped === 'locked') return 'cron skipped locked';
  requireThat(body?.ok === true && Number.isInteger(body.processed) && Number.isInteger(body.failed) &&
    (body.skipped === undefined || body.skipped === 'locked'), 'Invalid/disabled cron response');
  return body.skipped === 'locked' ? 'cron skipped locked' : `cron processed=${body.processed}, failed=${body.failed}`;
}

async function createProduct(transferable, supply) {
  const body = { productKind: 'license', title: `E2E License ${transferable ? 'T' : 'NT'} ${Date.now()}`,
    priceJpyc: config.price, contentKind: 'text', content: 'E2E TEST ONLY: revision 1 instructions. Read the linked terms before use.',
    saleActive: false, usdcEnabled: false,
    license: { supply, transferable, termsUrl: 'https://open-pay.jp/ja/terms', termsVersion: '1' } };
  const data = expectStatus(await request('/api/store/products', { method: 'POST', body, cookie: sellerCookie }), 201, 'Create license');
  const product = data?.product;
  requireThat(data?.ok === true && PRODUCT_ID.test(product?.id ?? ''), 'Missing created product id');
  // Retain ids even when a subsequent response assertion fails (manual cleanup).
  const record = { id: product.id, tokenId: product.license?.tokenId, transferable, supply, priceJpyc: config.price };
  if (product.registration?.txHash) tx('registration', product.registration.txHash, product.id);
  report.products.push(record);
  requireThat(product.productKind === 'license' && product.saleActive === false && product.registration?.status === 'pending', 'Created product must be paused with pending registration');
  requireThat(product.license?.tokenChainId === CHAIN_ID && sameAddress(product.license.contract, config.contract) &&
    product.license.tokenId === keccak256(stringToHex(`openpay:license:${product.id}`)), 'Created license chain/contract/tokenId mismatch');
  requireThat(product.license.supply === supply && product.license.transferable === transferable && product.contentRevision === 1 && product.priceJpyc === config.price &&
    sameAddress(product.owner, config.seller.address) && sameAddress(product.payTo, config.seller.address), 'Created license definition/owner/payTo mismatch');
  Object.assign(record, { contract: config.contract, tokenId: product.license.tokenId, registration: 'pending' });
  return product;
}

const productPath = (product) => `/api/store/products/${product.id}`;
const paidPath = (product) => `/api/paid/hosted/${product.id}?payer=${config.buyer.address}`;

async function register(product) {
  const registered = await poll(`registration ${product.id}`, async (deadline) => {
    const worker = await driveCron(deadline);
    const response = await request(productPath(product), { cookie: sellerCookie, deadline });
    if ([429, 503].includes(response.status)) return { done: false, detail: `${worker}; seller GET HTTP ${response.status}` };
    const data = expectStatus(response, 200, 'Read registration');
    requireThat(data?.ok === true && data.product?.id === product.id, 'Seller product GET shape mismatch');
    requireThat(data.product.license?.definitionHash === product.license.definitionHash && sameAddress(data.product.payTo, config.seller.address), 'Registration changed the immutable definition/payTo');
    const registration = data.product.registration;
    requireThat(registration && ['pending', 'registered'].includes(registration.status), 'Product registration failed or has an invalid state');
    if (registration.txHash) tx('registration', registration.txHash, product.id);
    return { done: registration.status === 'registered', value: data.product, detail: `${worker}; registration=${registration.status}` };
  }, { interval: CRON_INTERVAL, timeout: config.registerTimeout });
  tx('registration', registered.registration.txHash, product.id);
  requireThat(registered.saleActive === false, 'Registration must not auto-publish');
  Object.assign(report.products.find((p) => p.id === product.id), { registration: 'registered', registrationTxHash: registered.registration.txHash });
  return registered;
}

async function publish(product) {
  const data = expectStatus(await request(productPath(product), { method: 'PATCH', body: { saleActive: true }, cookie: sellerCookie }), 200, 'Publish');
  requireThat(data?.ok === true && data.product?.id === product.id && data.product.saleActive === true, 'Publish did not set saleActive=true');
  report.products.find((p) => p.id === product.id).published = true;
}

function listingFromHtml(html, id) {
  // /ja/store exposes StoreBrowser listings through Next's Flight JSON. Parse only
  // JSON, never execute page scripts. Join chunks before parsing split records.
  const flight = [...html.matchAll(/self\.__next_f\.push\(\[1,\s*("(?:[^"\\]|\\.)*")\]\)/g)]
    .map((match) => JSON.parse(match[1])).join('');
  function find(value) {
    if (!value || typeof value !== 'object') return null;
    if (value.id === id && typeof value.handle === 'string') return value;
    for (const child of Object.values(value)) {
      const found = find(child);
      if (found) return found;
    }
    return null;
  }
  for (const line of flight.split('\n')) {
    const match = /^[0-9a-f]+:([\[{].*)$/i.exec(line);
    if (!match) continue;
    let value;
    try { value = JSON.parse(match[1]); } catch { continue; }
    const found = find(value);
    if (found) return found;
  }
  return null;
}

async function publicListing(product, remaining) {
  const response = await request('/ja/store', { html: true });
  expectStatus(response, 200, 'Public store');
  const listing = listingFromHtml(response.html, product.id);
  requireThat(listing, 'Product absent from /ja/store Flight listings; seller needs an existing public handle, UI flags ON and STORE_DEV_FIXTURES off');
  requireThat(listing.productKind === 'license' && Number.isInteger(listing.license?.remaining) &&
    listing.license.remaining >= 0 && listing.license.remaining <= product.license.supply &&
    (remaining === undefined || listing.license.remaining === remaining) && listing.license.supply === product.license.supply,
    'Public listing productKind/supply/remaining mismatch');
  return listing.license.remaining;
}

function prepareQuote(body, product, buyer, cap, now = Math.floor(Date.now() / 1000)) {
  requireThat(body?.x402Version === 1 && Array.isArray(body.accepts) && body.accepts.length === 1, 'Expected v1 402 with one accepts entry');
  const raw = body.accepts[0];
  const accept = normalizePaymentRequirements(raw);
  assertSupportedAssetAndForwarder(accept);
  requireThat(accept.chainId === CHAIN_ID && accept.network === NETWORK, 'Only Amoy payments are allowed');
  requireThat(raw.extra.name === JPYC.name && raw.extra.version === JPYC.version && raw.extra.decimals === JPYC.decimals, 'JPYC EIP-712 domain mismatch');
  const openpay = raw.extra.openpay;
  requireThat(sameAddress(openpay.merchant, product.payTo), 'Quote merchant differs from created seller payTo');
  const expected = BigInt(product.priceJpyc) * UNIT;
  const total = accept.extra.openpay.merchantValue + accept.extra.openpay.feeValue;
  requireThat(accept.extra.openpay.merchantValue === expected && accept.extra.openpay.feeValue === feeFor(expected), 'Quote price or 1%/1 JPYC floor fee mismatch');
  requireThat(total <= cap, 'Quote exceeds E2E_MAX_JPYC; no signing');
  requireThat(openpay.commitVersion?.toLowerCase() === COMMIT_VERSION && HEX32.test(openpay.intentSalt ?? '') && !/^0x0{64}$/i.test(openpay.intentSalt), 'Invalid forwarder commitVersion/server intentSalt');
  requireThat(typeof openpay.authorizationValidBeforeMax === 'string' && /^[0-9]+$/.test(openpay.authorizationValidBeforeMax), 'Missing server authorizationValidBeforeMax');
  const serverMax = BigInt(openpay.authorizationValidBeforeMax);
  const clientMax = BigInt(now + Math.min(600, accept.maxTimeoutSeconds));
  const validBefore = serverMax < clientMax ? serverMax : clientMax;
  requireThat(validBefore > BigInt(now + 5), 'Quote expired or too close to expiration');
  // Current hosted wire has no standalone nonce/validAfter/validBefore fields.
  // Match hostedPurchaseWire.ts: validAfter=0, bounded server deadline, and derive
  // the committed nonce from the server salt + split tuple (never a random nonce).
  const authorization = { from: buyer, validAfter: '0', validBefore: String(validBefore), intentSalt: openpay.intentSalt };
  const { typedData } = buildTypedDataFromPaymentRequirements(raw, authorization);
  return { accept, authorization, typedData, total };
}

async function quote(product) {
  const response = await request(paidPath(product), { cookie: buyerCookie });
  return prepareQuote(expectStatus(response, 402, 'Buyer quote'), product, config.buyer.address, config.cap);
}

async function signedHeader(prepared) {
  requireThat(!spendingHalted, 'Further signing disabled after an unresolved payment submission');
  requireThat(prepared.total <= config.cap, 'E2E_MAX_JPYC exceeded before signing');
  requireThat(BigInt(prepared.authorization.validBefore) > BigInt(Math.floor(Date.now() / 1000) + 5), 'Authorization expired before signing');
  requireThat(await balance() >= prepared.total, 'Buyer lacks JPYC for price plus fee (also needed to test signed sold_out admission)');
  const signature = await config.buyer.signTypedData(prepared.typedData);
  return Buffer.from(JSON.stringify({ x402Version: 1, scheme: prepared.accept.scheme, network: prepared.accept.network,
    payload: { signature, authorization: prepared.authorization } }), 'utf8').toString('base64');
}

async function purchaseStatus(intentSalt, deadline = Infinity) {
  const response = await request(`/api/store/purchase/status?intentSalt=${intentSalt}`, { cookie: buyerCookie, deadline });
  if ([429, 503].includes(response.status)) return { state: 'retry', http: response.status };
  const data = expectStatus(response, 200, 'Purchase status');
  const purchase = report.purchases.find((p) => p.intentSalt === intentSalt);
  if (purchase) collectPurchaseEvidence(purchase, data);
  requireThat(data?.ok === true && ['settled', 'pending', 'failed'].includes(data.state), 'Invalid purchase status');
  return data;
}

function collectPurchaseEvidence(purchase, data) {
  if (HEX32.test(data?.txHash ?? '')) {
    tx('payment', data.txHash, purchase.productId);
    purchase.txHash = data.txHash;
  }
  if (HEX32.test(data?.nft?.mintTxHash ?? '')) {
    tx('mint', data.nft.mintTxHash, purchase.productId);
    purchase.mintTxHash = data.nft.mintTxHash;
  }
}

async function buy(product, label) {
  const prepared = await quote(product);
  const header = await signedHeader(prepared);
  const purchase = { productId: product.id, tokenId: product.license.tokenId, label, intentSalt: prepared.authorization.intentSalt,
    nonce: prepared.typedData.message.nonce, validAfter: prepared.authorization.validAfter,
    validBefore: prepared.authorization.validBefore, totalJpyc: formatUnits(prepared.total, 18), state: 'submitting' };
  report.purchases.push(purchase);
  // A failed/ambiguous HTTP submission must not lead to a fresh paid intent.
  spendingHalted = true;
  let response;
  try { response = await request(paidPath(product), { cookie: buyerCookie, headers: { 'X-PAYMENT': header } }); }
  catch (error) { purchase.submissionError = safeError(error); }
  purchase.http = response?.status ?? null;
  let data = response?.data;
  collectPurchaseEvidence(purchase, data);
  if (response?.status !== 200) {
    data = await poll(`settlement ${label}`, async (deadline) => {
      const status = await purchaseStatus(purchase.intentSalt, deadline);
      requireThat(status.state !== 'failed', 'Purchase status failed; no automatic replacement purchase');
      return { done: status.state === 'settled', value: status, detail: `state=${status.state}${status.http ? ` HTTP ${status.http}` : ''}` };
    }, { interval: 5_000 });
  }
  requireThat(data?.ok === true && data.state === 'settled' && data.productKind === 'license', 'Expected settled license payment');
  tx('payment', data.txHash, product.id);
  if (data.nft?.mintTxHash) tx('mint', data.nft.mintTxHash, product.id);
  purchase.txHash = data.txHash;
  purchase.state = 'settled';
  // The status/paid response is authoritative, never a string search in content.
  spendingHalted = false;
  if (response?.status === 200) {
    requireThat(data.resourceId === product.id && data.contentRevision === 1 && data.kind === 'text' && typeof data.value === 'string', 'Paid 200 content shape mismatch');
  }
  requireThat(response && [200, 202].includes(response.status), 'Payment recovered by status, but initial response was not the required 200/202 (see report)');
  purchase.completed = true;
  return purchase;
}

async function library(cookie, source, deadline = Date.now() + TIMEOUT) {
  let cursor = null;
  const seen = new Set();
  const items = [];
  do {
    const query = new URLSearchParams(source ? { source } : {});
    if (cursor) query.set('cursor', cursor);
    const data = expectStatus(await request(`/api/store/library?${query}`, { cookie, deadline }), 200, 'Library');
    requireThat(data?.ok === true && Array.isArray(data.items) && (data.nextCursor === null || typeof data.nextCursor === 'string'), 'Invalid library page');
    if (source) requireThat(data.source === source, 'Library source mismatch');
    items.push(...data.items);
    cursor = data.nextCursor;
    if (cursor !== null) {
      requireThat(!seen.has(cursor), 'Library cursor repeated');
      seen.add(cursor);
    }
  } while (cursor !== null);
  return items;
}

async function pendingRights(product) {
  const item = (await library(buyerCookie)).find((value) => value.resourceId === product.id);
  if (item?.nft?.mintTxHash) tx('mint', item.nft.mintTxHash, product.id);
  report.immediateRights = { productId: product.id, found: Boolean(item), entitled: item?.entitled ?? null,
    basis: ['purchase', 'holder'].includes(item?.basis) ? item.basis : null,
    nftStatus: ['awaiting_finality', 'pending', 'submitted', 'minted', 'retryable', 'needs_repair', 'unknown'].includes(item?.nft?.status) ? item.nft.status : 'unknown' };
  requireThat(item?.productKind === 'license' && item.entitled === true && item.basis === 'purchase', 'Immediate library must show the purchase grant and entitlement');
  requireThat(['pending', 'awaiting_finality'].includes(item.nft?.status), `Expected immediate nft pending/awaiting_finality; observed ${report.immediateRights.nftStatus} (after() can race this observation)`);
  return `entitled=true basis=purchase nft.status=${item.nft.status}`;
}

// The public verify proof describes the latest grant, not every purchase. A
// matching mint hash prevents one minted unit from masking another pending unit.
function mintedProof(status, rights, { singleGrant = false, mintTxHash } = {}) {
  if (status?.nft?.status === 'minted') return status.nft;
  const expectedHash = status?.nft?.mintTxHash ?? mintTxHash;
  if (rights?.nft?.status === 'minted' && (singleGrant ||
    (expectedHash && rights.nft.mintTxHash === expectedHash))) return rights.nft;
  return null;
}

async function mintObservation(product, purchase, deadline, readStatus, singleGrant) {
  // Failure of either read must not suppress a minted proof from the other.
  const results = await Promise.allSettled([
    readStatus(), verify(product, config.buyer.address, deadline), driveCron(deadline),
  ]);
  const [status, rights, worker] = results.map((r) => r.status === 'fulfilled' ? r.value : undefined);
  for (const nft of [status?.nft, rights?.nft]) {
    if (nft?.mintTxHash) tx('mint', nft.mintTxHash, product.id);
  }
  if (status?.nft?.mintTxHash) purchase.mintTxHash = status.nft.mintTxHash;
  const proof = mintedProof(status, rights, { singleGrant, mintTxHash: purchase.mintTxHash });
  const detail = `worker=${worker ?? 'unavailable'}; status=${status?.nft?.status ?? status?.state ?? 'unavailable'}; verify=${rights?.nft?.status ?? 'unavailable'}`;
  if (proof) return { done: true, value: proof, detail };
  for (const result of results) {
    if (result.status === 'rejected' && !(result.reason instanceof TransportError)) throw result.reason;
  }
  requireThat(status?.nft?.status !== 'needs_repair', 'Mint obligation needs_repair');
  return { done: false, detail };
}

function recordMint(product, purchase, proof) {
  if (proof.mintTxHash) {
    tx('mint', proof.mintTxHash, product.id);
    purchase.mintTxHash = proof.mintTxHash;
  }
  purchase.nftStatus = 'minted';
}

async function waitMint(product, purchase) {
  const singleGrant = !report.products.find((p) => p.id === product.id)?.resumed &&
    report.purchases.filter((p) => p.productId === product.id).length === 1;
  const proof = await poll(`mint ${purchase.label}`, (deadline) => mintObservation(product, purchase, deadline,
    () => purchaseStatus(purchase.intentSalt, deadline), singleGrant),
  { interval: CRON_INTERVAL, timeout: config.mintTimeout });
  recordMint(product, purchase, proof);
}

async function buyerGrants(product, deadline = Date.now() + config.mintTimeout) {
  const grants = [];
  const seen = new Set();
  let cursor = null;
  do {
    const query = new URLSearchParams({ address: config.buyer.address, product: product.id });
    if (cursor) query.set('cursor', cursor);
    const response = await request(`/api/license/grants?${query}`, { cookie: buyerCookie, deadline });
    requireThat(response.status !== 404, 'Resume requires SIWE /api/license/grants; this checkout does not expose all grants');
    if ([429, 503].includes(response.status)) throw new TransportError(`Grants HTTP ${response.status}`);
    const data = expectStatus(response, 200, 'Buyer license grants');
    requireThat(data?.ok === true && Array.isArray(data.grants) &&
      (data.nextCursor === null || typeof data.nextCursor === 'string'), 'Invalid grants page');
    for (const grant of data.grants) {
      requireThat(HEX32.test(grant.intentSalt ?? '') && HEX32.test(grant.txHash ?? '') &&
        (grant.productId === undefined || grant.productId === product.id) &&
        (grant.payer === undefined || sameAddress(grant.payer, config.buyer.address)), 'Grant identity/payment mismatch');
      requireThat(!grants.some((g) => g.intentSalt === grant.intentSalt), 'Duplicate grant');
      grants.push(grant);
      tx('payment', grant.txHash, product.id);
      if (grant.nft?.mintTxHash) tx('mint', grant.nft.mintTxHash, product.id);
      let record = report.grants.find((g) => g.productId === product.id && g.intentSalt === grant.intentSalt);
      if (!record) {
        record = { productId: product.id, tokenId: product.license.tokenId, intentSalt: grant.intentSalt };
        report.grants.push(record);
      }
      Object.assign(record, { txHash: grant.txHash, nftStatus: grant.nft?.status, mintTxHash: grant.nft?.mintTxHash });
    }
    cursor = data.nextCursor;
    if (cursor !== null) {
      requireThat(cursor.length > 0 && !seen.has(cursor), 'Grants cursor repeated/empty');
      seen.add(cursor);
    }
  } while (cursor !== null);
  return grants;
}

async function waitAllGrants(product) {
  const proofs = new Map();
  let knownGrants = [];
  await poll(`all buyer grants ${product.id}`, async (deadline) => {
    let grants;
    let refreshed = true;
    try { grants = await buyerGrants(product, deadline); } catch (error) {
      if (!(error instanceof TransportError) || knownGrants.length === 0) throw error;
      refreshed = false;
      grants = knownGrants.map((g) => ({ ...g, nft: { mintTxHash: g.nft?.mintTxHash } }));
    }
    if (refreshed) knownGrants = grants;
    requireThat(grants.length > 0, 'No buyer grants found for resume product');
    // Read public verify once per cycle; it must not count as proof for all units.
    const results = await Promise.allSettled([verify(product, config.buyer.address, deadline), driveCron(deadline)]);
    const rights = results[0].status === 'fulfilled' ? results[0].value : undefined;
    if (rights?.nft?.mintTxHash) tx('mint', rights.nft.mintTxHash, product.id);
    for (const grant of grants) {
      const proof = mintedProof(grant, rights, { singleGrant: grants.length === 1 });
      if (proof) proofs.set(grant.intentSalt, proof);
      if (proofs.has(grant.intentSalt)) {
        recordMint(product, report.grants.find((g) => g.productId === product.id && g.intentSalt === grant.intentSalt), proofs.get(grant.intentSalt));
      }
    }
    const done = grants.every((g) => proofs.has(g.intentSalt));
    if (!done) {
      for (const result of results) {
        if (result.status === 'rejected' && !(result.reason instanceof TransportError)) throw result.reason;
      }
      requireThat(!grants.some((g) => g.nft?.status === 'needs_repair' && !proofs.has(g.intentSalt)), 'Mint obligation needs_repair');
    }
    return { done, detail: `minted=${grants.filter((g) => proofs.has(g.intentSalt)).length}/${grants.length}` };
  }, { interval: CRON_INTERVAL, timeout: config.mintTimeout });
}

async function verify(product, address, deadline = Infinity) {
  const response = await request(`/api/license/verify?address=${address}&product=${product.id}`, { deadline });
  if ([429, 503].includes(response.status)) throw new TransportError(`Verify HTTP ${response.status}`);
  const data = expectStatus(response, 200, 'License verify');
  requireThat(data?.version === 1 && sameAddress(data.address, address) && data.license?.productId === product.id &&
    data.license.chainId === CHAIN_ID && sameAddress(data.license.contract, config.contract) && data.license.tokenId === product.license.tokenId,
  'Verify API identity mismatch');
  if (data.nft?.mintTxHash) tx('mint', data.nft.mintTxHash, product.id);
  return data;
}

function assertSoldOutPurchases(product, initialRemaining) {
  const completed = report.purchases.filter((p) => p.productId === product.id && p.completed === true);
  requireThat(completed.length === initialRemaining, 'Sold-out signing blocked: required purchases did not all pass');
  // Only a fresh run can derive sold == supply from its own purchases. Resume
  // uses an observed starting remaining count (which can also exclude reserves).
  if (!config.resumeProduct) requireThat(completed.length === product.license.supply, 'Own completed purchases must equal supply');
}

async function soldOut(product, initialRemaining = product.license.supply) {
  assertSoldOutPurchases(product, initialRemaining);
  await publicListing(product, 0);
  const before = await balance();
  let response;
  let prepared;
  try {
    prepared = await quote(product);
    const header = await signedHeader(prepared);
    spendingHalted = true;
    response = await request(paidPath(product), { cookie: buyerCookie, headers: { 'X-PAYMENT': header } });
    if (HEX32.test(response.data?.txHash ?? '')) tx('unexpected-sold-out-payment', response.data.txHash, product.id);
  } finally {
    const after = await balance();
    report.soldOut = { productId: product.id, beforeJpyc: formatUnits(before, 18), afterJpyc: formatUnits(after, 18),
      http: response?.status ?? null, ...(prepared ? { intentSalt: prepared.authorization.intentSalt,
        nonce: prepared.typedData.message.nonce, validBefore: prepared.authorization.validBefore } : {}) };
    requireThat(before === after, 'Sold-out test changed buyer JPYC balance');
  }
  const data = expectStatus(response, 409, 'Signed sold-out claim');
  requireThat(data?.error === 'sold_out', 'Signed claim must be rejected specifically with sold_out');
  const used = await rpc.readContract({ address: JPYC.address, abi: ABI, functionName: 'authorizationState', args: [config.buyer.address, prepared.typedData.message.nonce] });
  requireThat(used === false, 'Rejected authorization was consumed on-chain');
  spendingHalted = false;
  return 'signed claim HTTP 409 sold_out; JPYC unchanged; authorization unused';
}

async function transfer(product) {
  const [pol, gasPrice] = await Promise.all([rpc.getBalance({ address: config.buyer.address }), rpc.getGasPrice()]);
  const needed = gasPrice * 120000n;
  if (pol < needed) throw new Skip(`buyer POL insufficient: have ${formatEther(pol)}, need ${formatEther(needed)}`);
  const wallet = createWalletClient({ account: config.buyer, chain: polygonAmoy, transport: http(config.rpcUrl, { timeout: 10_000, retryCount: 0 }) });
  const { request: call } = await rpc.simulateContract({ account: config.buyer, address: config.contract, abi: ABI,
    functionName: 'safeTransferFrom', args: [config.buyer.address, config.transferTo.address, BigInt(product.license.tokenId), 1n, '0x'] });
  const hash = await wallet.writeContract(call);
  tx('transfer', hash, product.id);
  const receipt = await rpc.waitForTransactionReceipt({ hash, timeout: TIMEOUT, pollingInterval: 5_000 });
  requireThat(receipt.status === 'success', 'ERC-1155 transfer reverted');
  // Rights reads use finalized, while SDK hasLicense uses latest. Wait for the
  // transfer block to finalize before testing holder rights and cached negatives.
  await poll('transfer finality', async () => {
    const block = await rpc.getBlock({ blockTag: 'finalized' });
    return { done: block.number >= receipt.blockNumber, detail: `finalized block=${block.number}`, value: block };
  });
  requireThat((await rpc.getBlock({ blockNumber: receipt.blockNumber })).hash === receipt.blockHash, 'Transfer receipt is no longer canonical');
  return `safeTransferFrom finalized: ${hash}`;
}

async function resumePurchases(product, listing) {
  if (!listing) return null;
  const remaining = listing.value;
  let previous = listing;
  const count = Math.min(remaining, config.maxPurchases);
  for (let i = 0; i < count; i++) {
    const n = i === 0 ? '6.1' : i === 1 ? '8.1' : `8.1.${i + 1}`;
    previous = await step(n, `Resume buyer purchase #${i + 1}`, async () => {
      await publicListing(product, remaining - i);
      return (await buy(product, `NT resume #${i + 1}`)).txHash;
    }, { ready: previous });
  }
  if (remaining === 0) {
    await step('6.1', 'Resume purchase', async () => {}, { skip: 'Listing already exhausted; no purchase needed' });
  }
  if (remaining <= 1) {
    await step('8.1', 'Resume second purchase', async () => {}, { skip: 'No second purchase needed' });
  }
  if (remaining > config.maxPurchases) {
    await step('R.limit', 'Resume purchase bound', async () => {}, { skip: `E2E_MAX_PURCHASES=${config.maxPurchases}; sold-out prerequisite not reached` });
    return null;
  }
  return previous;
}

async function checkHeld(product) {
  const held = await hasLicense({ address: config.buyer.address, chainId: CHAIN_ID, contract: config.contract,
    tokenId: product.license.tokenId, rpcUrl: config.rpcUrl });
  requireThat(held.holder === true, 'SDK hasLicense holder must be true');
  await poll('verify minted NT', async (deadline) => {
    const rights = await verify(product, config.buyer.address, deadline);
    return { done: rights.entitled === true && rights.basis === 'purchase' && rights.nft?.status === 'minted',
      detail: `entitled=${rights.entitled} basis=${rights.basis} nft=${rights.nft?.status}` };
  }, { interval: 10_000, timeout: 90_000 });
  return `holder=true; balance=${held.balance}; entitled=true basis=purchase nft=minted`;
}

async function main() {
  const configured = await step('1.1', 'Configuration and spend guard', async () => {
    config = readConfig();
    rpc = createPublicClient({ chain: polygonAmoy, transport: http(config.rpcUrl, { timeout: 10_000, retryCount: 0 }) });
    report.config = { baseUrl: config.base.origin, chainId: CHAIN_ID, contract: config.contract,
      seller: config.seller.address, buyer: config.buyer.address, transferTo: config.transferTo?.address ?? null,
      priceJpyc: config.price, supply: config.supply, maxJpycPerSignature: formatUnits(config.cap, 18),
      resumeProduct: config.resumeProduct, maxPurchases: config.maxPurchases, allowSkips: config.allowSkips,
      mintTimeoutSec: config.mintTimeout / 1000, registerTimeoutSec: config.registerTimeout / 1000, cronIntervalSec: 60 };
    return `${config.base.origin}; cap=${formatUnits(config.cap, 18)} JPYC per signature`;
  });
  const ready = await step('1.2', 'Server readiness on explicit port', async () => {
    await poll('server readiness', async (deadline) => {
      try {
        const response = await request('/api/auth/siwe/me', { deadline });
        return { done: response.status === 200 && response.data?.ok === true, detail: `HTTP ${response.status}` };
      } catch (error) { return { done: false, detail: safeError(error) }; }
    }, { interval: 3_000, timeout: 30_000 });
    return `ready at ${config.base.origin}`;
  }, { ready: configured });
  const seller = await step('1.3', 'Seller SIWE and /me echo', async () => {
    sellerCookie = await login(config.seller);
    return config.seller.address;
  }, { ready });
  const buyer = await step('1.4', 'Buyer SIWE and /me echo', async () => {
    buyerCookie = await login(config.buyer);
    return config.buyer.address;
  }, { ready });
  const resumeSkip = config?.resumeProduct ? 'E2E_RESUME_PRODUCT: existing registered/published product' : undefined;
  const disclosure = await step('1.5', 'Seller disclosure', async () => {
    let data = expectStatus(await request('/api/store/seller', { cookie: sellerCookie }), 200, 'Seller GET');
    requireThat(data?.ok === true, 'Invalid seller GET');
    const missing = data.seller === null;
    if (missing) data = expectStatus(await request('/api/store/seller', { method: 'PUT', cookie: sellerCookie, body: {
      name: 'E2E TEST ONLY - placeholder business', contact: 'e2e@example.invalid (E2E placeholder)',
      disclosure: 'E2E TEST ONLY. Fictional business/address/phone; no real business disclosure. Amoy testnet license test.',
    } }), 200, 'Seller PUT');
    requireThat(data?.ok === true && data.seller?.name && data.seller?.contact, 'Seller disclosure is incomplete');
    return missing ? 'created clearly marked E2E placeholder' : 'existing disclosure retained';
  }, { ready: seller, skip: resumeSkip });
  const chain = await step('1.6', 'Amoy RPC, buyer JPYC and minter POL', async () => {
    requireThat(await rpc.getChainId() === CHAIN_ID, 'RPC is not Polygon Amoy');
    const minter = await rpc.readContract({ address: config.contract, abi: ABI, functionName: 'minter' });
    requireThat(isAddress(minter) && !/^0x0{40}$/i.test(minter), 'Contract minter is disabled');
    const [jpyc, pol] = await Promise.all([balance(), rpc.getBalance({ address: minter })]);
    report.preflight = { buyerJpyc: formatUnits(jpyc, 18), minter, minterPol: formatEther(pol) };
    requireThat(jpyc >= config.priceAtomic + feeFor(config.priceAtomic), 'Buyer JPYC is below price plus fee');
    requireThat(pol > parseEther('0.12'), 'Minter POL must be greater than 0.12 (worker requires gas + 0.1 POL reserve)');
    return `buyer=${formatUnits(jpyc, 18)} JPYC; minter=${formatEther(pol)} POL`;
  }, { ready: configured });
  let product;
  const created = await step('2', 'Create non-transferable license', async () => {
    product = await createProduct(false, config.supply);
    return `${product.id}; paused; registration=pending; tokenId=${product.license.tokenId}`;
  }, { ready: disclosure && buyer && chain, skip: resumeSkip });
  const registrationGate = await step('3', 'Registration gates payment quote', async () => {
    const response = await request(paidPath(product), { cookie: buyerCookie });
    requireThat(expectStatus(response, 409, 'Unregistered quote')?.error === 'license_registration_pending' &&
      !response.headers.has('payment-required'), 'Expected license_registration_pending without a 402 challenge');
  }, { ready: created, skip: resumeSkip });
  const registered = await step('4', 'Cron registers product', async () => { product = await register(product); }, { ready: created && registrationGate, skip: resumeSkip });
  const published = await step('5.1', 'Publish license', () => publish(product), { ready: registered, skip: resumeSkip });
  let productReady = created;
  let minted;
  if (config?.resumeProduct) {
    const resumed = await step('R.1', 'Load resume product and buyer grants', async () => {
      const data = expectStatus(await request(productPath({ id: config.resumeProduct }), { cookie: sellerCookie }), 200, 'Resume product');
      const existing = data?.product;
      requireThat(data?.ok === true && existing?.id === config.resumeProduct && existing.productKind === 'license' &&
        existing.license?.transferable === false && existing.registration?.status === 'registered' && existing.saleActive === true,
      'Resume product must be non-transferable, registered and published');
      requireThat(existing.license.tokenChainId === CHAIN_ID && sameAddress(existing.license.contract, config.contract) &&
        existing.license.tokenId === keccak256(stringToHex(`openpay:license:${existing.id}`)) &&
        sameAddress(existing.owner, config.seller.address) && sameAddress(existing.payTo, config.seller.address), 'Resume product chain/token/owner mismatch');
      product = existing;
      report.products.push({ id: product.id, tokenId: product.license.tokenId, contract: config.contract,
        transferable: false, supply: product.license.supply, priceJpyc: product.priceJpyc,
        registration: 'registered', registrationTxHash: product.registration.txHash, published: true, resumed: true });
      if (product.registration.txHash) tx('registration', product.registration.txHash, product.id);
      // Prove the all-grants API is available before signing any resume purchase.
      await buyerGrants(product);
      return product.id;
    }, { ready: seller && buyer && chain });
    productReady = resumed;
    const listing = await step('5.2', 'Public listing and resume remaining', () => publicListing(product), { ready: resumed });
    const initialRemaining = listing?.value;
    const purchases = await resumePurchases(product, listing);
    const exhausted = await step('8.2', 'Signed sold-out claim after resume purchases',
      () => soldOut(product, initialRemaining), { ready: purchases });
    minted = await step('7.1', 'Enumerate and mint ALL buyer grants', () => waitAllGrants(product), { ready: exhausted });
    await step('7.2', 'SDK hasLicense and verify API', () => checkHeld(product), { ready: minted });
  } else {
    const listing = await step('5.2', 'Public listing and initial remaining', () => publicListing(product, config.supply), { ready: published });
    let first;
    const firstPurchase = await step('6.1', 'Buyer purchase #1', async () => { first = await buy(product, 'NT #1'); return first.txHash; }, { ready: published && listing });
    // A content or mint-state assertion failure must not prevent inspecting a payment
    // that already settled. Locate authoritative evidence independently of step OK.
    first ??= report.purchases.find((p) => p.productId === product?.id && p.label === 'NT #1' && p.state === 'settled');
    const immediate = await step('6.2', 'Immediate library rights before mint', () => pendingRights(product), { ready: first });
    minted = await step('7.1', 'Cron mints purchase #1', () => waitMint(product, first), { ready: first });
    const held = await step('7.2', 'SDK hasLicense and verify API', () => checkHeld(product), { ready: minted });
    let second;
    const secondPurchase = await step('8.1', 'Buyer purchase #2 with the same wallet', async () => {
      second = await buy(product, 'NT #2');
      return second.txHash;
    }, { ready: firstPurchase && immediate && minted && held, skip: configured && config.supply < 2 ? 'E2E_SUPPLY=1; no second successful purchase is possible' : undefined });
    second ??= report.purchases.find((p) => p.productId === product?.id && p.label === 'NT #2' && p.state === 'settled');
    await step('8.2', 'Third quote and signed sold-out claim', () => soldOut(product), {
      ready: firstPurchase && secondPurchase, skip: configured && config.supply !== 2 ? 'Exhaustion scenario requires E2E_SUPPLY=2; no additional supply-filling purchases made' : undefined,
    });
    await step('8.3', 'Reconcile purchase #2 mint after sold-out check', () => waitMint(product, second), {
      ready: second, skip: configured && config.supply < 2 ? 'No second purchase for E2E_SUPPLY=1' : undefined,
    });
  }
  const transferSkip = !config?.transferTo ? 'E2E_TRANSFER_TO_KEY is unset' : undefined;
  let transferable;
  const tc = await step('9.1', 'Create transferable license (supply 1)', async () => {
    transferable = await createProduct(true, 1); return transferable.id;
  }, { ready: (config?.resumeProduct ? seller && productReady : disclosure) && buyer && chain && !spendingHalted, skip: transferSkip });
  const tr = await step('9.2', 'Register transferable license', async () => { transferable = await register(transferable); }, { ready: tc, skip: transferSkip });
  const tp = await step('9.3', 'Publish transferable license', () => publish(transferable), { ready: tr, skip: transferSkip });
  let transferPurchase;
  const transferBought = await step('9.4', 'Buy transferable license', async () => { transferPurchase = await buy(transferable, 'T #1'); return transferPurchase.txHash; }, { ready: tp, skip: transferSkip });
  transferPurchase ??= report.purchases.find((p) => p.productId === transferable?.id && p.state === 'settled');
  const tm = await step('9.5', 'Mint transferable license', () => waitMint(transferable, transferPurchase), { ready: transferPurchase, skip: transferSkip });
  const transferred = await step('9.6', 'Transfer ERC-1155 on Amoy', () => transfer(transferable), { ready: transferBought && tm && !spendingHalted, skip: transferSkip });
  const noPol = report.steps.find((s) => s.n === '9.6')?.status === 'SKIP';
  const holderSkip = transferSkip ?? (noPol ? 'Transfer skipped because buyer POL is insufficient' : undefined);
  const recipientRights = await step('9.7', 'Recipient gains rights; buyer loses rights', async () => {
    await poll('transfer rights (60s API cache)', async (deadline) => {
      const [holder, previous] = await Promise.all([verify(transferable, config.transferTo.address, deadline), verify(transferable, config.buyer.address, deadline)]);
      return { done: holder.entitled === true && holder.basis === 'holder' && previous.entitled === false,
        detail: `recipient=${holder.entitled}/${holder.basis}; buyer=${previous.entitled}` };
    }, { interval: 10_000, timeout: 120_000 });
  }, { ready: transferred, skip: holderSkip });
  await step('9.8', 'Holder SIWE, paginated library and revision 1', async () => {
    const cookie = await login(config.transferTo);
    const items = await library(cookie, 'holders');
    requireThat(items.some((p) => p.resourceId === transferable.id && p.productKind === 'license' && p.entitled === true && p.basis === 'holder'), 'Holder library does not list transferred license');
    const content = expectStatus(await request(`/api/store/content/${transferable.id}?revision=1`, { cookie }), 200, 'Holder content');
    requireThat(content?.ok === true && content.resourceId === transferable.id && content.productKind === 'license' && content.contentRevision === 1 &&
      content.state === 'ready' && content.kind === 'text' && typeof content.value === 'string' && content.entitled === true && content.basis === 'holder', 'Holder content revision 1 shape mismatch');
    return 'all holder pages read; content revision=1 ready';
  }, { ready: transferred && recipientRights, skip: holderSkip });
  await step('10.1', 'Random address is not entitled', async () => {
    const address = getAddress(`0x${randomBytes(20).toString('hex')}`);
    requireThat((await verify(product, address)).entitled === false, 'Random address must not be entitled');
    return address;
  }, { ready: productReady });
  await step('10.2', 'Malformed verify address', async () => {
    expectStatus(await request(`/api/license/verify?address=not-an-address&product=${product.id}`), 400, 'Malformed address');
  }, { ready: productReady });
  await step('10.3', 'Cron without Bearer', async () => { expectStatus(await cron(Infinity, false), 401, 'Unauthenticated cron'); }, { ready });
  await step('10.4', 'Concurrent cron lock', async () => {
    // The worker intentionally keeps its 55s lease until expiry, even when idle.
    // Let our previous run/after() expire so this pair tests an actual winner.
    await sleep(56_000);
    const pair = await Promise.all([cron(), cron()]);
    const details = pair.map(cronDetail);
    requireThat(pair.every((r) => r.status === 200) && pair.filter((r) => r.data?.skipped === 'locked').length === 1 &&
      pair.filter((r) => r.data?.skipped === undefined).length === 1,
    'Expected one cron winner and exactly one skipped=locked (external cron may interfere)');
    return details.join('; ');
  }, { ready });
}

function runPassed(steps, allowSkips) {
  return steps.every((s) => s.status === 'OK' || (allowSkips && s.status === 'SKIP'));
}

async function writeReport() {
  const path = resolve(process.env.E2E_REPORT ?? DEFAULT_REPORT);
  await step('11', 'Summary and JSON report', async () => {
    report.finishedAt = new Date().toISOString();
    report.durationMs = Date.now() - Date.parse(report.startedAt);
    report.ok = runPassed(report.steps, config?.allowSkips ?? (process.env.E2E_ALLOW_SKIPS ?? '1') === '1');
    report.summary = { ok: report.steps.filter((s) => s.status === 'OK').length,
      fail: report.steps.filter((s) => s.status === 'FAIL').length, skip: report.steps.filter((s) => s.status === 'SKIP').length };
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    return path;
  });
  report.ok = runPassed(report.steps, config?.allowSkips ?? (process.env.E2E_ALLOW_SKIPS ?? '1') === '1');
  report.finishedAt = new Date().toISOString();
  report.durationMs = Date.now() - Date.parse(report.startedAt);
  report.summary = { ok: report.steps.filter((s) => s.status === 'OK').length,
    fail: report.steps.filter((s) => s.status === 'FAIL').length, skip: report.steps.filter((s) => s.status === 'SKIP').length };
  // Include the reporting step itself; I/O failures are visible and nonzero.
  try { await writeFile(path, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 }); }
  catch { report.ok = false; console.error('[11] Final report write ... FAIL (local I/O failure)'); }
  console.table(report.steps.map(({ n, name, status, durationMs }) => ({ step: n, name, status, seconds: (durationMs / 1000).toFixed(2) })));
  console.log(`Summary: OK=${report.summary.ok} FAIL=${report.summary.fail} SKIP=${report.summary.skip}`);
  console.log(`JSON report: ${path}`);
  if (!report.ok) process.exitCode = 1;
}

async function driverSelfCheck(account, product) {
  const saved = { config, rpc, buyerCookie, nextCronAt, spendingHalted, fetch: globalThis.fetch, log: console.log };
  const lengths = Object.fromEntries(['steps', 'purchases', 'products', 'grants', 'transactions', 'polls'].map((k) => [k, report[k].length]));
  let networkAttempts = 0;
  try {
    console.log = () => {};
    globalThis.fetch = async () => { networkAttempts++; throw new Error('No network in self-check'); };
    const defaults = driverOptions({});
    assert.equal(defaults.mintTimeout, 720_000);
    assert.equal(defaults.registerTimeout, 720_000);
    assert.equal(defaults.maxPurchases, 2);
    assert.equal(defaults.allowSkips, true);
    assert.equal(CRON_INTERVAL, 60_000);
    const custom = driverOptions({ E2E_MINT_TIMEOUT_SEC: '900', E2E_REGISTER_TIMEOUT_SEC: '800',
      E2E_MAX_PURCHASES: '3', E2E_ALLOW_SKIPS: '0', E2E_RESUME_PRODUCT: product.id });
    assert.equal(custom.mintTimeout, 900_000);
    assert.equal(custom.registerTimeout, 800_000);
    assert.equal(custom.maxPurchases, 3);
    assert.equal(custom.allowSkips, false);
    assert.throws(() => driverOptions({ E2E_MINT_TIMEOUT_SEC: '0' }));
    assert.throws(() => driverOptions({ E2E_REGISTER_TIMEOUT_SEC: 'NaN' }));
    assert.throws(() => driverOptions({ E2E_MAX_PURCHASES: '-1' }));
    assert.throws(() => driverOptions({ E2E_RESUME_PRODUCT: 'bad' }));
    assert.throws(() => driverOptions({ E2E_ALLOW_SKIPS: 'yes' }));
    assert.equal(cronDetail({ status: 200, data: { ok: true, skipped: 'locked' } }), 'cron skipped locked');
    config = { ...defaults, base: localBase('http://localhost:3119'), buyer: account, contract: account.address };
    product = { ...product, license: { tokenId: keccak256(stringToHex(product.id)), supply: 2 } };
    let signed = 0;
    const signing = async () => { signed++; };
    for (const ready of [undefined, null, false]) {
      assert.equal(await step('test.blocked', 'Blocked signing', signing, { ready }), null);
    }
    const skipped = await step('test.skip', 'Skipped prerequisite', signing, { skip: 'fixture' });
    assert.equal(await step('test.dependent', 'Dependent signing', signing, { ready: skipped }), null);
    assert.equal(signed, 0);
    const passed = await step('test.pass', 'Passed prerequisite', async () => {});
    await step('test.sign', 'Authorized signing', signing, { ready: passed });
    assert.equal(signed, 1);
    // Settled evidence recovered after a failed purchase must never authorize 8.2.
    report.purchases.push({ productId: product.id, state: 'settled', completed: true });
    report.purchases.push({ productId: product.id, state: 'settled' });
    await assert.rejects(() => soldOut(product), /required purchases did not all pass/);
    assert.equal(networkAttempts, 0);
    report.purchases.at(-1).completed = true;
    assert.doesNotThrow(() => assertSoldOutPurchases(product, 2));
    report.purchases.length = lengths.purchases;
    const hash1 = `0x${'1'.repeat(64)}`;
    const hash2 = `0x${'2'.repeat(64)}`;
    const minted = { nft: { status: 'minted', mintTxHash: hash1 } };
    assert.equal(mintedProof(minted, undefined), minted.nft);
    assert.equal(mintedProof({ nft: { status: 'pending' } }, minted, { singleGrant: true }), minted.nft);
    assert.equal(mintedProof({ nft: { status: 'submitted', mintTxHash: hash1 } }, minted), minted.nft);
    assert.equal(mintedProof({ nft: { status: 'submitted', mintTxHash: hash2 } }, minted), null);
    assert.equal(mintedProof({ nft: { status: 'pending' } }, minted), null);
    rpc = { getBalance: async () => 1n, getGasPrice: async () => 2n,
      simulateContract: async () => { signed++; throw new Error('Must not simulate'); } };
    const transferred = await step('test.9.6', 'Transfer funding', () => transfer(product), { ready: passed });
    assert.equal(transferred, null);
    assert.equal(report.steps.at(-1).status, 'SKIP');
    assert.match(report.steps.at(-1).detail, /^buyer POL insufficient: have .* need /);
    for (const n of ['test.9.7', 'test.9.8']) {
      await step(n, 'Transfer dependent', signing, { ready: transferred, skip: 'buyer POL insufficient' });
    }
    assert.ok(report.steps.slice(-3).every((s) => s.status === 'SKIP'));
    assert.equal(runPassed(report.steps.slice(-3), true), true);
    assert.equal(runPassed(report.steps.slice(-3), false), false);
    assert.equal(runPassed([{ status: 'FAIL' }], true), false);
    assert.equal(signed, 1);
    assert.equal(networkAttempts, 0);
    // All HTTP below is an in-memory fixture; no server/RPC access is possible.
    buyerCookie = 'op_sess=offline';
    const grants = [
      { intentSalt: hash1, txHash: hash1, nft: { status: 'minted', mintTxHash: hash1 } },
      { intentSalt: hash2, txHash: hash2, nft: { status: 'submitted', mintTxHash: hash2 } },
    ];
    let grantPages = 0;
    let verifyHash = hash2;
    let verifyFailure = false;
    let cronCalls = 0;
    globalThis.fetch = async (url, options) => {
      let data;
      if (url.pathname === '/api/license/grants') {
        assert.equal(options.headers.cookie, buyerCookie);
        assert.equal(url.searchParams.get('address'), account.address);
        assert.equal(url.searchParams.get('product'), product.id);
        const second = url.searchParams.get('cursor') === 'page2';
        grantPages++;
        data = { ok: true, grants: [grants[second ? 1 : 0]], nextCursor: second ? null : 'page2' };
      } else if (url.pathname === '/api/license/verify') {
        if (verifyFailure) throw new Error('Offline connection loss');
        data = { version: 1, address: account.address, license: { productId: product.id,
          tokenId: product.license.tokenId, chainId: CHAIN_ID, contract: config.contract },
        nft: { status: 'minted', mintTxHash: verifyHash } };
      } else if (url.pathname === '/api/cron/license-mint') {
        cronCalls++;
        data = { ok: true, skipped: 'locked' };
      } else {
        throw new CheckError(`Unexpected offline request: ${url.pathname}`);
      }
      return new Response(JSON.stringify(data), { status: 200 });
    };
    nextCronAt = 0;
    assert.equal((await buyerGrants(product)).length, 2);
    assert.equal(grantPages, 2);
    await waitAllGrants(product);
    assert.equal(grantPages, 4);
    assert.ok(report.grants.every((g) => g.nftStatus === 'minted'));
    assert.equal(new Set(report.grants.map((g) => g.mintTxHash)).size, 2);
    assert.equal(cronCalls, 1);
    verifyHash = hash1;
    const observation = await mintObservation(product, {}, Infinity,
      async () => { throw new TransportError('Offline status unavailable'); }, true);
    assert.equal(observation.done, true);
    verifyFailure = true;
    assert.equal((await mintObservation(product, {}, Infinity, async () => minted, true)).done, true);
    assert.equal(cronCalls, 1); // consecutive waits still obey the 60s cadence
    config.resumeProduct = product.id;
    assert.doesNotThrow(() => assertSoldOutPurchases(product, 0));
    assert.equal(await resumePurchases(product, null), null);
    assert.ok(await resumePurchases(product, { status: 'OK', value: 0 }));
    // A first purchase failure blocks the next action, including any signing.
    assert.equal(await resumePurchases(product, { status: 'OK', value: 3 }), null);
    assert.equal(report.steps.filter((s) => s.name.startsWith('Resume buyer purchase')).length, 2);
    assert.ok(report.steps.filter((s) => s.name.startsWith('Resume buyer purchase')).every((s) => s.status === 'FAIL'));
    assert.equal(signed, 1);
    const json = JSON.parse(JSON.stringify(report));
    assert.ok(json.grants.every((g) => g.productId === product.id && g.tokenId === product.license.tokenId));
    assert.ok(json.transactions.some((t) => t.kind === 'payment' && t.hash === hash1));
    assert.ok(json.transactions.some((t) => t.kind === 'mint' && t.hash === hash2));
  } finally {
    ({ config, rpc, buyerCookie, nextCronAt, spendingHalted } = saved);
    globalThis.fetch = saved.fetch;
    console.log = saved.log;
    for (const [key, length] of Object.entries(lengths)) report[key].length = length;
  }
}

async function selfCheck() {
  const started = Date.now();
  const account = privateKeyToAccount(generatePrivateKey());
  const base = localBase('http://localhost:3119');
  const now = new Date();
  const nonce = randomBytes(32).toString('hex');
  const message = siweMessage(base, account.address, nonce, now);
  const fields = parseSiweMessage(message);
  // lib/siwe.ts:139-203: address/nonce/chain/domain, allowed domain+URI host,
  // local-only HTTP and 0 < expiration-issued <= 15 minutes.
  assert.equal(fields.address, account.address);
  assert.equal(fields.nonce, nonce);
  assert.equal(fields.chainId, CHAIN_ID);
  assert.equal(fields.version, '1');
  assert.equal(fields.domain, base.host);
  assert.equal(new URL(fields.uri).host, base.host);
  assert.equal(new URL(fields.uri).protocol, 'http:');
  assert.equal(fields.issuedAt.getTime(), now.getTime());
  assert.equal(fields.expirationTime.getTime() - fields.issuedAt.getTime(), 600_000);
  assert.ok(fields.expirationTime > now);
  const signature = await account.signMessage({ message });
  assert.equal(await verifyMessage({ address: account.address, message, signature }), true);
  assert.throws(() => localBase('https://open-pay.jp:3119'));
  assert.throws(() => localBase('http://localhost'));
  for (const name of ['op_sess', '__Host-op_sess']) {
    assert.equal(sessionCookie(new Headers({ 'set-cookie': `${name}=self-check-cookie; Path=/; HttpOnly; Secure` })), `${name}=self-check-cookie`);
  }
  const { SUPPORTED_JPYC_FORWARDERS } = await import('../packages/x402-sdk/src/guards.mjs');
  const merchant = privateKeyToAccount(generatePrivateKey()).address;
  const feeReceiver = privateKeyToAccount(generatePrivateKey()).address;
  const product = { id: `h_${randomBytes(16).toString('hex')}`, payTo: merchant, priceJpyc: '1000' };
  const deadline = String(Math.floor(now.getTime() / 1000) + 300);
  const challenge = { x402Version: 1, accepts: [{ scheme: 'exact', network: NETWORK, maxAmountRequired: String(1010n * UNIT),
    asset: JPYC.address, payTo: SUPPORTED_JPYC_FORWARDERS[NETWORK], maxTimeoutSeconds: 600,
    extra: { name: JPYC.name, version: JPYC.version, decimals: JPYC.decimals, assetTransferMethod: 'eip3009',
      openpay: { mode: 'forwarder-split', forwarder: SUPPORTED_JPYC_FORWARDERS[NETWORK], merchant,
        merchantValue: String(1000n * UNIT), feeReceiver, feeValue: String(10n * UNIT), commitVersion: COMMIT_VERSION,
        intentSalt: `0x${randomBytes(32).toString('hex')}`, authorizationValidBeforeMax: deadline } } }] };
  const prepared = prepareQuote(challenge, product, account.address, 1100n * UNIT);
  assert.equal(prepared.authorization.validBefore, deadline);
  assert.equal(prepared.typedData.message.validAfter, 0n);
  assert.notEqual(prepared.typedData.message.nonce, prepared.authorization.intentSalt);
  assert.equal(prepared.typedData.primaryType, 'ReceiveWithAuthorization');
  assert.throws(() => prepareQuote(challenge, product, account.address, 1000n * UNIT));
  for (const mutate of [
    (c) => { c.accepts[0].asset = merchant; },
    (c) => { c.accepts[0].payTo = merchant; c.accepts[0].extra.openpay.forwarder = merchant; },
    (c) => { c.accepts[0].extra.openpay.intentSalt = undefined; },
    (c) => { c.accepts[0].extra.openpay.authorizationValidBeforeMax = '0'; },
    (c) => { c.accepts[0].extra.openpay.commitVersion = `0x${'0'.repeat(64)}`; },
    (c) => { c.accepts[0].extra.name = 'untrusted'; },
  ]) {
    const changed = structuredClone(challenge); mutate(changed);
    assert.throws(() => prepareQuote(changed, product, account.address, 1100n * UNIT));
  }
  const changed = structuredClone(challenge);
  changed.accepts[0].extra.openpay.intentSalt = `0x${randomBytes(32).toString('hex')}`;
  assert.notEqual(prepareQuote(changed, product, account.address, 1100n * UNIT).typedData.message.nonce, prepared.typedData.message.nonce);
  const listing = { id: product.id, handle: 'e2e', productKind: 'license', license: { supply: 2, remaining: 2 } };
  const row = `1:["$","component",null,{"listings":[${JSON.stringify(listing)}]}]\n`;
  const html = [row.slice(0, 35), row.slice(35)].map((chunk) => `<script>self.__next_f.push([1,${JSON.stringify(chunk)}])</script>`).join('');
  assert.deepEqual(listingFromHtml(html, product.id), listing);
  assert.equal(listingFromHtml(html, 'absent'), null);
  await driverSelfCheck(account, product);
  console.log('[self-check] timeout/cadence, prerequisite signing gates, dual mint proofs, paginated grants, resume bound, POL skips and report fields ... OK (offline fixtures)');
  console.log(`[self-check] SIWE parse/signature, cookie names, quote spend/asset/forwarder/domain guards, committed nonce and streamed listing ... OK (${Date.now() - started}ms; no network)`);
}

if (process.argv.includes('--self-check')) {
  try { await selfCheck(); } catch { console.error('[self-check] ... FAIL (offline assertion failed)'); process.exitCode = 1; }
} else if (process.argv.length > 2) {
  console.error('Usage: node scripts/license-amoy-e2e.mjs [--self-check]');
  process.exitCode = 1;
} else {
  try { await main(); } catch (error) { await step('fatal', 'Unexpected orchestration failure', async () => { throw error; }); }
  await writeReport();
}
