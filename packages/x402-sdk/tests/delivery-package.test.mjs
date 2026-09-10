import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { fixture } from './delivery.fixture.mjs';

const packageDir = fileURLToPath(new URL('..', import.meta.url));
const manifestOf = (output) => {
  const value = JSON.parse(output);
  return Array.isArray(value) ? value[0] : Object.values(value)[0];
};
const exported = ['DeliveryError', 'createDeliveryGate', 'deliveryKeyThumbprint', 'ticketFromRequest', 'verifyDeliveryTicket'];

test('workspace root keeps existing exports and does not expose delivery; subpath has exactly the delivery API', async () => {
  const root = await import('openpay-x402-sdk');
  for (const name of ['createOpenPayClient', 'createJpycGate', 'createDualGate', 'createListingClient',
    'hasLicense', 'verifyLicense', 'resolveLicense', 'createLicenseGate', 'LicenseError', 'LicenseRpcError']) assert.equal(typeof root[name], 'function');
  for (const name of exported) assert.equal(Object.hasOwn(root, name), false);
  assert.deepEqual(Object.keys(await import('openpay-x402-sdk/delivery')).sort(), exported);
});

test('actual npm tarball includes types/examples and verifies through installed export map without Node globals', () => {
  const dir = mkdtempSync('/private/tmp/openpay-delivery-package-');
  try {
    const npm = ['pack', '--json', '--ignore-scripts', '--cache', join(dir, 'npm-cache')];
    const dry = manifestOf(execFileSync('npm', [...npm, '--dry-run'], { cwd: packageDir, encoding: 'utf8' }));
    assert.equal(dry.version, '0.8.1');
    const paths = dry.files.map((file) => file.path);
    for (const path of ['src/delivery.mjs', 'delivery.d.ts', 'src/index.mjs', 'index.d.ts', 'README.md', 'CHANGELOG.md',
      'examples/node-delivery-gate.mjs', 'examples/cloudflare-r2-delivery-gate/worker.mjs',
      'examples/cloudflare-r2-delivery-gate/wrangler.toml', 'examples/cloudflare-r2-delivery-gate/README.md']) assert.ok(paths.includes(path), path);
    assert.equal(paths.some((path) => path.startsWith('tests/')), false);
    const pack = manifestOf(execFileSync('npm', [...npm, '--pack-destination', dir], { cwd: packageDir, encoding: 'utf8' }));
    execFileSync('tar', ['-xzf', join(dir, pack.filename), '-C', dir]);
    const extracted = join(dir, 'package');
    const manifest = JSON.parse(readFileSync(join(extracted, 'package.json'), 'utf8'));
    assert.deepEqual(manifest.exports['.'], { types: './index.d.ts', import: './src/index.mjs' });
    assert.deepEqual(manifest.exports['./delivery'], { types: './delivery.d.ts', import: './src/delivery.mjs' });
    assert.equal(manifest.engines.node, '>=20'); assert.deepEqual(manifest.dependencies, { viem: '^2.45.0' });
    assert.doesNotMatch(readFileSync(join(extracted, 'src/index.mjs'), 'utf8'), /delivery/);
    assert.doesNotMatch(readFileSync(join(extracted, 'index.d.ts'), 'utf8'), /Delivery|delivery\.mjs/);
    const source = readFileSync(join(extracted, 'src/delivery.mjs'), 'utf8');
    assert.doesNotMatch(source, /\b(?:Buffer|process|atob)\b|node:|\bimport\s*(?:[({*]|['"])/);
    mkdirSync(join(dir, 'node_modules'));
    symlinkSync(extracted, join(dir, 'node_modules/openpay-x402-sdk'), 'dir');
    // There are deliberately NO installed dependencies beside the packed package.
    const consumer = `
      import assert from 'node:assert/strict';
      globalThis.Buffer = undefined; globalThis.process = undefined; globalThis.atob = undefined;
      const api = await import('openpay-x402-sdk/delivery');
      assert.deepEqual(Object.keys(api).sort(), ${JSON.stringify(exported)});
      const fixture = ${JSON.stringify(fixture)};
      const gate = api.createDeliveryGate({ product: fixture.claims.product, audience: fixture.claims.aud,
        keys: [fixture.publicJwk], now: () => 1700000030000 });
      await gate.ready();
      assert.equal((await gate.verify(fixture.ticket)).revision, 3);
      console.log('packed delivery subpath verified without Node globals or dependencies');
    `;
    writeFileSync(join(dir, 'consumer.mjs'), consumer);
    assert.match(execFileSync(process.execPath, [join(dir, 'consumer.mjs')], { cwd: dir, encoding: 'utf8' }), /packed delivery subpath verified/);
    writeFileSync(join(dir, 'consumer.mts'), `
      import { createDeliveryGate, verifyDeliveryTicket, ticketFromRequest, deliveryKeyThumbprint, DeliveryError,
        type DeliveryOptions, type DeliveryVerification, type DeliveryPublicJwk, type DeliveryReplayStore,
        type DeliveryErrorCode, type DeliveryGate } from 'openpay-x402-sdk/delivery';
      const key: DeliveryPublicJwk = ${JSON.stringify(fixture.publicJwk)};
      const store: DeliveryReplayStore = { async consume(jti: string, expSeconds: number) { return !!jti && expSeconds > 0; } };
      const options: DeliveryOptions = { product: '${fixture.claims.product}', audience: '${fixture.claims.aud}', keys: [key], replayStore: store };
      const gate: DeliveryGate = createDeliveryGate(options);
      const ready: Promise<void> = gate.ready();
      const result: Promise<DeliveryVerification> = gate.verify('ticket');
      const request = new Request('${fixture.claims.aud}');
      const extracted: string | null = ticketFromRequest(request);
      const checked: Promise<DeliveryVerification> = gate.verifyRequest(request);
      const direct: Promise<DeliveryVerification> = verifyDeliveryTicket({ ...options, ticket: extracted ?? '' });
      const kid: Promise<string> = deliveryKeyThumbprint(key.x);
      const code: DeliveryErrorCode = new DeliveryError('replay').code;
      void [ready, result, checked, direct, kid, code];
    `);
    const tsc = fileURLToPath(new URL('../../../node_modules/typescript/bin/tsc', import.meta.url));
    execFileSync(process.execPath, [tsc, '--noEmit', '--strict', '--target', 'ES2022', '--module', 'NodeNext',
      '--moduleResolution', 'NodeNext', '--lib', 'ES2022,DOM', 'consumer.mts'], { cwd: dir, encoding: 'utf8' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
