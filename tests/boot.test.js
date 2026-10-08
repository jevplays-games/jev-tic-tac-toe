import test from 'node:test';
import assert from 'node:assert/strict';
import {environment,browser,loginFixture,start} from './helpers.js';
import {getMatch,run} from '../server/store.js';
import {sha256} from '../server/util.js';
import {resolveInitialMatch,loadPriorMatch,singleFlight,createRequestHolder,withBootLock} from '../public/game/boot.js';

const httpError=(status,message='failed',detail)=>Object.assign(new Error(message),{status,detail});
const body=()=>({requestId:crypto.randomUUID(),humanMark:'X',difficulty:'normal',ranked:false});
const holder=()=>createRequestHolder(body);
const live=(over={})=>({id:'m1',status:'human_turn',revision:2,expiresAt:Date.now()+60000,actions:[],...over});
function fakeApi(routes,calls=[]){
  const api=async(path,{method='GET',body}={})=>{
    calls.push(`${method} ${path}`);const route=routes[`${method} ${path}`];
    if(!route)throw httpError(404,'match_not_found');
    const value=typeof route==='function'?route(body):route;if(value instanceof Error)throw value;return value;
  };
  api.calls=calls;return api;
}
const apiFor=client=>async(path,{method='GET',body}={})=>{
  const r=await client.request(path,{method,body});
  if(r.status>=400){const e=new Error(r.data?.error??'Request failed');e.status=r.status;e.detail=r.data?.detail;throw e;}
  return r.data;
};
async function setup(t,overrides={}){const env=environment(overrides);t.after(()=>env.DB.close());return {env,client:await browser(env)};}
const meOf=async client=>(await client.request('/api/me')).data;

