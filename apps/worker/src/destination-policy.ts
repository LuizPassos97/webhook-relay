import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';
export interface Address { address: string; family: number }
export type Resolver = (hostname: string) => Promise<Address[]>;
export interface PinnedDestination { url: URL; hostname: string; address: string; family: number }
export const systemResolver: Resolver = hostname => lookup(hostname, { all: true, verbatim: true });
export async function resolveDestination(raw: string, resolver: Resolver = systemResolver, demoOrigin?: string): Promise<PinnedDestination> {
  const url = new URL(raw), hostname = url.hostname.replace(/^\[|\]$/g,'');
  const isDemo = demoOrigin !== undefined && url.origin === demoOrigin;
  if (url.username || url.password || url.hash || (url.protocol !== 'https:' && !(isDemo && url.protocol === 'http:'))) throw new Error('Destination rejected');
  const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await resolver(hostname);
  if (!addresses.length || addresses.some(entry => !ipaddr.isValid(entry.address))) throw new Error('Destination resolution failed');
  if (!isDemo && addresses.some(entry => ipaddr.process(entry.address).range() !== 'unicast')) throw new Error('Non-public destination rejected');
  const address = addresses[0]!;
  return { url, hostname, ...address };
}
