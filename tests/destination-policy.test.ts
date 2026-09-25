import { describe, expect, it } from 'vitest';
import { resolveDestination, type Resolver } from '../apps/worker/src/destination-policy.js';

/** Builds a fake DNS resolver that always returns the given IPv4 addresses. */
function resolvesTo(...addresses: string[]): Resolver {
  return () => Promise.resolve(addresses.map((address) => ({ address, family: 4 })));
}

describe('resolveDestination', () => {
  it.each([
    'http://example.com', // plain HTTP
    'https://user:pass@example.com', // embedded credentials
    'https://127.0.0.1', // loopback
    'https://169.254.169.254', // cloud metadata (link-local)
    'https://[::1]', // IPv6 loopback
    'https://[::ffff:127.0.0.1]', // IPv4-mapped IPv6 loopback
    'https://10.1.2.3', // private
    'https://192.168.1.1', // private
    'https://0x7f000001', // hexadecimal loopback
    'https://example.com/#fragment',
  ])('rejects unsafe destination %s', async (url) => {
    await expect(resolveDestination(url, resolvesTo('127.0.0.1'))).rejects.toThrow();
  });

  it('rejects a hostname when any DNS answer is private', async () => {
    await expect(
      resolveDestination('https://example.com', resolvesTo('8.8.8.8', '127.0.0.1')),
    ).rejects.toThrow();
  });

  it('pins a public address and keeps the original hostname', async () => {
    const destination = await resolveDestination('https://example.com/hook', resolvesTo('8.8.8.8'));

    expect(destination).toMatchObject({ address: '8.8.8.8', hostname: 'example.com', family: 4 });
  });

  it('allows only the exact configured local demo origin', async () => {
    const demoOrigin = 'http://localhost:4000';

    await expect(
      resolveDestination('http://localhost:4000/hook', resolvesTo('127.0.0.1'), demoOrigin),
    ).resolves.toMatchObject({ address: '127.0.0.1' });

    await expect(
      resolveDestination('http://localhost:4001/hook', resolvesTo('127.0.0.1'), demoOrigin),
    ).rejects.toThrow();
  });
});
