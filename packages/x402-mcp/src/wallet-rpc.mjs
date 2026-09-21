import { lookup as dnsLookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';
import { isPrivatePaymentHost, parseSafePaymentUrl } from 'openpay-x402-sdk';

// The SDK's guarded transport is GET-only. Reuse its public URL/host policy for this
// read-only JSON-RPC POST, and pin validated DNS answers into the actual Node connection.
export async function fetchPolygonRpc(rawUrl, init, { fetchImpl = globalThis.fetch, lookup } = {}) {
  const url = new URL(rawUrl);
  const localHttp = url.protocol === 'http:' &&
    (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
  if (localHttp) {
    if (url.username || url.password) throw new Error('polygon_rpc_not_allowed');
  } else if (url.protocol !== 'https:' || parseSafePaymentUrl(rawUrl) === null) {
    throw new Error('polygon_rpc_not_allowed');
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  const resolve = lookup ?? ((host) => dnsLookup(host, { all: true, verbatim: true }));
  const resolved = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) }]
    : await resolve(hostname);
  init.signal.throwIfAborted();
  if (!Array.isArray(resolved) || resolved.length === 0) throw new Error('polygon_rpc_dns_unavailable');
  const addresses = resolved.map((entry) => {
    const address = typeof entry === 'string' ? entry : entry.address;
    const family = typeof address === 'string' ? isIP(address) : 0;
    if (family === 0 || (localHttp
      ? address !== '127.0.0.1' && address !== '::1'
      : isPrivatePaymentHost(address))) {
      throw new Error('polygon_rpc_private_address');
    }
    return { address, family };
  });
  if (fetchImpl !== globalThis.fetch) return fetchImpl(url.toString(), init);

  return new Promise((resolveResponse, reject) => {
    const request = (url.protocol === 'https:' ? https : http).request(url, {
      method: 'POST',
      headers: init.headers,
      signal: init.signal,
      agent: false,
      lookup(_hostname, options, callback) {
        // No second DNS resolution: even a rebinding hostname connects only to a checked address.
        if (options?.all) callback(null, addresses);
        else callback(null, addresses[0].address, addresses[0].family);
      },
    }, (response) => {
      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.destroy();
        reject(new Error('polygon_rpc_http_error'));
        return;
      }
      resolveResponse(new Response(response.statusCode === 204 || response.statusCode === 205
        ? null : Readable.toWeb(response), { status: response.statusCode }));
    });
    request.on('error', reject);
    request.end(init.body);
  });
}
