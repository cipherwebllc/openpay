// hostname / IP literal の SSRF 判定だけを持つ pure utility。DNS や Node 専用 module は import せず、
// 保存入口・接続 sink の双方から同じ literal 判定を利用できるようにする。

// IPv4 の先頭 2 octet で private/loopback/link-local/CGNAT/this-host を判定する。
function isPrivateIpv4(a: number, b: number): boolean {
  if (a === 0 || a === 127 || a === 10) return true;
  if (a === 169 && b === 254) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

// IPv6 literal を 8 group (各 16bit) に展開する。末尾の埋め込み IPv4 も 2 group の hex にする。
function expandIpv6(hostname: string): number[] | null {
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
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : null;
  let groups: string[];
  if (tail === null) {
    groups = head;
  } else {
    const fill = 8 - head.length - tail.length;
    if (fill < 0) return null;
    groups = [...head, ...Array<string>(fill).fill('0'), ...tail];
  }
  if (groups.length !== 8) return null;
  const numbers = groups.map((group) =>
    /^[0-9a-f]{1,4}$/.test(group) ? parseInt(group, 16) : -1,
  );
  return numbers.some((number) => number < 0) ? null : numbers;
}

// URL.hostname の IPv6 brackets と FQDN root label を判定前に統一する。
export function normalizeHost(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, '').replace(/\.+$/, '');
}

// hostname / IP literal が private / loopback / link-local / CGNAT / ULA なら true。
export function isPrivateHost(hostname: string): boolean {
  const host = normalizeHost(hostname.toLowerCase());
  if (
    host === 'localhost' ||
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
    return false;
  }

  const ipv4 = host.match(
    /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/,
  );
  if (ipv4) return isPrivateIpv4(Number(ipv4[1]), Number(ipv4[2]));
  return false;
}
