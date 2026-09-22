import {fileURLToPath} from 'node:url';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createInitialState,enumerateStates,getLegalActions,applyAction,getOutcome,getPlayerToMove,canonicalBoard,key} from '../public/game/rules.js';
import {evaluateActions,value} from '../public/game/oracle.js';
import {csv} from '../public/game/analytics.js';
import {sha256} from '../server/util.js';

export function auditRules(){
  const states=enumerateStates(),byPly={},terminalCounts={X:0,O:0,draw:0},sequenceCounts={X:0,O:0,draw:0},classSet=new Set();
  let nonterminalBoards=0,edges=0;
  for(const state of states.values()){
    const ply=state.board.filter(c=>c!=='.').length,out=getOutcome(state);
    byPly[ply]??={boards:0,terminal:0,edges:0};byPly[ply].boards++;
    classSet.add(canonicalBoard(state));
    if(out.terminal){terminalCounts[out.winner??'draw']++;byPly[ply].terminal++;}else nonterminalBoards++;
    const n=getLegalActions(state).length;edges+=n;byPly[ply].edges+=n;
  }
  function walk(state){const out=getOutcome(state);if(out.terminal){sequenceCounts[out.winner??'draw']++;return;}for(const a of getLegalActions(state))walk(applyAction(state,a));}
  walk(createInitialState());
  return {schemaVersion:1,rulesVersion:'ttt/1',basis:'exhaustive deterministic rules traversal; not model performance',rawAssignments:3**9,reachableBoards:states.size,nonterminalBoards,symmetryClasses:classSet.size,completeGames:Object.values(sequenceCounts).reduce((a,b)=>a+b,0),legalEdges:edges,terminalCounts,sequenceCounts,emptyBoardMinimax:value(createInitialState(),'X'),byPly};
}
export async function writeAudit(outDir='reports'){
  mkdirSync(outDir,{recursive:true});const report=auditRules();
  const expected={reachableBoards:5478,nonterminalBoards:4520,symmetryClasses:765,completeGames:255168};
  for(const[k,v]of Object.entries(expected))if(report[k]!==v)throw new Error(`${k}: expected ${v}, got ${report[k]}`);
  const states=[...enumerateStates().values()].sort((a,b)=>key(a).localeCompare(key(b))),rows=[],edges=[];
  for(const state of states){
    const actions=evaluateActions(state),player=getPlayerToMove(state),out=getOutcome(state);
    rows.push({board:key(state),canonicalBoard:canonicalBoard(state),ply:state.board.filter(c=>c!=='.').length,toMove:player,terminal:out.terminal,winner:out.winner,valueForX:value(state,'X'),optimalCells:actions.filter(a=>a.value===Math.max(...actions.map(a=>a.value))).map(a=>a.cell),actions});
    for(const a of actions)edges.push({board:key(state),canonicalBoard:canonicalBoard(state),toMove:player,cell:a.cell,value:a.value,after:key(applyAction(state,{type:'place',cell:a.cell}))});
  }
  const corpus=rows.map(row=>JSON.stringify(row)).join('\n')+'\n';report.corpusSha256=await sha256(corpus);
  writeFileSync(resolve(outDir,'reference-audit.json'),JSON.stringify(report,null,2)+'\n');
  writeFileSync(resolve(outDir,'reference-states.ndjson'),corpus);writeFileSync(resolve(outDir,'reference-edges.csv'),csv(edges));
  writeFileSync(new URL('../public/reference-audit.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
  return report;
}
if(process.argv[1]&&resolve(process.argv[1])===resolve(fileURLToPath(import.meta.url)))console.log(JSON.stringify(await writeAudit(process.argv[2]??'reports'),null,2));
