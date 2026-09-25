import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { sign } from '../../../packages/core/src/signatures.js';
import { resolveDestination, type Resolver } from './destination-policy.js';
export interface SendInput { url: string; body: string; secret: string; eventId: string; deliveryId: string; timeoutMs: number; demoOrigin?: string; resolver?: Resolver }
export interface AttemptOutcome { kind: 'response' | 'network' | 'timeout' | 'rejected'; status?: number; durationMs: number; excerpt?: string }
export async function sendWebhook(input: SendInput): Promise<AttemptOutcome> {
  const started = performance.now(), controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const duration = () => Math.round(performance.now()-started);
  const deadline = new Promise<AttemptOutcome>(resolve => {
    timer = setTimeout(() => { controller.abort(); resolve({kind:'timeout',durationMs:duration()}); }, input.timeoutMs);
  });
  const perform = async (): Promise<AttemptOutcome> => {
    let destination;
    try { destination = await resolveDestination(input.url,input.resolver,input.demoOrigin); }
    catch { return {kind:'rejected',durationMs:duration()}; }
    if(controller.signal.aborted) return {kind:'timeout',durationMs:duration()};
    const timestamp = Math.floor(Date.now()/1000), body = Buffer.from(input.body);
    return new Promise(resolve => {
      const request = destination.url.protocol === 'https:' ? httpsRequest : httpRequest;
      const req = request(destination.url, {
        method:'POST', signal:controller.signal, agent:false, family:destination.family,
        lookup: (_host,_options,callback) => callback(null,destination.address,destination.family),
        headers:{'content-type':'application/json','content-length':body.length,
          'x-webhook-id':input.eventId,'x-webhook-delivery-id':input.deliveryId,
          'x-webhook-timestamp':String(timestamp),'x-webhook-signature':sign(body,timestamp,input.secret)},
      }, response => {
        const chunks:Buffer[]=[]; let captured=0;
        const finish=() => {
          const excerpt=Array.from(Buffer.concat(chunks).toString('utf8')).filter(char=>char.charCodeAt(0)>=32 || char==='\n').join('').replaceAll(input.secret,'[redacted]');
          resolve({kind:'response',status:response.statusCode,durationMs:duration(),excerpt});
        };
        response.on('data',(chunk:Buffer)=>{
          const take=chunk.subarray(0,Math.max(0,2048-captured));chunks.push(take);captured+=take.length;
          if(captured>=2048){finish();response.destroy();}
        });
        response.on('end',finish);
        response.on('error',()=>resolve({kind:'network',durationMs:duration()}));
      });
      req.on('error',()=>resolve({kind:controller.signal.aborted?'timeout':'network',durationMs:duration()}));
      req.end(body);
    });
  };
  try { return await Promise.race([perform(),deadline]); }
  finally { clearTimeout(timer!); }
}
