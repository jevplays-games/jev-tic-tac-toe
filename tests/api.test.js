import test from 'node:test';
import assert from 'node:assert/strict';
import {environment,browser,loginFixture,start,playToEnd,responseFor} from './helpers.js';
import {one,run,getMatch,saveMatch} from '../server/store.js';
import {verifyMatch,publicMatch,maintenance} from '../server/matches.js';
import {sha256} from '../server/util.js';
import {handle} from '../server/worker.js';

async function setup(t,overrides={}){const env=environment(overrides);t.after(()=>env.DB.close());return {env,client:await browser(env)};}

test('anonymous session has HttpOnly cookie, CSRF secret and security headers',async t=>{
  const {env,client}=await setup(t);const r=await client.request('/api/me');assert.equal(r.status,200);assert.equal(r.data.user,null);assert.equal(r.data.csrf.length,64);assert.equal(r.headers.get('x-content-type-options'),'nosniff');assert.ok(r.headers.get('content-security-policy').includes("script-src 'self'"));assert.ok(!JSON.stringify(r.data).includes('TYPESAFE_API_KEY'));
});
test('CSRF and origin checks reject browser mutations independently',async t=>{
  const{client}=await setup(t);
  const body={requestId:crypto.randomUUID(),humanMark:'X',difficulty:'normal',ranked:false};
  assert.equal((await client.request('/api/matches',{method:'POST',body,headers:{'x-csrf-token':'bad'}})).status,403);
  assert.equal((await client.request('/api/matches',{method:'POST',body,headers:{origin:'https://attacker.example'}})).status,403);
});
test('ranked matches require both a real account session and a configured JEV key',async t=>{
  const {client}=await setup(t);const body={requestId:crypto.randomUUID(),humanMark:'X',difficulty:'normal',ranked:true};
  assert.equal((await client.request('/api/matches',{method:'POST',body})).status,401);await loginFixture(client);assert.equal((await client.request('/api/matches',{method:'POST',body})).status,503);
});
test('casual no-key game is playable and visibly excludes fallback from rankings',async t=>{
  const{client}=await setup(t);const m=await playToEnd(client,await start(client));assert.equal(m.status,'complete');assert.equal(m.outcome,'draw');assert.equal(m.eligible,false);assert.ok(m.actions.some(a=>a.decision?.source==='fallback-minimax'));assert.equal(m.audit.ok,true);assert.equal((await verifyMatch(m)).ok,true);
});
test('ranked match verifies genuine adapter decisions with a mocked provider',async t=>{
  const{client}=await setup(t,{TYPESAFE_API_KEY:'fixture-secret'});await loginFixture(client);const m=await playToEnd(client,await start(client,{ranked:true,difficulty:'jev'}));assert.equal(m.outcome,'draw');assert.equal(m.eligible,true);assert.equal(m.audit.ok,true);assert.ok(m.actions.some(a=>a.decision?.source==='jev'));assert.equal((await verifyMatch(m)).ok,true);
  const leader=await client.request('/api/leaderboard?difficulty=jev&mark=X');assert.equal(leader.status,200);assert.equal(leader.data.entries.length,1);assert.equal(leader.data.entries[0].draws,1);assert.equal(leader.data.entries[0].provisional,true);
});
test('playing as O schedules and records the initial JEV move',async t=>{
  const{client}=await setup(t,{TYPESAFE_API_KEY:'fixture'});const m=await start(client,{humanMark:'O'});assert.equal(m.actions.length,1);assert.equal(m.actions[0].actor,'jev');assert.equal(m.status,'human_turn');assert.equal(m.board.filter(c=>c==='X').length,1);
});
test('oracle data and raw request are not exposed during an active ranked game',async t=>{
  const{client}=await setup(t,{TYPESAFE_API_KEY:'fixture'});await loginFixture(client);const m=await start(client,{humanMark:'O',ranked:true});assert.equal(m.events,undefined);assert.equal(m.actions[0].analysis,undefined);assert.equal(m.actions[0].decision.request,undefined);assert.equal(m.actions[0].decision.response,undefined);
});
test('duplicate match creation is idempotent; conflicting options reject',async t=>{
  const{client}=await setup(t);const body={requestId:crypto.randomUUID(),humanMark:'X',difficulty:'normal',ranked:false};const a=await client.request('/api/matches',{method:'POST',body}),b=await client.request('/api/matches',{method:'POST',body});assert.equal(a.data.id,b.data.id);assert.equal((await client.request('/api/matches',{method:'POST',body:{...body,humanMark:'O'}})).status,409);
});
test('duplicate action request does not duplicate a placement or invoke the model twice',async t=>{
  let calls=0;const{client}=await setup(t,{TYPESAFE_API_KEY:'fixture',FETCH:async(_url,options)=>{calls++;return new Response(JSON.stringify(responseFor(JSON.parse(options.body))));}});
  const m=await start(client),body={requestId:crypto.randomUUID(),expectedRevision:m.revision,action:{type:'place',cell:0}};
  const a=await client.request(`/api/matches/${m.id}/actions`,{method:'POST',body}),b=await client.request(`/api/matches/${m.id}/actions`,{method:'POST',body});assert.equal(a.status,200);assert.deepEqual(a.data.board,b.data.board);assert.equal(calls,1);assert.equal(b.data.actions.length,2);
  assert.equal((await client.request(`/api/matches/${m.id}/actions`,{method:'POST',body:{...body,action:{type:'place',cell:1}}})).status,409);
});
test('concurrent human submissions cannot fork the authoritative state',async t=>{
  const{client}=await setup(t,{TYPESAFE_API_KEY:'fixture'}),m=await start(client);
  const send=cell=>client.request(`/api/matches/${m.id}/actions`,{method:'POST',body:{requestId:crypto.randomUUID(),expectedRevision:m.revision,action:{type:'place',cell}}});
  const results=await Promise.all([send(0),send(1)]);assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);const final=(await client.request(`/api/matches/${m.id}`)).data;assert.equal(final.actions.length,2);
});
test('stale revision and illegal placements fail without state mutation',async t=>{
  const{client}=await setup(t),m=await start(client);
  for(const[revision,cell,status]of [[100,0,409],[0,10,400],[0,'0',400]]){const r=await client.request(`/api/matches/${m.id}/actions`,{method:'POST',body:{requestId:crypto.randomUUID(),expectedRevision:revision,action:{type:'place',cell}}});assert.equal(r.status,status);}
  assert.equal((await client.request(`/api/matches/${m.id}`)).data.actions.length,0);
});
test('another session cannot read, move or export a private match',async t=>{
  const{env,client}=await setup(t),other=await browser(env),m=await start(client);
  assert.equal((await other.request(`/api/matches/${m.id}`)).status,404);assert.equal((await other.request(`/api/matches/${m.id}/resume`,{method:'POST'})).status,404);assert.equal((await other.request('/api/history')).data.matches.length,0);
});
test('supplied scores, winners and community IDs cannot forge results or context',async t=>{
  const{client}=await setup(t);const m=await start(client,{score:9999,outcome:'win',guild_id:'99999999',channel_id:'88888888'});assert.equal(m.outcome,null);assert.equal(m.context,null);assert.equal(m.eligible,false);
});
test('resignation becomes a loss and cannot be replaced with a second active ranked game',async t=>{
  const{client}=await setup(t,{TYPESAFE_API_KEY:'fixture'});await loginFixture(client);const m=await start(client,{ranked:true});
  const duplicate=await client.request('/api/matches',{method:'POST',body:{requestId:crypto.randomUUID(),difficulty:'normal',humanMark:'X',ranked:true}});assert.equal(duplicate.status,409);
  const r=await client.request(`/api/matches/${m.id}/actions`,{method:'POST',body:{requestId:crypto.randomUUID(),expectedRevision:m.revision,action:{type:'resign'}}});assert.equal(r.data.outcome,'loss');assert.equal(r.data.eligible,true);assert.equal(r.data.audit.ok,true);
});
test('expired human turn counts as a forfeit; expired service turn is void',async t=>{
  const{env,client}=await setup(t,{TYPESAFE_API_KEY:'fixture'});await loginFixture(client);const m=await start(client,{ranked:true}),doc=await getMatch(env,m.id);doc.expiresAt=Date.now()-100;await run(env,'UPDATE matches SET expires_at=?,doc=? WHERE id=?',doc.expiresAt,JSON.stringify(doc),doc.id);
  await maintenance(env);const result=await getMatch(env,m.id);assert.equal(result.outcome,'loss');assert.equal(result.termination,'expired');
  const next=await start(client,{ranked:true}),nextDoc=await getMatch(env,next.id);nextDoc.status='jev_pending';nextDoc.expiresAt=Date.now()-100;await run(env,"UPDATE matches SET status='jev_pending',expires_at=?,doc=? WHERE id=?",nextDoc.expiresAt,JSON.stringify(nextDoc),next.id);await maintenance(env);const interrupted=await getMatch(env,next.id);assert.equal(interrupted.status,'void');assert.equal(interrupted.eligible,false);
});
test('fallback during a ranked match permanently removes ranking eligibility',async t=>{
  const{client}=await setup(t,{TYPESAFE_API_KEY:'fixture',FETCH:async()=>new Response('{}')});await loginFixture(client);const m=await playToEnd(client,await start(client,{ranked:true}));assert.equal(m.eligible,false);assert.ok(m.actions.some(a=>a.decision?.source==='fallback-minimax'));assert.equal((await client.request('/api/leaderboard')).data.entries.length,0);
});
test('provider requests are prepared durably before dispatch',async t=>{
  let observed=false;const{env,client}=await setup(t,{TYPESAFE_API_KEY:'fixture'});
  env.FETCH=async(_url,options)=>{const row=await one(env,"SELECT doc FROM matches WHERE status='jev_pending' LIMIT 1"),doc=JSON.parse(row.doc);assert.equal(doc.events.at(-1).type,'jev_request_prepared');assert.ok(doc.lease.token);observed=true;return new Response(JSON.stringify(responseFor(JSON.parse(options.body))));};
  const m=await start(client,{humanMark:'O'});assert.ok(observed);assert.equal(m.actions.length,1);
});
test('export verifier detects action, model evidence and hash-chain tampering',async t=>{
  const{client}=await setup(t,{TYPESAFE_API_KEY:'fixture'});const m=await playToEnd(client,await start(client));assert.equal((await verifyMatch(m)).ok,true);
  const copies=[structuredClone(m),structuredClone(m),structuredClone(m)];copies[0].actions[0].cell=8;copies[1].actions.find(a=>a.decision?.source==='jev').decision.response.model='other';copies[2].events[0].payload.humanMark='O';for(const copy of copies)assert.equal((await verifyMatch(copy)).ok,false);
});
test('personal analytics separate human/JEV/forced/fallback and history is paginated',async t=>{
  const{client}=await setup(t);for(let i=0;i<3;i++)await playToEnd(client,await start(client));
  const data=(await client.request('/api/analytics')).data;assert.equal(data.summary.matches,3);assert.ok(data.summary.bySource.human);assert.ok(data.summary.bySource['fallback-minimax']);assert.equal(data.summary.bySource.jev,undefined);assert.equal(data.summary.summary.inputTokens,0);assert.equal(data.coverage.truncated,false);
  const first=(await client.request('/api/history?limit=2')).data;assert.equal(first.matches.length,2);assert.ok(first.next);const second=(await client.request('/api/history?'+new URLSearchParams({...first.next,limit:2}))).data;assert.equal(second.matches.length,1);assert.equal(second.next,null);assert.equal(new Set([...first.matches,...second.matches].map(m=>m.id)).size,3);
});
test('channel/server endpoints fail closed without fresh verified Discord context',async t=>{
  const{client}=await setup(t);assert.equal((await client.request('/api/leaderboard?scope=channel&channel=123456789')).status,403);await loginFixture(client);assert.equal((await client.request('/api/leaderboard?scope=server&guild=123456789')).status,403);
});
test('public assets and game data never include the provider secret',async t=>{
  const secret='secret-that-must-not-leak', {client}=await setup(t,{TYPESAFE_API_KEY:secret});const m=await playToEnd(client,await start(client));assert.ok(!JSON.stringify(m).includes(secret));assert.ok(!JSON.stringify((await client.request('/api/me')).data).includes(secret));
});
test('oversized JSON and non-JSON mutations reject',async t=>{
  const{env,client}=await setup(t);let r=await client.request('/api/matches',{method:'POST',body:{huge:'x'.repeat(5000)}});assert.equal(r.status,413);
  r=await client.request('/api/matches',{method:'POST',body:{},headers:{'content-type':'text/plain'}});assert.equal(r.status,415);
});
test('unknown actions and arbitrary proxy paths do not expose a JEV proxy',async t=>{
  const{client}=await setup(t);assert.equal((await client.request('/api/jev',{method:'POST',body:{state:'malicious'}})).status,404);
});
test('changing duplicate decision evidence while preserving its chosen cell is detected',async t=>{
  const{client}=await setup(t,{TYPESAFE_API_KEY:'fixture'}),m=await playToEnd(client,await start(client));const forged=structuredClone(m);forged.actions.find(a=>a.decision?.source==='jev').decision.response.usage.input_tokens=99999;assert.equal((await verifyMatch(forged)).reason,'decision_event_mismatch');
});
test('operational counters are anonymous and require a separate administrator secret',async t=>{
  const{client}=await setup(t,{ADMIN_ANALYTICS_KEY:'operator-test-secret'});await client.request('/api/me');assert.equal((await client.request('/api/admin/operations')).status,403);
  const r=await client.request('/api/admin/operations',{headers:{authorization:'Bearer operator-test-secret'}});assert.equal(r.status,200);assert.ok(r.data.requests>=2);assert.ok(r.data.rows.every(row=>!('ip' in row)&&!('user_id' in row)&&!('body' in row)));assert.ok(!JSON.stringify(r.data).includes('operator-test-secret'));
});
test('malformed JSON provider response is not retried or misrepresented',async t=>{
  let calls=0;const{client}=await setup(t,{TYPESAFE_API_KEY:'fixture',FETCH:async()=>{calls++;return new Response('not json');}});const m=await start(client,{humanMark:'O'});assert.equal(calls,1);assert.equal(m.actions[0].decision.source,'fallback-minimax');assert.equal(m.actions[0].decision.fallbackReason,'malformed_json');
});
test('expired in-flight lease uses labeled recovery and discards a late provider result',async t=>{
  let release,enteredResolve,calls=0;const entered=new Promise(resolve=>enteredResolve=resolve);
  const{env,client}=await setup(t,{TYPESAFE_API_KEY:'fixture',FETCH:async(_url,options)=>{calls++;enteredResolve();await new Promise(resolve=>release=resolve);return new Response(JSON.stringify(responseFor(JSON.parse(options.body))));}});
  await loginFixture(client);const m=await start(client,{ranked:true});
  const pending=client.request(`/api/matches/${m.id}/actions`,{method:'POST',body:{requestId:crypto.randomUUID(),expectedRevision:m.revision,action:{type:'place',cell:0}}});
  await entered;const doc=await getMatch(env,m.id);doc.lease.expiresAt=Date.now()-1;await run(env,'UPDATE matches SET doc=? WHERE id=?',JSON.stringify(doc),doc.id);
  const recovered=await client.request(`/api/matches/${m.id}/resume`,{method:'POST'});assert.equal(recovered.data.eligible,false);assert.equal(recovered.data.actions.length,2);assert.equal(recovered.data.actions[1].decision.fallbackReason,'abandoned_inflight_request');
  release();const late=await pending;assert.equal(late.data.actions.length,2);assert.equal(calls,1);assert.deepEqual(late.data.board,recovered.data.board);
});
test('ranked ties, mark separation, channel/server isolation and stable pagination use verified matches',async t=>{
  const{env,client:a}=await setup(t,{TYPESAFE_API_KEY:'fixture'}),b=await browser(env);
  const ua=await loginFixture(a,'Alice'),ub=await loginFixture(b,'Bob');
  for(const [u,channelId]of [[ua,'222222222'],[ub,'333333333']])await run(env,'UPDATE sessions SET context_json=? WHERE token_hash=?',JSON.stringify({guildId:'111111111',channelId,issuedAt:Date.now(),expiresAt:Date.now()+900000,launchHash:'fixture-context'}),u.sessionHash);
  for(let i=0;i<20;i++){await playToEnd(a,await start(a,{ranked:true}));await playToEnd(b,await start(b,{ranked:true}));}
  const world=(await a.request('/api/leaderboard?scope=world')).data;assert.equal(world.entries.length,2);assert.ok(world.entries.every(r=>r.rank===1&&!r.provisional&&r.resultRate===0.5));
  assert.equal((await a.request('/api/leaderboard?scope=world&mark=O')).data.entries.length,0);
  const channel=(await a.request('/api/leaderboard?scope=channel&channel_id=333333333')).data;assert.equal(channel.entries.length,1);assert.equal(channel.entries[0].displayName,'Alice');
  const server=(await a.request('/api/leaderboard?scope=server')).data;assert.equal(server.entries.length,2);
  const first=(await a.request('/api/leaderboard?scope=world&limit=1')).data,second=(await a.request('/api/leaderboard?'+new URLSearchParams({scope:'world',limit:1,...first.next}))).data;
  assert.notEqual(first.entries[0].playerId,second.entries[0].playerId);assert.equal(first.entries[0].rank,second.entries[0].rank);
});
