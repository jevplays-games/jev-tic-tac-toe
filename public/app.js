import {createInitialState,applyAction,getLegalActions,getOutcome,getPlayerToMove,replay,coordinate} from './game/rules.js';
import {minimaxAction} from './game/oracle.js';
import {inspectMove,csv} from './game/analytics.js';
import {resolveInitialMatch,singleFlight,createRequestHolder,withBootLock} from './game/boot.js';

const $=id=>document.getElementById(id);
function newId(){
  if(typeof crypto.randomUUID==='function')return crypto.randomUUID();
  const b=crypto.getRandomValues(new Uint8Array(16));b[6]=(b[6]&15)|64;b[8]=(b[8]&63)|128;
  const h=[...b].map(x=>x.toString(16).padStart(2,'0')).join('');
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}
const fmt=(n,digits=0)=>typeof n==='number'&&Number.isFinite(n)?n.toLocaleString(undefined,{maximumFractionDigits:digits}):'—';
const pct=n=>typeof n==='number'?`${(n*100).toFixed(1)}%`:'—';
const ms=n=>typeof n==='number'?n>=1000?`${(n/1000).toFixed(2)} s`:`${Math.round(n)} ms`:'—';
const outcomeName=v=>v===1?'Win':v===0?'Draw':'Loss';
const profileText={easy:'Easy · board and legal actions',normal:'Normal · immediate tactical features',hard:'Hard · forks and bounded replies',jev:'JEV · candidate outcome distributions'};
const sourceName=s=>({'jev':'JEV','human':'Human','forced':'Forced','fallback-minimax':'Fallback','local-minimax':'Local oracle'}[s]??s);
let me=null,match=null,busy=false,pendingCell=null,pendingAction=null,replayPly=null;
let boot={state:'loading',stage:null};
const createRequest=createRequestHolder(()=>({requestId:newId(),humanMark:$('human-mark').value,difficulty:$('difficulty').value,ranked:$('ranked').checked}));
let backend=false,scope='world',leaderNext=null,historyNext=null,summary=null;
let resumeTimer=null,bootEpoch=0,autoPolls=0;
const maxAutoPolls=30;
const preferences=readPreferences();
function readPreferences(){try{return JSON.parse(localStorage.getItem('jev-preferences')??'{}');}catch{return {};}}
function savePreferences(){try{localStorage.setItem('jev-preferences',JSON.stringify({difficulty:$('difficulty').value,humanMark:$('human-mark').value,analysis:$('analysis-toggle').checked}));}catch{/* Storage can be unavailable in private contexts. */}}
function element(tag,text=null,className=null){const node=document.createElement(tag);if(text!==null)node.textContent=text;if(className)node.className=className;return node;}
function notice(message){$('notice').textContent=message;$('notice').hidden=!message;}
// A boot failure is shown as a suffix on any session/context notice from the current load. Retry retires only that
// suffix, so an obsolete error never outlives a recovery while a session or context warning is never erased with it.
let sessionNotice='',errorSuffix='';
function sessionNote(message){sessionNotice=message;notice(message);}
function errorNote(message){const shown=$('notice').textContent,base=sessionNotice&&shown.startsWith(sessionNotice)?sessionNotice:'';errorSuffix=message;notice(base?`${base} ${message}`:message);}
function retireErrorNote(){if(!errorSuffix)return;const shown=$('notice').textContent;if(shown.endsWith(errorSuffix))notice(shown.slice(0,shown.length-errorSuffix.length).trimEnd());errorSuffix='';}
function tableRow(values){const tr=element('tr');for(const value of values){const td=element('td');if(value instanceof Node)td.append(value);else td.textContent=String(value??'—');tr.append(td);}return tr;}
function setBusy(value){busy=value;renderGame();}
let bearer=null; // set only inside a Discord Activity, where cookies are not sent
async function api(path,{method='GET',body}={}){
  const response=await fetch(path,{method,credentials:'same-origin',headers:{...(bearer?{Authorization:`Bearer ${bearer}`}:{}),...(body?{'Content-Type':'application/json'}:{}),...(method!=='GET'?{'X-CSRF-Token':me?.csrf??''}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(12000)});
  let data;try{data=await response.json();}catch{throw new Error('The game service did not return JSON. Local play remains available.');}
  if(!response.ok){const error=new Error(data.error??'Request failed');error.status=response.status;error.detail=data.detail;throw error;}
  return data;
}
function humanMessage(error){const messages={discord_not_configured:'Discord is not configured on this host.',fresh_discord_context_required:'Launch /play tic-tac-toe in a Discord channel to view its community leaderboard.',rate_limit:'The request limit was reached. Your existing match is preserved.',active_match_exists:'Resume or resign the existing match before starting another.',jev_not_configured:'Ranked play needs a server-side JEV API key.',csrf_rejected:'The session changed. Reload the page before continuing.',launch_expired:'This Discord launch expired. Run /play tic-tac-toe again.',launch_user_mismatch:'This personal launch belongs to a different Discord account.'};return messages[error.message]??error.message;}
function makeBoard(){
  for(let cell=0;cell<9;cell++){
    const button=element('button',null,'cell');button.type='button';button.dataset.cell=cell;button.setAttribute('aria-label',`${coordinate(cell)}, empty`);
    button.addEventListener('click',()=>place(cell));
    button.addEventListener('keydown',event=>{const delta={ArrowLeft:-1,ArrowRight:1,ArrowUp:-3,ArrowDown:3}[event.key];if(delta!==undefined){event.preventDefault();const next=(cell+delta+9)%9;$('board').children[next].focus();}});
    // The piece is art (public/art/x.svg, o.svg) painted by CSS from the cell's x/o class. The two spans are
    // created once and kept, so a re-render never restarts a placement animation half way through.
    const piece=element('span',null,'piece');piece.setAttribute('aria-hidden','true');
    button.append(element('span',coordinate(cell),'coord'),piece);
    $('board').append(button);
  }
}
const shown=Array(9).fill('.');
function drawBoard(board,wins=[],interactive=false){
  const grid=$('board');
  // Presentation hooks only: which mark a free square previews, and where the strike through a win is drawn.
  grid.dataset.mark=match?.humanMark??$('human-mark').value;
  if(wins.length){grid.dataset.strike=wins[0].join('');grid.dataset.winner=board[wins[0][0]];}else{delete grid.dataset.strike;delete grid.dataset.winner;}
  for(let cell=0;cell<9;cell++){
    const button=grid.children[cell],value=board[cell],display=pendingCell===cell&&value==='.'?(match?.humanMark??'X'):value;
    button.lastElementChild.classList.toggle('is-new',display!=='.'&&(shown[cell]==='.'||(shown[cell]===display&&button.lastElementChild.classList.contains('is-new'))));
    shown[cell]=display;
    button.className=`cell ${display==='X'?'x':display==='O'?'o':''} ${wins.some(line=>line.includes(cell))?'winning':''} ${pendingCell===cell?'pending':''}`;
    // aria-disabled preserves arrow navigation and keyboard inspection on occupied cells.
    button.setAttribute('aria-disabled',String(!interactive||value!=='.'));
    button.setAttribute('aria-label',`${coordinate(cell)}, ${value==='.'?'empty':value}${wins.some(line=>line.includes(cell))?', winning line':''}`);
  }
}
function renderGame(){
  const active=match&&!['complete','void'].includes(match.status),human=match?.humanMark??$('human-mark').value;
  const state=match?{rulesVersion:'ttt/1',board:replayPly!==null?replay(match.actions.slice(0,replayPly)).board:match.board}:createInitialState();
  drawBoard(state.board,getOutcome(state).winningLines,Boolean(active&&match.status==='human_turn'&&!busy&&replayPly===null));
  $('human-symbol').textContent=human==='X'?'×':'○';$('human-symbol').className=`mark ${human.toLowerCase()}`;
  $('jev-symbol').textContent=human==='X'?'○':'×';$('jev-symbol').className=`mark ${human==='X'?'o':'x'}`;
  $('human-label').textContent=`Play as ${human} · ${human==='X'?'goes first':'goes second'}`;
  const fallback=match?.actions?.some(a=>a.decision?.source?.includes('minimax'));
  $('opponent-name').textContent=match?.local||fallback?'Local oracle':'JEV';
  $('opponent-label').textContent=match?.local?'Browser-only · unranked':fallback?'Perfect-play fallback · unranked':'Structured decision model';
  $('mode-badge').textContent=match?.rankedStarted&&match?.eligible?'RANKED MATCH':match?.local?'LOCAL PRACTICE':'CASUAL PLAY';
  let text=boot.state==='loading'?'Loading your game…':boot.state==='error'?(match?'Could not refresh your game.':'Could not load your game.'):'Choose your settings and start a game.';
  if(match){
    if(replayPly!==null)text=`Replay · after ${replayPly} of ${match.actions.length} moves`;
    else if(match.status==='complete')text=match.termination==='resign'?'Match resigned.':match.termination==='expired'?'Match expired.':match.outcome==='win'?'You win. Three in a row.':match.outcome==='loss'?'Your opponent wins.':'A draw. No squares left.';
    else if(match.status==='void')text='Match void · excluded from rankings';
    else if(busy&&pendingCell!==null)text='Move submitted · waiting for opponent';
    else if(match.status==='jev_pending'||busy)text=match.local?'Local opponent is selecting a move…':'JEV is evaluating legal actions…';
    else text=`Your turn · place ${human}`;
    // A refresh in flight or failed on a displayed game is said plainly; the board itself stays as it was.
    if(replayPly===null&&boot.state==='loading')text='Loading your game…';
    else if(replayPly===null&&boot.state==='error')text='Could not refresh your game.';
  }
  $('game-status').textContent=text;
  // End state: the status line becomes the result plaque in place, so the final board stays in view.
  const result=replayPly===null&&match?.status==='complete'?({win:'is-win',loss:'is-loss',draw:'is-draw'}[match.outcome]??''):'';
  $('game-status').parentElement.className=`turn-row${result?` jv-plaque ${result}`:''}`;
  const toMove=active&&replayPly===null?(match.status==='human_turn'?'human':'jev'):null;
  $('human-symbol').parentElement.classList.toggle('is-turn',toMove==='human');
  $('jev-symbol').parentElement.classList.toggle('is-turn',toMove==='jev');
  $('eligibility').textContent=match?.local?'Browser-only practice. Not included in server analytics or rankings.':match?.rankedStarted&&!match.eligible?'Excluded from ranked results: a fallback or verification issue occurred.':match?.eligible?'Official match · quitting a human turn does not erase the result.':me?.user?'Casual match · enable Ranked before starting for leaderboard eligibility.':'Guest matches are unranked.';
  $('difficulty').disabled=Boolean(active);$('human-mark').disabled=Boolean(active);
  $('ranked').disabled=Boolean(active)||!me?.user||!me?.jevConfigured;
  document.body.classList.toggle('busy',busy||boot.state==='loading');
  $('new-game').disabled=busy||boot.state!=='ready'||Boolean(active&&match.status==='jev_pending');
  $('boot-actions').hidden=boot.state!=='error';$('boot-retry').disabled=boot.state==='loading'||busy;$('boot-local').hidden=Boolean(match);
  $('new-game').textContent=active?'New game':match?'Play again ↗':'Start game ↗';
  $('resign').hidden=!active;$('resign').disabled=busy||match?.status==='jev_pending';
  $('reconnect').hidden=!active||Boolean(match?.local);
  $('evidence-state').textContent=busy?'EVALUATING':fallback?'FALLBACK':match?.actions.some(a=>a.decision)?'RECORDED':'READY';
  $('profile-detail').textContent=profileText[match?.config?.difficulty??$('difficulty').value];
  renderEvidence();
}
function renderEvidence(){
  const action=[...(match?.actions??[])].reverse().find(a=>a.decision),d=action?.decision;
  if(!d){$('candidate-count').textContent='—';$('selected-cell').textContent='—';$('decision-latency').textContent='—';$('confidence').textContent='No response yet';$('probabilities').replaceChildren(element('p','JEV’s actual option distribution will appear after a decision.','empty jv-empty'));$('factors').replaceChildren(element('p','Play a move to begin.','empty'));return;}
  $('candidate-count').textContent=d.candidateCount??action.analysis?.candidates?.length??'—';$('selected-cell').textContent=coordinate(action.cell);$('decision-latency').textContent=ms(d.latencyMs);
  const confidence=d.response?.answers?.preference?.confidence??d.reportedConfidence;
  $('confidence').textContent=typeof confidence==='number'?`Confidence ${pct(confidence)}`:sourceName(d.source);
  const probabilities=d.response?.answers?.preference?.probabilities??d.probabilities;
  $('probabilities').replaceChildren();
  if(probabilities){for(const [id,p]of Object.entries(probabilities).sort((a,b)=>a[0].localeCompare(b[0]))){
    const cell=Number(id.slice(5)),row=element('div',null,`probability-row ${cell===action.cell?'selected':''}`),meter=element('meter');meter.min=0;meter.max=1;meter.value=p;meter.setAttribute('aria-label',`${coordinate(cell)} preference ${pct(p)}`);row.append(element('span',coordinate(cell)),meter,element('span',`${Math.round(p*100)}%`));$('probabilities').append(row);
  }}else $('probabilities').append(element('p',d.source==='forced'?'Only one legal move remained; no model call was needed.':`No JEV distribution. ${d.fallbackReason??'Local practice opponent'}.`,'empty'));
  $('factors').replaceChildren(...(action.analysis?.factors??d.factors??[]).map(f=>element('p',f,'factor')));
  if(!$('factors').childNodes.length)$('factors').append(element('p','No immediate tactical factors flagged.','empty'));
  $('evidence-note').textContent=d.source==='jev'?'Confidence describes the model’s answer distribution, not a calibrated probability of winning.':d.source==='forced'?'A forced legal action is not an inference result.':'This move was not selected by JEV. It cannot contribute to official JEV rankings.';
}
async function acceptMatch(data,{auto=true}={}){
  match=data;replayPly=null;pendingCell=null;renderGame();renderPostgame();
  clearTimeout(resumeTimer);
  if(match.status!=='jev_pending')autoPolls=0;
  if(auto&&match.status==='jev_pending'&&!match.local){
    if(autoPolls>=maxAutoPolls)notice('JEV is still working on this move. Use Reconnect to check again.');
    else resumeTimer=setTimeout(()=>{if(boot.state==='ready')resume(false);},1800);
  }
  if(['complete','void'].includes(match.status)&&!match.local){loadLeaderboard();loadAnalytics();}
}
async function startGame(){
  if(busy)return;
  if(match&&!['complete','void'].includes(match.status)){
    if(!confirm('Resign the current match and start a new one? Ranked resignations count as a loss.'))return;
    await resign(false);if(match&&!['complete','void'].includes(match.status))return;
  }
  notice('');setBusy(true);replayPly=null;
  try{
    if(!backend){await startLocal();return;}
    const data=await api('/api/matches',{method:'POST',body:createRequest.current});createRequest.clear();await acceptMatch(data);
  }catch(e){
    if(e.message==='active_match_exists'&&e.detail?.matchId)await acceptMatch(await api(`/api/matches/${e.detail.matchId}`));
    if(e.status && e.status<500)createRequest.clear();
    notice(humanMessage(e));
  }finally{setBusy(false);}
}
async function place(cell){
  if(busy||!match||match.status!=='human_turn'||replayPly!==null||match.board[cell]!=='.')return;
  notice('');pendingCell=cell;setBusy(true);
  try{
    if(match.local){localMove(cell,'human');await localOpponent();renderPostgame();return;}
    pendingAction??={requestId:newId(),expectedRevision:match.revision,action:{type:'place',cell}};
    const data=await api(`/api/matches/${match.id}/actions`,{method:'POST',body:pendingAction});pendingAction=null;await acceptMatch(data);
  }catch(e){notice(humanMessage(e));if(e.status===409||e.status===400){pendingAction=null;await acceptMatch(await api(`/api/matches/${match.id}`));}}
  finally{pendingCell=null;setBusy(false);}
}
async function resign(ask=true){
  if(busy||!match||match.status!=='human_turn')return;
  if(ask&&!confirm('Resign this match? An official ranked match will count as a loss.'))return;
  setBusy(true);
  try{
    if(match.local){match.status='complete';match.outcome='loss';match.termination='resign';match.finishedAt=Date.now();renderPostgame();return;}
    const body={requestId:newId(),expectedRevision:match.revision,action:{type:'resign'}};
    await acceptMatch(await api(`/api/matches/${match.id}/actions`,{method:'POST',body}));
  }catch(e){notice(humanMessage(e));}finally{setBusy(false);}
}
async function resume(manual=true){
  if(busy||!match||match.local||boot.state==='loading')return;
  const id=match.id,epoch=bootEpoch,current=()=>epoch===bootEpoch&&match?.id===id;
  if(manual){notice('');autoPolls=0;}else autoPolls++;
  setBusy(true);
  try{
    let data;
    if(pendingAction){data=await api(`/api/matches/${id}/actions`,{method:'POST',body:pendingAction});pendingAction=null;}
    else data=await api(`/api/matches/${id}/resume`,{method:'POST'});
    if(!current())return;
    // An authoritative answer for the displayed match proves the service is back: it clears a refresh error
    // (never a failed session load, which only Retry can repair), so the board, New game and polling resume.
    const recovered=boot.state==='error'&&boot.stage!=='connect'&&backend;
    if(recovered){retireErrorNote();setBoot('ready');}
    await acceptMatch(data);
    if(recovered)loadLeaderboard();
  }catch(e){
    if(!current())return;
    if(manual){if(boot.state==='error')errorNote(humanMessage(e));else notice(humanMessage(e));}
    else{errorNote(`${bootStageText.resume} ${describeBootError(e)} Your game is unchanged. Retry to continue.`);setBoot('error','resume');}
  }finally{setBusy(false);}
}
/* Boot: the board is playable as soon as the page is, with no click -- but only after the player's prior
   match is resolved. A live match is restored (never a second one beside it), an expired one is resumed
   first, and only an absent or ended one is replaced by a new match. A connection or server failure at any
   step leaves the page in a visible error state with Retry; it never starts a local game on its own and
   never replaces the match already on screen. Ranked follows the checkbox rule (signed in AND hosted JEV),
   so auto-start cannot rank a game the player could not have ranked by hand. */
function setBoot(state,stage=null){boot={state,stage};renderGame();}
function describeBootError(error){const text=!error?.status?'The game service did not respond':error.status>=500?'The game service had a problem':humanMessage(error);return text.replace(/\.?$/,'.');}
const bootStageText={connect:'Could not reach the game service.',load:'Could not load your saved game.',resume:'Could not refresh your saved game.',create:'Could not start a new game.'};
async function loadSession(){
  me=await api('/api/me');backend=true;$('identity-name').textContent=me.user?.displayName??'Guest';$('login').hidden=Boolean(me.user);$('logout').hidden=!me.user;
  $('service-status').textContent=me.jevConfigured?'Hosted JEV available':'Local fallback · JEV key not configured';$('service-dot').classList.remove('is-off');$('service-dot').classList.add('is-live');
  if(!me.discordConfigured){$('login').hidden=true;sessionNote('Local-ready build. Add server-side JEV and Discord credentials to enable hosted inference and authentication.');}
  if(me.pendingLaunch){try{me.context=(await api('/api/context/redeem',{method:'POST'})).context;sessionNote('Discord channel context verified. Ranked results can be attributed to this community.');}catch(e){sessionNote(humanMessage(e));}}
}
const runBoot=singleFlight(()=>withBootLock(async()=>{
  bootEpoch++;autoPolls=0;clearTimeout(resumeTimer);retireErrorNote();
  setBoot('loading');
  try{await loadSession();}
  catch(error){
    backend=false;$('service-status').textContent='Game service unreachable';$('service-dot').classList.remove('is-live');$('service-dot').classList.add('is-off');
    errorNote(`${bootStageText.connect} ${describeBootError(error)} Retry, or practice locally without JEV.`);setBoot('error','connect');return;
  }
  const request={get current(){if(!createRequest.peek())$('ranked').checked=Boolean(me?.user&&me?.jevConfigured);return createRequest.current;},clear:()=>createRequest.clear()};
  const result=await resolveInitialMatch({me,api,request});
  if(result.status==='error'){
    if(result.match)await acceptMatch(result.match,{auto:false});
    errorNote(`${bootStageText[result.stage]} ${describeBootError(result.error)} Your existing game is unchanged. Retry to continue.`);setBoot('error',result.stage);return;
  }
  await acceptMatch(result.match);setBoot('ready');
  loadLeaderboard();
}));
async function startLocal(){
  const at=Date.now();match={local:true,id:newId(),schemaVersion:1,status:'human_turn',revision:0,board:Array(9).fill('.'),humanMark:$('human-mark').value,config:{difficulty:$('difficulty').value,modelId:null},configHash:'local-untrusted',actions:[],events:[],eligible:false,rankedStarted:false,startedAt:at};
  notice('The backend is unreachable. Playing a local perfect-play opponent, not JEV.');
  await localOpponent();renderPostgame();
}
function localMove(cell,actor){
  const state={rulesVersion:'ttt/1',board:match.board},analysis=inspectMove(state,cell),mark=getPlayerToMove(state);
  match.actions.push({cell,actor,mark,acceptedAt:Date.now(),serverDwellMs:null,analysis,...(actor==='jev'?{decision:{source:'local-minimax',action:{type:'place',cell},latencyMs:null,probabilities:null,fallbackReason:'backend_unreachable'}}:{})});
  match.board=applyAction(state,{type:'place',cell}).board;match.revision++;pendingCell=null;
  const out=getOutcome({board:match.board});
  if(out.terminal){match.status='complete';match.outcome=out.winner===null?'draw':out.winner===match.humanMark?'win':'loss';match.termination='board';match.finishedAt=Date.now();}
}
async function localOpponent(){if(match.status!=='complete'&&getPlayerToMove({board:match.board})!==match.humanMark)localMove(minimaxAction({rulesVersion:'ttt/1',board:match.board}).cell,'jev');}
function renderPostgame(){
  const complete=match&&['complete','void'].includes(match.status);$('postgame').hidden=!complete;
  if(!complete)return;
  $('replay-step').max=match.actions.length;$('replay-step').value=match.actions.length;$('replay-output').textContent='Final';
  $('move-table').replaceChildren(...match.actions.map(a=>tableRow([a.analysis.ply,a.actor==='human'?'You':'Opponent',coordinate(a.cell),sourceName(a.decision?.source??'human'),`${outcomeName(a.analysis.valueBefore)} → ${outcomeName(a.analysis.valueAfter)}`,a.analysis.regret,a.analysis.optimal?'Yes':'No',ms(a.decision?.latencyMs)])));
  $('raw-evidence').textContent=JSON.stringify({audit:match.audit??{ok:null,reason:'browser_only_untrusted'},events:match.events,decisions:match.actions.filter(a=>a.decision).map(a=>({ply:a.analysis.ply,...a.decision}))},null,2);
}
async function loadLeaderboard(next=false){
  if(!backend){$('leader-note').textContent='The leaderboard requires the game backend.';return;}
  try{
    const params=new URLSearchParams({scope,difficulty:$('leader-profile').value,mark:$('leader-mark').value,...(next?leaderNext??{}:{})});
    const data=await api(`/api/leaderboard?${params}`);leaderNext=data.next;
    $('leader-table').replaceChildren(...data.entries.map(r=>tableRow([r.provisional?'Provisional':r.rank,r.displayName,pct(r.resultRate),r.wins,r.draws,r.losses,r.games])));
    $('leader-note').textContent=data.entries.length?`Result rate = (wins + 0.5 × draws) / games. Configuration ${data.configHash.slice(0,12)}.`:'No verified results in this configuration yet.';
    $('leader-more').hidden=!leaderNext;
  }catch(e){$('leader-table').replaceChildren();$('leader-note').textContent=humanMessage(e);$('leader-more').hidden=true;}
}
function metric(label,value,description){const div=element('div',null,'panel metric');div.append(element('span',label),element('strong',value),element('small',description));return div;}
function keyValues(target,rows){$(target).replaceChildren(...rows.map(([label,value])=>{const row=element('div',null,'kv');row.append(element('span',label),element('strong',value));return row;}));}
async function loadAnalytics(){
  if(!backend)return;
  try{
    const params=new URLSearchParams();if($('analytics-profile').value)params.set('difficulty',$('analytics-profile').value);if($('analytics-mark').value)params.set('mark',$('analytics-mark').value);
    const data=await api(`/api/analytics?${params}`);summary=data.summary;
    $('analytics-coverage').textContent=`${data.coverage.matchesIncluded} matches included${data.coverage.truncated?' · newest 500 only; export for full history':''}`;
    const live=summary.bySource.jev,totals=summary.summary;
    $('metric-grid').replaceChildren(metric('COMPLETED MATCHES',fmt(summary.matches),`${summary.wins} wins · ${summary.draws} draws · ${summary.losses} losses`),metric('HUMAN RESULT RATE',pct(summary.resultRate),'Descriptive; may mix configurations'),metric('LIVE JEV OPTIMAL MOVES',pct(live?.optimalRate),`${fmt(live?.moves??0)} actual model decisions`),metric('LIVE JEV P95 LATENCY',ms(live?.latencyMs?.p95),'Decision wall time · measured, not simulated'),metric('FALLBACK MOVES',fmt(totals.fallback),'Excluded from official JEV rankings'),metric('VERIFIED RANKED MATCHES',fmt(summary.rankedEligible),'Same-configuration leaderboard cohorts'));
    $('source-table').replaceChildren(...Object.entries(summary.bySource).map(([source,s])=>tableRow([sourceName(source),s.moves,pct(s.optimalRate),fmt(s.meanRegret,3),s.avoidableLosses])));
    keyValues('latency-detail', [['JEV p50 / p95 / p99',`${ms(live?.latencyMs?.p50)} / ${ms(live?.latencyMs?.p95)} / ${ms(live?.latencyMs?.p99)}`],['Transport retries',fmt(totals.retries)],['Forced placements',fmt(totals.forced)],['Input / output tokens',`${fmt(totals.inputTokens)} / ${fmt(totals.outputTokens)}`],['Responses with token usage',`${totals.usageKnown} / ${totals.jevCalls}`],['Attempts with unknown billing usage',fmt(totals.unknownAttemptUsage)],['Known estimated cost (operator prices)',totals.knownEstimatedCostUsd===null?'Not configured':`$${totals.knownEstimatedCostUsd.toFixed(6)}`],['Mean human dwell',ms(totals.humanDwellMs.mean)]]);
    const calibration=live?.calibration;
    keyValues('calibration-detail',[['Candidate predictions',fmt(calibration?.n??0)],['Multiclass Brier score',fmt(calibration?.multiclassBrier,4)],['Negative log likelihood',fmt(calibration?.nll,4)],['Expected calibration error',fmt(calibration?.ece,4)],['Outcome classification accuracy',pct(calibration?.accuracy)],['Mean preference mass on optimal set',pct(live?.optimalPreferenceMass?.mean)]]);
    $('ply-table').replaceChildren(...Object.entries(summary.byPly).filter(([,s])=>s.moves).map(([ply,s])=>tableRow([ply,s.moves,pct(s.optimalRate),fmt(s.meanRegret,3),`${s.missedWins} / ${s.winOpportunities}`,`${s.missedBlocks} / ${s.blockOpportunities}`])));
    $('cohort-list').replaceChildren(...Object.entries(summary.byCohort).map(([hash,c])=>{const row=element('div',null,'cohort');row.append(element('p',`${c.config.modelId} · ${c.config.difficulty} · human ${c.humanMark} · ${c.matches} matches`),element('code',hash));return row;}));
    renderHeatmap();
  }catch(e){$('analytics-coverage').textContent=humanMessage(e);}
}
function renderHeatmap(){const counts=summary?.bySource?.[$('heatmap-source').value]?.cellCounts??Array(9).fill(0),max=Math.max(...counts,1);$('heatmap').replaceChildren(...counts.map((n,cell)=>{const box=element('div',null,`heat-cell level${n?Math.max(1,Math.ceil(n/max*4)):0}`);box.append(element('small',coordinate(cell)),element('b',fmt(n)));return box;}));}
async function loadHistory(next=false){
  if(!backend){$('history-note').textContent='Records require the game backend.';return;}
  try{
    const data=await api(`/api/history?${new URLSearchParams(next?historyNext??{}:{})}`);historyNext=data.next;
    if(!next)$('history-table').replaceChildren();
    for(const m of data.matches){const button=element('button','Open','text-button');button.addEventListener('click',async()=>{if(match&&!['complete','void'].includes(match.status)&&match.id!==m.id){notice('Finish or resign your active match before inspecting a different replay.');return;}await acceptMatch(m);showView('play');$('postgame').scrollIntoView({block:'start'});});$('history-table').append(tableRow([new Date(m.startedAt).toLocaleString(),m.config.difficulty,m.humanMark,m.outcome??m.status,m.eligible?'Ranked':'Unranked',m.actions.length,button]));}
    $('history-note').textContent=data.matches.length?'':'No server matches yet.';$('history-more').hidden=!historyNext;
  }catch(e){$('history-note').textContent=humanMessage(e);}
}
function download(name,data,type='application/json'){const link=element('a');const url=URL.createObjectURL(new Blob([typeof data==='string'?data:JSON.stringify(data,null,2)],{type}));link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
function movesCsv(m){return csv(m.actions.map(a=>({matchId:m.id,configHash:m.configHash,profile:m.config.difficulty,humanMark:m.humanMark,ply:a.analysis.ply,actor:a.actor,cell:coordinate(a.cell),source:a.decision?.source??'human',board:a.analysis.board,valueBefore:a.analysis.valueBefore,valueAfter:a.analysis.valueAfter,regret:a.analysis.regret,optimal:a.analysis.optimal,missedImmediateWin:a.analysis.missedImmediateWin,missedNecessaryBlock:a.analysis.missedNecessaryBlock,latencyMs:a.decision?.latencyMs??null,serverDwellMs:a.serverDwellMs??null,confidence:a.decision?.response?.answers?.preference?.confidence??null,inputTokens:a.decision?.response?.usage?.input_tokens??null,outputTokens:a.decision?.response?.usage?.output_tokens??null})) );}
async function exportAll(){
  $('export-all').disabled=true;
  try{const matches=[];let cursor={};do{const page=await api(`/api/history?${new URLSearchParams({...cursor,limit:100})}`);matches.push(...page.matches);cursor=page.next;}while(cursor);download(`jev-matches-${new Date().toISOString().slice(0,10)}.json`,{schemaVersion:1,exportedAt:new Date().toISOString(),scope:'own-account-or-session',matches});notice(`Exported ${matches.length} matches. Community IDs may be present; review before sharing.`);}catch(e){notice(`Export stopped without a partial file: ${humanMessage(e)}`);}finally{$('export-all').disabled=false;}
}
function showView(view){for(const node of document.querySelectorAll('.view'))node.hidden=node.id!==`view-${view}`;for(const button of document.querySelectorAll('[data-view]')){button.classList.toggle('active',button.dataset.view===view);if(button.dataset.view===view)button.setAttribute('aria-current','page');else button.removeAttribute('aria-current');}if(view==='analytics')loadAnalytics();if(view==='records')loadHistory();}
async function initialize(){
  makeBoard();if(['easy','normal','hard','jev'].includes(preferences.difficulty))$('difficulty').value=preferences.difficulty;if(['X','O'].includes(preferences.humanMark))$('human-mark').value=preferences.humanMark;
  if(preferences.analysis===false)$('analysis-toggle').checked=false;
  function toggleAnalysis(){$('evidence-panel').hidden=!$('analysis-toggle').checked;document.querySelector('.arena').classList.toggle('without-evidence',!$('analysis-toggle').checked);savePreferences();}
  $('analysis-toggle').addEventListener('change',toggleAnalysis);toggleAnalysis();
  $('new-game').addEventListener('click',startGame);$('resign').addEventListener('click',()=>resign());$('reconnect').addEventListener('click',()=>resume());
  for(const id of ['difficulty','human-mark'])$(id).addEventListener('change',()=>{savePreferences();renderGame();});
  for(const button of document.querySelectorAll('[data-view]'))button.addEventListener('click',()=>showView(button.dataset.view));
  for(const button of document.querySelectorAll('[data-scope]'))button.addEventListener('click',()=>{scope=button.dataset.scope;for(const b of document.querySelectorAll('[data-scope]'))b.classList.toggle('selected',b===button);leaderNext=null;loadLeaderboard();});
  for(const id of ['leader-profile','leader-mark'])$(id).addEventListener('change',()=>loadLeaderboard());$('leader-more').addEventListener('click',()=>loadLeaderboard(true));
  $('show-rules').addEventListener('click',()=>$('rules-dialog').showModal());$('show-privacy').addEventListener('click',()=>$('privacy-dialog').showModal());for(const b of document.querySelectorAll('[data-close-dialog]'))b.addEventListener('click',()=>b.closest('dialog').close());
  $('replay-step').addEventListener('input',()=>{replayPly=Number($('replay-step').value);$('replay-output').textContent=`${replayPly} / ${match.actions.length}`;renderGame();});$('return-live').addEventListener('click',()=>{replayPly=null;$('replay-step').value=match.actions.length;$('replay-output').textContent='Final';renderGame();});
  $('download-match').addEventListener('click',()=>download(`jev-${match.id}.json`,match));$('download-moves').addEventListener('click',()=>download(`jev-${match.id}-moves.csv`,movesCsv(match),'text/csv'));
  $('refresh-analytics').addEventListener('click',loadAnalytics);for(const id of ['analytics-profile','analytics-mark'])$(id).addEventListener('change',loadAnalytics);$('heatmap-source').addEventListener('change',renderHeatmap);
  $('refresh-records').addEventListener('click',()=>loadHistory());$('history-more').addEventListener('click',()=>loadHistory(true));$('export-all').addEventListener('click',exportAll);
  $('logout').addEventListener('click',async()=>{try{await api('/api/logout',{method:'POST'});location.reload();}catch(e){notice(humanMessage(e));}});
  document.addEventListener('keydown',event=>{if(/^[1-9]$/.test(event.key)&&!['INPUT','SELECT','TEXTAREA'].includes(document.activeElement.tagName)&&!document.querySelector('dialog[open]')&&!$('view-play').hidden)place(Number(event.key)-1);});
  renderGame();
  if(new URLSearchParams(location.search).has('frame_id')){
    try{bearer=(await (await import('/activity.js')).signInWithDiscord(api)).token;}
    catch(e){notice(`Could not sign in through Discord. ${humanMessage(e)}`);}
  }
  $('boot-retry').addEventListener('click',()=>runBoot());
  $('boot-local').addEventListener('click',()=>{if(match)return;backend=false;createRequest.clear();setBoot('ready');startLocal();renderGame();});
  await runBoot();
  try{const reference=await fetch('/reference-audit.json').then(r=>r.json());$('audit-reference').replaceChildren(...[['Reachable boards',reference.reachableBoards],['Nonterminal boards',reference.nonterminalBoards],['Symmetry classes',reference.symmetryClasses],['Complete games',reference.completeGames]].map(([label,n])=>{const d=element('div');d.append(element('strong',fmt(n)),element('small',label));return d;}));}catch{$('audit-reference').textContent='Run npm run audit to generate the exhaustive reference report.';}
  renderGame();renderHeatmap();
}
initialize();
