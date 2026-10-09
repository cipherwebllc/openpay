import { describe, expect, it } from 'vitest';
import { isPrivateHost } from '@/lib/net/privateHost';
import {
  LOCAL_OR_MALFORMED_HOSTS, PRIVATE_IPV4_RANGES, PRIVATE_IPV6_RANGES, PUBLIC_IPV4_HOSTS,
  PUBLIC_IPV6_AND_NAMES, TRANSLATED_PRIVATE_HOSTS, mappedIpv6Forms,
} from './privateHostCases';

describe('isPrivateHost special-purpose ranges', () => {
  it.each(PRIVATE_IPV4_RANGES)('blocks both ends of %s, including mapped IPv6', (_cidr, first, last) => {
    for (const ip of [first, last]) {
      for (const host of [ip, `${ip}.`, ...mappedIpv6Forms(ip)]) {
        expect(isPrivateHost(host), host).toBe(true);
      }
    }
  });

  it.each(PRIVATE_IPV6_RANGES)('blocks both ends of %s, compressed/expanded/bracketed', (_cidr, first, last) => {
    for (const host of [first, last, `[${first}]`, `[${last.toUpperCase()}]`]) {
      expect(isPrivateHost(host), host).toBe(true);
    }
  });

  it.each(TRANSLATED_PRIVATE_HOSTS)('blocks translated/tunnel ranges and embedded special-purpose IPv4: %s', (host) => {
    expect(isPrivateHost(host)).toBe(true);
  });

  it.each(PUBLIC_IPV4_HOSTS)('keeps public IPv4 outside the ranges allowed, including mapped form: %s', (host) => {
    expect(isPrivateHost(host)).toBe(false);
    expect(isPrivateHost(`::ffff:${host}`)).toBe(false);
  });

  it.each(PUBLIC_IPV6_AND_NAMES)('keeps public IPv6 and DNS names allowed: %s', (host) => {
    expect(isPrivateHost(host)).toBe(false);
  });

  it.each(LOCAL_OR_MALFORMED_HOSTS)('blocks local names and malformed IPv6: %s', (host) => {
    expect(isPrivateHost(host)).toBe(true);
  });
});
