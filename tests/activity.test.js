import test from 'node:test';
import assert from 'node:assert/strict';
import {environment} from './helpers.js';
import {handle,ACTIVITY_FRAME_ANCESTORS} from '../server/worker.js';
import {one} from '../server/store.js';

const APP='123456789012345678',ACTIVITY=`https://${APP}.discordsays.com`;
function discordFetch(calls=[]){
  return async(url,options)=>{
    calls.push({url,body:options?.body?String(options.body):null});
    if(String(url).endsWith('/oauth2/token'))return new Response(JSON.stringify({access_token:'fixture-access'}),{headers:{'Content-Type':'application/json'}});
    if(String(url).endsWith('/users/@me'))return new Response(JSON.stringify({id:'223344556677889900',username:'player',global_name:'Player One',avatar:null}),{headers:{'Content-Type':'application/json'}});
    throw new Error(`unexpected fetch ${url}`);
  };
}
function setup(t,overrides={}){
  const env=environment({DISCORD_APPLICATION_ID:APP,DISCORD_CLIENT_SECRET:'fixture-secret',...overrides});t.after(()=>env.DB.close());return env;
}
const post=(env,path,{origin=ACTIVITY,body,headers={}}={})=>handle(new Request(env.PUBLIC_ORIGIN+path,{method:'POST',headers:{origin,'Content-Type':'application/json',...headers},body:JSON.stringify(body??{})}),env);
const get=(env,path,headers={})=>handle(new Request(env.PUBLIC_ORIGIN+path,{headers}),env);

test('activity config exposes only the public client id and needs Discord configured',async t=>{
  const env=setup(t),r=await get(env,'/api/activity/config');assert.equal(r.status,200);assert.deepEqual(await r.json(),{clientId:APP});
  const bare=setup(t,{DISCORD_APPLICATION_ID:undefined,DISCORD_CLIENT_SECRET:undefined});assert.equal((await get(bare,'/api/activity/config')).status,503);
});
test('an SDK code becomes a bearer session: exchanged without a redirect uri, token is not stored in clear',async t=>{
  const calls=[],env=setup(t,{FETCH:discordFetch(calls)});
  const r=await post(env,'/api/activity/session',{body:{code:'sdk-code'}});assert.equal(r.status,200);
  const s=await r.json();assert.match(s.token,/^[a-f0-9]{64}$/);assert.match(s.csrf,/^[a-f0-9]{64}$/);assert.equal(s.accessToken,'fixture-access');assert.equal(s.user.displayName,'Player One');
  const exchange=new URLSearchParams(calls[0].body);assert.equal(exchange.get('grant_type'),'authorization_code');assert.equal(exchange.get('code'),'sdk-code');assert.equal(exchange.has('redirect_uri'),false);
  assert.equal(r.headers.get('set-cookie'),null,'no cookie is set inside an Activity');
  assert.equal(await one(env,'SELECT 1 AS x FROM sessions WHERE token_hash=?',s.token),null,'the raw token must not be stored');
});
test('the bearer session works for reads and for mutations from the activity origin',async t=>{
  const env=setup(t,{FETCH:discordFetch()}),s=await (await post(env,'/api/activity/session',{body:{code:'c'}})).json();
  const me=await (await get(env,'/api/me',{authorization:`Bearer ${s.token}`})).json();assert.equal(me.user.displayName,'Player One');assert.equal(me.csrf,s.csrf);
  const out=await post(env,'/api/logout',{headers:{authorization:`Bearer ${s.token}`,'x-csrf-token':s.csrf}});assert.equal(out.status,200);
  assert.equal((await get(env,'/api/me',{authorization:`Bearer ${s.token}`})).status,200,'logout removed the session, so /api/me starts a fresh anonymous one');
  assert.equal((await (await get(env,'/api/me',{authorization:`Bearer ${s.token}`})).json()).user,null);
});
test('the activity origin is accepted only together with a bearer session',async t=>{
  const env=setup(t,{FETCH:discordFetch()}),s=await (await post(env,'/api/activity/session',{body:{code:'c'}})).json();
  const cookieOnly=await handle(new Request(env.PUBLIC_ORIGIN+'/api/me'),env),cookie=cookieOnly.headers.get('set-cookie').split(';')[0],me=await cookieOnly.json();
  const viaCookie=await post(env,'/api/logout',{headers:{cookie,'x-csrf-token':me.csrf}});assert.equal(viaCookie.status,403,'cookie session must not be usable from the discordsays origin');
  const foreign=await post(env,'/api/logout',{origin:'https://evil.example',headers:{authorization:`Bearer ${s.token}`,'x-csrf-token':s.csrf}});assert.equal(foreign.status,403);
  const otherApp=await post(env,'/api/logout',{origin:'https://999999999999999999.discordsays.com',headers:{authorization:`Bearer ${s.token}`,'x-csrf-token':s.csrf}});assert.equal(otherApp.status,403,'another application\'s discordsays origin is not ours');
  const noCsrf=await post(env,'/api/logout',{headers:{authorization:`Bearer ${s.token}`}});assert.equal(noCsrf.status,403);
});
test('session creation rejects foreign origins, missing codes, malformed bearer tokens and Discord failures',async t=>{
  const env=setup(t,{FETCH:discordFetch()});
  assert.equal((await post(env,'/api/activity/session',{origin:'https://evil.example',body:{code:'c'}})).status,403);
  assert.equal((await post(env,'/api/activity/session',{body:{}})).status,400);
  assert.equal((await post(env,'/api/activity/session',{body:{code:'x'.repeat(3000)}})).status,400);
  const noOrigin=await handle(new Request(env.PUBLIC_ORIGIN+'/api/activity/session',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"code":"c"}'}),env);assert.equal(noOrigin.status,403);
  const badToken=await get(env,'/api/me',{authorization:'Bearer nothex'});assert.equal(badToken.status,200,'a malformed bearer is ignored and a fresh anonymous session is created');
  const failing=setup(t,{FETCH:async()=>new Response('no',{status:400})});assert.equal((await post(failing,'/api/activity/session',{body:{code:'c'}})).status,502);
});
test('only a page loaded with frame_id may be framed, and only by Discord',async t=>{
  const env=setup(t),plain=await get(env,'/'),framed=await get(env,'/?frame_id=1&instance_id=2&platform=desktop');
  assert.equal(plain.headers.get('x-frame-options'),'DENY');assert.match(plain.headers.get('content-security-policy'),/frame-ancestors 'none'/);
  assert.equal(framed.headers.get('x-frame-options'),null);const csp=framed.headers.get('content-security-policy');assert.ok(csp.includes(ACTIVITY_FRAME_ANCESTORS));assert.ok(!csp.includes("frame-ancestors 'none'"));
  assert.match(csp,/script-src 'self'/,'the rest of the policy is unchanged');assert.match(csp,/connect-src 'self'/);
  const api=await get(env,'/api/me?frame_id=1');assert.equal(api.headers.get('x-frame-options'),'DENY','API responses are never frameable');
});
