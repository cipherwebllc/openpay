import { isIP } from 'node:net';

export const DEFAULT_PAYMENT_FETCH_TIMEOUT_MS = 15_000;

function normalizeHost(hostname) {
  return hostname.replace(/^\[|\]$/g, '').replace(/\.+$/, '').toLowerCase();
}

// SSRF boundary shared with the OpenPay server (lib/net/privateHost.ts): private,
// non-unicast, documentation and transition ranges from the IANA special-purpose
// registries (checked 2026-09-23). Translation/tunnel ranges (NAT64, 6to4, Teredo)
// are rejected as a whole even where IANA lists globally reachable exceptions, so a
// DNS answer like 64:ff9b::a9fe:a9fe (NAT64 to 169.254.169.254) or 2002:c0a8:101::
// (6to4 to 192.168.1.1) never carries a signed X-PAYMENT into the buyer's own network.
// Keep both tables identical; tests/packages/x402-sdk-network.test.ts compares them.
const IPV4_CIDRS = [
  ['0.0.0.0', 8], // this network
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.88.99.0', 24], // deprecated 6to4 relay anycast
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved (includes limited broadcast)
];

const IPV6_CIDRS = [
  ['::', 128], // unspecified
  ['::1', 128], // loopback
  ['::ffff:0:0:0', 96], // IPv4-translated (RFC 6145)
  ['64:ff9b::', 96], // NAT64 well-known prefix
  ['64:ff9b:1::', 48], // local-use NAT64
  ['100::', 64], // discard-only
  ['100:0:0:1::', 64], // dummy prefix
  ['2001::', 32], // Teredo
  ['2001:2::', 48], // benchmarking
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4
  ['3fff::', 20], // documentation
  ['5f00::', 16], // segment routing SIDs
  ['fc00::', 7], // ULA
  ['fe80::', 10], // link-local
  ['fec0::', 10], // deprecated site-local
  ['ff00::', 8], // multicast
];

const IPV4_PREFIXES = IPV4_CIDRS.map(([base, bits]) => ({
  groups: base.split('.').map(Number), bits,
}));
const IPV6_PREFIXES = IPV6_CIDRS.map(([base, bits]) => ({
  groups: expandIpv6(base), bits,
}));

// Compare only the bits inside the prefix, including a CIDR that ends mid-group.
function matchesPrefix(address, prefix, groupBits) {
  for (let i = 0; i * groupBits < prefix.bits; i += 1) {
    const shift = Math.max(0, (i + 1) * groupBits - prefix.bits);
    if (address[i] >>> shift !== prefix.groups[i] >>> shift) return false;
  }
  return true;
}

function isPrivateIpv4(octets) {
  return IPV4_PREFIXES.some((prefix) => matchesPrefix(octets, prefix, 8));
}

