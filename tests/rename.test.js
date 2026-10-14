// Tic-Tac-Toe -> Tic-Tac-Typed. Until the legacy host is 301-redirected, one Worker serves both hostnames, Discord
// accepts both /play subcommands, and matches stored before the rename (gameId 'tic-tac-toe') still verify.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {environment,browser,start,playToEnd} from './helpers.js';
import {handle} from '../server/worker.js';
import {verifyMatch} from '../server/matches.js';
import {PLAY_SUBCOMMANDS} from '../server/discord.js';
import {allowedOrigins,originFor} from '../server/auth.js';
import {GAME_ID,GAME_IDS,game} from '../public/game/rules.js';
import {buildJevRequest} from '../public/game/policy.js';
import {createInitialState} from '../public/game/rules.js';

const NEW='https://tic-tac-typed.jevplay.games',OLD='https://tic-tac-toe.jevplay.games',APP='123456789';
// Production shape: no DEV_LOCAL, so __Host- Secure cookies and the real origin checks are in force.
function hosted(t,overrides={}){
  const env=environment({PUBLIC_ORIGIN:NEW,LEGACY_PUBLIC_ORIGINS:OLD,DEV_LOCAL:undefined,DISCORD_APPLICATION_ID:APP,DISCORD_CLIENT_SECRET:'fixture-secret',...overrides});
  t.after(()=>env.DB.close());return env;
}
async function signing(){const keys=await crypto.subtle.generateKey({name:'Ed25519'},true,['sign','verify']);return {keys,publicKey:Buffer.from(await crypto.subtle.exportKey('raw',keys.publicKey)).toString('hex')};}
async function signed(origin,payload,keys){
  const text=JSON.stringify(payload),timestamp=String(Math.floor(Date.now()/1000)),sig=await crypto.subtle.sign('Ed25519',keys.privateKey,new TextEncoder().encode(timestamp+text));
  return new Request(origin+'/api/discord/interactions',{method:'POST',headers:{'x-signature-ed25519':Buffer.from(sig).toString('hex'),'x-signature-timestamp':timestamp,'content-type':'application/json'},body:text});
}
const command=(id,name)=>({type:2,application_id:APP,id,guild_id:'777777777',channel_id:'666666666',member:{user:{id:'555555555'}},data:{name:'play',options:[{type:1,name}]}});
const cookieOf=r=>r.headers.get('set-cookie').split(';')[0];

test('allowed origins are PUBLIC_ORIGIN plus the legacy host; unknown hosts fall back to PUBLIC_ORIGIN',t=>{
  const env=hosted(t);
  assert.deepEqual(allowedOrigins(env),[NEW,OLD]);
  assert.equal(originFor(new Request(OLD+'/x'),env),OLD);
  assert.equal(originFor(new Request(NEW+'/x'),env),NEW);
  assert.equal(originFor(new Request('https://jev-tic-tac-typed.example.workers.dev/x'),env),NEW);
  assert.deepEqual(allowedOrigins({PUBLIC_ORIGIN:NEW}),[NEW]);
});

test('legacy entries with credentials, a path, query or hash are skipped and never admit the host they hide',t=>{
  const logged=[],error=console.error;console.error=(...a)=>logged.push(a.join(' '));t.after(()=>{console.error=error;});
  const tricks=['https://user:pw@evil.example','https://evil.example#@tic-tac-toe.jevplay.games','https://evil.example/path','https://evil.example?x=1'];
  for(const trick of tricks){
    const env=hosted(t,{LEGACY_PUBLIC_ORIGINS:`${trick},${OLD}`}),allowed=allowedOrigins(env);
    assert.deepEqual(allowed,[NEW,OLD],trick);assert.ok(!allowed.includes('https://evil.example'),trick);
    assert.equal(originFor(new Request('https://evil.example/api/auth/discord'),env),NEW,trick);
    assert.equal(originFor(new Request(OLD+'/x'),env),OLD);assert.equal(originFor(new Request(NEW+'/x'),env),NEW);
    assert.ok(logged.some(l=>l.includes('legacy_origin_ignored')&&l.includes('evil.example')),trick);
  }
  assert.deepEqual(allowedOrigins({PUBLIC_ORIGIN:NEW,LEGACY_PUBLIC_ORIGINS:`${OLD}/`}),[NEW,OLD]);
});

test('a malformed LEGACY_PUBLIC_ORIGINS entry is skipped and logged, never a 500 on moves or sign-in',async t=>{
  const logged=[],error=console.error;console.error=(...a)=>logged.push(a.join(' '));t.after(()=>{console.error=error;});
  const env=hosted(t,{LEGACY_PUBLIC_ORIGINS:`not a url, ${OLD} ,javascript:alert(1)`});
  assert.deepEqual(allowedOrigins(env),[NEW,OLD]);
  assert.ok(logged.some(l=>l.includes('legacy_origin_ignored')&&l.includes('not a url')));
  for(const host of [NEW,OLD]){
    const me=await handle(new Request(host+'/api/me'),env),cookie=cookieOf(me),{csrf}=await me.json();
    const body=JSON.stringify({requestId:crypto.randomUUID(),humanMark:'X',difficulty:'normal',ranked:false});
    const created=await handle(new Request(host+'/api/matches',{method:'POST',headers:{cookie,origin:host,'x-csrf-token':csrf,'content-type':'application/json'},body}),env);
    assert.equal(created.status,201,host);
    const begin=await handle(new Request(host+'/api/auth/discord',{headers:{cookie}}),env);
    assert.equal(begin.status,302);assert.equal(new URL(begin.headers.get('location')).searchParams.get('redirect_uri'),`${host}/api/auth/discord/callback`);
  }
});

