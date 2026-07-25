import { isIP } from 'node:net';

export const DEFAULT_PAYMENT_FETCH_TIMEOUT_MS = 15_000;

function normalizeHost(hostname) {
  return hostname.replace(/^\[|\]$/g, '').replace(/\.+$/, '').toLowerCase();
}

function isPrivateIpv4(a, b) {
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return a >= 224;
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
    if (fill < 0) return null;
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
    if (groups.every((group) => group === 0)) return true;
    if (
      groups.slice(0, 7).every((group) => group === 0) &&
      groups[7] === 1
    ) {
      return true;
    }
    if (
      groups.slice(0, 5).every((group) => group === 0) &&
      (groups[5] === 0xffff || groups[5] === 0)
    ) {
      return isPrivateIpv4(
        (groups[6] >> 8) & 0xff,
        groups[6] & 0xff,
      );
    }
    if (groups[0] >= 0xfc00 && groups[0] <= 0xfdff) return true;
    if (groups[0] >= 0xfe80 && groups[0] <= 0xfebf) return true;
    return groups[0] >= 0xff00;
  }

  const ipv4 = host.match(
    /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/,
  );
  if (!ipv4) return false;
  const octets = ipv4.slice(1).map(Number);
  if (octets.some((octet) => octet > 255)) return true;
  return isPrivateIpv4(octets[0], octets[1]);
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
