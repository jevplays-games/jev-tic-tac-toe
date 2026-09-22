import test from 'node:test';import assert from 'node:assert/strict';
import {inspectMove,calibration,quantiles,distributionStats,csv,decisionSummary,summarizeMatches} from '../public/game/analytics.js';
import {replay,createInitialState} from '../public/game/rules.js';
import {sha256,addEvent,verifyEvents,canonical} from '../server/util.js';

test('optimal opening moves are all recognized, not just one tie-break choice',()=>{for(let cell=0;cell<9;cell++){const a=inspectMove(createInitialState(),cell);assert.equal(a.regret,0);assert.equal(a.optimal,true);}});
test('missed win and necessary block are correctly distinguished',()=>{
  const winState=replay([0,3,1,4]);assert.equal(inspectMove(winState,2).missedImmediateWin,false);assert.equal(inspectMove(winState,8).missedImmediateWin,true);
  const blockState=replay([0,4,1]);assert.equal(inspectMove(blockState,2).missedNecessaryBlock,false);assert.equal(inspectMove(blockState,8).missedNecessaryBlock,true);assert.equal(inspectMove(blockState,8).regret,1);
});
test('quantiles ignore missing observations, preserve genuine zero measurements',()=>{assert.deepEqual(quantiles([null,undefined]),{n:0,mean:null,min:null,max:null,p50:null,p95:null,p99:null});assert.equal(quantiles([null,0,10]).mean,5);assert.equal(quantiles([0,10]).p50,5);});
test('calibration perfect predictions have zero Brier, NLL and ECE',()=>{const c=calibration([{label:'draw',probabilities:{win:0,draw:1,loss:0}}]);assert.equal(c.multiclassBrier,0);assert.equal(c.nll,0);assert.equal(c.ece,0);assert.equal(c.accuracy,1);assert.equal(calibration([]).ece,null);});
test('uniform three-way probabilities have expected Brier and entropy',()=>{const p={win:1/3,draw:1/3,loss:1/3};const c=calibration([{label:'draw',probabilities:p}]);assert.ok(Math.abs(c.multiclassBrier-2/3)<1e-10);assert.ok(Math.abs(distributionStats(p).entropyBits-Math.log2(3))<1e-10);});
test('CSV neutralizes spreadsheet formulas and escapes quotes/newlines',()=>{const text=csv([{name:'=HYPERLINK("malicious")',note:'a\nb'}]);assert.match(text,/\'=HYPERLINK/);assert.match(text,/""malicious""/);assert.match(text,/a\nb/);});
test('empty analytics do not manufacture measured performance',()=>{const a=summarizeMatches([]);assert.equal(a.resultRate,null);assert.equal(a.summary.latencyMs.n,0);assert.equal(a.summary.calibration.n,0);assert.deepEqual(a.bySource,{});});
test('hash-linked events detect changes, missing sequence, wrong match and reordering',async()=>{
  const doc={id:'fixture',events:[]};await addEvent(doc,'start',{x:1});await addEvent(doc,'end',{x:2},1);assert.equal((await verifyEvents(doc.events,doc.id)).ok,true);
  const changed=structuredClone(doc.events);changed[0].payload.x=3;assert.equal((await verifyEvents(changed,doc.id)).ok,false);assert.equal((await verifyEvents([...doc.events].reverse(),doc.id)).ok,false);assert.equal((await verifyEvents(doc.events,'wrong')).ok,false);
});
test('canonicalization is key-order independent',async()=>{assert.equal(await sha256({a:1,b:[2,3]}),await sha256({b:[2,3],a:1}));});
test('CSV retains negative numeric oracle labels as numbers, not escaped text',()=>{const text=csv([{value:-1,label:'-formula'}]);assert.ok(text.includes('"-1"'));assert.ok(!text.includes('"\'-1"'));assert.ok(text.includes('"\'-formula"'));});