test('/play tic-tac-typed and the legacy /play tic-tac-toe both issue a launch on the host Discord called',async t=>{
  const {keys,publicKey}=await signing(),env=hosted(t,{DISCORD_PUBLIC_KEY:publicKey});
  assert.deepEqual(PLAY_SUBCOMMANDS,['tic-tac-typed','tic-tac-toe']);
  for(const [i,[host,name]] of [[NEW,'tic-tac-typed'],[NEW,'tic-tac-toe'],[OLD,'tic-tac-toe'],[OLD,'tic-tac-typed']].entries()){
    const response=await handle(await signed(host,command(`98765432${i}`,name),keys),env),data=await response.json();
    assert.equal(response.status,200,`${host} ${name}`);
    assert.match(data.data.content,/^Play Tic-Tac-Typed against Jev\./);
    assert.ok(data.data.content.includes(`\n${host}/api/auth/discord?launch=`),data.data.content);
  }
  const duplicate=await handle(await signed(NEW,command('987654320','tic-tac-typed'),keys),env);
  assert.match((await duplicate.json()).data.content,/Run \/play tic-tac-typed again/);
  const other=await handle(await signed(NEW,command('987654329','connect-four'),keys),env);assert.equal(other.status,400);
});

test('Discord OAuth completes on both hosts with a redirect_uri on the host the player is on',async t=>{
  for(const host of [NEW,OLD]){
    const exchanges=[],env=hosted(t,{FETCH:async(url,options)=>{
      if(url.endsWith('/oauth2/token')){exchanges.push(new URLSearchParams(String(options.body)));return new Response(JSON.stringify({access_token:'fixture-token'}));}
      return new Response(JSON.stringify({id:'555555555',username:'Player'}));
    }});
    const me=await handle(new Request(host+'/api/me'),env),cookie=cookieOf(me);
    assert.match(cookie,/^__Host-jev_session=/);
    const begin=await handle(new Request(host+'/api/auth/discord',{headers:{cookie}}),env),authorize=new URL(begin.headers.get('location'));
    assert.equal(begin.status,302);assert.equal(authorize.searchParams.get('redirect_uri'),`${host}/api/auth/discord/callback`);
    const callback=await handle(new Request(`${host}/api/auth/discord/callback?state=${authorize.searchParams.get('state')}&code=fixture-code`,{headers:{cookie}}),env);
    assert.equal(callback.status,303,host);assert.equal(exchanges[0].get('redirect_uri'),`${host}/api/auth/discord/callback`);
    const signedIn=await (await handle(new Request(host+'/api/me',{headers:{cookie:cookieOf(callback)}}),env)).json();
    assert.equal(signedIn.user.displayName,'Player');
  }
});

test('mutations accept the Origin of the host they were sent to and reject the other host',async t=>{
  const env=hosted(t);
  for(const [host,other] of [[NEW,OLD],[OLD,NEW]]){
    const me=await handle(new Request(host+'/api/me'),env),cookie=cookieOf(me),{csrf}=await me.json();
    const body=JSON.stringify({requestId:crypto.randomUUID(),humanMark:'X',difficulty:'normal',ranked:false});
    const post=origin=>handle(new Request(host+'/api/matches',{method:'POST',headers:{cookie,origin,'x-csrf-token':csrf,'content-type':'application/json'},body}),env);
    assert.equal((await post(other)).status,403,`${other} on ${host}`);
    assert.equal((await post(host)).status,201,`${host} on ${host}`);
  }
});

test('the Discord Activity session accepts its own host and discordsays.com on both hosts',async t=>{
  const appId='123456789012345678',env=hosted(t,{DISCORD_APPLICATION_ID:appId,FETCH:async url=>new Response(JSON.stringify(url.endsWith('/oauth2/token')?{access_token:'a'}:{id:'223344556677889900',username:'p'}))});
  for(const host of [NEW,OLD])for(const origin of [host,`https://${appId}.discordsays.com`]){
    const r=await handle(new Request(host+'/api/activity/session',{method:'POST',headers:{origin,'content-type':'application/json'},body:'{"code":"c"}'}),env);
    assert.equal(r.status,200,`${origin} on ${host}`);
  }
  const cross=await handle(new Request(OLD+'/api/activity/session',{method:'POST',headers:{origin:NEW,'content-type':'application/json'},body:'{"code":"c"}'}),env);
  assert.equal(cross.status,403);
});

test('new matches record gameId tic-tac-typed; the Jev request still names the rules tic-tac-toe',async t=>{
  assert.equal(GAME_ID,'tic-tac-typed');assert.equal(game.id,GAME_ID);assert.deepEqual([...GAME_IDS],['tic-tac-typed','tic-tac-toe']);
  assert.equal(buildJevRequest(createInitialState(),'jev','jev-1.13.0').state.game,'tic-tac-toe');
  const env=environment({TYPESAFE_API_KEY:'fixture-key'});t.after(()=>env.DB.close());
  const client=await browser(env),match=await playToEnd(client,await start(client));
  assert.equal(match.status,'complete');assert.equal(match.config.gameId,'tic-tac-typed');assert.equal((await verifyMatch(match)).ok,true);
});

test('a match exported before the rename (gameId tic-tac-toe, live Jev decisions) still verifies',async()=>{
  // Recorded at main c634d30 with the in-process fixture provider; see tests/fixtures/README.md.
  const [old]=JSON.parse(readFileSync(new URL('./fixtures/pre-rename-export.json',import.meta.url),'utf8')).matches;
  assert.equal(old.config.gameId,'tic-tac-toe');assert.ok(GAME_IDS.includes(old.config.gameId));
  assert.ok(old.actions.some(a=>a.decision?.source==='jev'),'fixture must exercise the rebuilt Jev request');
  const audit=await verifyMatch(old);assert.equal(audit.ok,true,JSON.stringify(audit));
});
