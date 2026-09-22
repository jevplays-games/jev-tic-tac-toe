import test from 'node:test';
import assert from 'node:assert/strict';
import {createInitialState,replay,enumerateStates,getOutcome,getLegalActions} from '../public/game/rules.js';
import {buildJevRequest,validateJevResponse,selectJevAction,generateCandidates} from '../public/game/policy.js';
import {chooseJevAction} from '../server/jev.js';
import {responseFor} from './helpers.js';
const model='jev-1.13.0';
const request=buildJevRequest(replay([0]),'normal',model);

test('all profiles contain exactly the legal actions, no oracle or identity fields',()=>{
  for(const difficulty of ['easy','normal','hard','jev'])for(const state of enumerateStates().values()){
    if(getOutcome(state).terminal)continue;
    const req=buildJevRequest(state,difficulty,model);
    assert.equal(req.state.candidates.length,getLegalActions(state).length);
    assert.deepEqual(req.state.candidates.map(c=>c.cell),getLegalActions(state).map(c=>c.cell));
    assert.ok(!/minimax|optimalCells|valueBefore|valueAfter|discord|guild|channelId|userId/.test(JSON.stringify(req)));
    if(difficulty==='easy')assert.equal(req.state.candidates[0].features,undefined);
  }
});
test('JEV full profile encodes candidate references in question instructions',()=>{const req=buildJevRequest(createInitialState(),'jev',model);assert.equal(Object.keys(req.questions).length,10);assert.equal(req.questions.outcome_0.instructions.candidateActionId,'cell_0');});
test('valid documented response is accepted without extra provider fields',()=>{const r=responseFor(request);r.debug='discard';assert.equal(validateJevResponse(r,request).debug,undefined);});
test('wrong model, missing question, invalid action, bad distributions, bad confidence reject',()=>{
  const mutators=[r=>{r.model='jev-latest';},r=>{delete r.answers.preference;},r=>{r.answers.preference.choice='cell_0';},r=>{r.answers.preference.probabilities.cell_8=5;},r=>{r.answers.preference.probabilities.cell_4=NaN;},r=>{r.answers.preference.confidence=2;},r=>{r.usage.input_tokens=-1;},r=>{r.answers.preference.choice='cell_1';}];
  for(const mutate of mutators){const response=responseFor(request);mutate(response);assert.throws(()=>validateJevResponse(response,request));}
});
test('full profile selection is based on outcome probabilities and deterministic ties',()=>{
  const req=buildJevRequest(createInitialState(),'jev',model),response=responseFor(req);
  for(const answer of Object.values(response.answers)){const opts=Object.keys(answer.probabilities);for(const option of opts)answer.probabilities[option]=1/opts.length;answer.choice=opts[0];answer.confidence=0;}
  validateJevResponse(response,req);assert.equal(selectJevAction(response,req,'jev').cell,4);
});
test('adapter records actual request, response, latency, tokens and hashes',async()=>{
  const result=await chooseJevAction({state:replay([0]),difficulty:'normal',modelId:model,apiKey:'fixture',fetchFn:async(_url,options)=>new Response(JSON.stringify(responseFor(JSON.parse(options.body))))});
  assert.equal(result.source,'jev');assert.ok(result.latencyMs>=0);assert.equal(result.inputHash.length,64);assert.equal(result.response.usage.input_tokens,100);assert.equal(result.estimatedCostUsd,null);
});
test('no API key means a labeled deterministic fallback, not mock JEV',async()=>{const d=await chooseJevAction({state:createInitialState(),difficulty:'normal',modelId:model});assert.equal(d.source,'fallback-minimax');assert.equal(d.fallbackReason,'missing_api_key');assert.equal(d.response,null);assert.equal(d.action.cell,4);});
test('one legal placement avoids a provider call and is labeled forced',async()=>{
  const state=replay([0,4,1,2,6,3,5,7]);let calls=0;
  const d=await chooseJevAction({state,difficulty:'jev',modelId:model,apiKey:'fixture',fetchFn:async()=>{calls++;throw new Error();}});assert.equal(d.source,'forced');assert.equal(calls,0);assert.equal(d.action.cell,8);
});
test('malformed structured output falls back without rerolling',async()=>{
  let calls=0;const d=await chooseJevAction({state:replay([0]),difficulty:'normal',modelId:model,apiKey:'fixture',fetchFn:async()=>{calls++;return new Response(JSON.stringify({model,answers:{}}));}});assert.equal(d.source,'fallback-minimax');assert.equal(calls,1);
});
test('transient failure retries once within the budget',async()=>{
  let calls=0;const d=await chooseJevAction({state:replay([0]),difficulty:'normal',modelId:model,apiKey:'fixture',fetchFn:async(_url,options)=>++calls===1?new Response('unavailable',{status:503}):new Response(JSON.stringify(responseFor(JSON.parse(options.body))))});assert.equal(d.source,'jev');assert.equal(calls,2);assert.equal(d.attempts[0].httpStatus,503);
});
test('Retry-After beyond remaining budget does not trigger another call',async()=>{
  let calls=0;const d=await chooseJevAction({state:replay([0]),difficulty:'normal',modelId:model,apiKey:'fixture',budgetMs:100,fetchFn:async()=>{calls++;return new Response('rate',{status:429,headers:{'Retry-After':'60'}});}});assert.equal(calls,1);assert.equal(d.source,'fallback-minimax');
});
test('abort deadline causes a timeout fallback',async()=>{
  const d=await chooseJevAction({state:replay([0]),difficulty:'normal',modelId:model,apiKey:'fixture',budgetMs:30,fetchFn:(_url,options)=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>resolve(new Response('{}')),200);options.signal.addEventListener('abort',()=>{clearTimeout(timer);reject(new DOMException('aborted','AbortError'));});})});assert.equal(d.fallbackReason,'timeout');assert.equal(d.source,'fallback-minimax');
});
