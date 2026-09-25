import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';

export interface Address {
  address: string;
  family: number;
}

export type Resolver = (hostname: string) => Promise<Address[]>;

/** A destination whose IP address has been validated and must be used for the connection. */
export interface PinnedDestination {
  url: URL;
  /** Original hostname, kept for the Host header and TLS certificate verification. */
  hostname: string;
  address: string;
  family: number;
}

export const systemResolver: Resolver = (hostname) =>
  lookup(hostname, { all: true, verbatim: true });

/**
 * Validates a webhook URL and resolves it to a single public IP address.
 *
 * Protects against server-side request forgery: private, loopback, link-local and other
 * special-purpose ranges are rejected (including IPv4-mapped IPv6 forms). If any DNS answer
 * is non-public the whole destination is rejected, because the OS could pick any of them.
 * The caller must connect to the returned address instead of resolving the hostname again,
 * otherwise a DNS change between validation and connection could bypass this check.
 *
 * `demoOrigin` is the single local origin allowed in development for the demo receiver.
 */
export async function resolveDestination(
  rawUrl: string,
  resolver: Resolver = systemResolver,
  demoOrigin?: string,
): Promise<PinnedDestination> {
  const url = new URL(rawUrl);
  const isDemo = demoOrigin !== undefined && url.origin === demoOrigin;

  const hasCredentials = url.username !== '' || url.password !== '';
  const allowedProtocol = url.protocol === 'https:' || (isDemo && url.protocol === 'http:');
  if (hasCredentials || url.hash !== '' || !allowedProtocol) {
    throw new Error('Destination rejected');
  }

  // URL keeps brackets around IPv6 literals, e.g. "[::1]".
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) }]
    : await resolver(hostname);

  if (addresses.length === 0 || addresses.some((entry) => !ipaddr.isValid(entry.address))) {
    throw new Error('Destination resolution failed');
  }
  if (!isDemo && addresses.some((entry) => !isPublicAddress(entry.address))) {
    throw new Error('Non-public destination rejected');
  }

  const [pinned] = addresses as [Address, ...Address[]];
  return { url, hostname, address: pinned.address, family: pinned.family };
}

function isPublicAddress(address: string): boolean {
  // `process` converts IPv4-mapped IPv6 addresses to IPv4 so they are classified correctly.
  // ipaddr.js reports ordinary globally routable addresses as the "unicast" range.
  return ipaddr.process(address).range() === 'unicast';
}
