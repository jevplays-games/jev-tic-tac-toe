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

export function getOutcome(state) {
  const lines = WIN_LINES.filter(line => state.board[line[0]] !== '.' && line.every(i => state.board[i] === state.board[line[0]]));
  return { terminal: lines.length > 0 || !state.board.includes('.'), winner: lines.length ? state.board[lines[0][0]] : null, winningLines: lines };
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
export function canonicalBoard(state) {
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
export const game = { id:'tic-tac-toe', rulesVersion:RULES_VERSION, createInitialState, getLegalActions, applyAction, getOutcome, serialize, deserialize, replay };
