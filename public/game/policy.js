/** Bounded tactical features and model-only selection; deliberately no oracle import. */
import {WIN_LINES, CELL_ORDER, coordinate, getLegalActions, getPlayerToMove, applyAction, getOutcome, other} from './rules.js';
export const POLICY_VERSION = 'policy/1';
export const DIFFICULTIES = Object.freeze(['easy','normal','hard','jev']);
export function winningCells(board, mark) {
  return CELL_ORDER.filter(cell => board[cell] === '.' && WIN_LINES.some(line => line.includes(cell) && line.every(i => i===cell || board[i]===mark)));
}
function futureFeatures(state, mark) {
  const opponent = other(mark), ownWins = winningCells(state.board,mark);
  return {
    winsNow: getOutcome(state).winner === mark,
    opponentImmediateWinningReplies: getOutcome(state).terminal ? 0 : winningCells(state.board,opponent).length,
    ownFutureWinningCells: ownWins.length,
    createsFork: !getOutcome(state).terminal && ownWins.length>=2,
    unblockedLines: WIN_LINES.filter(line=>line.every(i=>state.board[i]!==opponent)).length
  };
}
export function generateCandidates(state, difficulty='normal') {
  if (!DIFFICULTIES.includes(difficulty)) throw new Error('Unknown difficulty');
  const mark = getPlayerToMove(state);
  return getLegalActions(state).map(action => {
    const after = applyAction(state,action);
    const candidate = {actionId:`cell_${action.cell}`,cell:action.cell,coordinate:coordinate(action.cell),boardAfter:after.board};
    if (difficulty !== 'easy') {
      const facts = futureFeatures(after,mark);
      candidate.features = { winsNow:facts.winsNow, opponentImmediateWinningReplies:facts.opponentImmediateWinningReplies, isCenter:action.cell===4, isCorner:[0,2,6,8].includes(action.cell) };
      if (difficulty==='hard' || difficulty==='jev') {
        Object.assign(candidate.features,facts);
        candidate.replySummary = getLegalActions(after).map(reply => {
          const replyState = applyAction(after,reply);
          return {humanCell:reply.cell,humanWins:getOutcome(replyState).winner===other(mark),humanFutureWinningCells:winningCells(replyState.board,other(mark)).length,jevWinningResponses:getLegalActions(replyState).filter(a=>getOutcome(applyAction(replyState,a)).winner===mark).map(a=>a.cell)};
        });
      }
    }
    return candidate;
  });
}
export function buildJevRequest(state, difficulty, model) {
  const candidates = generateCandidates(state,difficulty);
  if (!candidates.length) throw new Error('Terminal JEV request');
  const mark=getPlayerToMove(state);
  const questions = {preference:{
    type:'choice',
    instructions:'Select the legal placement giving JEV the best eventual result against optimal opposition. Prefer win to draw to loss. X moves first. Three matching marks in a row wins. All candidates are legal.',
    criteria:Object.fromEntries(candidates.map(c=>[c.actionId,{cell:c.cell,coordinate:c.coordinate}]))
  }};
  if (difficulty==='jev') for (const c of candidates) questions[`outcome_${c.cell}`] = {
    type:'choice', instructions:{candidateActionId:c.actionId,question:'After JEV commits candidateActionId, what eventual outcome can JEV achieve if BOTH sides subsequently play optimally?'},
    criteria:{win:'JEV can force a win.',draw:'JEV can force a draw but cannot force a win.',loss:'The human can force JEV to lose.'}
  };
  return {model,state:{game:'tic-tac-toe',rulesVersion:state.rulesVersion,board:state.board,jevMark:mark,humanMark:other(mark),toMove:mark,candidates},questions};
}
export function validateJevResponse(response, request) {
  if (!response || response.model!==request.model || !response.answers || typeof response.answers!=='object') throw new Error('model_or_answers_mismatch');
  const expectedQuestions = Object.keys(request.questions);
  if (Object.keys(response.answers).length !== expectedQuestions.length) throw new Error('question_set_mismatch');
  for (const id of expectedQuestions) {
    const a=response.answers[id], options=Object.keys(request.questions[id].criteria);
    if (!a || a.type!=='choice' || !options.includes(a.choice) || !a.probabilities || Object.keys(a.probabilities).length!==options.length) throw new Error('choice_schema_invalid');
    const probabilities=options.map(o=>a.probabilities[o]);
    if (probabilities.some(p=>typeof p!=='number' || !Number.isFinite(p) || p<0 || p>1) || Math.abs(probabilities.reduce((x,y)=>x+y,0)-1)>0.001) throw new Error('probabilities_invalid');
    if (a.probabilities[a.choice] + 0.000001 < Math.max(...probabilities)) throw new Error('choice_not_maximum');
    if (typeof a.confidence!=='number' || !Number.isFinite(a.confidence) || a.confidence<0 || a.confidence>1) throw new Error('confidence_invalid');
  }
  if (response.usage) for (const key of ['input_tokens','output_tokens']) if (!Number.isSafeInteger(response.usage[key]) || response.usage[key]<0) throw new Error('usage_invalid');
  // Only preserve the documented, allowlisted response surface.
  return {model:response.model,answers:Object.fromEntries(expectedQuestions.map(id=>[id,{
    type:'choice',choice:response.answers[id].choice,probabilities:{...response.answers[id].probabilities},confidence:response.answers[id].confidence
  }])),usage:response.usage ? {input_tokens:response.usage.input_tokens,output_tokens:response.usage.output_tokens} : null};
}
export function selectJevAction(response, request, difficulty) {
  const answer=response.answers.preference;
  if (difficulty !== 'jev') return {type:'place',cell:Number(answer.choice.slice(5))};
  const round = x=>Math.round(x*1e6)/1e6;
  const ranked=request.state.candidates.map(c=>({cell:c.cell,utility:round(response.answers[`outcome_${c.cell}`].probabilities.win-response.answers[`outcome_${c.cell}`].probabilities.loss),preference:round(answer.probabilities[c.actionId])}));
  ranked.sort((a,b)=>b.utility-a.utility || b.preference-a.preference || CELL_ORDER.indexOf(a.cell)-CELL_ORDER.indexOf(b.cell));
  return {type:'place',cell:ranked[0].cell};
}
export function tacticalAction(state) {
  const mark=getPlayerToMove(state);
  const wins=winningCells(state.board,mark), blocks=winningCells(state.board,other(mark));
  return {type:'place',cell:wins[0]??blocks[0]??getLegalActions(state)[0]?.cell};
}
export function factorsFor(state,cell) {
  const mark=getPlayerToMove(state), next=applyAction(state,{type:'place',cell});
  const facts=futureFeatures(next,mark), factors=[];
  if (facts.winsNow) factors.push('Completes a winning line');
  if (winningCells(state.board,other(mark)).includes(cell)) factors.push('Occupies an immediate opponent winning square');
  if (facts.createsFork) factors.push('Creates two future winning squares');
  if (facts.opponentImmediateWinningReplies>0) factors.push('Leaves an immediate opponent winning reply');
  if (cell===4) factors.push('Occupies the center');
  return factors;
}
