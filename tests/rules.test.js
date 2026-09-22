import test from 'node:test';
import assert from 'node:assert/strict';
import {createInitialState,applyAction,replay,getOutcome,getLegalActions,getPlayerToMove,enumerateStates,deserialize,serialize,canonicalBoard,key} from '../public/game/rules.js';
import {value,evaluateActions,minimaxAction} from '../public/game/oracle.js';
import {auditRules} from '../bench/audit.js';

// Independent bitboard implementation: no calls to the application engine.
const masks=[7,56,448,73,146,292,273,84],wins=bits=>masks.some(m=>(bits&m)===m);
const bitStates=new Set(),memo=new Map();
function reference(x=0,o=0,turn=0){
  const id=`${x}:${o}`;bitStates.add(id);
  if(wins(x))return 1;if(wins(o))return -1;if((x|o)===511)return 0;
  if(memo.has(id))return memo.get(id);
  const outcomes=[];for(let cell=0;cell<9;cell++)if(!((x|o)&1<<cell))outcomes.push(turn===0?reference(x|1<<cell,o,1):reference(x,o|1<<cell,0));
  const result=turn===0?Math.max(...outcomes):Math.min(...outcomes);memo.set(id,result);return result;
}
reference();
const bits=state=>[state.board.reduce((b,c,i)=>b|(c==='X'?1<<i:0),0),state.board.reduce((b,c,i)=>b|(c==='O'?1<<i:0),0)];

test('initial state, immutable moves, coordinate independence',()=>{
  const s=createInitialState(),next=applyAction(s,{type:'place',cell:4});assert.equal(s.board[4],'.');assert.equal(next.board[4],'X');assert.equal(getPlayerToMove(next),'O');assert.equal(getLegalActions(s).length,9);
});
test('invalid actions and occupied cells are rejected',()=>{
  const state=replay([4]);for(const cell of [-1,9,0.5,'1',null,NaN,Infinity])assert.throws(()=>applyAction(state,{type:'place',cell}));assert.throws(()=>applyAction(state,{type:'move',cell:1}));assert.throws(()=>applyAction(state,{type:'place',cell:4}));
});
test('terminal games do not accept trailing moves',()=>{
  const moves=[0,3,1,4,2];assert.equal(getOutcome(replay(moves)).winner,'X');assert.deepEqual(getLegalActions(replay(moves)),[]);assert.throws(()=>replay([...moves,5]));assert.throws(()=>replay(Array(10).fill(0)));
});
test('a valid full-board draw reconstructs exactly',()=>{
  const s=replay([0,4,1,2,6,3,5,7,8]);assert.deepEqual(getOutcome(s),{terminal:true,winner:null,winningLines:[]});assert.equal(getPlayerToMove(s),null);assert.deepEqual(deserialize(serialize(s)),s);
});
test('all 19,683 raw boards have correct reachability classification against independent bitboards',()=>{
  let legal=0;
  for(let i=0;i<3**9;i++){
    let n=i;const board=Array.from({length:9},()=>{const c=['.','X','O'][n%3];n=Math.floor(n/3);return c;}),state={rulesVersion:'ttt/1',board},[x,o]=bits(state);
    if(bitStates.has(`${x}:${o}`)){assert.deepEqual(deserialize(state),state);legal++;}else assert.throws(()=>deserialize(state));
  }
  assert.equal(legal,5478);assert.equal(bitStates.size,5478);
});
test('exact oracle agrees with independent bitboard minimax on all reachable boards and 16,167 legal edges',()=>{
  let edges=0;
  for(const state of enumerateStates().values()){
    const[x,o]=bits(state),turn=state.board.filter(c=>c!=='.').length%2,v=reference(x,o,turn);
    assert.equal(value(state,'X'),v,key(state));assert.equal(value(state,'O'),v===0?0:-v,key(state));
    for(const a of evaluateActions(state)){
      const[nextX,nextO]=bits(applyAction(state,{type:'place',cell:a.cell}));const referenceX=reference(nextX,nextO,1-turn);
      assert.equal(a.value,turn===0?referenceX:referenceX===0?0:-referenceX);edges++;
    }
  }
  assert.equal(edges,16167);
});
test('exhaustive board, symmetry, terminal and complete-sequence counts match',()=>{
  const a=auditRules();assert.equal(a.reachableBoards,5478);assert.equal(a.nonterminalBoards,4520);assert.equal(a.symmetryClasses,765);assert.equal(a.completeGames,255168);assert.equal(a.legalEdges,16167);assert.deepEqual(a.sequenceCounts,{X:131184,O:77904,draw:46080});assert.deepEqual(a.terminalCounts,{X:626,O:316,draw:16});
});
test('minimax self-play always draws from the empty board',()=>{let state=createInitialState();while(!getOutcome(state).terminal)state=applyAction(state,minimaxAction(state));assert.equal(getOutcome(state).winner,null);});
test('malformed snapshots and version mismatches reject',()=>{for(const state of [null,{board:[]},{rulesVersion:'ttt/2',board:Array(9).fill('.')},{rulesVersion:'ttt/1',board:Array(9).fill('Z')}])assert.throws(()=>deserialize(state));});
