import test from 'node:test';
import assert from 'node:assert/strict';
import {environment,browser,loginFixture,responseFor,start} from './helpers.js';
import {getMatch,insertMatch,run} from '../server/store.js';
import {sha256} from '../server/util.js';

const options=(over={})=>({requestId:crypto.randomUUID(),humanMark:'X',difficulty:'normal',ranked:false,...over});
const create=(client,over)=>client.request('/api/matches',{method:'POST',body:options(over)});
const count=async(env,where='1=1')=>(await env.DB.prepare(`SELECT COUNT(*) n FROM matches WHERE ${where}`).first()).n;
const active=env=>count(env,"status IN ('human_turn','jev_pending')");
function providerEnv(overrides={}){
  const calls=[];
  const env=environment({TYPESAFE_API_KEY:'fixture',FETCH:async(_url,o)=>{calls.push(1);return new Response(JSON.stringify(responseFor(JSON.parse(o.body))),{headers:{'Content-Type':'application/json'}});},...overrides});
  return {env,calls};
}
async function setup(t,overrides={}){const env=environment(overrides);t.after(()=>env.DB.close());return {env,client:await browser(env)};}
async function sibling(env,client,userId){
  const other=await browser(env);
  await run(env,'UPDATE sessions SET user_id=? WHERE token_hash=?',userId,await sha256(other.cookie.split('=')[1]));return other;
}
const admitted=rs=>rs.filter(r=>r.status===201||r.status===202);

