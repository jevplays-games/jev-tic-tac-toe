/** The sole gameplay rules implementation. No DOM, I/O, time or randomness. */
export const RULES_VERSION = 'ttt/1';
export const WIN_LINES = Object.freeze([
  [0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]
].map(Object.freeze));
export const CELL_ORDER = Object.freeze([4,0,2,6,8,1,3,5,7]);
export const other = mark => mark === 'X' ? 'O' : 'X';
export const coordinate = cell => `${'ABC'[cell % 3]}${Math.floor(cell / 3) + 1}`;
export const key = state => state.board.join('');
export const createInitialState = () => ({ rulesVersion: RULES_VERSION, board: Array(9).fill('.') });

export function getOutcomeReference(state) {
  const lines = WIN_LINES.filter(line => state.board[line[0]] !== '.' && line.every(i => state.board[i] === state.board[line[0]]));
  return { terminal: lines.length > 0 || !state.board.includes('.'), winner: lines.length ? state.board[lines[0][0]] : null, winningLines: lines };
}
/* Allocation-free equivalent of getOutcomeReference (same result shape; winningLines reuse the frozen WIN_LINES entries). */
export function getOutcome(state) {
  const board = state.board;
  let lines = null;
  for (let i = 0; i < 8; i++) {
    const line = WIN_LINES[i], mark = board[line[0]];
    if (mark !== '.' && board[line[1]] === mark && board[line[2]] === mark) (lines ??= []).push(line);
  }
  if (lines) return { terminal: true, winner: board[lines[0][0]], winningLines: lines };
  return { terminal: !board.includes('.'), winner: null, winningLines: [] };
}
export function getPlayerToMove(state) {
  if (getOutcome(state).terminal) return null;
  return state.board.filter(c => c !== '.').length % 2 === 0 ? 'X' : 'O';
}
export function getLegalActions(state) {
  return getOutcome(state).terminal ? [] : CELL_ORDER.filter(cell => state.board[cell] === '.').map(cell => ({type:'place', cell}));
}
export function applyAction(state, action) {
  const cell = action?.cell;
  if (action?.type !== 'place' || !Number.isInteger(cell) || cell < 0 || cell > 8) throw new Error('Invalid placement');
  if (getOutcome(state).terminal) throw new Error('Game is complete');
  if (state.board[cell] !== '.') throw new Error('Cell is occupied');
  const board = state.board.slice();
  board[cell] = getPlayerToMove(state);
  return {rulesVersion: RULES_VERSION, board};
}
export function replay(moves) {
  if (!Array.isArray(moves) || moves.length > 9) throw new Error('Invalid move history');
  return moves.reduce((state, move) => applyAction(state, {type:'place', cell: typeof move === 'number' ? move : move.cell}), createInitialState());
}
export function enumerateStates() {
  const states = new Map();
  function visit(state) {
    const k = key(state);
    if (states.has(k)) return;
    states.set(k, state);
    for (const action of getLegalActions(state)) visit(applyAction(state, action));
  }
  visit(createInitialState());
  return states;
}
let reachable;
export function deserialize(input) {
  const state = typeof input === 'string' ? JSON.parse(input) : input;
  if (!state || state.rulesVersion !== RULES_VERSION || !Array.isArray(state.board) || state.board.length !== 9 || state.board.some(c => !['.','X','O'].includes(c))) throw new Error('Invalid state schema');
  reachable ??= enumerateStates();
  if (!reachable.has(key(state))) throw new Error('Unreachable board');
  return {rulesVersion: RULES_VERSION, board: [...state.board]};
}
export function serialize(state) { return JSON.stringify(deserialize(state)); }
export function canonicalBoardReference(state) {
  const variants = [];
  for (let reflect = 0; reflect < 2; reflect++) for (let rotations = 0; rotations < 4; rotations++) {
    const out = Array(9);
    state.board.forEach((value, index) => {
      let r = Math.floor(index / 3), c = index % 3;
      if (reflect) c = 2-c;
      for (let k=0; k<rotations; k++) [r,c] = [c,2-r];
      out[r*3+c] = value;
    });
    variants.push(out.join(''));
  }
  return variants.sort()[0];
}
// PERMUTATIONS[v][position] is the source index placed at that position by variant v (reflect, then rotate).
const PERMUTATIONS = [];
for (let reflect = 0; reflect < 2; reflect++) for (let rotations = 0; rotations < 4; rotations++) {
  const permutation = Array(9);
  for (let index = 0; index < 9; index++) {
    let r = Math.floor(index / 3), c = index % 3;
    if (reflect) c = 2-c;
    for (let k=0; k<rotations; k++) [r,c] = [c,2-r];
    permutation[r*3+c] = index;
  }
  PERMUTATIONS.push(permutation);
}
export function canonicalBoard(state) {
  const board = state.board;
  let best = null;
  for (let v = 0; v < 8; v++) {
    const p = PERMUTATIONS[v];
    const text = [board[p[0]], board[p[1]], board[p[2]], board[p[3]], board[p[4]], board[p[5]], board[p[6]], board[p[7]], board[p[8]]].join('');
    if (best === null || text < best) best = text;
  }
  return best;
}
export const game = { id:'tic-tac-toe', rulesVersion:RULES_VERSION, createInitialState, getLegalActions, applyAction, getOutcome, serialize, deserialize, replay };
