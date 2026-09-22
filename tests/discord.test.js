import test from 'node:test';import assert from 'node:assert/strict';
import {environment,browser,loginFixture} from './helpers.js';
import {one,run} from '../server/store.js';
import {sha256,randomToken} from '../server/util.js';
import {handle} from '../server/worker.js';
import {verifyInteraction} from '../server/discord.js';

async function signing(){const keys=await crypto.subtle.generateKey({name:'Ed25519'},true,['sign','verify']);const publicKey=Buffer.from(await crypto.subtle.exportKey('raw',keys.publicKey)).toString('hex');return {keys,publicKey};}
async function signed(env,payload,keys,timestamp=String(Math.floor(Date.now()/1000))){const text=JSON.stringify(payload),sig=await crypto.subtle.sign('Ed25519',keys.privateKey,new TextEncoder().encode(timestamp+text));return new Request(env.PUBLIC_ORIGIN+'/api/discord/interactions',{method:'POST',headers:{'x-signature-ed25519':Buffer.from(sig).toString('hex'),'x-signature-timestamp':timestamp,'content-type':'application/json'},body:text});}

test('native Ed25519 verifies exact body and timestamp, rejects modification',async()=>{
  const{keys,publicKey}=await signing(),env=environment();const request=await signed(env,{type:1},keys);const bytes=new TextEncoder().encode(JSON.stringify({type:1}));assert.equal(await verifyInteraction(request,publicKey,bytes),true);assert.equal(await verifyInteraction(request,publicKey,new TextEncoder().encode('{"type":2}')),false);env.DB.close();
});
test('Discord ping and guild command are verified, personal launches are one-time',async t=>{
  const{keys,publicKey}=await signing(),env=environment({DISCORD_PUBLIC_KEY:publicKey,DISCORD_APPLICATION_ID:'123456789'});t.after(()=>env.DB.close());
  const ping=await handle(await signed(env,{type:1},keys),env);assert.deepEqual(await ping.json(),{type:1});
  const payload={type:2,application_id:'123456789',id:'987654321',guild_id:'777777777',channel_id:'666666666',member:{user:{id:'555555555'}},data:{name:'play',options:[{type:1,name:'tic-tac-toe'}]}};
  const response=await handle(await signed(env,payload,keys),env),data=await response.json();assert.equal(response.status,200);assert.equal(data.data.flags,64);assert.match(data.data.content,/launch=[a-f0-9]{64}/);
  const duplicate=await handle(await signed(env,payload,keys),env);assert.match((await duplicate.json()).data.content,/already issued/);
});
test('stale signatures and non-guild launch contexts reject',async t=>{
  const{keys,publicKey}=await signing(),env=environment({DISCORD_PUBLIC_KEY:publicKey,DISCORD_APPLICATION_ID:'123456789'});t.after(()=>env.DB.close());
  assert.equal((await handle(await signed(env,{type:1},keys,String(Math.floor(Date.now()/1000)-1000)),env)).status,401);
  const payload={type:2,application_id:'123456789',id:'987654322',data:{name:'play',options:[{type:1,name:'tic-tac-toe'}]},user:{id:'555555555'}};assert.equal((await handle(await signed(env,payload,keys),env)).status,403);
});
test('launch grants bind to Discord identity and survive idempotent same-session redemption',async t=>{
  const env=environment();t.after(()=>env.DB.close());const a=await browser(env),b=await browser(env),identity=await loginFixture(a),other=await loginFixture(b),token=randomToken(),hash=await sha256(token),at=Date.now();
  await run(env,'INSERT INTO launches(token_hash,interaction_id,discord_id,guild_id,channel_id,issued_at,redeem_expires,context_expires) VALUES(?,?,?,?,?,?,?,?)',hash,'1234512345',identity.discordId,'222222222','333333333',at,at+300000,at+900000);
  await run(env,'UPDATE sessions SET pending_launch=? WHERE token_hash IN (?,?)',hash,identity.sessionHash,other.sessionHash);
  assert.equal((await b.request('/api/context/redeem',{method:'POST'})).status,403);
  const result=await a.request('/api/context/redeem',{method:'POST'});assert.equal(result.status,200);assert.equal(result.data.context.channelId,'333333333');assert.equal((await one(env,'SELECT redeemed_session FROM launches WHERE token_hash=?',hash)).redeemed_session,identity.sessionHash);
  assert.equal((await a.request('/api/leaderboard?scope=channel')).status,200);
});
test('OAuth flow uses identify only, rotates session, and consumes state',async t=>{
  const env=environment({DISCORD_APPLICATION_ID:'123456789',DISCORD_CLIENT_SECRET:'fixture-secret'});t.after(()=>env.DB.close());const client=await browser(env),oldCookie=client.cookie;
  let exchanged=false;env.FETCH=async(url,options)=>{
    if(url.endsWith('/oauth2/token')){exchanged=true;assert.ok(String(options.body).includes('grant_type=authorization_code'));return new Response(JSON.stringify({access_token:'fixture-token'}));}
    assert.equal(options.headers.Authorization,'Bearer fixture-token');return new Response(JSON.stringify({id:'555555555',username:'Player',global_name:'<script>alert(1)</script>'}));
  };
  const begin=await client.request('/api/auth/discord'),url=new URL(begin.headers.get('location'));assert.equal(url.searchParams.get('scope'),'identify');const state=url.searchParams.get('state');assert.equal(state.length,64);
  const callback=await client.request(`/api/auth/discord/callback?state=${state}&code=fixture-code`);assert.equal(callback.status,303);assert.ok(exchanged);const nextCookie=callback.headers.get('set-cookie').split(';')[0];assert.notEqual(nextCookie,oldCookie);assert.equal((await client.request('/api/history')).status,401);
  const logged=await handle(new Request(env.PUBLIC_ORIGIN+'/api/me',{headers:{cookie:nextCookie}}),env),me=await logged.json();assert.equal(me.user.displayName,'<script>alert(1)</script>');assert.ok(!JSON.stringify(me).includes('fixture-token'));
  const reused=await handle(new Request(env.PUBLIC_ORIGIN+`/api/auth/discord/callback?state=${state}&code=fixture-code`,{headers:{cookie:nextCookie}}),env);assert.equal(reused.status,403);
});
test('OAuth mismatched state never exchanges an authorization code',async t=>{
  let calls=0;const env=environment({DISCORD_APPLICATION_ID:'123456789',DISCORD_CLIENT_SECRET:'fixture',FETCH:async()=>{calls++;throw new Error();}});t.after(()=>env.DB.close());const client=await browser(env);await client.request('/api/auth/discord');const callback=await client.request(`/api/auth/discord/callback?state=${'a'.repeat(64)}&code=code`);assert.equal(callback.status,403);assert.equal(calls,0);
});
