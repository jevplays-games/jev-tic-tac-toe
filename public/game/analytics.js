/** Post-decision analytics. Null means not observed; never synthesize model measurements. */
import {getPlayerToMove, getOutcome, other, applyAction, replay, key, canonicalBoard} from './rules.js';
import {evaluateActions} from './oracle.js';
import {winningCells, factorsFor} from './policy.js';
export const ANALYTICS_VERSION='analytics/1';
export function inspectMove(state, cell) {
  const mark=getPlayerToMove(state), candidates=evaluateActions(state), chosen=candidates.find(c=>c.cell===cell);
  if (!chosen) throw new Error('Cannot analyze illegal move');
  const best=Math.max(...candidates.map(c=>c.value));
  const after=applyAction(state,{type:'place',cell});
  const forkCells=candidates.filter(c=>{const next=applyAction(state,{type:'place',cell:c.cell});return !getOutcome(next).terminal && winningCells(next.board,mark).length>=2;}).map(c=>c.cell);
  const immediateWins=winningCells(state.board,mark);
  const opponentThreat=winningCells(state.board,other(mark)).length>0;
  const safeBlocks=candidates.filter(c=>{
    const s=applyAction(state,{type:'place',cell:c.cell});
    return getOutcome(s).winner===mark || (!winningCells(s.board,other(mark)).length && !getOutcome(s).winner);
  });
  return {board:key(state),canonicalBoard:canonicalBoard(state),ply:state.board.filter(c=>c!=='.').length+1,mark,cell,
    valueBefore:best,valueAfter:chosen.value,regret:best-chosen.value,optimal:chosen.value===best,
    optimalCells:candidates.filter(c=>c.value===best).map(c=>c.cell),candidates,
    errorType:chosen.value===best ? null : `${best===1?'win':'draw'}_to_${chosen.value===0?'draw':'loss'}`,
    winOpportunity:immediateWins.length>0,missedImmediateWin:immediateWins.length>0 && !immediateWins.includes(cell),
    necessaryBlockOpportunity:opponentThreat && immediateWins.length===0 && safeBlocks.length>0,
    missedNecessaryBlock:opponentThreat && immediateWins.length===0 && safeBlocks.length>0 && !safeBlocks.some(c=>c.cell===cell),
    forkOpportunity:forkCells.length>0,createsFork:forkCells.includes(cell),forkCells,
    factors:factorsFor(state,cell),afterBoard:key(after)
  };
}
export const ratio=(numerator,denominator)=>denominator ? numerator/denominator : null;
export function quantiles(values) {
  const xs=values.filter(x=>typeof x==='number' && Number.isFinite(x)).sort((a,b)=>a-b);
  const q=p=>{ if (!xs.length) return null; const i=(xs.length-1)*p,a=Math.floor(i); return xs[a]+(xs[Math.ceil(i)]-xs[a])*(i-a); };
  return {n:xs.length,mean:xs.length?xs.reduce((a,b)=>a+b,0)/xs.length:null,min:xs[0]??null,max:xs.at(-1)??null,p50:q(.5),p95:q(.95),p99:q(.99)};
}
export function distributionStats(probabilities) {
  if (!probabilities) return null;
  const p=Object.values(probabilities),sorted=[...p].sort((a,b)=>b-a),total=p.reduce((a,b)=>a+b,0);
  const normalized=p.map(x=>x/total);
  const entropyBits=-normalized.reduce((sum,x)=>sum+(x?x*Math.log2(x):0),0);
  return {entropyBits,normalizedEntropy:p.length>1?entropyBits/Math.log2(p.length):0,topMargin:(sorted[0]??0)-(sorted[1]??0)};
}
export function calibration(rows) {
  const bins=Array.from({length:10},(_,i)=>({lower:i/10,upper:(i+1)/10,n:0,confidenceSum:0,correct:0}));
  let brier=0,nll=0,correct=0;
  for (const row of rows) {
    const entries=Object.entries(row.probabilities),total=entries.reduce((a,[,p])=>a+p,0);
    const normalized=Object.fromEntries(entries.map(([label,p])=>[label,p/total]));
    const [prediction,confidence]=Object.entries(normalized).sort((a,b)=>b[1]-a[1])[0];
    const hit=prediction===row.label ? 1:0;
    brier+=Object.entries(normalized).reduce((a,[label,p])=>a+(p-(label===row.label?1:0))**2,0);
    nll-=Math.log(Math.max(1e-15,normalized[row.label]??0)); correct+=hit;
    const bin=bins[Math.min(9,Math.floor(confidence*10))]; bin.n++;bin.confidenceSum+=confidence;bin.correct+=hit;
  }
  return {n:rows.length,accuracy:ratio(correct,rows.length),multiclassBrier:ratio(brier,rows.length),nll:ratio(nll,rows.length),ece:rows.length?bins.reduce((a,b)=>a+(b.n?Math.abs(b.correct/b.n-b.confidenceSum/b.n)*b.n:0),0)/rows.length:null,
    bins:bins.map(b=>({lower:b.lower,upper:b.upper,n:b.n,accuracy:ratio(b.correct,b.n),meanConfidence:ratio(b.confidenceSum,b.n)}))};
}
export function decisionSummary(moves) {
  const models=moves.filter(m=>m.decision?.source==='jev'), forced=moves.filter(m=>m.decision?.source==='forced'),fallback=moves.filter(m=>m.decision?.source?.includes('fallback'));
  const calibrationRows=[],optimalMass=[],expectedValues=[];
  const fallbackReasons={},attemptOutcomes={};
  for(const m of moves){if(m.decision?.fallbackReason)fallbackReasons[m.decision.fallbackReason]=(fallbackReasons[m.decision.fallbackReason]??0)+1;for(const a of m.decision?.attempts??[])attemptOutcomes[a.result??'unknown']=(attemptOutcomes[a.result??'unknown']??0)+1;}
  for(const m of models){const p=m.decision.response?.answers?.preference?.probabilities;if(p){const total=Object.values(p).reduce((a,b)=>a+b,0);optimalMass.push(m.analysis.optimalCells.reduce((sum,cell)=>sum+(p[`cell_${cell}`]??0)/total,0));expectedValues.push(m.analysis.candidates.reduce((sum,c)=>sum+c.value*(p[`cell_${c.cell}`]??0)/total,0));}}
  for (const m of models) for (const candidate of m.analysis.candidates) {
    const a=m.decision.response?.answers?.[`outcome_${candidate.cell}`];
    if (a) calibrationRows.push({label:candidate.value===1?'win':candidate.value===0?'draw':'loss',probabilities:a.probabilities});
  }
  return {moves:moves.length,fallbackReasons,attemptOutcomes,
    forkOpportunities:moves.filter(m=>m.analysis?.forkOpportunity).length,forksCreated:moves.filter(m=>m.analysis?.createsFork).length,
    valueTransitions:Object.fromEntries(['win_to_draw','win_to_loss','draw_to_loss'].map(type=>[type,moves.filter(m=>m.analysis?.errorType===type).length])),
    optimalPreferenceMass:quantiles(optimalMass),preferenceExpectedOracleValue:quantiles(expectedValues),
    entropyBits:quantiles(models.map(m=>m.decision.distribution?.entropyBits)),topMargin:quantiles(models.map(m=>m.decision.distribution?.topMargin)),
    inputBytes:quantiles(moves.map(m=>m.decision?.inputBytes)),candidateCounts:quantiles(moves.filter(m=>m.actor!=='human').map(m=>m.analysis?.candidates.length)),
    knownEstimatedCostUsd:moves.some(m=>typeof m.decision?.estimatedCostUsd==='number')?moves.reduce((sum,m)=>sum+(m.decision?.estimatedCostUsd??0),0):null,
    pricedDecisions:moves.filter(m=>typeof m.decision?.estimatedCostUsd==='number').length,
    unknownAttemptUsage:moves.reduce((sum,m)=>sum+Math.max(0,(m.decision?.attempts?.length??0)-(m.decision?.response?.usage?1:0)),0),
    optimal: moves.filter(m=>m.analysis?.optimal).length,optimalRate:ratio(moves.filter(m=>m.analysis?.optimal).length,moves.length),
    meanRegret:ratio(moves.reduce((a,m)=>a+(m.analysis?.regret??0),0),moves.length),
    avoidableLosses:moves.filter(m=>m.analysis?.valueBefore>=0 && m.analysis?.valueAfter===-1).length,
    winOpportunities:moves.filter(m=>m.analysis?.winOpportunity).length,missedWins:moves.filter(m=>m.analysis?.missedImmediateWin).length,
    blockOpportunities:moves.filter(m=>m.analysis?.necessaryBlockOpportunity).length,missedBlocks:moves.filter(m=>m.analysis?.missedNecessaryBlock).length,
    jevCalls:models.length,forced:forced.length,fallback:fallback.length,
    latencyMs:quantiles(moves.map(m=>m.decision?.latencyMs)),providerLatencyMs:quantiles(moves.flatMap(m=>m.decision?.attempts?.map(a=>a.latencyMs)??[])),
    humanDwellMs:quantiles(moves.filter(m=>m.actor==='human').map(m=>m.serverDwellMs)),
    reportedConfidence:quantiles(models.map(m=>m.decision.response?.answers?.preference?.confidence)),
    inputTokens:models.reduce((a,m)=>a+(m.decision.response?.usage?.input_tokens??0),0),outputTokens:models.reduce((a,m)=>a+(m.decision.response?.usage?.output_tokens??0),0),
    usageKnown:models.filter(m=>m.decision.response?.usage).length,
    retries:moves.reduce((a,m)=>a+Math.max(0,(m.decision?.attempts?.length??0)-1),0),
    calibration:calibration(calibrationRows),cellCounts:Array.from({length:9},(_,cell)=>moves.filter(m=>m.cell===cell).length)};
}
export function summarizeMatches(matches) {
  const complete=matches.filter(m=>m.status==='complete');
  const moves=complete.flatMap(m=>m.actions??[]), bySource={},byPly={},byConfig={},byCohort={};
  for (const source of new Set(moves.map(m=>m.actor==='human'?'human':m.decision?.source??'unknown'))) bySource[source]=decisionSummary(moves.filter(m=>(m.actor==='human'?'human':m.decision?.source??'unknown')===source));
  for (let ply=1;ply<=9;ply++) byPly[ply]=decisionSummary(moves.filter(m=>m.analysis?.ply===ply));
  for (const c of new Set(complete.map(m=>m.configHash))) {
    const cohort=complete.filter(m=>m.configHash===c);
    byConfig[c]={config:cohort[0].config,matches:cohort.length,summary:decisionSummary(cohort.flatMap(m=>m.actions))};
  }
  for(const m of complete){const cohortId=`${m.configHash}/${m.humanMark}`;byCohort[cohortId]??={config:m.config,configHash:m.configHash,humanMark:m.humanMark,matches:0,moves:[]};byCohort[cohortId].matches++;byCohort[cohortId].moves.push(...m.actions);}
  for(const cohort of Object.values(byCohort)){cohort.summary=decisionSummary(cohort.moves);delete cohort.moves;}
  const wins=complete.filter(m=>m.outcome==='win').length,draws=complete.filter(m=>m.outcome==='draw').length,losses=complete.filter(m=>m.outcome==='loss').length;
  const chronological=[...complete].sort((a,b)=>a.finishedAt-b.finishedAt);
  let current=0,best=0;
  for (const m of chronological) {current=m.outcome==='win'?current+1:0;best=Math.max(best,current);}
  return {version:ANALYTICS_VERSION,matches:complete.length,void:matches.filter(m=>m.status==='void').length,rankedEligible:complete.filter(m=>m.eligible).length,wins,draws,losses,resultRate:ratio(wins+.5*draws,complete.length),winRate:ratio(wins,complete.length),currentWinStreak:current,bestWinStreak:best,
    forfeits:complete.filter(m=>['resign','expired'].includes(m.termination)).length,summary:decisionSummary(moves),bySource,byPly,byConfig,byCohort};
}
export function analyzeReplay(moves) {
  return moves.map((move,i)=>inspectMove(replay(moves.slice(0,i)),typeof move==='number'?move:move.cell));
}
export function csv(rows, fields=Object.keys(rows[0]??{})) {
  const escape=value=>{let s=typeof value==='object'&&value!==null?JSON.stringify(value):String(value??'');if (typeof value==='string' && /^\s*[=+@\-\t\r]/.test(s)) s="'"+s;return '"'+s.replaceAll('"','""')+'"';};
  return [fields.map(escape).join(','),...rows.map(row=>fields.map(f=>escape(row[f])).join(','))].join('\r\n');
}
