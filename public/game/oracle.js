/** Exact reference evaluator. NEVER included in a JEV request or normal selection policy. */
import {key, other, getOutcome, getPlayerToMove, getLegalActions, applyAction} from './rules.js';
const cache = new Map();
export function value(state, perspective) {
  const k = key(state) + perspective;
  if (cache.has(k)) return cache.get(k);
  const out = getOutcome(state);
  let result;
  if (out.terminal) result = out.winner === null ? 0 : out.winner === perspective ? 1 : -1;
  else {
    const values = getLegalActions(state).map(a => value(applyAction(state,a), perspective));
    result = getPlayerToMove(state) === perspective ? Math.max(...values) : Math.min(...values);
  }
  cache.set(k,result);
  return result;
}
export function evaluateActions(state) {
  const perspective = getPlayerToMove(state);
  if (!perspective) return [];
  return getLegalActions(state).map(action => ({cell:action.cell, value:value(applyAction(state,action),perspective)}));
}
export function optimalActions(state) {
  const candidates = evaluateActions(state);
  const best = Math.max(...candidates.map(a=>a.value));
  return candidates.filter(a=>a.value===best).map(a=>a.cell);
}
export function minimaxAction(state) {
  const cell = optimalActions(state)[0];
  if (cell === undefined) throw new Error('No legal move');
  return {type:'place',cell};
}
