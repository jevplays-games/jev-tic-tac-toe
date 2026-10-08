// Resolves the player's starting match on page load. Pure: the caller injects api(), so Node tests drive it directly.
const ENDED=['complete','void'];
export const isEnded=match=>ENDED.includes(match?.status);
const absent=error=>error?.status===404||error?.status===400;

export async function loadPriorMatch({me,api,now=Date.now}) {
  const id=me?.activeMatchId;
  if(!id)return {status:'none'};
  let match;
  try{match=await api(`/api/matches/${encodeURIComponent(id)}`);}
  catch(error){
    if(absent(error))return {status:'none'};
    return {status:'error',stage:'load',error,match:null};
  }
  if(isEnded(match))return {status:'none'};
  if(Number.isFinite(match.expiresAt)&&now()>=match.expiresAt){
    try{match=await api(`/api/matches/${encodeURIComponent(match.id)}/resume`,{method:'POST'});}
    catch(error){return {status:'error',stage:'resume',error,match};}
    if(isEnded(match))return {status:'none',ended:match};
  }
  return {status:'resumed',match};
}

// request is the caller-owned create body holder. Its key is kept only while a create outcome is genuinely unknown
// (a network or 5xx failure), so a retry replays that create idempotently. Once the server has told us what became of
// it -- an adopted live match, an active-match conflict, any definite answer -- the key is retired, so a later
// intentional New game gets a fresh key instead of replaying (and returning) the match it just resigned.
export async function resolveInitialMatch({me,api,request,now=Date.now}) {
  const prior=await loadPriorMatch({me,api,now});
  if(prior.status==='resumed'){request.clear();return prior;}
  if(prior.status==='error')return prior;
  for(let attempt=0;attempt<2;attempt++){
    try{
      const match=await api('/api/matches',{method:'POST',body:request.current});
      request.clear();
      // A retained key can replay a match that has since ended; that is a replay, not a new game, so make one fresh game.
      if(isEnded(match)&&attempt===0)continue;
      return {status:'created',match};
    }catch(error){
      if(error?.status&&error.status<500)request.clear();
      if(error?.message==='active_match_exists'&&error.detail?.matchId){
        try{return {status:'resumed',match:await api(`/api/matches/${encodeURIComponent(error.detail.matchId)}`)};}
        catch(loadError){return {status:'error',stage:'load',error:loadError,match:null};}
      }
      return {status:'error',stage:'create',error,match:null};
    }
  }
}

// Concurrent callers share one in-flight run; the next call after it settles starts a fresh one.
export function singleFlight(run) {
  let flight=null;
  return (...args)=>flight??=Promise.resolve().then(()=>run(...args)).finally(()=>{flight=null;});
}

export function createRequestHolder(make) {
  let current=null;
  return {
    get current(){return current??=make();},
    clear(){current=null;},
    peek(){return current;},
  };
}

// Serialises boot across tabs of one browser (they share the session cookie), so the second tab sees the match the
// first created instead of racing it. Where Web Locks is missing the run is unserialised, which is the old behavior.
export function withBootLock(run,locks=globalThis.navigator?.locks) {
  if(!locks?.request)return run();
  return locks.request('jev-ttt-boot',run);
}
