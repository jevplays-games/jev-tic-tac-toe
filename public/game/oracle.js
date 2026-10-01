/** Exact reference evaluator. NEVER included in a JEV request or normal selection policy. */
import {key, other, getOutcome, getPlayerToMove, getLegalActions, applyAction, WIN_LINES} from './rules.js';
const referenceCache = new Map();
export function valueReference(state, perspective) {
  const k = key(state) + perspective;
  if (referenceCache.has(k)) return referenceCache.get(k);
  const out = getOutcome(state);
  let result;
  if (out.terminal) result = out.winner === null ? 0 : out.winner === perspective ? 1 : -1;
  else {
    const values = getLegalActions(state).map(a => valueReference(applyAction(state,a), perspective));
    result = getPlayerToMove(state) === perspective ? Math.max(...values) : Math.min(...values);
  }
  referenceCache.set(k,result);
  return result;
}
/* Fast exact solver: base-3 board index, one shared table for both perspectives, in-place do/undo. Results equal valueReference. */
const POW3 = [1,3,9,27,81,243,729,2187,6561];
const LINES = WIN_LINES.map(line => Int8Array.from(line));
const SOLVED = new Int8Array(2 * 19683).fill(2); // 2 = not computed; otherwise -1, 0, 1
const work = new Uint8Array(9);
function solve(index, filled, p) {
  const slot = index * 2 + (p - 1), known = SOLVED[slot];
  if (known !== 2) return known;
  let result;
  let winner = 0;
  for (let i = 0; i < 8; i++) {
    const line = LINES[i], mark = work[line[0]];
    if (mark !== 0 && work[line[1]] === mark && work[line[2]] === mark) { winner = mark; break; }
  }
  if (winner) result = winner === p ? 1 : -1;
  else if (filled === 9) result = 0;
  else {
    const mover = filled % 2 === 0 ? 1 : 2, maximizing = mover === p;
    let best = maximizing ? -2 : 2;
    for (let cell = 0; cell < 9; cell++) {
      if (work[cell] !== 0) continue;
      work[cell] = mover;
      const v = solve(index + mover * POW3[cell], filled + 1, p);
      work[cell] = 0;
      if (maximizing ? v > best : v < best) best = v;
    }
    result = best;
  }
  SOLVED[slot] = result;
  return result;
}
export function value(state, perspective) {
  const board = state.board, p = perspective === 'X' ? 1 : perspective === 'O' ? 2 : 0;
  if (!p || !Array.isArray(board) || board.length !== 9) return valueReference(state, perspective);
  let index = 0, filled = 0;
  for (let i = 0; i < 9; i++) {
    const cell = board[i], code = cell === '.' ? 0 : cell === 'X' ? 1 : cell === 'O' ? 2 : -1;
    if (code < 0) return valueReference(state, perspective);
    work[i] = code; index += code * POW3[i]; if (code) filled++;
  }
  return solve(index, filled, p);
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
