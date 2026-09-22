import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {runBenchmark} from '../bench/run.js';

test('offline benchmark is labeled, repeatable, resumable and rejects mixed treatments',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'jev-bench-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const options={out:dir,source:'minimax',mode:'positions',limit:40,seed:123,repeats:2};
  const result=await runBenchmark(options);assert.equal(result.samples,80);assert.equal(result.focalSummary.optimalRate,1);assert.equal(result.providerAttempts,0);assert.equal(result.replication.disagreementRate,0);assert.equal(result.basis,'offline_baselines_NOT_JEV');
  const previous=readFileSync(join(dir,'results.ndjson'),'utf8');const resumed=await runBenchmark({...options,resume:true});assert.equal(resumed.samples,80);assert.equal(readFileSync(join(dir,'results.ndjson'),'utf8'),previous);
  await assert.rejects(()=>runBenchmark({...options,resume:true,profile:'hard'}),/Mixed treatment/);
});
test('benchmark never spends API credits without explicit live confirmation',async()=>{await assert.rejects(()=>runBenchmark({source:'jev',limit:1}),/confirm-live/);});
test('minimax game benchmark distinguishes sides and draws against itself',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'jev-games-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const report=await runBenchmark({out:dir,source:'minimax',opponent:'minimax',mode:'games',limit:10});assert.equal(report.games.draws,10);assert.equal(report.games.byMark.X.games,5);assert.equal(report.games.byMark.O.games,5);assert.equal(report.games.withFallback,0);
});