function expandIpv6(hostname) {
  let value = hostname;
  const embeddedV4 = value.match(
    /^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/,
  );
  if (embeddedV4) {
    const octets = embeddedV4[2].split('.').map(Number);
    if (octets.some((octet) => octet > 255)) return null;
    value = `${embeddedV4[1]}${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  const halves = value.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail =
    halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : null;
  let groups;
  if (tail === null) {
    groups = head;
  } else {
    const fill = 8 - head.length - tail.length;
    // `::` must stand for at least one zero group (same rule as the server).
    if (fill < 1) return null;
    groups = [...head, ...Array(fill).fill('0'), ...tail];
  }
  if (groups.length !== 8) return null;
  const numbers = groups.map((group) =>
    /^[0-9a-f]{1,4}$/i.test(group) ? parseInt(group, 16) : -1,
  );
  return numbers.some((number) => number < 0) ? null : numbers;
}

export function isPrivatePaymentHost(hostname) {
  const host = normalizeHost(hostname);
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  ) {
    return true;
  }

  if (host.includes(':')) {
    const groups = expandIpv6(host);
    if (groups === null) return true;
    if (IPV6_PREFIXES.some((prefix) => matchesPrefix(groups, prefix, 16))) return true;
    // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d) literals are the
    // socket's IPv4 form; judge them by the full IPv4 table.
    if (
      groups.slice(0, 5).every((group) => group === 0) &&
      (groups[5] === 0xffff || groups[5] === 0)
    ) {
      return isPrivateIpv4([
        (groups[6] >> 8) & 0xff, groups[6] & 0xff,
        (groups[7] >> 8) & 0xff, groups[7] & 0xff,
      ]);
    }
    return false;
  }

  const ipv4 = host.match(
    /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/,
  );
  if (!ipv4) return false;
  const octets = ipv4.slice(1).map(Number);
  if (octets.some((octet) => octet > 255)) return true;
  return isPrivateIpv4(octets);
}

export function parseSafePaymentUrl(raw) {
  if (typeof raw !== 'string') return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  if (parsed.username !== '' || parsed.password !== '') return null;
  if (isPrivatePaymentHost(parsed.hostname)) return null;
  return parsed;
}

async function defaultLookup(hostname) {
  const dns = await import('node:dns/promises');
  return dns.lookup(normalizeHost(hostname), { all: true, verbatim: true });
}

function normalizedAddresses(addresses) {
  if (!Array.isArray(addresses) || addresses.length === 0) {
    throw new Error('payment_target_dns_unavailable');
  }
  return addresses.map((entry) => {
    const address = typeof entry === 'string' ? entry : entry?.address;
    const family =
      typeof entry === 'object' && entry !== null && entry.family !== undefined
        ? Number(entry.family)
        : isIP(address);
    if (
      typeof address !== 'string' ||
      (family !== 4 && family !== 6) ||
      isPrivatePaymentHost(address)
    ) {
      throw new Error('payment_target_private_address');
    }
    return { address, family };
  });
}

function lookupWithSignal(lookup, hostname, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    lookup(normalizeHost(hostname)).then(
      (addresses) => {
        signal.removeEventListener('abort', abort);
        resolve(addresses);
      },
      (error) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}

function safeConnectLookup(lookup, signal) {
  return (hostname, options, callback) => {
    lookupWithSignal(lookup, hostname, signal)
      .then(normalizedAddresses)
      .then((addresses) => {
        if (options?.all) {
          callback(null, addresses);
          return;
        }
        callback(null, addresses[0].address, addresses[0].family);
      })
      .catch((error) => callback(error));
  };
}

async function nodeFetchWithSafeLookup(parsed, init, lookup) {
  const transport =
    parsed.protocol === 'https:'
      ? await import('node:https')
      : await import('node:http');
  const { Readable } = await import('node:stream');
  return new Promise((resolve, reject) => {
    const request = transport.request(
      parsed,
      {
        agent: false,
        headers: init.headers,
        lookup: safeConnectLookup(lookup, init.signal),
        method: 'GET',
        signal: init.signal,
      },
      (response) => {
        try {
          const headers = new Headers();
          for (let index = 0; index < response.rawHeaders.length; index += 2) {
            headers.append(
              response.rawHeaders[index],
              response.rawHeaders[index + 1],
            );
          }
          const status = response.statusCode;
          if (!Number.isInteger(status) || status < 200 || status > 599) {
            response.destroy();
            reject(new Error(`unsupported payment response status: ${status}`));
            return;
          }
          const body =
            status === 204 || status === 205 || status === 304
              ? null
              : Readable.toWeb(response);
          resolve(
            new Response(body, {
              status,
              statusText: response.statusMessage,
              headers,
            }),
          );
        } catch (error) {
          response.destroy();
          reject(error);
        }
      },
    );
    request.on('error', reject);
    request.end();
  });
}

export async function fetchPaymentTarget(
  rawUrl,
  {
    fetchImpl = globalThis.fetch,
    headers,
    lookup,
    timeoutMs = DEFAULT_PAYMENT_FETCH_TIMEOUT_MS,
  } = {},
) {
  const parsed = parseSafePaymentUrl(rawUrl);
  if (parsed === null) throw new Error('payment_target_not_allowed');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error('payment fetch timeout must be a positive integer');
  }

  const resolver = lookup ?? defaultLookup;
  const useSafeNodeTransport = fetchImpl === globalThis.fetch;
  const signal = AbortSignal.timeout(timeoutMs);
  if (useSafeNodeTransport || lookup !== undefined) {
    normalizedAddresses(
      await lookupWithSignal(resolver, parsed.hostname, signal),
    );
  } else {
    // A custom fetchImpl used to skip pre-resolution entirely, so a public hostname pointing at
    // 169.254.169.254 or another private target reached the injected transport unchecked. Resolve
    // with the default resolver and reject a proven-private target before the transport runs.
    // A resolver failure is not itself proof of a private target and the custom transport resolves
    // independently, so it does not block here; connection-time rebinding protection still
    // requires supplying `lookup` (documented in the README).
    let addresses = null;
    try {
      addresses = await lookupWithSignal(resolver, parsed.hostname, signal);
    } catch (error) {
      // An aborted pre-resolution is the caller's timeout, not a DNS verdict; continuing would
      // hand the transport a dead signal.
      if (signal.aborted) throw error;
      addresses = null;
    }
    if (Array.isArray(addresses) && addresses.length > 0) {
      normalizedAddresses(addresses);
    }
  }

  const init = {
    headers,
    redirect: 'manual',
    signal,
  };
  if (useSafeNodeTransport) {
    return nodeFetchWithSafeLookup(parsed, init, resolver);
  }
  return fetchImpl(parsed.toString(), init);
}
