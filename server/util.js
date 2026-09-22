export class HttpError extends Error { constructor(status,code,detail=undefined){super(code);this.status=status;this.code=code;this.detail=detail;} }
export function assert(condition,status,code,detail) {if (!condition) throw new HttpError(status,code,detail);}
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value==='object') return `{${Object.keys(value).sort().filter(k=>value[k]!==undefined).map(k=>`${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
export async function sha256(value) {return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(typeof value==='string'?value:canonical(value))))].map(x=>x.toString(16).padStart(2,'0')).join('');}
export function randomToken(bytes=32) {return [...crypto.getRandomValues(new Uint8Array(bytes))].map(x=>x.toString(16).padStart(2,'0')).join('');}
export const now=()=>Date.now();
export function safeEqual(a,b) {if(typeof a!=='string'||typeof b!=='string')return false;let d=a.length^b.length;for(let i=0;i<Math.max(a.length,b.length);i++)d|=(a.charCodeAt(i)||0)^(b.charCodeAt(i)||0);return d===0;}
export function json(value,status=200,headers={}) {return new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...headers}});}
export async function readJson(request,max=4096) {
  assert(request.headers.get('content-type')?.split(';')[0]==='application/json',415,'json_required');
  const bytes=await readBody(request,max);
  try {const data=JSON.parse(new TextDecoder().decode(bytes));assert(data && typeof data==='object' && !Array.isArray(data),400,'object_required');return data;} catch(e) {if(e instanceof HttpError) throw e;throw new HttpError(400,'invalid_json');}
}
export async function readBody(request,max) {
  const reader=request.body?.getReader(); if (!reader) return new Uint8Array();
  let size=0;const chunks=[];
  while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>max){await reader.cancel();throw new HttpError(413,'body_too_large');}chunks.push(value);}
  const out=new Uint8Array(size);let offset=0;for(const c of chunks){out.set(c,offset);offset+=c.length;}return out;
}
export async function addEvent(doc,type,payload={},causedBy=null) {
  doc.events??=[];
  const event={schemaVersion:1,matchId:doc.id,seq:doc.events.length+1,type,at:new Date().toISOString(),causedBy,payload,previousHash:doc.events.at(-1)?.hash??'0'.repeat(64)};
  event.hash=await sha256(event);doc.events.push(event);return event;
}
export async function verifyEvents(events,matchId) {
  if(!Array.isArray(events)||events.length===0)return {ok:false,reason:'empty_chain'};
  let previous='0'.repeat(64);
  for(let i=0;i<events.length;i++){const{hash,...body}=events[i];if(body.matchId!==matchId || body.seq!==i+1 || body.previousHash!==previous || hash!==await sha256(body))return {ok:false,reason:'event_chain_invalid',seq:i+1};previous=hash;}
  return {ok:true,events:events.length,head:previous};
}
export async function boundedJson(response,max=200000) {
  const bytes=await readBody(response,max);
  return JSON.parse(new TextDecoder().decode(bytes));
}
