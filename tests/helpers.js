import {openDatabase} from '../local/database.js';
import {handle} from '../server/worker.js';
import {one,run} from '../server/store.js';
import {sha256,randomToken} from '../server/util.js';
import {evaluateActions,minimaxAction} from '../public/game/oracle.js';

export function responseFor(request,{cell,model=request.model}={}) {
  const state={rulesVersion:'ttt/1',board:request.state.board};
  const selected=cell??minimaxAction(state).cell;
  const answers={};
  for(const[id,q]of Object.entries(request.questions)){
    const options=Object.keys(q.criteria);let choice;
    if(id==='preference')choice=`cell_${selected}`;
    else{const c=Number(id.slice(8)),v=evaluateActions(state).find(a=>a.cell===c).value;choice=v===1?'win':v===0?'draw':'loss';}
    answers[id]={type:'choice',choice,probabilities:Object.fromEntries(options.map(o=>[o,o===choice?1:0])),confidence:1};
  }
  return {model,answers,usage:{input_tokens:100,output_tokens:20}};
}
export function environment(overrides={}){
  return {PUBLIC_ORIGIN:'http://localhost:8787',DEV_LOCAL:'1',RATE_LIMIT_SALT:'test-only',PINNED_JEV_MODEL:'jev-1.13.0',MAX_JEV_CALLS_PER_DAY:'10000',JEV_CALLS_PER_HOUR:'10000',MATCHES_PER_HOUR:'10000',SESSION_CREATIONS_PER_HOUR:'10000',API_REQUESTS_PER_MINUTE:'100000',DB:openDatabase(),ASSETS:{fetch:async()=>new Response('test assets')},FETCH:async(_url,options)=>new Response(JSON.stringify(responseFor(JSON.parse(options.body))),{headers:{'Content-Type':'application/json'}}),...overrides};
}
export async function browser(env){
  const sessionResponse=await handle(new Request(env.PUBLIC_ORIGIN+'/api/me'),env);
  if(!sessionResponse.ok)throw new Error(await sessionResponse.text());
  const me=await sessionResponse.json(),cookie=sessionResponse.headers.get('set-cookie').split(';')[0];
  return {env,me,cookie,async request(path,{method='GET',body,headers={}}={}){
    const r=await handle(new Request(env.PUBLIC_ORIGIN+path,{method,headers:{cookie,origin:env.PUBLIC_ORIGIN,'x-csrf-token':me.csrf,...(body?{'Content-Type':'application/json'}:{}),...headers},...(body?{body:JSON.stringify(body)}:{})}),env);
    const text=await r.text();let data;try{data=JSON.parse(text);}catch{data=text;}return {status:r.status,headers:r.headers,data};
  }};
}
export async function loginFixture(client,name='Player'){
  const raw=client.cookie.split('=')[1],hash=await sha256(raw),userId=crypto.randomUUID(),discordId=String(100000000000000000n+BigInt('0x'+randomToken(5)));
  await run(client.env,'INSERT INTO users(id,discord_id,display_name,created_at,last_seen_at) VALUES(?,?,?,?,?)',userId,discordId,name,Date.now(),Date.now());
  await run(client.env,'UPDATE sessions SET user_id=? WHERE token_hash=?',userId,hash);
  return {userId,discordId,sessionHash:hash};
}
export async function start(client,options={}){
  const result=await client.request('/api/matches',{method:'POST',body:{requestId:crypto.randomUUID(),humanMark:'X',difficulty:'normal',ranked:false,...options}});
  if(![200,201,202].includes(result.status))throw new Error(`Start: ${JSON.stringify(result)}`);return result.data;
}
export async function playToEnd(client,match,chooser=state=>minimaxAction(state).cell){
  for(let i=0;i<10&&match.status!=='complete'&&match.status!=='void';i++){
    if(match.status==='jev_pending'){match=(await client.request(`/api/matches/${match.id}/resume`,{method:'POST'})).data;continue;}
    const r=await client.request(`/api/matches/${match.id}/actions`,{method:'POST',body:{requestId:crypto.randomUUID(),expectedRevision:match.revision,action:{type:'place',cell:chooser({rulesVersion:'ttt/1',board:match.board})}}});
    if(r.status!==200)throw new Error(`Action: ${JSON.stringify(r)}`);match=r.data;
  }
  return match;
}