test('a live prior match is restored and no create is attempted',async()=>{
  const api=fakeApi({'GET /api/matches/m1':live()});
  const r=await resolveInitialMatch({me:{activeMatchId:'m1'},api,request:holder()});
  assert.equal(r.status,'resumed');assert.equal(r.match.id,'m1');assert.deepEqual(api.calls,['GET /api/matches/m1']);
});
test('no prior match creates exactly one and clears the request on success',async()=>{
  const request=holder(),created=live({id:'m2'});
  const api=fakeApi({'POST /api/matches':created});
  const r=await resolveInitialMatch({me:{activeMatchId:null},api,request});
  assert.equal(r.status,'created');assert.equal(r.match.id,'m2');assert.equal(request.peek(),null);
});
test('an ended or absent prior match becomes a new playable match',async()=>{
  for(const prior of [live({status:'complete'}),live({status:'void'}),httpError(404,'match_not_found'),httpError(400,'invalid_match_id')]){
    const api=fakeApi({'GET /api/matches/m1':prior,'POST /api/matches':live({id:'new'})});
    const r=await resolveInitialMatch({me:{activeMatchId:'m1'},api,request:holder()});
    assert.equal(r.status,'created',JSON.stringify(prior.status??prior.message));assert.equal(r.match.id,'new');
  }
});
test('an expired prior match is resumed first, then replaced only once it has ended',async()=>{
  const expired=live({expiresAt:Date.now()-5});
  const api=fakeApi({'GET /api/matches/m1':expired,'POST /api/matches/m1/resume':live({status:'complete',termination:'expired'}),'POST /api/matches':live({id:'new'})});
  const r=await resolveInitialMatch({me:{activeMatchId:'m1'},api,request:holder()});
  assert.equal(r.match.id,'new');assert.deepEqual(api.calls,['GET /api/matches/m1','POST /api/matches/m1/resume','POST /api/matches']);
  const still=fakeApi({'GET /api/matches/m1':expired,'POST /api/matches/m1/resume':live({status:'jev_pending'})});
  const kept=await resolveInitialMatch({me:{activeMatchId:'m1'},api:still,request:holder()});
  assert.equal(kept.status,'resumed');assert.equal(kept.match.status,'jev_pending');assert.ok(!still.calls.includes('POST /api/matches'));
});
test('a failed load never creates and never invents a match; retry succeeds',async()=>{
  for(const failure of [httpError(500,'internal'),httpError(503,'unavailable'),new Error('The game service did not return JSON.'),Object.assign(new Error('timeout'),{name:'TimeoutError'})]){
    let fail=true;const api=fakeApi({'GET /api/matches/m1':()=>fail?failure:live(),'POST /api/matches':live({id:'new'})});
    const first=await resolveInitialMatch({me:{activeMatchId:'m1'},api,request:holder()});
    assert.equal(first.status,'error');assert.equal(first.stage,'load');assert.equal(first.match,null);assert.ok(!api.calls.some(c=>c.startsWith('POST')));
    fail=false;const second=await resolveInitialMatch({me:{activeMatchId:'m1'},api,request:holder()});
    assert.equal(second.status,'resumed');assert.equal(second.match.id,'m1');
  }
});
test('a failed resume of an expired match keeps it on screen and does not create',async()=>{
  const expired=live({expiresAt:Date.now()-5});let fail=true;
  const api=fakeApi({'GET /api/matches/m1':expired,'POST /api/matches/m1/resume':()=>fail?httpError(502,'bad_gateway'):live({status:'complete'}),'POST /api/matches':live({id:'new'})});
  const first=await resolveInitialMatch({me:{activeMatchId:'m1'},api,request:holder()});
  assert.equal(first.status,'error');assert.equal(first.stage,'resume');assert.equal(first.match.id,'m1');assert.ok(!api.calls.includes('POST /api/matches'));
  fail=false;const second=await resolveInitialMatch({me:{activeMatchId:'m1'},api,request:holder()});
  assert.equal(second.status,'created');assert.equal(second.match.id,'new');
});
test('an ambiguous create failure retries with the same requestId; a definite rejection mints a new one',async()=>{
  const request=holder(),seen=[];let mode='timeout';
  const api=fakeApi({'POST /api/matches':b=>{seen.push(b.requestId);return mode==='timeout'?new Error('timeout'):mode==='500'?httpError(500,'internal'):mode==='409'?httpError(409,'idempotency_conflict'):live({id:'new'});}});
  assert.equal((await resolveInitialMatch({me:{},api,request})).stage,'create');
  mode='500';assert.equal((await resolveInitialMatch({me:{},api,request})).stage,'create');
  mode='ok';assert.equal((await resolveInitialMatch({me:{},api,request})).status,'created');
  assert.equal(new Set(seen).size,1,'same requestId across ambiguous failures');
  const again=holder(),ids=[];
  const rejecting=fakeApi({'POST /api/matches':b=>{ids.push(b.requestId);return httpError(409,'idempotency_conflict');}});
  await resolveInitialMatch({me:{},api:rejecting,request:again});await resolveInitialMatch({me:{},api:rejecting,request:again});
  assert.equal(new Set(ids).size,2,'definite rejection clears the request');
});
test('active_match_exists on create adopts the existing match instead of failing',async()=>{
  const api=fakeApi({'POST /api/matches':httpError(409,'active_match_exists',{matchId:'other'}),'GET /api/matches/other':live({id:'other'})});
  const r=await resolveInitialMatch({me:{},api,request:holder()});
  assert.equal(r.status,'resumed');assert.equal(r.match.id,'other');
});
test('singleFlight shares one run among concurrent callers and allows a fresh run afterwards',async()=>{
  let runs=0,release;const gate=new Promise(r=>release=r);
  const boot=singleFlight(async()=>{runs++;await gate;return runs;});
  const a=boot(),b=boot(),c=boot();release();
  assert.deepEqual(await Promise.all([a,b,c]),[1,1,1]);assert.equal(runs,1);
  assert.equal(await boot(),2);
});

