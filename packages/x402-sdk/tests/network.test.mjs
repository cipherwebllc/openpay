import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isPrivatePaymentHost, parseSafePaymentUrl } from '../src/index.mjs';

// The full boundary table lives in the OpenPay repository (shared with the server's
// lib/net/privateHost.ts). This package-level test pins the ranges that used to be
// missing from the SDK so a publish cannot regress them.
const privateHosts = [
  // NAT64 / 6to4 / Teredo / deprecated 6to4 relay
  '64:ff9b::a9fe:a9fe', '64:ff9b::169.254.169.254', '64:ff9b:1::1', '2002:c0a8:101::', '2002:0808:0808::',
  '2001::1', '192.88.99.1',
  // CGNAT, documentation, benchmarking, IETF assignments, reserved
  '100.64.0.1', '100.127.255.255', '192.0.2.10', '198.51.100.7', '203.0.113.9', '198.18.0.1', '192.0.0.1', '240.0.0.1',
  '2001:db8::1', '2001:2::1', '3fff::1', '5f00::1', '100::1', '100:0:0:1::1', 'fec0::1',
  // ranges the SDK already rejected
  '127.0.0.1', '10.0.0.1', '169.254.169.254', '172.16.0.1', '192.168.1.1', '224.0.0.1', '0.0.0.0',
  '::', '::1', '::ffff:127.0.0.1', '::ffff:0:8.8.8.8', '::192.0.2.1', 'fc00::1', 'fe80::1', 'ff02::1',
  'localhost', 'seller.localhost', 'db.internal', 'printer.local', '::bad::ip', '1:2:3:4:5:6:7::8',
];

const publicHosts = [
  '1.1.1.1', '8.8.8.8', '93.184.216.34', '100.63.255.255', '100.128.0.0', '192.88.98.255', '192.88.100.0',
  '192.0.1.255', '192.0.3.0', '198.17.255.255', '198.20.0.0', '2606:4700:4700::1111', '2001:4860:4860::8888',
  '2001:db7::1', '2001:db9::', '2003::1', '3fff:1000::', '::ffff:8.8.8.8', '::8.8.8.8', 'example.com', 'example.com.',
];

test('rejects NAT64, 6to4, CGNAT, documentation and other special-purpose ranges', () => {
  for (const host of privateHosts) {
    assert.equal(isPrivatePaymentHost(host), true, host);
    if (host.includes(':')) assert.equal(isPrivatePaymentHost(`[${host.toUpperCase()}]`), true, host);
  }
});

test('keeps public addresses and DNS names, including the edges next to each range', () => {
  for (const host of publicHosts) {
    assert.equal(isPrivatePaymentHost(host), false, host);
  }
});

test('parseSafePaymentUrl refuses private literals before any DNS or fetch', () => {
  assert.equal(parseSafePaymentUrl('https://[64:ff9b::a9fe:a9fe]/paid'), null);
  assert.equal(parseSafePaymentUrl('https://[2002:c0a8:101::]/paid'), null);
  assert.equal(parseSafePaymentUrl('https://100.64.0.1/paid'), null);
  assert.equal(parseSafePaymentUrl('https://192.0.2.10/paid'), null);
  assert.ok(parseSafePaymentUrl('https://seller.example/paid') instanceof URL);
});
