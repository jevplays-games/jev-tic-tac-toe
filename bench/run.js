import {fileURLToPath} from 'node:url';
import {mkdirSync,readFileSync,writeFileSync,existsSync,openSync,writeSync,fsyncSync,closeSync,renameSync} from 'node:fs';
import {resolve} from 'node:path';
import {enumerateStates,getOutcome,getLegalActions,getPlayerToMove,createInitialState,applyAction,canonicalBoard,key,other} from '../public/game/rules.js';
import {minimaxAction} from '../public/game/oracle.js';
import {tacticalAction} from '../public/game/policy.js';
import {inspectMove,decisionSummary,quantiles} from '../public/game/analytics.js';
import {chooseJevAction} from '../server/jev.js';
import {configuration} from '../server/matches.js';
import {sha256,canonical} from '../server/util.js';

function args(argv){const out={};for(let i=0;i<argv.length;i++){if(!argv[i].startsWith('--'))throw new Error(`Unexpected argument ${argv[i]}`);const k=argv[i].slice(2);out[k]=argv[i+1]&&!argv[i+1].startsWith('--')?argv[++i]:true;}return out;}
function integer(value,fallback,min,max){const n=Number(value??fallback);if(!Number.isSafeInteger(n)||n<min||n>max)throw new Error(`Integer outside ${min}..${max}`);return n;}
function generator(seed){let x=seed>>>0||1;return ()=>{x^=x<<13;x^=x>>>17;x^=x<<5;return (x>>>0)/4294967296;};}
function atomicWrite(path,data){writeFileSync(path+'.tmp',JSON.stringify(data,null,2)+'\n');renameSync(path+'.tmp',path);}
async function loadRows(path){
  if(!existsSync(path))return [];
  const text=readFileSync(path,'utf8');if(text&&!text.endsWith('\n'))throw new Error('Interrupted final NDJSON line. Preserve file and remove only the incomplete final line before resuming.');
  const rows=text.trim()?text.trim().split('\n').map(JSON.parse):[];let previous='0'.repeat(64);
  for(const [i,row]of rows.entries()){const{hash,...body}=row;if(body.seq!==i+1||body.previousHash!==previous||hash!==await sha256(body))throw new Error(`Corrupt result chain at row ${i+1}`);previous=hash;}
  return rows;
}
export async function runBenchmark(options){
  const source=options.source??'minimax',mode=options.mode??'positions',opponent=options.opponent??'random',profile=options.profile??'normal';
  if(!['jev','minimax','random','tactical'].includes(source)||!['positions','games'].includes(mode)||!['jev','minimax','random','tactical'].includes(opponent))throw new Error('Invalid source, mode or opponent');
  const live=source==='jev'||mode==='games'&&opponent==='jev';
  if(live&&(!options['confirm-live']||!process.env.TYPESAFE_API_KEY))throw new Error('Live evaluation requires TYPESAFE_API_KEY and --confirm-live. It spends API credits.');
  const limit=integer(options.limit,mode==='positions'?4520:200,1,100000),repeats=integer(options.repeats,1,1,20),seed=integer(options.seed,20260922,1,2147483647),maxCalls=integer(options['max-calls'],100,1,200000),split=options.split??'all';
  if(!['all','development','validation','test'].includes(split))throw new Error('Invalid split');
  const config=configuration({PINNED_JEV_MODEL:process.env.PINNED_JEV_MODEL??'jev-1.13.0'},profile);
  const harnessHash=await sha256(readFileSync(fileURLToPath(import.meta.url),'utf8'));
  const spec={schemaVersion:1,harnessHash,mode,source,opponent,profile,limit,repeats,seed,split,maxCalls,config};
  const specHash=await sha256(spec),dir=resolve(options.out??`bench-runs/${mode}-${source}-${profile}`);
  mkdirSync(dir,{recursive:true});const manifestPath=resolve(dir,'manifest.json'),rowsPath=resolve(dir,'results.ndjson'),requestsPath=resolve(dir,'request-ledger.ndjson');
  let manifest;
  if(existsSync(manifestPath)){
    if(!options.resume)throw new Error('Output directory contains a run; use --resume or a new --out.');
    manifest=JSON.parse(readFileSync(manifestPath,'utf8'));if(manifest.specHash!==specHash)throw new Error('Mixed treatment rejected: manifest specification differs.');
  }else{manifest={runId:crypto.randomUUID(),createdAt:new Date().toISOString(),specHash,spec,live};atomicWrite(manifestPath,manifest);}
  const rows=await loadRows(rowsPath),seen=new Set(rows.map(r=>r.payload.sampleId));
  const ledgerText=existsSync(requestsPath)?readFileSync(requestsPath,'utf8'):'';
  if(ledgerText&&!ledgerText.endsWith('\n'))throw new Error('Incomplete request-ledger line; preserve the interrupted run.');
  const ledger=ledgerText.trim()?ledgerText.trim().split('\n').map(JSON.parse):[];
  if(live&&ledger.some(entry=>!seen.has(entry.sampleId)))throw new Error('Uncommitted live request found. This run cannot safely resume without re-sampling; preserve it and use a new output directory.');
  let calls=ledger.length,currentSampleId=null;
  const resultFd=openSync(rowsPath,'a'),requestFd=openSync(requestsPath,'a');
  const rng=generator(seed);
  async function append(payload){const body={schemaVersion:1,runId:manifest.runId,seq:rows.length+1,at:new Date().toISOString(),previousHash:rows.at(-1)?.hash??'0'.repeat(64),payload};const row={...body,hash:await sha256(body)};writeSync(resultFd,JSON.stringify(row)+'\n');fsyncSync(resultFd);rows.push(row);seen.add(payload.sampleId);}
  async function decide(state,kind,sampleSeed){
    if(kind==='jev')return chooseJevAction({state,difficulty:profile,modelId:config.modelId,apiKey:process.env.TYPESAFE_API_KEY,budgetMs:config.budgetMs,beforeAttempt:async({inputHash})=>{
      if(calls>=maxCalls)throw new Error('Call budget exhausted');calls++;
      writeSync(requestFd,JSON.stringify({schemaVersion:1,runId:manifest.runId,attempt:calls,at:new Date().toISOString(),board:key(state),sampleId:currentSampleId,inputHash})+'\n');fsyncSync(requestFd);
    }});
    const start=performance.now(),legal=getLegalActions(state);const rand=generator(sampleSeed);
    const action=kind==='minimax'?minimaxAction(state):kind==='tactical'?tacticalAction(state):legal[Math.floor(rand()*legal.length)];
    return {action,source:`baseline-${kind}`,latencyMs:performance.now()-start,attempts:[],request:null,response:null,fallbackReason:null};
  }
  const makeMove=(state,decision,actor)=>({cell:decision.action.cell,mark:getPlayerToMove(state),actor,analysis:inspectMove(state,decision.action.cell),decision,serverDwellMs:null});
  let stopReason=null;
  try{
    if(mode==='positions'){
      const states=[...enumerateStates().values()].filter(s=>!getOutcome(s).terminal);
      const samples=[];
      for(const state of states){const canonicalKey=canonicalBoard(state),h=await sha256(`${seed}|${canonicalKey}`),group=Number.parseInt(h.slice(0,8),16)%10,partition=group<6?'development':group<8?'validation':'test';if(split==='all'||split===partition)samples.push({state,partition,sort:await sha256(`${seed}|${key(state)}`)});}
      samples.sort((a,b)=>a.sort.localeCompare(b.sort));
      for(const item of samples.slice(0,limit))for(let repeat=0;repeat<repeats;repeat++){
        const sampleId=`${key(item.state)}:${repeat}`;if(seen.has(sampleId))continue;currentSampleId=sampleId;
        if(live&&calls>=maxCalls){stopReason='call_budget_exhausted';break;}
        const decision=await decide(item.state,source,Number.parseInt((await sha256(`${seed}|${sampleId}`)).slice(0,8),16));
        await append({sampleId,kind:'position',partition:item.partition,repeat,board:key(item.state),move:makeMove(item.state,decision,'focal')});
      }
    }else{
      for(let game=0;game<limit;game++)for(let repeat=0;repeat<repeats;repeat++){
        const sampleId=`game:${game}:${repeat}`;if(seen.has(sampleId))continue;currentSampleId=sampleId;
        if(live&&calls>=maxCalls){stopReason='call_budget_exhausted';break;}
        let state=createInitialState();const focalMark=game%2?'O':'X',moves=[];
        while(!getOutcome(state).terminal){const actor=getPlayerToMove(state)===focalMark?'focal':'opponent',kind=actor==='focal'?source:opponent;
          const sampleSeed=Number.parseInt((await sha256(`${seed}|${sampleId}|${moves.length}`)).slice(0,8),16),decision=await decide(state,kind,sampleSeed);
          moves.push(makeMove(state,decision,actor));state=applyAction(state,decision.action);
        }
        const result=getOutcome(state);await append({sampleId,kind:'game',game,repeat,focalMark,moves,focalOutcome:result.winner===null?'draw':result.winner===focalMark?'win':'loss'});
      }
    }
  }finally{closeSync(resultFd);closeSync(requestFd);}
  const moves=rows.flatMap(r=>r.payload.kind==='position'?[r.payload.move]:r.payload.moves),sources={};
  for(const s of new Set(moves.map(m=>m.decision.source)))sources[s]=decisionSummary(moves.filter(m=>m.decision.source===s));
  const focal=moves.filter(m=>m.actor==='focal');
  const repetitions=new Map();for(const row of rows)if(row.payload.kind==='position'){const p=row.payload;const group=repetitions.get(p.board)??[];group.push(p.move.cell);repetitions.set(p.board,group);}
  const replicated=[...repetitions.values()].filter(group=>group.length>1);
  const byPly={};for(let ply=1;ply<=9;ply++){const subset=focal.filter(m=>m.analysis.ply===ply);if(subset.length)byPly[ply]=decisionSummary(subset);}
  const byPartition={};for(const partition of ['development','validation','test']){const subset=rows.filter(r=>r.payload.partition===partition).map(r=>r.payload.move);if(subset.length)byPartition[partition]=decisionSummary(subset);}
  const summary={schemaVersion:1,runId:manifest.runId,specHash,generatedAt:new Date().toISOString(),basis:live?'live_provider_observations_with_source_separation':'offline_baselines_NOT_JEV',samples:rows.length,providerAttempts:calls,stopReason,resultChainHead:rows.at(-1)?.hash??null,
    coverage:{distinctPositions:new Set(moves.map(m=>m.analysis.board)).size,distinctFocalPositions:new Set(focal.map(m=>m.analysis.board)).size,reachableNonterminalUniverse:4520,repeats,split},sources,byPly,byPartition,replication:{replicatedPositions:replicated.length,disagreeingPositions:replicated.filter(g=>new Set(g).size>1).length,disagreementRate:replicated.length?replicated.filter(g=>new Set(g).size>1).length/replicated.length:null},focalSummary:decisionSummary(focal),
    games:mode==='games'?{total:rows.length,wins:rows.filter(r=>r.payload.focalOutcome==='win').length,draws:rows.filter(r=>r.payload.focalOutcome==='draw').length,losses:rows.filter(r=>r.payload.focalOutcome==='loss').length,withFallback:rows.filter(r=>r.payload.moves.some(m=>m.decision.source==='fallback-minimax')).length,byMark:Object.fromEntries(['X','O'].map(mark=>[mark,{games:rows.filter(r=>r.payload.focalMark===mark).length,wins:rows.filter(r=>r.payload.focalMark===mark&&r.payload.focalOutcome==='win').length,draws:rows.filter(r=>r.payload.focalMark===mark&&r.payload.focalOutcome==='draw').length,losses:rows.filter(r=>r.payload.focalMark===mark&&r.payload.focalOutcome==='loss').length}]))}:null};
  atomicWrite(resolve(dir,'summary.json'),summary);
  console.log(JSON.stringify({out:dir,samples:summary.samples,basis:summary.basis,providerAttempts:calls,stopReason},null,2));return summary;
}
if(process.argv[1]&&resolve(process.argv[1])===resolve(fileURLToPath(import.meta.url)))runBenchmark(args(process.argv.slice(2))).catch(e=>{console.error(e.message);process.exitCode=1;});
