import {createInitialState,getPlayerToMove,getOutcome,getLegalActions,applyAction,replay,key} from '../public/game/rules.js';
import {DIFFICULTIES,POLICY_VERSION,buildJevRequest,validateJevResponse,selectJevAction} from '../public/game/policy.js';
import {inspectMove,ANALYTICS_VERSION} from '../public/game/analytics.js';
import {minimaxAction} from '../public/game/oracle.js';
import {assert,HttpError,sha256,canonical,addEvent,verifyEvents,randomToken} from './util.js';
import {one,all,quota,getMatch,insertMatch,activeMatchFor,saveMatch} from './store.js';
import {userFor,contextFor} from './auth.js';
import {chooseJevAction} from './jev.js';
import {SOURCE_REVISION} from './build-info.js';

export function configuration(env,difficulty) {
  assert(DIFFICULTIES.includes(difficulty),400,'invalid_difficulty');
  const modelId=env.PINNED_JEV_MODEL??'jev-1.13.0';
  assert(/^jev-\d+\.\d+\.\d+$/.test(modelId),503,'pinned_model_required');
  return {gameId:'tic-tac-toe',rulesVersion:'ttt/1',difficulty,modelId,policyVersion:POLICY_VERSION,analyticsVersion:ANALYTICS_VERSION,sourceRevision:SOURCE_REVISION,fallback:'minimax-unranked/v1',budgetMs:3000};
}
export async function ownedMatch(env,session,id) {
  assert(typeof id==='string' && /^[a-f0-9-]{36}$/.test(id),400,'invalid_match_id');
  const doc=await getMatch(env,id);
  assert(doc && (session.user_id && doc.userId===session.user_id || doc.ownerSession===session.token_hash),404,'match_not_found');
  return doc;
}
export function publicMatch(doc) {
  const closed=['complete','void'].includes(doc.status);
  // Exact oracle scores and raw provider evidence are withheld until completion.
  return {id:doc.id,schemaVersion:1,revision:doc.revision,status:doc.status,humanMark:doc.humanMark,board:replay(doc.actions).board,
    config:doc.config,configHash:doc.configHash,rankedStarted:doc.rankedStarted,eligible:doc.eligible,
    opponent:doc.actions.some(a=>a.decision?.source==='fallback-minimax')?'Local perfect-play fallback — unranked':'JEV',
    context:doc.context?{guildId:doc.context.guildId,channelId:doc.context.channelId}:null,
    outcome:doc.outcome??null,termination:doc.termination??null,startedAt:doc.startedAt,finishedAt:doc.finishedAt??null,expiresAt:doc.expiresAt,
    actions:doc.actions.map(a=>closed?a:{cell:a.cell,mark:a.mark,actor:a.actor,acceptedAt:a.acceptedAt,decision:a.decision?{
      source:a.decision.source,latencyMs:a.decision.latencyMs,probabilities:a.decision.probabilities??null,distribution:a.decision.distribution??null,
      reportedConfidence:a.decision.response?.answers?.preference?.confidence??null,fallbackReason:a.decision.fallbackReason,candidateCount:a.analysis.candidates.length,factors:a.analysis.factors
    }:null}),
    ...(closed?{events:doc.events,audit:doc.audit,exportedAt:new Date().toISOString()}:{} )};
}
export async function createMatch(env,session,input) {
  assert(input && typeof input.requestId==='string' && /^[a-zA-Z0-9_-]{16,80}$/.test(input.requestId),400,'request_id_required');
  assert(['X','O'].includes(input.humanMark) && typeof input.ranked==='boolean',400,'invalid_match_options');
  const config=configuration(env,input.difficulty), fingerprint=await sha256({humanMark:input.humanMark,ranked:input.ranked,config});
  const replay=async()=>{
    const existing=await one(env,'SELECT doc,create_fingerprint FROM matches WHERE owner_session=? AND create_key=?',session.token_hash,input.requestId);
    if(!existing)return null;
    assert(existing.create_fingerprint===fingerprint,409,'idempotency_conflict');return JSON.parse(existing.doc);
  };
  const replayed=await replay();
  if(replayed)return replayed;
  const user=await userFor(env,session);
  if(user)assert(user.moderation_state==='active',403,'account_restricted');
  if(input.ranked){assert(user,401,'discord_login_required');assert(env.TYPESAFE_API_KEY,503,'jev_not_configured');}
  const active=await activeMatchFor(env,session);
  assert(!active,409,'active_match_exists',active?{matchId:active.id}:undefined);
  await quota(env,`create:${session.user_id??session.token_hash}`,Number(env.MATCHES_PER_HOUR??60),3600000);
  const at=Date.now(),doc={schemaVersion:1,id:crypto.randomUUID(),ownerSession:session.token_hash,userId:session.user_id??null,createKey:input.requestId,
    config,configHash:await sha256(config),humanMark:input.humanMark,context:contextFor(session),rankedStarted:input.ranked,eligible:input.ranked,
    revision:0,status:input.humanMark==='X'?'human_turn':'jev_pending',actions:[],events:[],receipts:[],lease:null,startedAt:at,turnSince:at,expiresAt:at+(input.ranked?900000:86400000)};
  await addEvent(doc,'match_started',{config,configHash:doc.configHash,humanMark:doc.humanMark,ranked:doc.rankedStarted,expiresAt:doc.expiresAt});
  if(!await insertMatch(env,doc,session,fingerprint)){
    // Lost an admission race: adopt the same-key match (never driving the provider a second time) or report the active one.
    const adopted=await replay();
    if(adopted)return adopted;
    const winner=await activeMatchFor(env,session);
    throw new HttpError(409,winner?'active_match_exists':'active_match_or_duplicate',winner?{matchId:winner.id}:undefined);
  }
  return driveJev(env,doc);
}
export async function verifyMatch(doc) {
  const chain=await verifyEvents(doc.events,doc.id);
  if(!chain.ok)return chain;
  if(await sha256(doc.config)!==doc.configHash)return {ok:false,reason:'config_hash_mismatch'};
  const starts=doc.events.filter(e=>e.type==='match_started');
  if(starts.length!==1 || starts[0].payload.configHash!==doc.configHash || canonical(starts[0].payload.config)!==canonical(doc.config) || starts[0].payload.humanMark!==doc.humanMark || starts[0].payload.ranked!==doc.rankedStarted)return {ok:false,reason:'manifest_event_mismatch'};
  if(doc.eligible&&!doc.rankedStarted)return {ok:false,reason:'eligibility_mismatch'};
  const decisionEvents=doc.events.filter(e=>e.type==='jev_result');
  const computerMoves=doc.actions.filter(a=>a.actor==='jev');
  if(decisionEvents.length!==computerMoves.length || decisionEvents.some((e,i)=>canonical(e.payload.decision)!==canonical(computerMoves[i].decision)))return {ok:false,reason:'decision_event_mismatch'};
  let state=createInitialState();
  try{
    for(const [index,move] of doc.actions.entries()){
      const mark=getPlayerToMove(state),actor=mark===doc.humanMark?'human':'jev';
      if(move.mark!==mark||move.actor!==actor)return {ok:false,reason:'actor_mismatch',ply:index+1};
      const analysis=inspectMove(state,move.cell);
      if(canonical(analysis)!==canonical(move.analysis))return {ok:false,reason:'analysis_mismatch',ply:index+1};
      if(actor==='jev'){
        const d=move.decision;
        if(!d)return {ok:false,reason:'missing_decision'};
        if(d.action.cell!==move.cell)return {ok:false,reason:'decision_move_mismatch'};
        if(d.source==='jev'){
          const request=buildJevRequest(state,doc.config.difficulty,doc.config.modelId);
          if(canonical(request)!==canonical(d.request)||await sha256(request)!==d.inputHash)return {ok:false,reason:'request_mismatch'};
          validateJevResponse(d.response,request);
          if(selectJevAction(d.response,request,doc.config.difficulty).cell!==move.cell)return {ok:false,reason:'selection_mismatch'};
        }else if(d.source==='forced'){
          if(getLegalActions(state).length!==1)return {ok:false,reason:'not_forced'};
        }else if(d.source==='fallback-minimax'){
          if(move.cell!==minimaxAction(state).cell||doc.eligible)return {ok:false,reason:'fallback_integrity'};
        }else return {ok:false,reason:'unknown_decision_source'};
      }
      state=applyAction(state,{type:'place',cell:move.cell});
    }
    const applied=doc.events.filter(e=>e.type==='action_applied');
    if(applied.length!==doc.actions.length || applied.some((e,i)=>e.payload.cell!==doc.actions[i].cell||e.payload.ply!==i+1||e.payload.mark!==doc.actions[i].mark||e.payload.actor!==doc.actions[i].actor||e.payload.before!==doc.actions[i].analysis.board||e.payload.after!==doc.actions[i].analysis.afterBoard))return {ok:false,reason:'event_action_mismatch'};
    if(doc.status==='complete'){
      const result=getOutcome(state);
      const completed=doc.events.filter(e=>e.type==='match_completed');
      if(completed.length!==1 || completed[0].payload.outcome!==doc.outcome || completed[0].payload.termination!==doc.termination || completed[0].payload.eligible!==doc.eligible)return {ok:false,reason:'completion_event_mismatch'};
      const expected=doc.termination==='board'?(result.winner===null?'draw':result.winner===doc.humanMark?'win':'loss'):'loss';
      if(doc.termination==='board'&&!result.terminal)return {ok:false,reason:'nonterminal_result'};
      if(!['board','resign','expired'].includes(doc.termination)||doc.outcome!==expected)return {ok:false,reason:'outcome_mismatch'};
    }
  }catch(e){return {ok:false,reason:'invalid_replay',detail:e.message};}
  return {...chain,ok:true,moves:doc.actions.length};
}
async function finish(doc,termination='board') {
  doc.status='complete';doc.termination=termination;doc.finishedAt=Date.now();doc.lease=null;
  const result=getOutcome(replay(doc.actions));
  doc.outcome=termination!=='board'?'loss':result.winner===null?'draw':result.winner===doc.humanMark?'win':'loss';
  await addEvent(doc,'match_completed',{outcome:doc.outcome,termination,eligible:doc.eligible});
  doc.audit=await verifyMatch(doc);
  if(!doc.audit.ok){doc.status='void';doc.eligible=false;doc.termination='verification_failed';}
  await addEvent(doc,'replay_verified',{ok:doc.audit.ok,reason:doc.audit.reason??null,verifiedHead:doc.audit.head??null});
}
async function appendMove(doc,state,cell,actor,decision=null,serverDwellMs=null) {
  const mark=getPlayerToMove(state),acceptedAt=Date.now(),analysis=inspectMove(state,cell);
  const move={cell,mark,actor,acceptedAt,serverDwellMs,analysis,...(decision?{decision}:{})};
  doc.actions.push(move);
  await addEvent(doc,'action_applied',{ply:doc.actions.length,cell,mark,actor,source:decision?.source??'human',before:key(state),after:analysis.afterBoard});
  doc.turnSince=acceptedAt;
  if(decision?.source==='fallback-minimax')doc.eligible=false;
  if(getOutcome(replay(doc.actions)).terminal)await finish(doc);
  else doc.status=getPlayerToMove(replay(doc.actions))===doc.humanMark?'human_turn':'jev_pending';
}
export async function driveJev(env,doc) {
  if(doc.status!=='jev_pending')return doc;
  const state=replay(doc.actions);
  assert(getPlayerToMove(state)!==doc.humanMark,500,'turn_invariant');
  if(doc.lease && doc.lease.expiresAt>Date.now())return doc;
  const abandoned=Boolean(doc.lease),expected=doc.revision;
  doc.revision++;doc.lease={token:randomToken(16),expiresAt:Date.now()+15000};
  const request=getLegalActions(state).length>1?buildJevRequest(state,doc.config.difficulty,doc.config.modelId):null;
  const prepared=await addEvent(doc,abandoned?'decision_recovery':'jev_request_prepared',{basisBoard:key(state),request,inputHash:request?await sha256(request):null,reason:abandoned?'abandoned_inflight_request':null});
  try{await saveMatch(env,doc,expected);}catch(e){if(e.status===409)return getMatch(env,doc.id);throw e;}
  let decision;
  if(abandoned){decision={action:minimaxAction(state),source:'fallback-minimax',request:null,response:null,attempts:[],latencyMs:null,fallbackReason:'abandoned_inflight_request'};}
  else decision=await chooseJevAction({state,difficulty:doc.config.difficulty,modelId:doc.config.modelId,apiKey:env.TYPESAFE_API_KEY,fetchFn:env.FETCH??fetch,budgetMs:doc.config.budgetMs,
    beforeAttempt:async()=>{await quota(env,'global-jev-calls',Number(env.MAX_JEV_CALLS_PER_DAY??5000),86400000);await quota(env,`jev:${doc.userId??doc.ownerSession}`,Number(env.JEV_CALLS_PER_HOUR??300),3600000);},
    inputPricePerMillion:env.INPUT_PRICE_PER_MILLION?Number(env.INPUT_PRICE_PER_MILLION):null,outputPricePerMillion:env.OUTPUT_PRICE_PER_MILLION?Number(env.OUTPUT_PRICE_PER_MILLION):null});
  const current=await getMatch(env,doc.id);
  if(current.revision!==doc.revision||current.lease?.token!==doc.lease.token)return current;
  await addEvent(doc,'jev_result',{decision},prepared.seq);
  await appendMove(doc,state,decision.action.cell,'jev',decision);
  const before=doc.revision;doc.revision++;doc.lease=null;
  try{await saveMatch(env,doc,before);}catch(e){if(e.status===409)return getMatch(env,doc.id);throw e;}
  return doc;
}
export async function act(env,session,id,input) {
  let doc=await ownedMatch(env,session,id);
  assert(typeof input.requestId==='string'&&/^[a-zA-Z0-9_-]{16,80}$/.test(input.requestId),400,'request_id_required');
  assert(Number.isSafeInteger(input.expectedRevision),400,'revision_required');
  const fingerprint=await sha256({expectedRevision:input.expectedRevision,action:input.action});
  const prior=doc.receipts.find(r=>r.id===input.requestId);
  if(prior){assert(prior.fingerprint===fingerprint,409,'idempotency_conflict');return doc;}
  assert(doc.status==='human_turn',409,'not_human_turn');
  assert(doc.revision===input.expectedRevision,409,'stale_revision');
  if(Date.now()>=doc.expiresAt)return expireMatch(env,doc);
  assert(input.action && ['place','resign'].includes(input.action.type),400,'invalid_action');
  const state=replay(doc.actions),expected=doc.revision;
  if(input.action.type==='place'){
    assert(getLegalActions(state).some(a=>a.cell===input.action.cell),400,'illegal_move');
    await appendMove(doc,state,input.action.cell,'human',null,Math.max(0,Date.now()-doc.turnSince));
  }else await finish(doc,'resign');
  doc.receipts.push({id:input.requestId,fingerprint,acceptedAt:Date.now()});
  doc.revision++;
  await saveMatch(env,doc,expected);
  return driveJev(env,doc);
}
export async function expireMatch(env,doc) {
  if(['complete','void'].includes(doc.status))return doc;
  const previous=doc.revision;
  if(doc.status==='jev_pending'){
    doc.status='void';doc.eligible=false;doc.termination='service_interruption';doc.finishedAt=Date.now();doc.lease=null;
    await addEvent(doc,'match_void',{reason:'service_interruption'});
  }else await finish(doc,'expired');
  doc.revision++;
  try{await saveMatch(env,doc,previous);}catch(e){if(e.status===409)return getMatch(env,doc.id);throw e;}
  return doc;
}
export async function maintenance(env) {
  const rows=await all(env,"SELECT doc FROM matches WHERE status IN ('human_turn','jev_pending') AND expires_at<=? LIMIT 100",Date.now());
  for(const row of rows)await expireMatch(env,JSON.parse(row.doc));
  await env.DB.prepare('DELETE FROM sessions WHERE expires_at<? OR last_seen_at<?').bind(Date.now(),Date.now()-86400000).run();
  await env.DB.prepare('DELETE FROM launches WHERE context_expires<?').bind(Date.now()-86400000).run();
  await env.DB.prepare('DELETE FROM quotas WHERE expires_at<?').bind(Date.now()-86400000).run();
  await env.DB.prepare('DELETE FROM operational_counters WHERE day<?').bind(new Date(Date.now()-30*86400000).toISOString().slice(0,10)).run();
}