test('same session: distinct-key creates race, exactly one is admitted and the rest name it',async t=>{
  const {env,client}=await setup(t);
  const rs=await Promise.all(Array.from({length:6},()=>create(client)));
  const won=admitted(rs);assert.equal(won.length,1);
  for(const r of rs.filter(r=>r!==won[0])){assert.equal(r.status,409);assert.equal(r.data.error,'active_match_exists');assert.equal(r.data.detail.matchId,won[0].data.id);}
  assert.equal(await active(env),1);assert.equal(await count(env),1);
});
test('same account, several sessions: concurrent creates admit one match for the account',async t=>{
  const {env,client}=await setup(t);const {userId}=await loginFixture(client);const b=await sibling(env,client,userId),c=await sibling(env,client,userId);
  const rs=await Promise.all([client,b,c,client,b,c].map(x=>create(x)));
  const won=admitted(rs);assert.equal(won.length,1);
  for(const r of rs.filter(r=>r!==won[0]))assert.deepEqual([r.status,r.data.error,r.data.detail.matchId],[409,'active_match_exists',won[0].data.id]);
  assert.equal(await active(env),1);
  const me=(await b.request('/api/me')).data;assert.equal(me.activeMatchId,won[0].data.id);
});
test('same key race: every caller gets the one match and the provider is driven once',async t=>{
  const {env,calls}=providerEnv();const client=await browser(env);t.after(()=>env.DB.close());
  const body=options({humanMark:'O'});
  const rs=await Promise.all(Array.from({length:5},()=>client.request('/api/matches',{method:'POST',body})));
  assert.ok(rs.every(r=>[200,201,202].includes(r.status)),JSON.stringify(rs.map(r=>r.status)));
  assert.equal(new Set(rs.map(r=>r.data.id)).size,1);
  assert.equal(await count(env),1);assert.equal(calls.length,1);
});
test('same key with a different body races to idempotency_conflict, not a second match',async t=>{
  const {env,client}=await setup(t);const requestId=crypto.randomUUID();
  const rs=await Promise.all([create(client,{requestId,humanMark:'X'}),create(client,{requestId,humanMark:'O'})]);
  assert.equal(admitted(rs).length,1);
  const loser=rs.find(r=>r.status===409);assert.equal(loser.data.error,'idempotency_conflict');
  assert.equal(await count(env),1);
});
test('distinct-key race with a provider-driven opening never pays twice',async t=>{
  const {env,calls}=providerEnv();const client=await browser(env);t.after(()=>env.DB.close());
  const rs=await Promise.all(Array.from({length:4},()=>create(client,{humanMark:'O'})));
  assert.equal(admitted(rs).length,1);assert.equal(calls.length,1);assert.equal(await count(env),1);
});
test('ranked race: one ranked match per account, losers name it',async t=>{
  const {env,calls}=providerEnv();const client=await browser(env);t.after(()=>env.DB.close());await loginFixture(client);
  const rs=await Promise.all(Array.from({length:4},()=>create(client,{ranked:true})));
  const won=admitted(rs);assert.equal(won.length,1);
  for(const r of rs.filter(r=>r!==won[0]))assert.deepEqual([r.status,r.data.error,r.data.detail.matchId],[409,'active_match_exists',won[0].data.id]);
  assert.equal(await count(env,'ranked_started=1'),1);assert.equal(calls.length,0);
});
test('a lost admission does not disturb the winner or other players',async t=>{
  const {env,client}=await setup(t);const stranger=await browser(env);
  const rs=await Promise.all([create(client),create(client),create(stranger),create(stranger)]);
  assert.equal(admitted(rs).length,2);assert.equal(await active(env),2);
  const mine=(await client.request('/api/me')).data.activeMatchId,theirs=(await stranger.request('/api/me')).data.activeMatchId;
  assert.notEqual(mine,theirs);assert.equal((await getMatch(env,mine)).revision,0);
});
test('normal flow: resign then New game admits exactly one new match; a second is refused',async t=>{
  const {env,client}=await setup(t);const first=await start(client);
  assert.equal((await create(client)).status,409);
  await client.request(`/api/matches/${first.id}/actions`,{method:'POST',body:{requestId:crypto.randomUUID(),expectedRevision:first.revision,action:{type:'resign'}}});
  const rs=await Promise.all([create(client),create(client)]);
  assert.equal(admitted(rs).length,1);assert.equal(rs.find(r=>r.status===409).data.error,'active_match_exists');
  assert.equal(await active(env),1);
});
test('an expired match still blocks creation until resumed, then a new one is admitted',async t=>{
  const {env,client}=await setup(t);const m=await start(client),doc=await getMatch(env,m.id);
  doc.expiresAt=Date.now()-100;await run(env,'UPDATE matches SET expires_at=?,doc=? WHERE id=?',doc.expiresAt,JSON.stringify(doc),doc.id);
  const blocked=await create(client);assert.equal(blocked.status,409);assert.equal(blocked.data.detail.matchId,m.id);
  assert.equal((await client.request(`/api/matches/${m.id}/resume`,{method:'POST'})).status,200);
  const rs=await Promise.all([create(client),create(client)]);assert.equal(admitted(rs).length,1);assert.equal(await active(env),1);
});
test('ownership: another player cannot read the winner named by a lost race',async t=>{
  const {env,client}=await setup(t);const m=await start(client),stranger=await browser(env);
  assert.equal((await stranger.request(`/api/matches/${m.id}`)).status,404);
  assert.equal((await create(stranger)).status,201);
});
test('insertMatch reports a duplicate key without throwing, so callers can read back',async t=>{
  const {env,client}=await setup(t);const m=await start(client),doc=await getMatch(env,m.id);
  await run(env,"UPDATE matches SET status='complete' WHERE id=?",m.id);
  const session={token_hash:doc.ownerSession,user_id:null};
  assert.equal(await insertMatch(env,{...doc,id:crypto.randomUUID()},session,'x'),false);
  assert.equal(await count(env),1);
});
test('a completed same-key match is replayed, not recreated, even after it ended',async t=>{
  const {env,client}=await setup(t);const body=options();
  const first=await client.request('/api/matches',{method:'POST',body});
  await client.request(`/api/matches/${first.data.id}/actions`,{method:'POST',body:{requestId:crypto.randomUUID(),expectedRevision:first.data.revision,action:{type:'resign'}}});
  const again=await client.request('/api/matches',{method:'POST',body});
  assert.equal(again.data.id,first.data.id);assert.equal(await count(env),1);
});
