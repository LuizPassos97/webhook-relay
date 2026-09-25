import { expect,it } from 'vitest';
import { resolveDestination } from '../apps/worker/src/destination-policy.js';
it.each(['http://example.com','https://user:pass@example.com','https://127.0.0.1','https://169.254.169.254','https://[::1]','https://[::ffff:127.0.0.1]','https://10.1.2.3','https://192.168.1.1','https://0x7f000001','https://example.com/#fragment'])('rejects unsafe destination %s',async url=>{
  await expect(resolveDestination(url,async()=>[{address:'127.0.0.1',family:4}])).rejects.toThrow();
});
it('rejects mixed DNS answers and preserves the hostname with a public pinned address',async()=>{
  await expect(resolveDestination('https://example.com',async()=>[{address:'8.8.8.8',family:4},{address:'127.0.0.1',family:4}])).rejects.toThrow();
  expect(await resolveDestination('https://example.com/hook',async()=>[{address:'8.8.8.8',family:4}])).toMatchObject({address:'8.8.8.8',hostname:'example.com',family:4});
});
it('allows only the exact operator-configured local demo origin',async()=>{
  expect(await resolveDestination('http://localhost:4000/hook',async()=>[{address:'127.0.0.1',family:4}],'http://localhost:4000')).toMatchObject({address:'127.0.0.1'});
  await expect(resolveDestination('http://localhost:4001/hook',async()=>[{address:'127.0.0.1',family:4}],'http://localhost:4000')).rejects.toThrow();
});
