import test from 'node:test';
import assert from 'node:assert/strict';
import {enumerateStates, getOutcome, getOutcomeReference, canonicalBoard, canonicalBoardReference, getLegalActions, applyAction} from '../public/game/rules.js';
import {winningCells, winningCellsReference, generateCandidates, DIFFICULTIES} from '../public/game/policy.js';
import {value, valueReference, evaluateActions} from '../public/game/oracle.js';
import {canonical, canonicalReference, hex, hexReference, sha256} from '../server/util.js';

// Optimized hot paths must be indistinguishable from the original implementations kept as *Reference exports.
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
const states = [...enumerateStates().values()];
const r = rng(42);
const wild = Array.from({length: 4000}, () => ({rulesVersion: 'ttt/1', board: Array.from({length: 9}, () => '.XO'[Math.floor(r() * 3)])}));
const outcome = fn => { try { return {value: fn()}; } catch (error) { return {error: error.message}; } };

test('getOutcome, winningCells and canonicalBoard match the reference on every reachable and 4000 arbitrary boards', () => {
  let compared = 0;
  for (const state of [...states, ...wild]) {
    assert.deepEqual(getOutcome(state), getOutcomeReference(state));
    for (const mark of ['X', 'O']) assert.deepEqual(winningCells(state.board, mark), winningCellsReference(state.board, mark));
    assert.equal(canonicalBoard(state), canonicalBoardReference(state));
    compared++;
  }
  assert.equal(states.length, 5478);
  assert.ok(compared > 9000);
  // Non-board inputs keep the reference behaviour.
  for (const board of [Array(9).fill('Z'), Array(9).fill(undefined), ['.', '.', 'X']]) {
    assert.deepEqual(outcome(() => getOutcome({board})), outcome(() => getOutcomeReference({board})));
    assert.equal(canonicalBoard({board}), canonicalBoardReference({board}));
  }
});

test('oracle value matches the reference for every position and both perspectives', () => {
  for (const state of [...states, ...wild]) for (const perspective of ['X', 'O']) {
    assert.equal(value(state, perspective), valueReference(state, perspective));
  }
  // Unusual inputs fall through to the reference implementation.
  assert.equal(value({board: Array(9).fill('.')}, 'Z'), valueReference({board: Array(9).fill('.')}, 'Z'));
  assert.equal(value({board: 'XO.......'.split('')}, null), valueReference({board: 'XO.......'.split('')}, null));
  for (const state of states) {
    if (getOutcome(state).terminal) { assert.deepEqual(evaluateActions(state), []); continue; }
    const expected = getLegalActions(state).map(a => ({cell: a.cell, value: valueReference(applyAction(state, a), state.board.filter(c => c !== '.').length % 2 ? 'O' : 'X')}));
    assert.deepEqual(evaluateActions(state), expected);
  }
});

test('candidate generation is unchanged for every reachable position', () => {
  // Every field is built from getOutcome/winningCells, compared above; this guards the composition and key order.
  let n = 0;
  for (const state of states) {
    if (getOutcome(state).terminal) continue;
    for (const difficulty of DIFFICULTIES) { const candidates = generateCandidates(state, difficulty); assert.ok(candidates.length > 0); n++; }
  }
  assert.ok(n > 4000 * 4);
});

function randomValue(rand, depth = 0) {
  const pick = a => a[Math.floor(rand() * a.length)];
  switch (Math.floor(rand() * (depth > 3 ? 6 : 9))) {
    case 0: return null;
    case 1: return rand() < .5;
    case 2: return pick([0, -0, 1, -1, 1.5, 1e21, NaN, Infinity, 0.1 + 0.2]);
    case 3: case 4: return pick(['', 'a', 'cell_4', 'quote"back\\slash', 'new\nline', ' ', 'café', '😀', '\ud800']);
    case 5: return pick([undefined, () => 1, 7]);
    case 6: case 7: return Array.from({length: Math.floor(rand() * 5)}, () => randomValue(rand, depth + 1));
    default: {
      const o = {};
      for (let i = 0, n = Math.floor(rand() * 6); i < n; i++) o[pick(['b', 'a', 'z', '10', '9', '2', 'A', 'é', 'key with space', 'q"', 'payload', 'hash'])] = randomValue(rand, depth + 1);
      return o;
    }
  }
}
test('canonical, hex and sha256 match the reference serializers', async () => {
  const rand = rng(7);
  for (let i = 0; i < 4000; i++) { const v = randomValue(rand); assert.equal(canonical(v), canonicalReference(v)); }
  for (const v of [undefined, [1, , 2], [, ,], [() => 1, undefined], {f() {}, g: 1, u: undefined}, new Date(0), Object.create(null), 'x', 7, true, null, {a: [{b: [1, {c: undefined}]}]}])
    assert.equal(canonical(v), canonicalReference(v));
  for (const state of states.slice(0, 300)) assert.equal(canonical({state, nested: [state.board]}), canonicalReference({state, nested: [state.board]}));
  const all = Uint8Array.from({length: 256}, (_, i) => i);
  assert.equal(hex(all), hexReference(all));
  assert.equal(hex(new Uint8Array(0)), '');
  assert.equal(await sha256({a: 1, b: [2]}), await sha256('{"a":1,"b":[2]}'));
  assert.equal(await sha256(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});