test('server: reload with a live match restores it and creates no duplicate',async t=>{
  const {env,client}=await setup(t);const api=apiFor(client),m=await start(client);
  for(let reload=0;reload<3;reload++){
    const r=await resolveInitialMatch({me:await meOf(client),api,request:holder()});
    assert.equal(r.status,'resumed');assert.equal(r.match.id,m.id);
  }
  assert.equal((await env.DB.prepare('SELECT COUNT(*) n FROM matches').first()).n,1);
});
test('server: a new session on the same account restores the signed-in player’s live match',async t=>{
  const {env,client}=await setup(t,{TYPESAFE_API_KEY:'fixture'});const {userId}=await loginFixture(client);const m=await start(client);
  const other=await browser(env);await run(env,'UPDATE sessions SET user_id=? WHERE token_hash=?',userId,await sha256(other.cookie.split('=')[1]));
  const r=await resolveInitialMatch({me:await meOf(other),api:apiFor(other),request:holder()});
  assert.equal(r.status,'resumed');assert.equal(r.match.id,m.id);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) n FROM matches').first()).n,1);
});
test('server: an ended match is replaced by exactly one new playable match',async t=>{
  const {client}=await setup(t);const api=apiFor(client),first=await start(client);
  await client.request(`/api/matches/${first.id}/actions`,{method:'POST',body:{requestId:crypto.randomUUID(),expectedRevision:first.revision,action:{type:'resign'}}});
  const r=await resolveInitialMatch({me:await meOf(client),api,request:holder()});
  assert.equal(r.status,'created');assert.notEqual(r.match.id,first.id);assert.equal(r.match.status,'human_turn');
  const reload=await resolveInitialMatch({me:await meOf(client),api,request:holder()});
  assert.equal(reload.status,'resumed');assert.equal(reload.match.id,r.match.id);
});
function fakeLocks(){
  let tail=Promise.resolve();
  return {request:(name,run)=>{const result=tail.then(run);tail=result.catch(()=>{});return result;}};
}
test('server: concurrent initialization from two tabs under the boot lock yields one match',async t=>{
  const {env,client}=await setup(t);const api=apiFor(client),locks=fakeLocks();
  const tab=()=>withBootLock(async()=>resolveInitialMatch({me:await meOf(client),api,request:holder()}),locks);
  const [a,b]=await Promise.all([tab(),tab()]);
  assert.equal(a.match.id,b.match.id);assert.deepEqual([a.status,b.status].sort(),['created','resumed']);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) n FROM matches').first()).n,1);
});
test('withBootLock runs directly when Web Locks is unavailable',async()=>{
  assert.equal(await withBootLock(async()=>'ran',null),'ran');
  assert.equal(await withBootLock(async()=>'ran',{}),'ran');
});
test('server: unserialised concurrent creates never fail the player, but the server alone cannot dedupe casual matches',async t=>{
  const {client}=await setup(t);const api=apiFor(client),me=await meOf(client);
  const [a,b]=await Promise.all([resolveInitialMatch({me,api,request:holder()}),resolveInitialMatch({me,api,request:holder()})]);
  assert.ok(['created','resumed'].includes(a.status)&&['created','resumed'].includes(b.status));
});
test('server: concurrent casual creates from one session leave a single active match',{todo:'needs server extension: unique active-match index for casual sessions'},async t=>{
  const {env,client}=await setup(t);const api=apiFor(client),me=await meOf(client);
  await Promise.all([resolveInitialMatch({me,api,request:holder()}),resolveInitialMatch({me,api,request:holder()})]);
  assert.equal((await env.DB.prepare("SELECT COUNT(*) n FROM matches WHERE status IN ('human_turn','jev_pending')").first()).n,1);
});
test('server: replaying the same requestId after a lost response returns the same match',async t=>{
  const {env,client}=await setup(t);const api=apiFor(client),request=holder(),me=await meOf(client);
  const first=await api('/api/matches',{method:'POST',body:request.current});
  const r=await resolveInitialMatch({me,api,request});
  assert.equal(r.match.id,first.id);assert.equal((await env.DB.prepare('SELECT COUNT(*) n FROM matches').first()).n,1);
});
test('server: ownership — a foreign or invalid id is absent, never another player’s match',async t=>{
  const {env,client}=await setup(t);const owner=await start(client),stranger=await browser(env),api=apiFor(stranger);
  const foreign=await loadPriorMatch({me:{activeMatchId:owner.id},api});assert.equal(foreign.status,'none');
  const invalid=await loadPriorMatch({me:{activeMatchId:'not a valid id/../'},api});assert.equal(invalid.status,'none');
  const r=await resolveInitialMatch({me:await meOf(stranger),api,request:holder()});
  assert.equal(r.status,'created');assert.notEqual(r.match.id,owner.id);
  assert.equal((await getMatch(env,owner.id)).status,'human_turn');
});
test('server: an expired human turn is resumed to its final state, then replaced',async t=>{
  const {env,client}=await setup(t);const api=apiFor(client),m=await start(client),doc=await getMatch(env,m.id);
  doc.expiresAt=Date.now()-100;await run(env,'UPDATE matches SET expires_at=?,doc=? WHERE id=?',doc.expiresAt,JSON.stringify(doc),doc.id);
  const r=await resolveInitialMatch({me:await meOf(client),api,request:holder()});
  assert.equal(r.status,'created');assert.notEqual(r.match.id,m.id);
  const old=await getMatch(env,m.id);assert.equal(old.status,'complete');assert.equal(old.termination,'expired');
  assert.equal((await env.DB.prepare("SELECT COUNT(*) n FROM matches WHERE status NOT IN ('complete','void')").first()).n,1);
});
