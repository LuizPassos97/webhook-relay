import { createServer } from 'node:http';
import { once } from 'node:events';
import { afterAll,beforeAll,it,expect } from 'vitest';
import { sendWebhook } from '../apps/worker/src/http-transport.js';
import { verify } from '../packages/core/src/signatures.js';
const server=createServer(async(req,res)=>{
  const chunks:Buffer[]=[]; for await(const chunk of req) chunks.push(Buffer.from(chunk));
  if(req.url==='/slow') return;
  if(req.url==='/redirect'){res.writeHead(302,{location:'/signed'});res.end();return;}
  if(req.url==='/large'){res.end('x'.repeat(10000));return;}
  const valid=verify(Buffer.concat(chunks),Number(req.headers['x-webhook-timestamp']),String(req.headers['x-webhook-signature']),'test-secret',Math.floor(Date.now()/1000));
  res.writeHead(valid?200:401);res.end('accepted');
});
let origin:string;
beforeAll(async()=>{server.listen(0,'127.0.0.1');await once(server,'listening');const addr=server.address();if(!addr||typeof addr==='string')throw Error();origin=`http://127.0.0.1:${addr.port}`;});
afterAll(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});
const send=(path:string,timeoutMs=500)=>sendWebhook({url:origin+path,demoOrigin:origin,body:'{"id":"event"}',secret:'test-secret',eventId:'event',deliveryId:'delivery',timeoutMs});
it('delivers signed exact bytes',async()=>expect(await send('/signed')).toMatchObject({kind:'response',status:200,excerpt:'accepted'}));
it('does not follow redirects',async()=>expect(await send('/redirect')).toMatchObject({status:302}));
it('bounds response capture',async()=>expect((await send('/large')).excerpt?.length).toBe(2048));
it('enforces a total deadline',async()=>expect(await send('/slow',50)).toMatchObject({kind:'timeout'}));

it('connects to the validated IP without a second DNS lookup',async()=>{
  const fakeOrigin=origin.replace('127.0.0.1','receiver.test');let calls=0;
  const result=await sendWebhook({url:fakeOrigin+'/signed',demoOrigin:fakeOrigin,body:'{}',secret:'test-secret',eventId:'event',deliveryId:'delivery',timeoutMs:500,
    resolver:async()=>{calls++;return [{address:calls===1?'127.0.0.1':'192.0.2.10',family:4}];}});
  expect(result.status).toBe(200);expect(calls).toBe(1);
});
