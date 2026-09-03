import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const PACKAGE_DIR = resolve(process.cwd(), 'packages/x402-sdk');
const ROOT_TSC = resolve(process.cwd(), 'node_modules/typescript/bin/tsc');

function run(
  command: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv },
) {
  return spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 10 * 1024 * 1024,
  });
}

describe('openpay-x402-sdk tarball consumer', () => {
  it('packs, installs, supports a bare Node import, and typechecks every named export', () => {
    const temp = mkdtempSync(join(tmpdir(), 'openpay-x402-sdk-consumer-'));
    const packDir = join(temp, 'pack');
    const consumerDir = join(temp, 'consumer');
    const cacheDir = join(temp, 'npm-cache');
    mkdirSync(packDir);
    mkdirSync(consumerDir);
    mkdirSync(cacheDir);
    const env = { ...process.env, npm_config_cache: cacheDir };

    const packed = run(
      'npm',
      ['pack', '--json', '--pack-destination', packDir],
      { cwd: PACKAGE_DIR, env },
    );
    expect(packed.status, packed.stderr).toBe(0);
    // npm pack --json は npm 11 まで配列・npm 12 (node 26 同梱) からパッケージ名 key の
    // オブジェクト。ローカル node/npm 差で落とさないよう両形を受ける。
    const parsed = JSON.parse(packed.stdout) as unknown;
    const manifest = [
      (Array.isArray(parsed)
        ? parsed[0]
        : Object.values(parsed as Record<string, unknown>)[0]) as {
        filename: string;
        files: Array<{ path: string }>;
      },
    ];
    const paths = manifest[0].files.map((file) => file.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        'CHANGELOG.md',
        'README.md',
        'index.d.ts',
        'package.json',
        'src/catalog.mjs',
        'src/client.mjs',
        'src/executor.mjs',
        'src/gate.mjs',
        'src/guards.mjs',
        'src/index.mjs',
        'src/network.mjs',
        'src/payment.mjs',
        'src/receipt.mjs',
        'src/signer.mjs',
        'src/spendStore.mjs',
      ]),
    );

    writeFileSync(
      join(consumerDir, 'package.json'),
      JSON.stringify({ name: 'sdk-consumer', private: true, type: 'module' }),
    );
    mkdirSync(join(consumerDir, 'node_modules'));
    symlinkSync(
      resolve(process.cwd(), 'node_modules/viem'),
      join(consumerDir, 'node_modules/viem'),
      'dir',
    );
    const tarball = resolve(packDir, manifest[0].filename);
    const installed = run(
      'npm',
      [
        'install',
        '--offline',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--package-lock=false',
        tarball,
      ],
      { cwd: consumerDir, env },
    );
    expect(installed.status, installed.stderr).toBe(0);

    writeFileSync(
      join(consumerDir, 'smoke.mjs'),
      `import { createFileSpendStore, createJpycGate, createOpenPayClient, JPYC_DECIMALS } from 'openpay-x402-sdk';
const client = createOpenPayClient({ catalogTrust: false });
const gate = createJpycGate({ resourceUrl: 'https://seller.test/paid' });
if (JPYC_DECIMALS !== 18 || client.session.spentJpyc !== '0') process.exit(1);
if (JSON.stringify(client) !== '{}') process.exit(2);
if (typeof gate.handle !== 'function' || typeof gate.verify !== 'function') process.exit(3);
if (typeof createFileSpendStore !== 'function') process.exit(4);
`,
    );
    const smoke = run(process.execPath, ['smoke.mjs'], { cwd: consumerDir });
    expect(smoke.status, smoke.stderr).toBe(0);

    writeFileSync(
      join(consumerDir, 'consumer.mts'),
      `import {
  CATALOG_CACHE_MS,
  DEFAULT_ALLOWED_HOSTS,
  DEFAULT_CATALOG_TRUST,
  DEFAULT_DISCOVERY_URL,
  DEFAULT_MAX_PER_CALL_JPYC,
  DEFAULT_MAX_SESSION_JPYC,
  DEFAULT_MAX_TIMEOUT_SECONDS,
  DEFAULT_PAYMENT_FETCH_TIMEOUT_MS,
  JPYC_DECIMALS,
  MAX_AUTHORIZATION_TIMEOUT_SECONDS,
  MAX_SUPPORTED_TIMEOUT_SECONDS,
  REASONS,
  RECEIVE_WITH_AUTHORIZATION_TYPES,
  SETTLEMENT,
  SIGNER_MODES,
  SPEND_LOCK_STALE_MS,
  SUPPORTED_JPYC_ASSETS,
  SUPPORTED_JPYC_FORWARDERS,
  SUPPORTED_NETWORKS,
  buildForwarderNonce,
  buildTypedDataFromPaymentRequirements,
  chainIdFromNetwork,
  createAuthorization,
  createCatalogCache,
  createCatalogResolver,
  createFileSpendStore,
  createJpycGate,
  createOpenPayClient,
  createPaymentExecutor,
  createPaymentSession,
  createReceiptSignerResolver,
  createSigner,
  createSignerFromOptions,
  decodePaymentResponse,
  encodePaymentPayload,
  evaluatePaymentGuards,
  fetchPaymentTarget,
  formatAtomicJpyc,
  isHostAllowed,
  isPrivatePaymentHost,
  normalizePaymentRequirements,
  parseClientOptions,
  parseJpycToAtomic,
  parseSafePaymentUrl,
  parseSignerOptions,
  paymentPayloadFor,
  readMoneyConfig,
  readRuntimeConfig,
  readSignerMode,
  recordSuccessfulPayment,
  redactSensitiveText,
  resolveCatalogListings,
  safeErrorMessage,
  summarizeAccept,
  validateAcceptForPayment,
  verifyBoundPaymentResponse,
  type FreeApiResult,
  type FileSpendStoreOptions,
  type JpycGate,
  type JpycGateOptions,
  type JpycGatePaymentResponse,
  type OpenPayClient,
  type PaymentLookup,
  type PaymentResult,
  type QuoteResult,
  type ReceiptSignerResolver,
  type SettlementStatus,
  type SpendReservation,
  type SpendReservationResult,
  type SpendStore,
  type VerifiedJpycPayment,
} from 'openpay-x402-sdk';

const client: OpenPayClient = createOpenPayClient({ catalogTrust: false });
const spendStore: SpendStore = {
  async load() { return '0'; },
  async save() {},
};
const fileSpendStoreOptions: FileSpendStoreOptions = { path: './spend.json' };
const fileSpendStore: SpendStore = createFileSpendStore(fileSpendStoreOptions);
const paymentLookup: PaymentLookup = async () => [{ address: '93.184.216.34', family: 4 }];
const spendReservation: SpendReservation = {
  id: '0xnonce',
  payer: '${'0x1111111111111111111111111111111111111111'}',
  network: 'eip155:80002',
  asset: '${'0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29'}',
  validBefore: '2000000000',
};
const spendReservationResult: SpendReservationResult = {
  ok: true,
  totalAtomic: '1',
};
const lockedReservationResult: SpendReservationResult = {
  ok: false,
  reason: 'unavailable',
  detail: 'spend store lock unavailable: /tmp/spend.json.lock (held for 3s)',
};
const settlementStatus: SettlementStatus = SETTLEMENT.unavailable;
// settlement is optional so a result built before the field existed still typechecks.
const legacyPaymentResult: PaymentResult = { status: 200, body: null, receipt: null };
const receiptSignerResolver: ReceiptSignerResolver = createReceiptSignerResolver({
  discoveryUrl: 'https://open-pay.jp/api/discovery',
});
createOpenPayClient({
  privateKey: '${`0x${'1'.repeat(64)}`}',
  maxDailyJpyc: '25',
  maxTimeoutSeconds: 600,
  spendStore,
  catalogTrust: false,
});
const gateOptions: JpycGateOptions = { resourceUrl: 'https://seller.test/paid' };
const gate: JpycGate = createJpycGate(gateOptions);
const quote: Promise<QuoteResult> = client.quote('https://open-pay.jp/api/paid/demo');
const discovery: Promise<FreeApiResult<unknown>> = client.discover();
const handled: Promise<Response | JpycGatePaymentResponse> = gate.handle(
  new Request('https://seller.test/paid'),
);
const verified: Promise<Response | VerifiedJpycPayment> = gate.verify(
  new Request('https://seller.test/paid'),
);
client.pay('https://open-pay.jp/api/paid/demo', { maxTotalJpyc: '2' });
// @ts-expect-error maxTotalJpyc options are mandatory
client.pay('https://open-pay.jp/api/paid/demo');

void quote;
void discovery;
void handled;
void verified;
void fileSpendStore;
void paymentLookup;
void spendReservation;
void spendReservationResult;
void lockedReservationResult;
void settlementStatus;
void legacyPaymentResult;
void receiptSignerResolver;
void [
  SETTLEMENT, SPEND_LOCK_STALE_MS,
  CATALOG_CACHE_MS, DEFAULT_ALLOWED_HOSTS, DEFAULT_CATALOG_TRUST,
  DEFAULT_DISCOVERY_URL, DEFAULT_MAX_PER_CALL_JPYC, DEFAULT_MAX_SESSION_JPYC,
  DEFAULT_MAX_TIMEOUT_SECONDS, DEFAULT_PAYMENT_FETCH_TIMEOUT_MS, JPYC_DECIMALS,
  MAX_AUTHORIZATION_TIMEOUT_SECONDS, MAX_SUPPORTED_TIMEOUT_SECONDS, REASONS,
  RECEIVE_WITH_AUTHORIZATION_TYPES,
  SIGNER_MODES, SUPPORTED_JPYC_ASSETS, SUPPORTED_JPYC_FORWARDERS,
  SUPPORTED_NETWORKS, buildForwarderNonce,
  buildTypedDataFromPaymentRequirements,
  chainIdFromNetwork, createAuthorization, createCatalogCache,
  createCatalogResolver, createFileSpendStore, createJpycGate, createPaymentExecutor,
  createPaymentSession, createReceiptSignerResolver, createSigner,
  createSignerFromOptions, decodePaymentResponse, encodePaymentPayload,
  evaluatePaymentGuards, fetchPaymentTarget, formatAtomicJpyc, isHostAllowed,
  isPrivatePaymentHost,
  normalizePaymentRequirements, parseClientOptions, parseJpycToAtomic,
  parseSafePaymentUrl, parseSignerOptions, paymentPayloadFor, readMoneyConfig, readRuntimeConfig,
  readSignerMode, recordSuccessfulPayment, redactSensitiveText,
  resolveCatalogListings, safeErrorMessage, summarizeAccept,
  validateAcceptForPayment, verifyBoundPaymentResponse,
];
`,
    );
    writeFileSync(
      join(consumerDir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          target: 'ES2022',
          lib: ['ES2022', 'DOM'],
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          strict: true,
          noEmit: true,
          skipLibCheck: false,
        },
        include: ['consumer.mts'],
      }),
    );
    const typecheck = run(process.execPath, [ROOT_TSC, '--noEmit'], {
      cwd: consumerDir,
    });
    expect(
      typecheck.status,
      `${typecheck.stdout}\n${typecheck.stderr}\n${readFileSync(
        join(consumerDir, 'consumer.mts'),
        'utf8',
      )}`,
    ).toBe(0);
  }, 120_000);
});
